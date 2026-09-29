import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCredentialStore, createLocalKeyBackend } from '../src/credentials.mjs';

const values = () => ({
  dnspod: { DNSPOD_API_ID: '12', DNSPOD_API_TOKEN: 'test-only-token-never-a-real-credential' },
  tencentcloud: { TENCENTCLOUD_SECRET_ID: 'test-secret-id', TENCENTCLOUD_SECRET_KEY: 'test-secret-key' },
});

async function workspace(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = path.resolve(await fs.mkdtemp(path.join(parent, 'certflow-credentials-')));
  assert.equal(path.dirname(directory), parent);
  assert.ok(path.basename(directory).startsWith('certflow-credentials-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('certflow-credentials-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const vaultDirectory = path.join(directory, '.certflow');
  const makeStore = backend => createCredentialStore({
    directory: vaultDirectory,
    backend: backend ?? createLocalKeyBackend(vaultDirectory),
  });
  return { directory, vaultDirectory, makeStore, vaultPath: path.join(vaultDirectory, 'credentials.vault.json'), keyPath: path.join(vaultDirectory, 'credentials.key') };
}

test('missing credential vault loads empty without creating any files', async t => {
  const w = await workspace(t);
  assert.deepEqual(await w.makeStore().load(), {});
  assert.deepEqual(await fs.readdir(w.directory), []);
});

test('portable encrypted credentials survive a new store instance without plaintext on disk', async t => {
  const w = await workspace(t);
  const store = w.makeStore();
  await store.save(values());
  assert.deepEqual(await w.makeStore().load(), values());
  const envelope = await fs.readFile(w.vaultPath, 'utf8');
  const data = JSON.parse(envelope);
  assert.equal(data.protection, 'aes-256-gcm-local-key');
  assert.equal(data.version, 1);
  for (const fields of Object.values(values())) {
    for (const value of Object.values(fields)) if (value.length > 3) assert.equal(envelope.includes(value), false);
  }
  assert.equal(envelope.includes('DNSPOD_API_TOKEN'), false);
  assert.equal((await fs.readFile(w.keyPath)).length, 32);
  assert.deepEqual((await fs.readdir(w.vaultDirectory)).sort(), ['credentials.key', 'credentials.vault.json']);
  assert.equal(store.metadata.protection, 'aes-256-gcm-local-key');
});

test('saving replacements and empty contents retains the encryption key and other selected providers', async t => {
  const w = await workspace(t);
  const store = w.makeStore();
  await store.save(values());
  const key = await fs.readFile(w.keyPath);
  await store.save({ dnspod: values().dnspod });
  assert.deepEqual(await store.load(), { dnspod: values().dnspod });
  await store.save({});
  assert.deepEqual(await w.makeStore().load(), {});
  assert.deepEqual(await fs.readFile(w.keyPath), key);
});

test('corrupt or unauthenticated vault cannot be read or overwritten', async t => {
  const w = await workspace(t);
  const store = w.makeStore();
  await store.save(values());
  const original = await fs.readFile(w.vaultPath, 'utf8');
  const envelope = JSON.parse(original);
  const bytes = Buffer.from(envelope.ciphertext, 'base64');
  bytes[bytes.length - 1] ^= 1;
  envelope.ciphertext = bytes.toString('base64');
  const corrupt = JSON.stringify(envelope);
  await fs.writeFile(w.vaultPath, corrupt);
  await assert.rejects(store.load(), /无法读取已保存/);
  await assert.rejects(store.save({}), /无法读取已保存/);
  assert.equal(await fs.readFile(w.vaultPath, 'utf8'), corrupt);
  assert.deepEqual((await fs.readdir(w.vaultDirectory)).sort(), ['credentials.key', 'credentials.vault.json']);
});

test('missing local key does not generate a replacement or wipe an existing vault', async t => {
  const w = await workspace(t);
  const store = w.makeStore();
  await store.save(values());
  const key = await fs.readFile(w.keyPath);
  const encrypted = await fs.readFile(w.vaultPath);
  await fs.unlink(w.keyPath);
  await assert.rejects(store.load(), /无法读取已保存/);
  await assert.rejects(store.save(values()), /无法读取已保存/);
  assert.deepEqual(await fs.readFile(w.vaultPath), encrypted);
  await assert.rejects(fs.stat(w.keyPath), { code: 'ENOENT' });
  await fs.writeFile(w.keyPath, key, { mode: 0o600 });
  assert.deepEqual(await store.load(), values());
});

test('failed encryption preserves previous vault and releases its write lock', async t => {
  const w = await workspace(t);
  const backend = createLocalKeyBackend(w.vaultDirectory);
  const store = w.makeStore(backend);
  await store.save(values());
  const original = await fs.readFile(w.vaultPath);
  const failedStore = w.makeStore({ ...backend, protect: async () => { throw new Error('test encryption failed'); } });
  await assert.rejects(failedStore.save({}), /test encryption failed/);
  assert.deepEqual(await fs.readFile(w.vaultPath), original);
  await store.save({});
  assert.deepEqual(await store.load(), {});
});

test('an existing write lock prevents concurrent saves and remains intact', async t => {
  const w = await workspace(t);
  const store = w.makeStore();
  await store.save(values());
  const lockPath = path.join(w.vaultDirectory, '.credentials.lock');
  await fs.writeFile(lockPath, 'other-process');
  await assert.rejects(store.save({}), /正在保存/);
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'other-process');
  assert.deepEqual(await store.load(), values());
});

test('provider updates merge the current vault and preserve another instance changes', async t => {
  const w = await workspace(t);
  const first = w.makeStore();
  const second = w.makeStore();
  await first.save(values());
  await first.load();
  const changedCloud = { ...values().tencentcloud, TENCENTCLOUD_SECRET_KEY: 'updated-key-from-second-instance' };
  await second.update('tencentcloud', changedCloud);
  const changedDnsPod = { ...values().dnspod, DNSPOD_API_TOKEN: 'updated-token-from-first-instance' };
  const merged = await first.update('dnspod', changedDnsPod);
  assert.deepEqual(merged, { tencentcloud: changedCloud, dnspod: changedDnsPod });
  assert.deepEqual(await w.makeStore().load(), merged);
  const remaining = await second.update('dnspod', null);
  assert.deepEqual(remaining, { tencentcloud: changedCloud });
  assert.deepEqual(await first.load(), remaining);
});

test('transactional provider updates reject invalid values and obey existing locks', async t => {
  const w = await workspace(t);
  const store = w.makeStore();
  await assert.rejects(store.update('../outside', null), /凭据/);
  await assert.rejects(store.update('dnspod', { DNSPOD_API_TOKEN: 'bad\nvalue' }), /凭据/);
  assert.deepEqual(await fs.readdir(w.directory), []);
  await store.save(values());
  await fs.writeFile(path.join(w.vaultDirectory, '.credentials.lock'), 'other-process');
  await assert.rejects(store.update('dnspod', null), /正在保存/);
  assert.deepEqual(await store.load(), values());
});

test('credential format rejects unsafe field names and control characters before creating files', async t => {
  const w = await workspace(t);
  const store = w.makeStore();
  for (const invalid of [null, [], { '../outside': {} }, { dnspod: { unsafe: 'secret' } }, { dnspod: { DNSPOD_API_TOKEN: 'secret\nvalue' } }, JSON.parse('{"__proto__": {}}')]) {
    await assert.rejects(store.save(invalid), /凭据/);
  }
  assert.deepEqual(await fs.readdir(w.directory), []);
});

test('directory links are rejected without following their target', async t => {
  const w = await workspace(t);
  const target = path.join(w.directory, 'outside');
  await fs.mkdir(target, { mode: 0o700 });
  try { await fs.symlink(target, w.vaultDirectory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('directory links unavailable'); throw error; }
  await assert.rejects(w.makeStore().load(), /符号链接/);
  await assert.rejects(w.makeStore().save(values()), /符号链接/);
  assert.deepEqual(await fs.readdir(target), []);
});

test('vault file links are rejected and target is not overwritten', async t => {
  const w = await workspace(t);
  const target = path.join(w.directory, 'outside.txt');
  await fs.writeFile(target, 'unchanged');
  await fs.mkdir(w.vaultDirectory, { mode: 0o700 });
  try { await fs.symlink(target, w.vaultPath, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('file links unavailable'); throw error; }
  await assert.rejects(w.makeStore().load(), /符号链接/);
  await assert.rejects(w.makeStore().save(values()), /符号链接/);
  assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
});

test('portable storage restricts directory and file permissions', { skip: process.platform === 'win32' }, async t => {
  const w = await workspace(t);
  await w.makeStore().save(values());
  assert.equal((await fs.stat(w.vaultDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(w.keyPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(w.vaultPath)).mode & 0o777, 0o600);
  await fs.chmod(w.keyPath, 0o644);
  await assert.rejects(w.makeStore().load(), /无法读取已保存/);
});

test('Windows current-user DPAPI round-trips fake credentials across instances', { skip: process.platform !== 'win32' }, async t => {
  const w = await workspace(t);
  const store = createCredentialStore({ directory: w.vaultDirectory });
  assert.equal(store.metadata.protection, 'windows-dpapi-current-user');
  await store.save(values());
  assert.deepEqual(await createCredentialStore({ directory: w.vaultDirectory }).load(), values());
  const encrypted = await fs.readFile(w.vaultPath, 'utf8');
  assert.equal(encrypted.includes(values().dnspod.DNSPOD_API_TOKEN), false);
  assert.deepEqual(await fs.readdir(w.vaultDirectory), ['credentials.vault.json']);
});
