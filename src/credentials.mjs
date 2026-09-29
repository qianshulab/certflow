import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';

const VAULT_NAME = 'credentials.vault.json';
const KEY_NAME = 'credentials.key';
const LOCK_NAME = '.credentials.lock';
const MAX_BYTES = 256 * 1024;
const AAD = Buffer.from('CertFlow credential vault v1');
const ownObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const forbiddenNames = new Set(['__proto__', 'prototype', 'constructor']);

function validateValues(value) {
  if (!ownObject(value)) throw new Error('DNS 凭据内容格式无效。');
  const providers = Object.entries(value);
  if (providers.length > 32) throw new Error('DNS 凭据数量超出限制。');
  for (const [provider, fields] of providers) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider) || forbiddenNames.has(provider) || !ownObject(fields)) {
      throw new Error('DNS 凭据服务商格式无效。');
    }
    if (Object.keys(fields).length > 32) throw new Error('DNS 凭据字段数量超出限制。');
    for (const [name, secret] of Object.entries(fields)) {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || typeof secret !== 'string' ||
          secret.length === 0 || secret.length > 4096 || /[\x00-\x1f\x7f]/.test(secret)) {
        throw new Error('DNS 凭据字段格式无效。');
      }
    }
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_BYTES / 2) throw new Error('DNS 凭据内容超出大小限制。');
  return json;
}

async function inspectDirectory(directory, create = false) {
  if (create) await fs.mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await fs.lstat(directory).catch(error => {
    if (error.code === 'ENOENT' && !create) return null;
    throw error;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error('凭据存储目录必须是普通目录，不能使用符号链接。');
  }
  if (stat && process.platform !== 'win32' && (stat.mode & 0o077)) {
    throw new Error('凭据存储目录权限过宽，请将目录权限设为 700。');
  }
  return stat;
}

async function readRegularFile(filename, { missing = false, privateFile = false } = {}) {
  const before = await fs.lstat(filename).catch(error => {
    if (error.code === 'ENOENT' && missing) return null;
    throw error;
  });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('凭据存储文件必须是普通文件，不能使用符号链接。');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.ino !== before.ino || stat.dev !== before.dev) {
      throw new Error('凭据存储文件异常或过大。');
    }
    if (privateFile && process.platform !== 'win32' && (stat.mode & 0o077)) {
      throw new Error('凭据密钥文件权限过宽，请将文件权限设为 600。');
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_BYTES) throw new Error('凭据存储文件过大。');
    return bytes;
  } finally {
    await handle.close();
  }
}

function windowsTransform(bytes, action) {
  // Secret bytes go through stdin. Command-line arguments contain only this fixed script.
  const script = `$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  $entropy = [Text.Encoding]::UTF8.GetBytes('CertFlow credential vault v1')
  $outputBytes = [Security.Cryptography.ProtectedData]::${action}($inputBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($outputBytes))
} catch { [Console]::Error.Write('Credential protection failed.'); exit 1 }`;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let length = 0;
    let failure;
    const fail = message => { failure ??= new Error(message); child.kill(); };
    const timeout = setTimeout(() => fail('Windows 凭据加密服务响应超时。'), 15000);
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_BYTES * 2) fail('Windows 凭据加密服务返回异常。');
      else chunks.push(chunk);
    });
    child.on('error', () => { failure ??= new Error('无法启动 Windows 凭据加密服务。'); });
    child.stdin.on('error', () => { failure ??= new Error('Windows 凭据加密服务通信失败。'); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error('Windows 凭据解密或加密失败。请使用原来的 Windows 用户运行。'));
      const encoded = Buffer.concat(chunks).toString('ascii').trim();
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || !encoded) {
        return reject(new Error('Windows 凭据加密服务返回格式异常。'));
      }
      resolve(Buffer.from(encoded, 'base64'));
    });
    child.stdin.end(bytes.toString('base64'));
  });
}

function windowsBackend() {
  return {
    protection: 'windows-dpapi-current-user',
    label: 'Windows 当前用户加密（DPAPI）',
    protect: bytes => windowsTransform(bytes, 'Protect'),
    unprotect: bytes => windowsTransform(bytes, 'Unprotect'),
  };
}

/** Portable fallback: encryption depends on the permissions of a local key file.
 * A process that can read both credentials.key and the vault can decrypt it.
 * This is not equivalent to Windows DPAPI or a hardware-backed key store.
 */
export function createLocalKeyBackend(directory) {
  const keyPath = path.join(path.resolve(directory), KEY_NAME);
  async function readKey(create) {
    let key = await readRegularFile(keyPath, { missing: true, privateFile: true });
    if (!key && create) {
      const fresh = randomBytes(32);
      let file;
      try {
        file = await fs.open(keyPath, 'wx', 0o600);
        await file.writeFile(fresh);
        await file.sync();
        key = Buffer.from(fresh);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        key = await readRegularFile(keyPath, { privateFile: true });
      } finally {
        fresh.fill(0);
        if (file) await file.close();
      }
    }
    if (!key || key.length !== 32) {
      key?.fill(0);
      throw new Error('本地凭据密钥缺失或损坏，请恢复原来的 credentials.key 文件。');
    }
    return key;
  }
  return {
    protection: 'aes-256-gcm-local-key',
    label: '本地加密文件（密钥由文件权限保护）',
    async protect(bytes) {
      const key = await readKey(true);
      try {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(AAD);
        const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
      } finally { key.fill(0); }
    },
    async unprotect(bytes) {
      if (bytes.length < 29) throw new Error('本地凭据加密内容不完整。');
      const key = await readKey(false);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAAD(AAD);
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      } finally { key.fill(0); }
    },
  };
}

/** Creates a local vault. Call load() before starting services and surface errors.
 * backend is injectable for testing, with { protection, label, protect, unprotect }.
 */
export function createCredentialStore({ directory, backend } = {}) {
  if (typeof directory !== 'string' || !directory) throw new Error('必须提供凭据存储目录。');
  const root = path.resolve(directory);
  const vaultPath = path.join(root, VAULT_NAME);
  const lockPath = path.join(root, LOCK_NAME);
  const protector = backend ?? (process.platform === 'win32' ? windowsBackend() : createLocalKeyBackend(root));
  if (!protector || typeof protector.protection !== 'string' || typeof protector.label !== 'string' ||
      typeof protector.protect !== 'function' || typeof protector.unprotect !== 'function') {
    throw new Error('凭据加密后端配置无效。');
  }
  const metadata = Object.freeze({ protection: protector.protection, label: protector.label });

  async function load() {
    if (!await inspectDirectory(root)) return {};
    const bytes = await readRegularFile(vaultPath, { missing: true });
    if (!bytes) return {};
    let decoded;
    try {
      const envelope = JSON.parse(bytes.toString('utf8'));
      if (!ownObject(envelope) || envelope.version !== 1 || envelope.protection !== protector.protection ||
          typeof envelope.ciphertext !== 'string' || !envelope.ciphertext ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.ciphertext)) {
        throw new Error('格式或加密类型无效');
      }
      decoded = await protector.unprotect(Buffer.from(envelope.ciphertext, 'base64'));
      if (!Buffer.isBuffer(decoded) || decoded.length > MAX_BYTES / 2) throw new Error('解密内容无效');
      const values = JSON.parse(decoded.toString('utf8'));
      validateValues(values);
      return values;
    } catch {
      // Never include backend errors, file contents, or decrypted values in logs.
      throw new Error('无法读取已保存的 DNS 凭据：文件可能损坏、密钥丢失，或当前用户/系统与保存时不同。原文件已保留，请恢复原凭据存储后重试。');
    } finally { decoded?.fill?.(0); }
  }

  async function transaction(transform) {
    let plaintext;
    let lock;
    let tempPath;
    try {
      await inspectDirectory(root, true);
      try { lock = await fs.open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('DNS 凭据正在保存，或上次保存异常中断。请确认其他实例已退出后再处理 .credentials.lock 文件。');
        throw error;
      }
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      // Refuse to overwrite a vault that cannot be read, even with new values.
      const current = await load();
      const next = transform(current);
      plaintext = Buffer.from(validateValues(next));
      const encrypted = await protector.protect(plaintext);
      if (!Buffer.isBuffer(encrypted) || encrypted.length > MAX_BYTES / 2 + 4096) throw new Error('凭据加密返回内容异常。');
      const envelope = JSON.stringify({ version: 1, protection: protector.protection, ciphertext: encrypted.toString('base64') }, null, 2) + '\n';
      tempPath = path.join(root, `.credentials-${randomUUID()}.tmp`);
      const temporary = await fs.open(tempPath, 'wx', 0o600);
      try { await temporary.writeFile(envelope); await temporary.sync(); }
      finally { await temporary.close(); }
      await fs.rename(tempPath, vaultPath);
      tempPath = undefined;
      return next;
    } finally {
      plaintext?.fill(0);
      if (tempPath) await fs.unlink(tempPath).catch(() => {});
      if (lock) { await lock.close(); await fs.unlink(lockPath); }
    }
  }

  async function save(values) {
    // Validate and snapshot before awaiting, so caller mutation cannot affect encryption.
    const snapshot = JSON.parse(validateValues(values));
    await transaction(() => snapshot);
  }

  async function update(provider, values) {
    // Read and merge under the same lock to preserve other instances' provider updates.
    if (typeof provider !== 'string' || values === undefined) throw new Error('DNS 凭据更新格式无效。');
    const snapshot = JSON.parse(validateValues({ [provider]: values ?? {} }))[provider];
    return transaction(current => {
      const next = { ...current };
      if (values === null) delete next[provider];
      else next[provider] = snapshot;
      return next;
    });
  }
  return { load, save, update, metadata };
}
