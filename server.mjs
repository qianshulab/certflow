import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateConfig, getStatus, runOnce, plan, jobPaths, inspectCertificate } from './src/core.mjs';
import { nextWatchDelay } from './cli.mjs';
import { createCredentialStore } from './src/credentials.mjs';
import { localPaths, readLocalJson, writeLocalJson } from './src/local-state.mjs';
import { createAccess } from './src/access.mjs';
import { validateDnsPodCredentials } from './src/dnspod-token.mjs';
import { preflight } from './src/preflight.mjs';
import { createZip } from './src/zip.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.4.1';
const PROVIDERS = {
  'dnspod-token': ['DNSPOD_API_ID', 'DNSPOD_API_TOKEN'],
  tencentcloud: ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'],
  cloudflare: ['CF_DNS_API_TOKEN'],
  alidns: ['ALICLOUD_ACCESS_KEY', 'ALICLOUD_SECRET_KEY'],
};
const EXPORT_NAMES = { certificate: 'cert.pem', chain: 'chain.pem', fullchain: 'fullchain.pem', privateKey: 'privkey.pem' };
const ACTION_NAMES = { issued: '签发并导出完成', renewed: '续期并导出完成', deployed: '证书部署完成', unchanged: '检查完成，证书无需续期', backoff: '等待下次重试', failed: '执行失败' };
const DEFAULT_BODY_LIMIT = 128 * 1024;
const CONFIG_BODY_LIMIT = 2 * 1024 * 1024;
const hash = (data) => createHash('sha256').update(data).digest('hex');
class ApiError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details; }
}
const reject = (status, message, details) => { throw new ApiError(status, message, details); };

function editableConfig(config) {
  return {
    email: config.email, acceptTerms: config.acceptTerms, environment: config.environment,
    legoPath: config.legoPath, dataDir: config.dataDir,
    jobs: config.jobs.map((job) => ({ id: job.id, enabled: job.enabled !== false, domains: job.domains, challenge: job.challenge, deployment: job.deployment })),
  };
}

async function readJsonBody(request, maxBytes = DEFAULT_BODY_LIMIT) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) reject(415, '请求必须使用 JSON。');
  let size = 0;
  const chunks = [];
  // Drain rejected uploads without retaining their content. Throwing midway
  // through IncomingMessage's iterator can strand a socket during shutdown.
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      chunks.length = 0;
    } else chunks.push(chunk);
  }
  if (size > maxBytes) reject(413, maxBytes === CONFIG_BODY_LIMIT ? '配置内容超过 2 MiB 保存上限，当前已保存配置未改动。请减少配置大小后重试。' : '请求内容超过 128 KiB 上限，请减少内容后重试。', { code: 'REQUEST_BODY_TOO_LARGE', limitBytes: maxBytes });
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { reject(400, 'JSON 格式无效。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject(400, '请求必须是 JSON 对象。');
  return body;
}

export async function createApp({ configPath = path.join(ROOT, 'cert-config.json'), port = 0, host = '127.0.0.1', publicUrl, adminPassword, run = runOnce, inspect = preflight, credentialStore } = {}) {
  const access = createAccess({ host, publicUrl, adminPassword });
  const filename = path.resolve(configPath);
  const baseDir = path.dirname(filename);
  await fs.mkdir(baseDir, { recursive: true });
  try { await fs.access(filename); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const template = JSON.parse(await fs.readFile(path.join(ROOT, 'cert-config.example.json'), 'utf8'));
    const localClient = path.join(ROOT, '.tools', 'lego-v5.5.2', process.platform === 'win32' ? 'lego.exe' : 'lego');
    try { await fs.access(localClient); template.legoPath = localClient; } catch { /* A system lego may be configured later. */ }
    template.jobs[0].challenge.provider = 'dnspod-token';
    try { await fs.writeFile(filename, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
  }
  const csrfToken = randomBytes(32).toString('hex');
  const credentials = new Map();
  const local = localPaths(filename);
  const vault = credentialStore ?? createCredentialStore({ directory: local.directory });
  let savedCredentials = {}, storageError = null, preferences = { autoRenew: false }, historyError = null;
  try {
    savedCredentials = await vault.load();
    for (const [provider, values] of Object.entries(savedCredentials)) {
      if (!Object.hasOwn(PROVIDERS, provider) || !values || typeof values !== 'object' || Object.keys(values).some((key) => !PROVIDERS[provider].includes(key)) || PROVIDERS[provider].some((key) => typeof values[key] !== 'string' || !values[key])) throw new Error('已保存的 DNS 凭据格式无效。');
    }
  } catch { savedCredentials = {}; storageError = '无法解密或读取已保存的凭据。请使用保存时的系统用户，检查 .certflow 文件及权限；原文件未覆盖。'; }
  try { const loaded = await readLocalJson(local.preferences, preferences); if (typeof loaded?.autoRenew !== 'boolean') throw new Error(); preferences = loaded; }
  catch { historyError = '自动续期偏好读取失败，请检查本地文件后重新设置。'; }
  const secretValues = new Set(Object.values(PROVIDERS).flat().filter((name) => name !== 'DNSPOD_API_ID').map((name) => process.env[name]).filter(Boolean));
  for (const values of Object.values(savedCredentials)) for (const [key, value] of Object.entries(values)) if (key !== 'DNSPOD_API_ID') secretValues.add(value);
  const logs = [];
  try {
    const previous = await readLocalJson(local.history, []);
    if (!Array.isArray(previous)) throw new Error();
    logs.push(...previous.filter((entry) => entry && typeof entry.message === 'string' && ['info', 'success', 'warning', 'error'].includes(entry.level) && typeof entry.at === 'string').slice(0, 100).map((entry) => ({ id: String(entry.id), at: entry.at, level: entry.level, message: entry.message })));
  } catch { historyError = '历史记录读取失败；当前操作仍可继续。'; }
  const runtime = { running: false, runId: null, startedAt: null, finishedAt: null, only: null, currentJob: null, completedCount: 0, totalJobs: 0, results: [], error: null };
  const scheduler = { enabled: false, nextRunAt: null, resumeError: null };
  let timer = null, activeRun = null, mutationBusy = false, stopping = false, closePromise = null, url;
  let historyWrite = Promise.resolve();

  function redact(value) {
    const clean = (text) => {
      for (const secret of secretValues) text = text.split(secret).join('[已隐藏]');
      return text;
    };
    if (typeof value === 'string') return clean(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, ['csrfToken', 'configVersion'].includes(key) ? val : redact(val)]));
    return value;
  }
  function log(level, message) {
    logs.unshift({ id: randomUUID(), at: new Date().toISOString(), level, message: redact(message) });
    if (logs.length > 100) logs.length = 100;
    const snapshot = redact(logs.map((entry) => ({ ...entry })));
    historyWrite = historyWrite.then(() => writeLocalJson(local.history, snapshot)).catch(() => { historyError = '历史记录保存失败，请检查本地文件权限。'; });
  }
  function environment() {
    const env = { ...process.env };
    delete env.CERTFLOW_ADMIN_PASSWORD;
    delete env.CERTFLOW_ADMIN_PASSWORD_FILE;
    for (const values of [...Object.values(savedCredentials), ...credentials.values()]) {
      for (const [key, value] of Object.entries(values)) { env[key] = value; delete env[`${key}_FILE`]; }
    }
    return env;
  }
  function credentialStatus() {
    const env = environment();
    return Object.fromEntries(Object.entries(PROVIDERS).map(([provider, keys]) => {
      const fields = keys.map((name) => ({ name, configured: Boolean(env[name] || env[`${name}_FILE`]) }));
      const configured = fields.every((field) => field.configured);
      return [provider, { configured, source: credentials.has(provider) ? 'session' : Object.hasOwn(savedCredentials, provider) ? 'saved' : configured ? 'environment' : 'missing', fields }];
    }));
  }
  async function readConfiguration() {
    let text;
    try { text = await fs.readFile(filename, 'utf8'); }
    catch (error) { return { config: null, configVersion: 'missing', configError: `配置不可读取（${error.code}）。` }; }
    const configVersion = hash(text);
    try {
      const normalized = validateConfig(JSON.parse(text.replace(/^\uFEFF/, '')), baseDir);
      return { config: editableConfig(normalized), normalized, configVersion, configError: null };
    } catch (error) { return { config: null, configVersion, configError: redact(error.message) }; }
  }
  async function validConfig() {
    const snapshot = await readConfiguration();
    if (!snapshot.normalized) reject(400, snapshot.configError);
    return snapshot.normalized;
  }
  async function state() {
    const snapshot = await readConfiguration();
    let statuses = [], statusError = null;
    if (snapshot.normalized) {
      try { statuses = await getStatus(snapshot.normalized); }
      catch (error) { statusError = error.message; }
    }
    return redact({
      csrfToken, config: snapshot.config, configVersion: snapshot.configVersion, configError: snapshot.configError,
      configPath: filename, statuses, statusError, credentials: credentialStatus(), runtime: { ...runtime },
      credentialStorage: { ...vault.metadata, error: storageError },
      scheduler: { ...scheduler }, logs, historyError, stopping, app: { version: VERSION, platform: process.platform, baseDir, authentication: access.requiresLogin, remote: access.remote },
    });
  }
  function stopSchedule() {
    clearTimeout(timer); timer = null; scheduler.enabled = false; scheduler.nextRunAt = null;
  }
  function schedule(results, cycleFailed = false) {
    if (!scheduler.enabled || stopping) return;
    const delay = nextWatchDelay(results, { cycleFailed });
    scheduler.nextRunAt = new Date(Date.now() + delay).toISOString();
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null; scheduler.nextRunAt = null;
      if (runtime.running) return; // The active run will schedule the following check.
      if (mutationBusy) { schedule([], true); return; }
      mutationBusy = true;
      void beginRun({}).catch((error) => { log('error', error.message); schedule([], true); }).finally(() => { mutationBusy = false; });
    }, delay);
  }
  async function beginRun({ only, retry = false }) {
    if (runtime.running) reject(409, '已有任务正在执行，请等待完成。');
    if (stopping) reject(409, '工具正在退出。');
    const config = await validConfig();
    if (stopping) reject(409, '工具正在退出。');
    if (!config.acceptTerms) reject(400, '请先在证书配置中阅读并同意证书机构的服务条款。');
    if (only !== undefined && (typeof only !== 'string' || !config.jobs.some((job) => job.id === only))) reject(400, '证书任务不存在。');
    if (typeof retry !== 'boolean') reject(400, 'retry 必须为布尔值。');
    if (runtime.running) reject(409, '已有任务正在执行，请等待完成。');
    clearTimeout(timer); timer = null; scheduler.nextRunAt = null;
    const selectedJobs = config.jobs.filter((job) => only ? job.id === only : job.enabled !== false);
    Object.assign(runtime, { running: true, runId: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null, only: only ?? null, currentJob: null, completedCount: 0, totalJobs: selectedJobs.length, results: [], error: null });
    const runId = runtime.runId;
    const env = environment();
    scheduler.resumeError = null;
    log('info', `开始${config.environment === 'staging' ? '测试' : '正式'}环境证书检查${only ? `：${only}` : '：全部任务'}。`);
    const completed = new Set();
    const recordResult = (result) => {
      if (completed.has(result.id)) return;
      completed.add(result.id);
      runtime.results.push(redact(result));
      runtime.completedCount = completed.size;
      log(result.ok ? 'success' : 'error', `${result.id}：${ACTION_NAMES[result.action] ?? result.action}${result.error ? `；${result.error}` : ''}`);
      if (result.warning) log('warning', `${result.id}：${result.warning}`);
    };
    const onProgress = (event) => {
      if (!runtime.running || runtime.runId !== runId) return;
      if (event.type === 'job-start') runtime.currentJob = event.id;
      else if (event.type === 'job-complete') {
        recordResult(event.result);
        if (runtime.currentJob === event.id) runtime.currentJob = null;
      }
    };
    activeRun = Promise.resolve().then(() => run(config, { only, ignoreBackoff: retry, env, onProgress })).then((results) => {
      // Injected runners may not report progress; include their final results
      // while avoiding a second log entry for every normally completed job.
      for (const result of results) recordResult(result);
    }).catch((error) => {
      runtime.error = redact(error.message);
      log('error', `执行失败：${error.message}`);
    }).finally(() => {
      runtime.running = false; runtime.currentJob = null; runtime.finishedAt = new Date().toISOString();
      schedule(runtime.results, Boolean(runtime.error));
    });
    return { runId };
  }
  function ensureEditable() {
    if (runtime.running) reject(409, '任务运行中，请等待完成后修改。');
  }
  async function download(body, response) {
    if (runtime.running) reject(409, '任务运行中，请在完成后下载同一批证书文件。');
    const config = await validConfig();
    const job = config.jobs.find((job) => job.id === body.id);
    if (!job || typeof body.kind !== 'string' || !(body.kind === 'bundle' || Object.hasOwn(EXPORT_NAMES, body.kind))) reject(400, '证书任务或导出文件类型无效。');
    const files = jobPaths(config, job);
    let certificate, privateKey, contents;
    try {
      [certificate, privateKey] = await Promise.all([fs.readFile(files.certificate), fs.readFile(files.privateKey)]);
      inspectCertificate(certificate, privateKey, job.domains);
      const id = hash(new X509Certificate(certificate).raw);
      const root = await fs.realpath(files.exports);
      const blocks = certificate.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
      const expected = { certificate: `${blocks[0]}\n`, chain: blocks.length > 1 ? `${blocks.slice(1).join('\n')}\n` : '', fullchain: `${blocks.join('\n')}\n`, privateKey };
      const entries = [];
      for (const kind of body.kind === 'bundle' ? Object.keys(EXPORT_NAMES) : [body.kind]) {
        const target = path.join(root, id, EXPORT_NAMES[kind]);
        if ((await fs.realpath(target)) !== target || !(await fs.lstat(target)).isFile()) reject(403, '导出文件路径无效。');
        const data = await fs.readFile(target);
        if (!data.equals(Buffer.from(expected[kind]))) reject(409, '导出文件发生变化，请重新检查证书任务。');
        entries.push({ name: EXPORT_NAMES[kind], content: data });
      }
      contents = body.kind === 'bundle' ? createZip(entries) : entries[0].content;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      reject(404, '没有可用的导出文件，请先成功申请证书。');
    }
    response.writeHead(200, { 'Content-Type': body.kind === 'bundle' ? 'application/zip' : 'application/octet-stream', 'Content-Disposition': `attachment; filename="${job.id}-${body.kind === 'bundle' ? 'certificates.zip' : EXPORT_NAMES[body.kind]}"`, 'Content-Length': contents.length });
    response.end(contents);
  }

  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(redact(value)));
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const own = new URL(access.origin(url));
      const pathname = new URL(request.url, url).pathname;
      // Container health checks use loopback; they expose no configuration.
      if (request.method === 'GET' && pathname === '/api/health' && request.headers.host === new URL(url).host) return json(response, 200, { app: 'https-cert-manager', version: VERSION });
      if (request.headers.host !== own.host) reject(403, '访问地址与工具配置不一致，请使用配置的管理地址。');
      if (request.headers.origin && request.headers.origin !== own.origin) reject(403, '不允许跨站请求。');
      if (request.headers['sec-fetch-site'] === 'cross-site') reject(403, '不允许跨站请求。');
      if (request.method === 'POST' && ['/auth/login', '/auth/logout'].includes(pathname)) {
        if (request.headers.origin !== own.origin) reject(403, '登录操作必须来自当前管理页面。');
        const body = await readJsonBody(request);
        if (pathname === '/auth/logout') { response.setHeader('Set-Cookie', access.logout(request)); return json(response, 200, { ok: true }); }
        const result = access.login(request, body.password);
        if (result.cookie) response.setHeader('Set-Cookie', result.cookie);
        if (result.status === 429) response.setHeader('Retry-After', '60');
        return json(response, result.status, result.error ? { error: result.error } : { ok: true });
      }
      if (request.method === 'GET' && ['/login', '/login.css', '/login.js', '/brand.svg'].includes(pathname)) {
        const asset = { '/login': ['login.html', 'text/html; charset=utf-8'], '/login.css': ['login.css', 'text/css; charset=utf-8'], '/login.js': ['login.js', 'text/javascript; charset=utf-8'], '/brand.svg': ['brand.svg', 'image/svg+xml; charset=utf-8'] }[pathname];
        const content = await fs.readFile(path.join(ROOT, 'web', asset[0]));
        response.writeHead(200, { 'Content-Type': asset[1] }); return response.end(content);
      }
      if (!access.authorized(request) && pathname !== '/api/health') {
        if (pathname.startsWith('/api/')) return json(response, 401, { error: '请先登录证书工作台。', loginRequired: true });
        response.writeHead(302, { Location: '/login' }); return response.end();
      }
      if (request.method === 'GET') {
        if (pathname === '/api/health') return json(response, 200, { app: 'https-cert-manager', version: VERSION });
        if (pathname === '/api/state') return json(response, 200, await state());
        const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
        if (!Object.hasOwn(assets, pathname)) reject(404, '页面不存在。');
        const [asset, contentType] = assets[pathname];
        const content = await fs.readFile(path.join(ROOT, 'web', asset));
        response.writeHead(200, { 'Content-Type': contentType }); return response.end(content);
      }
      if (request.method !== 'POST') reject(405, '不支持该请求方式。');
      const token = request.headers['x-csrf-token'];
      if (typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(csrfToken) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))) reject(403, '操作凭证已失效，请刷新页面。');
      const body = await readJsonBody(request, pathname === '/api/config' ? CONFIG_BODY_LIMIT : DEFAULT_BODY_LIMIT);
      if (stopping) reject(409, '工具正在退出。');
      if (mutationBusy) reject(409, '另一项操作正在保存，请稍后重试。');
      mutationBusy = true;
      try {
        if (pathname === '/api/config') {
          ensureEditable();
          const current = await readConfiguration();
          if (body.version !== current.configVersion) reject(409, '配置已被其他窗口更新，请刷新后再保存。');
          let normalized;
          try { normalized = validateConfig(body.config, baseDir); } catch (error) { reject(400, error.message); }
          const temporary = `${filename}.${randomUUID()}.tmp`;
          try {
            await fs.writeFile(temporary, `${JSON.stringify(editableConfig(normalized), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, filename);
          } finally { await fs.rm(temporary, { force: true }); }
          log('success', '证书配置已保存，尚未执行签发。');
          return json(response, 200, await state());
        }
        if (pathname === '/api/credentials' || pathname === '/api/credentials/clear') {
          ensureEditable();
          if (typeof body.provider !== 'string' || !Object.hasOwn(PROVIDERS, body.provider)) reject(400, 'DNS 服务商无效。');
          if (body.persist !== undefined && typeof body.persist !== 'boolean') reject(400, 'persist 必须为布尔值。');
          if (pathname.endsWith('/clear')) {
            if (storageError) reject(409, storageError);
            const next = { ...savedCredentials }; delete next[body.provider];
            if (vault.update) savedCredentials = await vault.update(body.provider, null);
            else { await vault.save(next); savedCredentials = next; }
            credentials.delete(body.provider);
          }
          else {
            const keys = PROVIDERS[body.provider];
            if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values) || Object.keys(body.values).some((key) => !keys.includes(key))) reject(400, 'DNS 凭据字段无效。');
            const values = {};
            for (const key of keys) {
              const value = body.values[key];
              const minimum = key === 'DNSPOD_API_ID' ? 1 : 8;
              if (typeof value !== 'string' || value.trim().length < minimum || value.length > 4096 || /[\x00-\x1f]/.test(value)) reject(400, `请填写完整的 ${key}。`);
              values[key] = value.trim();
            }
            if (body.provider === 'dnspod-token') {
              try { validateDnsPodCredentials(values.DNSPOD_API_ID, values.DNSPOD_API_TOKEN); }
              catch (error) { reject(400, error.message); }
            }
            for (const [key, value] of Object.entries(values)) if (key !== 'DNSPOD_API_ID') secretValues.add(value);
            if (body.persist === false) credentials.set(body.provider, values);
            else {
              if (storageError) reject(409, storageError);
              const next = { ...savedCredentials, [body.provider]: values };
              if (vault.update) savedCredentials = await vault.update(body.provider, values);
              else { await vault.save(next); savedCredentials = next; }
              credentials.delete(body.provider);
            }
          }
          for (const values of Object.values(savedCredentials)) for (const [key, value] of Object.entries(values)) if (key !== 'DNSPOD_API_ID') secretValues.add(value);
          log('success', pathname.endsWith('/clear') ? '已删除保存的 DNS 凭据及本次会话覆盖值。' : body.persist === false ? 'DNS 凭据仅用于本次会话。' : 'DNS 凭据已加密保存，重启工具后自动加载。');
          return json(response, 200, await state());
        }
        if (pathname === '/api/plan') return json(response, 200, await plan(await validConfig()));
        if (pathname === '/api/preflight') {
          ensureEditable();
          const config = await validConfig();
          if (body.only !== undefined && (typeof body.only !== 'string' || !config.jobs.some((job) => job.id === body.only))) reject(400, '证书任务不存在。');
          return json(response, 200, await inspect(config, { only: body.only, env: environment() }));
        }
        if (pathname === '/api/run') return json(response, 202, await beginRun(body));
        if (pathname === '/api/scheduler') {
          if (typeof body.enabled !== 'boolean') reject(400, 'enabled 必须为布尔值。');
          if (!body.enabled) {
            await writeLocalJson(local.preferences, { autoRenew: false }); preferences.autoRenew = false;
            stopSchedule(); log('info', '自动续期已关闭；已开始的任务将继续完成。');
          }
          else if (!scheduler.enabled) {
            if (runtime.running) reject(409, '请等待当前任务完成后开启自动续期。');
            const config = await validConfig();
            if (!config.acceptTerms) reject(400, '请先阅读并同意证书机构服务条款。');
            await writeLocalJson(local.preferences, { autoRenew: true }); preferences.autoRenew = true;
            scheduler.enabled = true;
            try { await beginRun({}); } catch (error) { scheduler.resumeError = error.message; log('error', error.message); schedule([], true); }
            if (!runtime.running) schedule(runtime.results, Boolean(runtime.error));
            log('success', '自动续期已开启并记住设置，工具启动后会自动恢复检查。');
          }
          return json(response, 200, await state());
        }
        if (pathname === '/api/export') return await download(body, response);
        if (pathname === '/api/shutdown') {
          if (access.remote) reject(400, '请在 NAS 的 Docker 项目管理中停止容器；网页可使用退出登录。');
          stopSchedule(); json(response, 202, { message: '已停止调度，将在当前任务完成后退出。' });
          setImmediate(() => { void close(); }); return;
        }
        reject(404, '接口不存在。');
      } finally { mutationBusy = false; }
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? 500, { error: error.status ? error.message : '本地操作失败，请检查文件权限或配置。', ...(error instanceof ApiError ? error.details : {}) });
      else response.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  await new Promise((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => { server.off('error', rejectListen); resolve(); });
  });
  url = `http://127.0.0.1:${server.address().port}`;
  log('info', '图形界面已启动。填写配置后，可先在测试环境检查申请流程。');
  if (historyError) log('error', historyError);
  if (storageError) log('error', storageError);
  if (preferences.autoRenew) {
    scheduler.enabled = true;
    mutationBusy = true;
    try { await beginRun({}); log('info', '已恢复上次开启的自动续期。'); }
    catch (error) { scheduler.resumeError = error.message; log('error', `恢复自动续期失败：${error.message}`); schedule([], true); }
    finally { mutationBusy = false; }
  }
  function close() {
    if (!closePromise) {
      stopping = true; stopSchedule();
      closePromise = (async () => {
        if (activeRun) await activeRun;
        // An already-admitted config/credential request can queue another log
        // while shutdown waits. Drain those requests before flushing history.
        await new Promise((resolve, rejectClose) => server.close((error) => error ? rejectClose(error) : resolve()));
        await historyWrite;
        credentials.clear(); secretValues.clear();
        access.clear();
      })();
    }
    return closePromise;
  }
  return { server, url, close };
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string', default: process.env.CERTFLOW_CONFIG || path.join(ROOT, 'cert-config.json') }, port: { type: 'string', default: process.env.CERTFLOW_PORT || '3390' }, host: { type: 'string', default: process.env.CERTFLOW_HOST || '127.0.0.1' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('图形界面：node server.mjs [--config 配置路径] [--port 3390]\n仅监听本机 127.0.0.1。'); return; }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535 的整数。');
  let adminPassword = process.env.CERTFLOW_ADMIN_PASSWORD;
  if (process.env.CERTFLOW_ADMIN_PASSWORD_FILE) adminPassword = (await fs.readFile(process.env.CERTFLOW_ADMIN_PASSWORD_FILE, 'utf8')).trim();
  const app = await createApp({ configPath: values.config, port, host: values.host, publicUrl: process.env.CERTFLOW_PUBLIC_URL, adminPassword });
  console.log(`HTTPS 证书管理器：${app.url}\n关闭网页不会停止服务。按 Ctrl+C 停止服务及后续自动续期。`);
  const stop = () => { void app.close().catch((error) => { console.error(error.message); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.code === 'EADDRINUSE' ? '端口已被占用。若图形界面已启动，请打开现有页面；否则使用 --port 指定其他端口。' : error.message); process.exitCode = 1; });
}
