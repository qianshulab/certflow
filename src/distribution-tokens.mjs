import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';

const NAME = 'distribution-tokens.json';
const LOCK = '.distribution-tokens.lock';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_GRANTS = 4096;
const JOB = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HEX = /^[a-f0-9]{64}$/;
const TOKEN = /^cfp_[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fields = ['id', 'label', 'jobId', 'scopeFingerprint', 'createdAt', 'expiresAt', 'revokedAt', 'lastUsedAt', 'tokenHash'];
const DAY = 86400000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const label = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
function failure(message, code = 'EDISTRIBUTIONSTORE', statusCode = 503) {
  return Object.assign(new Error(message), { code, statusCode });
}
const invalid = () => failure('分发令牌参数无效。请检查任务、名称、范围和到期时间。', 'EDISTRIBUTIONVALIDATION', 400);
const unavailable = () => failure('无法安全读取或保存分发令牌。请检查存储权限和文件完整性；请勿删除原文件。');
const metadata = ({ tokenHash, ...grant }) => ({ ...grant });

export function scopeFingerprint(job, environment) {
  if (!job || typeof job.id !== 'string' || !JOB.test(job.id) || !['staging', 'production'].includes(environment) ||
      !Array.isArray(job.domains) || !job.domains.length || job.domains.length > 100) throw invalid();
  const domains = job.domains.map(value => {
    if (typeof value !== 'string' || /[\s/\\?#:@%]/.test(value)) throw invalid();
    const wildcard = value.startsWith('*.');
    const ascii = domainToASCII(wildcard ? value.slice(2) : value).toLowerCase();
    const labels = ascii.split('.');
    if (ascii.length > 253 || labels.length < 2 || !/[a-z]/.test(labels.at(-1)) ||
        labels.some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw invalid();
    return `${wildcard ? '*.' : ''}${ascii}`;
  });
  return createHash('sha256').update(JSON.stringify(['certflow-distribution-v1', environment, job.id, [...new Set(domains)].sort()])).digest('hex');
}

function validateEnvelope(value) {
  if (!object(value) || value.version !== 1 || Object.keys(value).length !== 2 || !Array.isArray(value.grants) || value.grants.length > MAX_GRANTS) throw unavailable();
  const ids = new Set(), hashes = new Set();
  for (const grant of value.grants) {
    if (!object(grant) || Object.keys(grant).length !== fields.length || fields.some(key => !Object.hasOwn(grant, key)) ||
        typeof grant.id !== 'string' || !UUID.test(grant.id) || !label(grant.label) || typeof grant.jobId !== 'string' || !JOB.test(grant.jobId) ||
        typeof grant.scopeFingerprint !== 'string' || !HEX.test(grant.scopeFingerprint) || typeof grant.tokenHash !== 'string' || !HEX.test(grant.tokenHash) || !date(grant.createdAt) ||
        !(grant.expiresAt === null || date(grant.expiresAt) && Date.parse(grant.expiresAt) > Date.parse(grant.createdAt)) ||
        !(grant.revokedAt === null || date(grant.revokedAt)) || !(grant.lastUsedAt === null || date(grant.lastUsedAt)) || ids.has(grant.id) || hashes.has(grant.tokenHash)) throw unavailable();
    ids.add(grant.id); hashes.add(grant.tokenHash);
  }
  return value;
}

/** Tokens are returned only by create(). Neither load/list nor authentication expose hashes.
 * The caller must additionally rate-limit HTTP requests and revokeForJobs before deleting jobs.
 * This store has a cross-process writer lock; an abandoned lock requires operator inspection.
 */
export function createDistributionTokenStore({ directory }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw invalid();
  directory = path.resolve(directory);
  const filename = path.join(directory, NAME), lockPath = path.join(directory, LOCK);
  let writeQueue = Promise.resolve(), pendingWrites = 0;

  async function inspectDirectory(create = false) {
    // Reject redirected ancestors as well as a redirected final directory. Parent is pre-existing.
    for (let ancestor = path.dirname(directory); ; ancestor = path.dirname(ancestor)) {
      const info = await fs.lstat(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
      if (process.platform !== 'win32') {
        // A root-owned sticky ancestor cannot rename another trusted user's child.
        // Every child ancestor is also checked for root/current-user ownership.
        const protectedStickyParent = info.uid === 0 && Boolean(info.mode & 0o1000);
        if (![0, process.getuid()].includes(info.uid) || (info.mode & 0o022) && !protectedStickyParent) throw unavailable();
      }
      if (ancestor === path.dirname(ancestor)) break;
    }
    if (create) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT' && !create) return null; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' &&
        ((info.mode & 0o077) || info.uid !== process.getuid()))) throw unavailable();
    return info;
  }

  async function read() {
    try {
      if (!await inspectDirectory()) return { version: 1, grants: [] };
      const before = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!before) return { version: 1, grants: [] };
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES ||
          process.platform !== 'win32' && ((before.mode & 0o077) || before.uid !== process.getuid())) throw unavailable();
      const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino || actual.size > MAX_BYTES) throw unavailable();
        const bytes = await handle.readFile();
        if (bytes.length > MAX_BYTES) throw unavailable();
        return validateEnvelope(JSON.parse(bytes.toString('utf8')));
      } finally { await handle.close(); }
    } catch { throw unavailable(); }
  }

  async function write(value) {
    const temporary = path.join(directory, `.${NAME}.${randomUUID()}.tmp`);
    const content = `${JSON.stringify(validateEnvelope(value))}\n`;
    if (Buffer.byteLength(content) > MAX_BYTES) throw unavailable();
    let file;
    try {
      file = await fs.open(temporary, 'wx', 0o600);
      await file.writeFile(content); await file.sync(); await file.close(); file = null;
      await fs.rename(temporary, filename);
      if (process.platform !== 'win32') {
        const dir = await fs.open(directory, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } finally {
      await file?.close();
      await fs.rm(temporary, { force: true });
    }
  }

  async function lockedMutation(operation) {
    let lock;
    try {
      await inspectDirectory(true);
      try { lock = await fs.open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw failure('分发令牌存储正在使用中。请稍后重试；若持续出现，请确认没有其他实例运行后检查存储锁。', 'EDISTRIBUTIONBUSY', 409);
        throw error;
      }
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const value = await read();
      const result = await operation(value);
      if (result.changed) await write(value);
      return result.value;
    } catch (error) {
      if (error.code?.startsWith('EDISTRIBUTION')) throw error;
      throw unavailable();
    } finally {
      if (lock) {
        try { await lock.close(); await fs.unlink(lockPath); }
        catch { throw unavailable(); }
      }
    }
  }

  function mutate(operation) {
    if (pendingWrites >= 64) return Promise.reject(failure('分发令牌操作过于频繁，请稍后重试。', 'EDISTRIBUTIONBUSY', 429));
    pendingWrites++;
    const operationResult = writeQueue.then(() => lockedMutation(operation));
    writeQueue = operationResult.catch(() => {}).finally(() => { pendingWrites--; });
    return operationResult;
  }

  return {
    async flush() { await writeQueue; },
    async load() { return (await read()).grants.map(metadata); },
    async list({ jobId } = {}) {
      if (jobId !== undefined && (typeof jobId !== 'string' || !JOB.test(jobId))) throw invalid();
      return (await read()).grants.filter(grant => jobId === undefined || grant.jobId === jobId).map(metadata);
    },
    async create({ jobId, label: name, scopeFingerprint, expiresAt } = {}) {
      const createdAt = new Date().toISOString();
      expiresAt ??= new Date(Date.parse(createdAt) + 365 * DAY).toISOString();
      // A minute of tolerance avoids rejecting a 1-day expiry calculated by the API just earlier.
      const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
      if (typeof jobId !== 'string' || !JOB.test(jobId) || !label(name) || typeof scopeFingerprint !== 'string' || !HEX.test(scopeFingerprint) ||
          !date(expiresAt) || lifetime < DAY - 60000 || lifetime > 365 * DAY) throw invalid();
      return mutate(value => {
        // Bound disk and per-authentication work. Revoked entries remain as an audit trail.
        if (value.grants.length >= MAX_GRANTS) throw failure('分发令牌记录已达 4096 条上限，请先归档存储并重新授权需要的接收端。', 'EDISTRIBUTIONLIMIT', 409);
        const token = `cfp_${randomBytes(32).toString('base64url')}`;
        const grant = { id: randomUUID(), label: name, jobId, scopeFingerprint, createdAt, expiresAt, revokedAt: null, lastUsedAt: null,
          tokenHash: createHash('sha256').update(token).digest('hex') };
        value.grants.push(grant);
        return { changed: true, value: { token, grant: metadata(grant) } };
      });
    },
    async revoke(id) {
      if (typeof id !== 'string' || !UUID.test(id)) throw invalid();
      return mutate(value => {
        const grant = value.grants.find(item => item.id === id);
        const changed = Boolean(grant && !grant.revokedAt);
        if (changed) grant.revokedAt = new Date().toISOString();
        return { changed, value: grant ? metadata(grant) : null };
      });
    },
    async revokeForJobs(jobIds) {
      if (!Array.isArray(jobIds) || jobIds.some(id => typeof id !== 'string' || !JOB.test(id))) throw invalid();
      const ids = new Set(jobIds);
      if (!ids.size) return 0;
      return mutate(value => {
        let count = 0;
        const revokedAt = new Date().toISOString();
        for (const grant of value.grants) if (ids.has(grant.jobId) && !grant.revokedAt) { grant.revokedAt = revokedAt; count++; }
        return { changed: count > 0, value: count };
      });
    },
    async recordUse(id) {
      if (typeof id !== 'string' || !UUID.test(id)) throw invalid();
      return mutate(value => {
        const grant = value.grants.find(item => item.id === id);
        if (!grant || grant.revokedAt || Date.parse(grant.expiresAt) <= Date.now()) return { changed: false, value: null };
        const changed = !grant.lastUsedAt || Date.now() - Date.parse(grant.lastUsedAt) >= 15 * 60000;
        if (changed) grant.lastUsedAt = new Date().toISOString();
        return { changed, value: metadata(grant) };
      });
    },
    async authenticate(token, jobId, scopeFingerprint) {
      if (typeof token !== 'string' || !TOKEN.test(token) || typeof jobId !== 'string' || !JOB.test(jobId) ||
          typeof scopeFingerprint !== 'string' || !HEX.test(scopeFingerprint)) return null;
      const hash = createHash('sha256').update(token).digest();
      const scope = Buffer.from(scopeFingerprint, 'hex');
      let match = null;
      // Compare all records, including revoked/expired ones, without an early hash-match return.
      for (const grant of (await read()).grants) {
        const tokenMatches = timingSafeEqual(hash, Buffer.from(grant.tokenHash, 'hex'));
        const scopeMatches = timingSafeEqual(scope, Buffer.from(grant.scopeFingerprint, 'hex'));
        if (tokenMatches && scopeMatches && grant.jobId === jobId && !grant.revokedAt &&
            (grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.now())) match = metadata(grant);
      }
      return match;
    },
  };
}
