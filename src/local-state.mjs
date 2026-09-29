import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createCredentialStore } from './credentials.mjs';

export function localPaths(configPath) {
  const directory = path.join(path.dirname(path.resolve(configPath)), '.certflow');
  const key = createHash('sha256').update(path.resolve(configPath)).digest('hex').slice(0, 20);
  return { directory, preferences: path.join(directory, `preferences-${key}.json`), history: path.join(directory, `history-${key}.json`) };
}

export async function readLocalJson(filename, fallback) {
  try {
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('本地状态文件无效。');
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeLocalJson(filename, value) {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('本地状态目录无效。');
  try { const file = await fs.lstat(filename); if (!file.isFile() || file.isSymbolicLink()) throw new Error('本地状态文件无效。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function savedEnvironment(configPath, env = process.env) {
  const store = createCredentialStore({ directory: localPaths(configPath).directory });
  const saved = await store.load();
  const result = { ...env };
  // Never turn arbitrary vault contents into child-process configuration.
  const allowed = new Set(['DNSPOD_API_ID', 'DNSPOD_API_TOKEN', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY', 'CF_DNS_API_TOKEN', 'ALICLOUD_ACCESS_KEY', 'ALICLOUD_SECRET_KEY']);
  for (const values of Object.values(saved)) for (const [name, value] of Object.entries(values)) {
    if (!allowed.has(name) || typeof value !== 'string') throw new Error('已保存的 DNS 凭据字段无效。');
    result[name] = value; delete result[`${name}_FILE`];
  }
  return result;
}
