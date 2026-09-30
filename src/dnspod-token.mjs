import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// DNSPod's legacy API uses ID,Token, not Tencent Cloud SecretId/SecretKey.
const API = 'https://dnsapi.cn/';
const ACTIONS = new Set(['Domain.Info', 'Record.Create', 'Record.Info', 'Record.Remove']);
const numericId = (value) => /^[1-9][0-9]{0,24}$/.test(String(value));
export const DNSPOD_DIAGNOSTICS = Object.freeze({
  INVALID_CREDENTIALS: 'DNSPod 凭据格式无效。请分别填写数字 ID 和 Token，不要填写腾讯云密钥或 ID,Token 组合。',
  AUTH_FAILED: 'DNSPod 鉴权失败。请检查 ID 和 Token 是否属于同一组、是否已被删除或重置。',
  RATE_LIMITED: 'DNSPod API 调用受到限制。请等待后再试，避免连续手动重试。',
  PERMISSION_DENIED: 'DNSPod 拒绝操作。请检查 Token 所属主账号是否有该域名的解析管理权限。',
  ACCOUNT_LOCKED: 'DNSPod 账号暂时受限或被锁定。请登录控制台检查账号状态后再试。',
  REGION_BLOCKED: 'DNSPod 登录区域保护拒绝了当前出口 IP。请检查 DNSPod 账号的登录地区限制。',
  ZONE_NOT_FOUND: 'DNSPod Token 无法管理验证域名。请检查域名所属账号；有 CNAME 委派时请检查目标域名。',
  ZONE_INACTIVE: 'DNSPod 域名解析未启用或被锁定。请检查控制台中的域名状态。',
  RECORD_EXISTS: 'DNSPod 已存在相同 TXT 记录。为保护原有记录，工具没有接管或删除它，请在控制台检查。',
  RECORD_CHANGED: 'DNSPod 验证记录已被修改。工具保留了远端记录和本地凭单，请检查控制台。',
  NETWORK_ERROR: '连接 DNSPod API 失败。请检查网络、HTTPS 代理及 dnsapi.cn 的访问情况。',
  TIMEOUT: 'DNSPod API 请求超时。请检查网络后重试。',
  API_ERROR: 'DNSPod API 拒绝了请求。请检查域名状态、解析套餐限制及 Token 权限。',
  INTERNAL_ERROR: 'DNSPod 验证桥接失败。请检查本地文件权限、遗留验证锁及 Node.js 运行环境。',
});

function bridgeError(diagnostic, message) {
  const error = new Error(message);
  error.diagnostic = diagnostic;
  return error;
}

export function dnsPodDiagnostic(error) {
  if (error instanceof DnsPodError) {
    return ({ '-1': 'AUTH_FAILED', '-2': 'RATE_LIMITED', '-7': 'PERMISSION_DENIED', '7': 'PERMISSION_DENIED',
      '-8': 'ACCOUNT_LOCKED', '83': 'ACCOUNT_LOCKED', '85': 'REGION_BLOCKED', '-15': 'ZONE_INACTIVE',
      '21': 'ZONE_INACTIVE', '104': 'RECORD_EXISTS' })[error.code] ?? 'API_ERROR';
  }
  return Object.hasOwn(DNSPOD_DIAGNOSTICS, error?.diagnostic) ? error.diagnostic : 'INTERNAL_ERROR';
}

export function readDnsPodDiagnostic(output) {
  for (const match of String(output).matchAll(/CERTFLOW_DNSPOD_ERROR:([A-Z_]{2,32})(?![A-Z_])/g)) {
    if (Object.hasOwn(DNSPOD_DIAGNOSTICS, match[1])) return DNSPOD_DIAGNOSTICS[match[1]];
  }
  return null;
}

export class DnsPodError extends Error {
  constructor(action, code) {
    const hints = { '-1': '鉴权失败，请检查 DNSPod ID 和 Token', '-2': '请求过于频繁，请稍后再试',
      '104': '相同记录已存在；为保护原有记录，本工具不会接管或删除它' };
    super(`DNSPod ${action} 失败（代码 ${code}）${hints[code] ? `：${hints[code]}` : '，请检查 Token 权限、域名状态和网络。'}`);
    this.name = 'DnsPodError';
    this.code = code;
  }
}

export function validateDnsPodCredentials(id, token) {
  if (!numericId(id)) throw bridgeError('INVALID_CREDENTIALS', 'DNSPod API ID 必须是正整数；请勿填写腾讯云 SecretId。');
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096 || /[\s,\x00-\x1f\x7f]/.test(token)) {
    throw bridgeError('INVALID_CREDENTIALS', 'DNSPod API Token 格式无效；请分别填写 ID 和 Token，不要包含逗号或空格。');
  }
  return { id: String(id), token };
}

export async function loadDnsPodCredentials(env = process.env) {
  const values = [];
  for (const name of ['DNSPOD_API_ID', 'DNSPOD_API_TOKEN']) {
    let value = env[name]?.trim();
    if (!value && env[`${name}_FILE`]) {
      try { value = (await fs.readFile(env[`${name}_FILE`], 'utf8')).trim(); }
      catch { throw new Error(`无法读取 ${name}_FILE 指定的凭据文件。`); }
    }
    if (!value) throw bridgeError('INVALID_CREDENTIALS', `缺少环境变量 ${name}（或 ${name}_FILE），请在本机配置 DNSPod 凭据。`);
    values.push(value);
  }
  return validateDnsPodCredentials(...values);
}

export function dnsPodExecEnvironment(env, directory, contact) {
  return {
    ...env,
    // lego exec accepts only an executable, with no prefix arguments. Node's
    // preloader receives present/cleanup before Node resolves its main script.
    // A file URL keeps spaces and Unicode paths intact on Windows and POSIX.
    EXEC_PATH: process.execPath,
    EXEC_MODE: '',
    NODE_OPTIONS: `--dns-result-order=ipv4first --import=${new URL('./dnspod-preload.mjs', import.meta.url).href}`,
    CERTFLOW_DNSPOD_STATE_DIR: path.resolve(directory),
    CERTFLOW_DNSPOD_CONTACT: contact,
    EXEC_PROPAGATION_TIMEOUT: '600',
    EXEC_POLLING_INTERVAL: '5',
    EXEC_SEQUENCE_INTERVAL: '5',
  };
}

export function createDnsPodClient({ id, token, contact, fetchImpl = fetch }) {
  validateDnsPodCredentials(id, token);
  if (typeof contact !== 'string' || !/^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]+$/.test(contact) || /[()]/.test(contact)) {
    throw new Error('请填写有效的 ASCII 联系邮箱以调用 DNSPod API。');
  }
  return async (action, params) => {
    if (!ACTIONS.has(action)) throw new Error('不支持的 DNSPod API 操作。');
    let response, payload;
    try {
      response = await fetchImpl(`${API}${action}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `CertFlow/0.3 (${contact})` },
        body: new URLSearchParams({ ...params, login_token: `${id},${token}`, format: 'json', lang: 'cn', error_on_empty: 'no' }),
      });
      if (!response.ok) throw new Error('HTTP failure');
      const parts = [];
      let size = 0;
      for await (const part of response.body) {
        size += part.byteLength;
        if (size > 1024 * 1024) throw new Error('Response too large');
        parts.push(Buffer.from(part));
      }
      payload = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch (error) {
      // Never echo network exceptions or API messages: either may contain tokens.
      throw bridgeError(['TimeoutError', 'AbortError'].includes(error.name) ? 'TIMEOUT' : 'NETWORK_ERROR', `DNSPod ${action} 请求失败，请检查网络连接或稍后重试。`);
    }
    const code = String(payload?.status?.code ?? '');
    if (!/^-?[0-9]{1,6}$/.test(code)) throw new Error(`DNSPod ${action} 返回了无法识别的响应。`);
    if (code !== '1') throw new DnsPodError(action, code);
    return payload;
  };
}

function challengeInput(fqdn, value) {
  if (typeof fqdn !== 'string') throw new Error('DNS 验证域名无效。');
  const name = fqdn.toLowerCase().replace(/\.$/, '');
  const labels = name.split('.');
  if (name.length > 253 || labels.length < 2 || labels.some(v => !/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(v))) {
    throw new Error('DNS 验证域名无效。');
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('DNS 验证值无效。');
  return { fqdn: name, value };
}

export async function findDnsPodZone(fqdn, client) {
  const labels = fqdn.split('.');
  for (let offset = 0; offset < labels.length - 1; offset += 1) {
    const zone = labels.slice(offset).join('.');
    if (zone.includes('_')) continue;
    let result;
    try { result = await client('Domain.Info', { domain: zone }); }
    catch (error) {
      if (error instanceof DnsPodError && ['6', '7', '8', '13'].includes(error.code)) continue;
      throw error;
    }
    const domain = result.domain;
    if (!numericId(domain?.id) || (domain.punycode ?? domain.name)?.toLowerCase() !== zone) {
      throw new Error('DNSPod 返回的域名信息不匹配，已停止操作。');
    }
    if (domain.status !== 'enable') throw bridgeError('ZONE_INACTIVE', 'DNSPod 域名未启用解析，请检查域名状态。');
    return { zone, domainId: String(domain.id), subDomain: offset === 0 ? '@' : labels.slice(0, offset).join('.') };
  }
  throw bridgeError('ZONE_NOT_FOUND', '没有找到当前 DNSPod Token 可管理的验证域名；若设置了 CNAME 委派，请检查目标域名的托管账号。');
}

async function readReceipt(filename, input) {
  let receipt;
  try {
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('Invalid receipt');
    receipt = JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('DNSPod 验证记录凭单损坏或不可读取，已停止操作。');
  }
  const zone = receipt.zone;
  if (receipt.version !== 1 || receipt.fqdn !== input.fqdn || receipt.value !== input.value ||
      !numericId(receipt.domainId) || !numericId(receipt.recordId) || typeof zone !== 'string' ||
      !(input.fqdn === zone || input.fqdn.endsWith(`.${zone}`)) ||
      receipt.subDomain !== (input.fqdn === zone ? '@' : input.fqdn.slice(0, -(zone.length + 1)))) {
    throw new Error('DNSPod 验证记录凭单不匹配，已停止操作。');
  }
  return receipt;
}

async function confirmOwnedRecord(receipt, client) {
  const result = await client('Record.Info', { domain_id: receipt.domainId, record_id: receipt.recordId });
  const record = result.record;
  if (String(record?.id) !== receipt.recordId || String(record?.domain_id ?? result.domain?.id) !== receipt.domainId ||
      record.record_type !== 'TXT' || record.sub_domain?.toLowerCase() !== receipt.subDomain || record.value !== receipt.value) {
    throw bridgeError('RECORD_CHANGED', 'DNSPod 验证记录已被修改，已保留远端记录和本地凭单；请在 DNSPod 控制台检查。');
  }
}

export async function runDnsPodChallenge(action, fqdn, value, { directory, client }) {
  if (!['present', 'cleanup'].includes(action)) throw new Error('不支持的 DNS 验证操作。');
  const input = challengeInput(fqdn, value);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('DNSPod 验证记录目录无效。');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await fs.lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('DNSPod 验证记录目录不安全。');
  const key = createHash('sha256').update(`${input.fqdn}\n${input.value}`).digest('hex');
  const filename = path.join(directory, `${key}.json`);
  const lockPath = path.join(directory, `${key}.lock`);
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch { throw new Error('相同 DNSPod 验证记录已有操作或遗留锁，请确认先前任务已退出。'); }
  try {
    const previous = await readReceipt(filename, input);
    if (previous) {
      await confirmOwnedRecord(previous, client);
      if (action === 'present') return { action: 'existing', recordId: previous.recordId };
      await client('Record.Remove', { domain_id: previous.domainId, record_id: previous.recordId });
      await fs.unlink(filename);
      return { action: 'removed', recordId: previous.recordId };
    }
    // Never look up and delete a record merely by its name/value. Only our saved
    // Record.Create response grants ownership, including for duplicate values.
    if (action === 'cleanup') return { action: 'absent' };
    const zone = await findDnsPodZone(input.fqdn, client);
    const response = await client('Record.Create', {
      domain_id: zone.domainId, sub_domain: zone.subDomain, record_type: 'TXT',
      record_line: '默认', value: input.value, status: 'enable',
    });
    if (!numericId(response.record?.id)) throw new Error('DNSPod 未返回有效记录 ID，请检查控制台中的验证记录。');
    const receipt = { version: 1, ...input, ...zone, recordId: String(response.record.id), createdAt: new Date().toISOString() };
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, filename);
    } catch {
      try { await client('Record.Remove', { domain_id: receipt.domainId, record_id: receipt.recordId }); }
      catch { throw new Error('DNSPod 已创建验证记录，但本地凭单保存与远端回滚均失败，请在控制台检查 TXT 记录。'); }
      throw new Error('DNSPod 验证记录凭单保存失败，已撤回本次创建的记录。');
    } finally { await fs.rm(temporary, { force: true }); }
    return { action: 'created', recordId: receipt.recordId };
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}
