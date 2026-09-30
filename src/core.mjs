import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { deployCertificate, recoverDeployment } from './deploy.mjs';
import { exportCertificate } from './export.mjs';
import { ACME_DIAGNOSTICS, readAcmeDiagnostic } from './acme-diagnostics.mjs';
import { ACCOUNT_RECOVERY_CHECKPOINT_ERROR, ACCOUNT_RECOVERY_DURABILITY_ERROR, accountRecoveryNeedsReview, isMissingAccountRecoveryFailure, quarantineIncompleteAccount } from './acme-account-recovery.mjs';
import { dnsPodExecEnvironment, loadDnsPodCredentials, readDnsPodDiagnostic } from './dnspod-token.mjs';
import { processCleanupError, requiresProcessCleanup } from './process-safety.mjs';

const SERVERS = {
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  production: 'https://acme-v02.api.letsencrypt.org/directory',
};
const PROVIDERS = {
  'dnspod-token': ['DNSPOD_API_ID', 'DNSPOD_API_TOKEN'],
  tencentcloud: ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'],
  cloudflare: ['CF_DNS_API_TOKEN'],
  alidns: ['ALICLOUD_ACCESS_KEY', 'ALICLOUD_SECRET_KEY'],
};
const DAY = 86400000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };
const resolvePath = (base, value) => path.resolve(base, value);

function string(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) fail(`${label} 必须是非空字符串，且不能含控制字符。`);
  return value;
}
function argv(value, label) {
  if (!Array.isArray(value) || !value.length) fail(`${label} 必须是命令参数数组。`);
  return value.map((v) => string(v, label));
}
function domain(value) {
  string(value, '域名');
  if (/[\s/\\?#:@%]/.test(value)) fail(`无效域名：${value}。请填写域名，不要填写 URL、端口或路径。`);
  const wildcard = value.startsWith('*.');
  const ascii = domainToASCII(wildcard ? value.slice(2) : value).toLowerCase();
  const labels = ascii.split('.');
  if (ascii.length > 253 || labels.length < 2 || !/[a-z]/.test(labels.at(-1)) ||
      labels.some((v) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v))) {
    fail(`无效域名：${value}。请填写域名，不要填写 URL、端口或 IP。`);
  }
  return `${wildcard ? '*.' : ''}${ascii}`;
}

export function validateConfig(raw, baseDir = process.cwd()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('配置必须是 JSON 对象。');
  const email = string(raw.email, 'email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('email 格式无效。');
  const environment = raw.environment ?? 'staging';
  if (!Object.hasOwn(SERVERS, environment)) fail('environment 必须是 staging 或 production。');
  if (raw.acceptTerms !== undefined && typeof raw.acceptTerms !== 'boolean') fail('acceptTerms 必须是布尔值。');
  if (!Array.isArray(raw.jobs) || !raw.jobs.length) fail('jobs 至少需要一个证书任务。');
  const ids = new Set();
  const targets = new Map();
  const jobs = raw.jobs.map((job) => {
    if (!job || typeof job !== 'object') fail('证书任务必须是对象。');
    if (typeof job.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(job.id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(job.id)) fail('任务 id 只能含小写字母、数字、下划线或短横线，不能使用系统保留名称。');
    if (ids.has(job.id)) fail(`重复任务 id：${job.id}`);
    ids.add(job.id);
    if (job.enabled !== undefined && typeof job.enabled !== 'boolean') fail(`${job.id} 的 enabled 必须是布尔值。`);
    if (!Array.isArray(job.domains) || !job.domains.length || job.domains.length > 100) fail(`${job.id} 需要 1–100 个域名。`);
    const domains = [...new Set(job.domains.map(domain))];
    let challenge;
    if (job.challenge?.type === 'dns') {
      const provider = job.challenge.provider === 'dnspod' ? 'tencentcloud' : job.challenge.provider;
      if (!Object.hasOwn(PROVIDERS, provider)) fail(`${job.id} 的 DNS 服务商不受支持。`);
      challenge = { type: 'dns', provider };
    } else if (job.challenge?.type === 'http') {
      if (domains.some((v) => v.startsWith('*.'))) fail('通配符证书必须使用 DNS 验证。');
      challenge = { type: 'http', webroot: resolvePath(baseDir, string(job.challenge.webroot, 'webroot')) };
    } else fail(`${job.id} 的 challenge.type 必须是 dns 或 http。`);
    let deployment = null;
    if (job.deployment != null) {
      if (environment !== 'production') fail('测试环境证书不能配置自动部署；请使用 deployment: null。');
      const directory = resolvePath(baseDir, string(job.deployment.directory, 'deployment.directory'));
      const targetKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
      if (targets.has(targetKey)) fail(`任务 ${targets.get(targetKey)} 与 ${job.id} 不能部署到相同目录：${directory}。`);
      targets.set(targetKey, job.id);
      deployment = {
        directory,
        checkCommand: argv(job.deployment.checkCommand, 'checkCommand'),
        reloadCommand: argv(job.deployment.reloadCommand, 'reloadCommand'),
      };
    }
    return { id: job.id, enabled: job.enabled !== false, domains, challenge, deployment };
  });
  const legoInput = string(raw.legoPath ?? 'lego', 'legoPath');
  return {
    email, acceptTerms: raw.acceptTerms === true, environment, baseDir,
    legoPath: /[/\\]/.test(legoInput) ? resolvePath(baseDir, legoInput) : legoInput,
    dataDir: resolvePath(baseDir, string(raw.dataDir ?? './data', 'dataDir')),
    jobs,
  };
}

export async function loadConfig(filename) {
  const absolute = path.resolve(filename);
  let raw;
  try { raw = JSON.parse((await fs.readFile(absolute, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { fail(`无法读取配置 ${absolute}：${error.code ?? 'JSON 格式错误'}`); }
  return validateConfig(raw, path.dirname(absolute));
}

export function jobPaths(config, job) {
  const directory = path.join(config.dataDir, config.environment, job.id);
  const lego = path.join(directory, 'lego');
  return {
    directory, lego, state: path.join(directory, 'state.json'),
    exports: path.join(directory, 'exports'),
    certificate: path.join(lego, 'certificates', `${job.id}.crt`),
    privateKey: path.join(lego, 'certificates', `${job.id}.key`),
  };
}

export function buildArgs(config, job) {
  const args = ['run', '--server', SERVERS[config.environment], '--email', config.email,
    '--path', jobPaths(config, job).lego, '--cert.name', job.id, '--key-type', 'EC256', '--force-cert-domains'];
  if (config.acceptTerms) args.push('--accept-tos');
  for (const name of job.domains) args.push('--domains', name);
  if (job.challenge.type === 'dns') args.push('--dns', job.challenge.provider === 'dnspod-token' ? 'exec' : job.challenge.provider);
  else args.push('--http', '--http.webroot', job.challenge.webroot);
  return args;
}

export async function plan(config) {
  return {
    environment: config.environment,
    termsAccepted: config.acceptTerms,
    notice: '计划预览，不访问 ACME 或修改 DNS。实际续期时间交给 lego 的 ARI 和证书寿命策略决定。',
    jobs: config.jobs.map((job) => ({
      id: job.id, enabled: job.enabled !== false, domains: job.domains, executable: config.legoPath,
      args: buildArgs(config, job), requiredEnvironment: PROVIDERS[job.challenge.provider] ?? [],
      files: jobPaths(config, job), deployment: job.deployment,
    })),
  };
}

async function readState(filename) {
  try {
    const state = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid state');
    if (state.failureCount !== undefined && (!Number.isSafeInteger(state.failureCount) || state.failureCount < 0)) throw new Error('Invalid failure counter');
    for (const field of ['lastAttemptAt', 'nextAttemptAt', 'lastSuccessAt', 'lastDeployedAt']) {
      if (state[field] != null && (typeof state[field] !== 'string' || !Number.isFinite(Date.parse(state[field])))) throw new Error('Invalid state timestamp');
    }
    return state;
  }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error(`状态文件损坏或不可读取：${filename}`); }
}

async function writeState(filename, state) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

export function inspectCertificate(certificate, privateKey, domains, now = Date.now()) {
  const cert = new X509Certificate(certificate);
  if (!cert.checkPrivateKey(createPrivateKey(privateKey))) fail('证书与私钥不匹配，拒绝部署。');
  const sans = (cert.subjectAltName ?? '').split(/,\s*/).filter((v) => v.startsWith('DNS:')).map((v) => v.slice(4).toLowerCase());
  if (domains.some((name) => !sans.includes(name))) fail('证书未包含全部配置域名，拒绝部署。');
  if (sans.some((name) => !domains.includes(name))) fail('证书包含已从配置移除的域名，请重新申请匹配当前域名的证书。');
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > now || to <= now) fail('证书尚未生效或已经过期，拒绝部署。');
  return {
    fingerprint: cert.fingerprint256, domains: sans,
    validFrom: new Date(from).toISOString(), validTo: new Date(to).toISOString(),
    remainingDays: Math.floor((to - now) / DAY),
  };
}

async function readCertificate(config, job) {
  const files = jobPaths(config, job);
  const [certificate, privateKey] = await Promise.all([fs.readFile(files.certificate), fs.readFile(files.privateKey)]);
  return { certificate, privateKey, ...inspectCertificate(certificate, privateKey, job.domains) };
}

export async function getStatus(config) {
  return Promise.all(config.jobs.map(async (job) => {
    const files = jobPaths(config, job);
    let state, stateError = null;
    try { state = await readState(files.state); }
    catch (error) { stateError = error.message; state = { lastError: stateError }; }
    let certificate;
    try {
      const pem = await fs.readFile(files.certificate);
      const cert = new X509Certificate(pem);
      certificate = { fingerprint: cert.fingerprint256, validFrom: new Date(cert.validFrom).toISOString(), validTo: new Date(cert.validTo).toISOString(),
        remainingDays: Math.floor((Date.parse(cert.validTo) - Date.now()) / DAY) };
      try {
        const privateKey = await fs.readFile(files.privateKey);
        certificate = { ...inspectCertificate(pem, privateKey, job.domains), status: 'valid' };
      } catch (error) {
        certificate.status = error.code === 'ENOENT' ? 'missing-key' : Date.parse(cert.validTo) <= Date.now() ? 'expired'
          : Date.parse(cert.validFrom) > Date.now() ? 'not-yet-valid' : 'invalid';
        certificate.error = error.code === 'ENOENT' ? '证书私钥文件缺失，请重新申请或恢复匹配的私钥。' : error.message;
      }
    } catch (error) {
      certificate = { status: error.code === 'ENOENT' ? 'not-issued' : 'unreadable',
        ...(error.code === 'ENOENT' ? {} : { error: '证书文件无法读取或格式无效。' }) };
    }
    return { id: job.id, enabled: job.enabled !== false, domains: job.domains, environment: config.environment, certificate,
      deployment: job.deployment ? { directory: job.deployment.directory, lastDeployedFingerprint: state.deployedFingerprint ?? null } : null,
      state, stateError, files };
  }));
}

async function terminateProcessTree(child) {
  if (!Number.isInteger(child.pid)) return;
  if (process.platform !== 'win32') {
    // detached gives this subprocess its own session and process group. Killing
    // the group also stops lego's DNS bridge and deployment command descendants.
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw processCleanupError(); }
    return;
  }
  const executable = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  await new Promise((resolve, reject) => {
    const terminator = spawn(executable, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    const deadline = setTimeout(() => { terminator.kill(); reject(processCleanupError()); }, 10000);
    terminator.once('error', () => { clearTimeout(deadline); reject(processCleanupError()); });
    terminator.once('close', (code) => { clearTimeout(deadline); code === 0 ? resolve() : reject(processCleanupError()); });
  });
}

export function runProcess(executable, args, { cwd, env = process.env, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    let markClosed;
    const closed = new Promise((complete) => { markClosed = complete; });
    const timer = setTimeout(() => {
      timedOut = true;
      void (async () => {
        let deadline;
        try {
          await terminateProcessTree(child);
          await Promise.race([closed, new Promise((_, stop) => { deadline = setTimeout(() => stop(processCleanupError()), 5000); })]);
          reject(new Error(`程序 ${path.basename(executable)} 执行超时，已终止进程树。`));
        } catch {
          // A failed tree termination must never silently permit the next run.
          try { child.kill('SIGKILL'); } catch { /* Retain the lock even if killing the parent also fails. */ }
          child.stdout.destroy(); child.stderr.destroy();
          reject(processCleanupError());
        } finally { clearTimeout(deadline); }
      })();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!timedOut) reject(new Error(`无法启动程序 ${path.basename(executable)}（${error.code ?? '未知错误'}）。`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      markClosed();
      if (!timedOut) resolve({ code, stdout, stderr });
    });
  });
}

async function checkCredentials(job, env) {
  if (job.challenge.type === 'http') {
    if (!(await fs.stat(job.challenge.webroot)).isDirectory()) fail('webroot 不是目录。');
    return;
  }
  if (job.challenge.provider === 'dnspod-token') { await loadDnsPodCredentials(env); return; }
  for (const key of PROVIDERS[job.challenge.provider]) {
    if (env[key]?.trim()) continue;
    if (env[`${key}_FILE`]) {
      const value = await fs.readFile(env[`${key}_FILE`], 'utf8');
      if (value.trim()) continue;
    }
    fail(`缺少环境变量 ${key}（或 ${key}_FILE），请在本机配置 DNS 凭据。`);
  }
}

function deploymentSignature(job) { return hash(JSON.stringify(job.deployment)); }

async function needsDeployment(job, cert, state) {
  if (!job.deployment) return false;
  if (state.deployedFingerprint !== cert.fingerprint || state.deploymentSignature !== deploymentSignature(job)) return true;
  try {
    const [crt, key] = await Promise.all([
      fs.readFile(path.join(job.deployment.directory, 'fullchain.pem')),
      fs.readFile(path.join(job.deployment.directory, 'privkey.pem')),
    ]);
    return hash(crt) !== hash(cert.certificate) || hash(key) !== hash(cert.privateKey);
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function withLock(config, operation) {
  const directory = path.join(config.dataDir, config.environment);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, '.run.lock');
  let lock;
  try { lock = await fs.open(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') fail(`已有任务运行或遗留运行锁：${filename}。若上次异常退出，请确认相关进程全部结束后再删除该文件。`);
    throw error;
  }
  let preserveLock = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const result = await operation();
    preserveLock = result.some((item) => item.requiresProcessCleanup);
    return result;
  } catch (error) { preserveLock = requiresProcessCleanup(error); throw error; }
  finally { await lock.close(); if (!preserveLock) await fs.unlink(filename); }
}

export async function runOnce(config, { only, ignoreBackoff = false, executor = runProcess, env = process.env, onProgress } = {}) {
  const jobs = only ? config.jobs.filter((job) => job.id === only) : config.jobs.filter((job) => job.enabled !== false);
  if (only && !jobs.length) fail(`不存在任务：${only}`);
  if (!jobs.length) return [];
  if (!config.acceptTerms) fail('请先阅读 CA 服务条款，再在配置中设置 acceptTerms: true。');
  return withLock(config, async () => {
    const results = [];
    let clientChecked = false;
    for (const [offset, job] of jobs.entries()) {
      // Progress is observational: a disconnected UI must not turn a completed
      // issuance into a failure or interrupt the remaining certificate jobs.
      const progress = async (type, result, phase) => {
        try { await onProgress?.({ type, id: job.id, index: offset + 1, total: jobs.length,
          ...(result ? { result: structuredClone(result) } : {}), ...(phase ? { phase } : {}) }); }
        catch { /* Reporting must never change certificate processing. */ }
      };
      const reportPhase = (phase) => progress('job-phase', null, phase);
      const complete = async (result) => { results.push(result); await progress('job-complete', result); };
      await progress('job-start');
      await reportPhase('preparing');
      const files = jobPaths(config, job);
      let state;
      try { state = await readState(files.state); }
      catch (error) {
        // Preserve the original state for manual repair; one damaged job must
        // not block the remaining certificates or silently create a new order.
        await complete({ id: job.id, ok: false, action: 'failed', error: error.message, stateError: true });
        continue;
      }
      let action = 'unchanged';
      let bridgeWarning = null;
      let accountRecovery = null;
      let accountRetryStarted = false;
      try {
        const runCommand = async (command, extraEnv) => {
          const result = await executor(command[0], command.slice(1), { cwd: config.baseDir, env: { ...env, ...extraEnv }, timeoutMs: 120000 });
          if (result.code !== 0) fail(`部署命令 ${path.basename(command[0])} 失败（退出码 ${result.code}）。原始输出未保存，以避免泄露凭据。`);
        };
        if (job.deployment) {
          const recovery = await recoverDeployment({ deployment: job.deployment, runCommand });
          if (recovery.recovered) {
            state.deployedFingerprint = null;
            state.deploymentSignature = null;
            await writeState(files.state, state);
          }
        }
        if (!ignoreBackoff && Date.parse(state.nextAttemptAt) > Date.now()) {
          await complete({ id: job.id, ok: false, action: 'backoff', nextAttemptAt: state.nextAttemptAt, error: state.lastError });
          continue;
        }
        state.lastAttemptAt = new Date().toISOString();
        let before;
        try { before = await readCertificate(config, job); } catch { /* Missing, expired or changed SAN: let ACME repair it. */ }
        const saveExport = async (cert) => {
          state.exportFiles = await exportCertificate({ directory: files.exports, certificate: cert.certificate, privateKey: cert.privateKey });
        };
        const deploy = async (cert) => {
          await deployCertificate({ ...cert, fingerprint: cert.fingerprint, deployment: job.deployment, runCommand });
          state.deployedFingerprint = cert.fingerprint;
          state.deploymentSignature = deploymentSignature(job);
          state.lastDeployedAt = new Date().toISOString();
        };
        // A saved new certificate must be deployed again after a previous deployment failure.
        if (before && state.issuedFingerprint === before.fingerprint && await needsDeployment(job, before, state)) {
          await reportPhase('export');
          await saveExport(before);
          await reportPhase('deployment');
          await deploy(before);
          action = 'deployed';
        } else {
          if (state.acmeAccountRecovery?.durabilityUnconfirmed === true) fail(ACCOUNT_RECOVERY_DURABILITY_ERROR);
          if (await accountRecoveryNeedsReview(config, job, SERVERS[config.environment], state.acmeAccountRecovery)) fail(ACCOUNT_RECOVERY_CHECKPOINT_ERROR);
          await reportPhase('credentials');
          await checkCredentials(job, env);
          if (!clientChecked) {
            await reportPhase('client');
            const version = await executor(config.legoPath, ['--version'], { cwd: config.baseDir, env, timeoutMs: 15000 });
            if (version.code !== 0 || !/\blego version v?5\./.test(version.stdout)) fail('仅支持 lego v5，请安装已验证的 v5.5.2 并检查 legoPath。');
            const help = await executor(config.legoPath, ['run', '--help'], { cwd: config.baseDir, env, timeoutMs: 15000 });
            if (help.code !== 0 || !help.stdout.includes('--cert.name') || !help.stdout.includes('--renew-force')) fail('需要 lego v5 客户端（已针对 v5.5.2 适配），请检查 legoPath。');
            clientChecked = true;
          }
          await fs.mkdir(files.lego, { recursive: true, mode: 0o700 });
          const clientEnv = job.challenge.provider === 'dnspod-token'
            ? dnsPodExecEnvironment(env, path.join(files.directory, 'dnspod-challenges'), config.email) : env;
          await reportPhase('acme');
          const executeLego = () => executor(config.legoPath, buildArgs(config, job), { cwd: config.baseDir, env: clientEnv });
          const diagnose = (result) => {
            const output = `${result.stdout}\n${result.stderr}`;
            return (job.challenge.provider === 'dnspod-token' ? readDnsPodDiagnostic(output) : null) ?? readAcmeDiagnostic(output);
          };
          let result = await executeLego();
          if (isMissingAccountRecoveryFailure(result) && diagnose(result) === ACME_DIAGNOSTICS.ACCOUNT_NOT_FOUND) {
            accountRecovery = await quarantineIncompleteAccount(config, job, SERVERS[config.environment]);
            if (accountRecovery) {
              state.acmeAccountRecovery = accountRecovery;
              await writeState(files.state, state);
              if (accountRecovery.durabilityUnconfirmed) fail(ACCOUNT_RECOVERY_DURABILITY_ERROR);
              // One retry under the same run lock; no second recovery attempt,
              // including on future cycles while the quarantine marker exists.
              accountRetryStarted = true;
              result = await executeLego();
            }
          }
          if (result.code !== 0) {
            const diagnostic = diagnose(result);
            const exitCode = Number.isSafeInteger(result.code) && result.code >= 0 ? result.code : '未知';
            fail(diagnostic ?? `lego 申请／续期失败（退出码 ${exitCode}）。请检查域名、DNS API 权限和网络；原始输出未保存，以避免泄露凭据。`);
          }
          if (job.challenge.provider === 'dnspod-token') bridgeWarning = readDnsPodDiagnostic(`${result.stdout}\n${result.stderr}`);
          await reportPhase('certificate');
          const issued = await readCertificate(config, job);
          state.issuedFingerprint = issued.fingerprint;
          await reportPhase('export');
          await saveExport(issued);
          // Persist issuance before deployment so a reload failure never forces another order.
          await writeState(files.state, state);
          action = before?.fingerprint === issued.fingerprint ? 'unchanged' : before ? 'renewed' : 'issued';
          if (await needsDeployment(job, issued, state)) {
            await reportPhase('deployment');
            await deploy(issued);
            if (action === 'unchanged') action = 'deployed';
          }
        }
        state.lastWarning = null;
        state.dnsCleanupPendingCount = 0;
        if (job.challenge.provider === 'dnspod-token') {
          try {
            const entries = await fs.readdir(path.join(files.directory, 'dnspod-challenges'));
            state.dnsCleanupPendingCount = entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length;
          } catch (error) {
            if (error.code !== 'ENOENT') {
              state.dnsCleanupPendingCount = null;
              state.lastWarning = '证书可用，但无法读取 DNSPod 验证记录凭单目录。请检查本地文件权限。';
            }
          }
          if (bridgeWarning) state.lastWarning = `证书可用，但 DNSPod 验证记录清理未完成：${bridgeWarning}`;
          else if (state.dnsCleanupPendingCount) state.lastWarning = `证书可用，但还有 ${state.dnsCleanupPendingCount} 条 DNSPod 验证记录凭单待核查。请检查 DNSPod 控制台中的验证 TXT 记录；工具不会删除未经确认的记录。`;
        }
        state.failureCount = 0;
        state.nextAttemptAt = null;
        state.lastError = null;
        state.lastSuccessAt = new Date().toISOString();
        state.lastAction = action;
        await writeState(files.state, state);
        await complete({ id: job.id, ok: true, action, certificatePath: files.certificate, privateKeyPath: files.privateKey, exportFiles: state.exportFiles,
          ...(accountRecovery ? { accountRecovery } : {}),
          ...(state.lastWarning ? { warning: state.lastWarning } : {}) });
      } catch (error) {
        const processCleanupPending = requiresProcessCleanup(error);
        state.failureCount = (state.failureCount ?? 0) + 1;
        const delay = [60000, 600000, 6000000, DAY][Math.min(state.failureCount - 1, 3)];
        state.nextAttemptAt = new Date(Date.now() + delay).toISOString();
        state.lastError = accountRecovery ? `已将未完成的 ACME 账户隔离保留${accountRetryStarted ? '并重试一次' : '，但尚未开始重试'}，请勿删除隔离目录。${error.message}` : error.message;
        let saveError = null;
        try { await writeState(files.state, state); }
        catch { saveError = '同时无法保存任务状态，请检查数据目录权限和磁盘空间。'; }
        await complete({ id: job.id, ok: false, action: 'failed', error: saveError ? `${state.lastError} ${saveError}` : state.lastError,
          nextAttemptAt: saveError ? null : state.nextAttemptAt, ...(saveError ? { stateError: true } : {}),
          ...(accountRecovery ? { accountRecovery } : {}),
          ...(processCleanupPending ? { requiresProcessCleanup: true } : {}) });
        if (processCleanupPending) break;
      }
    }
    return results;
  });
}
