import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createDistributionTokenStore, scopeFingerprint } from '../src/distribution-tokens.mjs';

const scope = createHash('sha256').update('production|job|example.com').digest('hex');
const otherScope = createHash('sha256').update('staging|job|example.net').digest('hex');
const input = (extra = {}) => ({ jobId: 'job', label: 'NAS Nginx', scopeFingerprint: scope, ...extra });
test('scope fingerprints normalize domain order/case but bind identity, environment and complete SAN scope', () => {
  const job = { id: 'job', domains: ['example.com', '*.example.com'] };
  const fingerprint = scopeFingerprint(job, 'production');
  assert.equal(scopeFingerprint({ ...job, domains: ['*.EXAMPLE.COM', 'example.com', 'example.com'] }, 'production'), fingerprint);
  assert.notEqual(scopeFingerprint(job, 'staging'), fingerprint);
  assert.notEqual(scopeFingerprint({ ...job, id: 'other' }, 'production'), fingerprint);
  assert.notEqual(scopeFingerprint({ ...job, domains: ['example.com'] }, 'production'), fingerprint);
  assert.throws(() => scopeFingerprint({ ...job, domains: ['https://example.com'] }, 'production'));
});
async function setup(t) {
  const temporary = path.resolve(os.tmpdir());
  const parent = await fs.mkdtemp(path.join(temporary, 'certflow-distribution-'));
  const directory = path.join(parent, 'store'), filename = path.join(directory, 'distribution-tokens.json');
  const create = () => createDistributionTokenStore({ directory });
  t.after(async () => {
    assert.equal(path.dirname(parent), temporary);
    assert.ok(path.basename(parent).startsWith('certflow-distribution-'));
    await fs.rm(parent, { force: true, recursive: true });
  });
  return { parent, directory, filename, create, store: create() };
}

test('empty token store is read-only; create returns 256-bit secret once and only hash survives restart', async t => {
  const w = await setup(t);
  assert.deepEqual(await w.store.load(), []);
  assert.deepEqual(await fs.readdir(w.parent), []);
  const { token, grant } = await w.store.create(input());
  assert.match(token, /^cfp_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token.slice(4), 'base64url').length, 32);
  assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt), 365 * 86400000);
  const raw = await fs.readFile(w.filename, 'utf8');
  assert.equal(raw.includes(token), false, 'raw token must never be stored');
  assert.equal(raw.includes(token.slice(4)), false, 'token entropy must never be stored');
  assert.equal(JSON.parse(raw).grants[0].tokenHash, createHash('sha256').update(token).digest('hex'));
  assert.equal('tokenHash' in grant, false);
  assert.deepEqual(await w.create().load(), [grant]);
  assert.deepEqual(await w.create().authenticate(token, 'job', scope), grant);
  assert.deepEqual(await fs.readdir(w.directory), ['distribution-tokens.json']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(w.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(w.filename)).mode & 0o777, 0o600);
  }
});

test('authenticate refuses malformed, wrong job/scope, expired and revoked tokens without leaking hashes', async t => {
  const w = await setup(t);
  const a = await w.store.create(input());
  for (const args of [[], ['not-a-token', 'job', scope], [a.token, 'other', scope], [a.token, 'job', otherScope],
    [`cfp_${'A'.repeat(43)}`, 'job', scope], [a.token, 'job'], [a.token, ['job'], scope]]) {
    assert.equal(await w.store.authenticate(...args), null);
  }
  const revoked = await w.store.revoke(a.grant.id);
  assert.ok(revoked.revokedAt);
  assert.deepEqual(await w.store.revoke(a.grant.id), revoked);
  assert.equal(await w.store.revoke(randomUUID()), null);
  assert.equal(await w.create().authenticate(a.token, 'job', scope), null);
  const b = await w.store.create(input({ label: 'Other server' }));
  const envelope = JSON.parse(await fs.readFile(w.filename, 'utf8'));
  const item = envelope.grants.find(grant => grant.id === b.grant.id);
  item.createdAt = new Date(Date.now() - 2 * 86400000).toISOString();
  item.expiresAt = new Date(Date.now() - 86400000).toISOString();
  await fs.writeFile(w.filename, JSON.stringify(envelope));
  assert.equal(await w.create().authenticate(b.token, 'job', scope), null);
});

test('batch revoke prevents same-ID recreation while preserving other targets and last use is throttled', async t => {
  const w = await setup(t);
  const a = await w.store.create(input()), b = await w.store.create(input({ label: 'second' }));
  const c = await w.store.create(input({ jobId: 'other' }));
  assert.equal(a.grant.lastUsedAt, null);
  const used = await w.store.recordUse(c.grant.id);
  assert.ok(used.lastUsedAt);
  const before = await fs.stat(w.filename);
  assert.deepEqual(await w.store.recordUse(c.grant.id), used);
  assert.equal((await fs.stat(w.filename)).mtimeMs, before.mtimeMs);
  assert.equal(await w.store.revokeForJobs(['job', 'job']), 2);
  assert.equal(await w.store.revokeForJobs(['job']), 0);
  assert.equal(await w.store.authenticate(a.token, 'job', scope), null);
  assert.equal(await w.store.authenticate(b.token, 'job', scope), null);
  assert.equal(await w.store.recordUse(a.grant.id), null);
  assert.deepEqual(await w.store.authenticate(c.token, 'other', scope), used);
  assert.equal((await w.store.list({ jobId: 'job' })).length, 2);
});

test('invalid parameters fail before storage and errors do not echo input', async t => {
  const w = await setup(t);
  for (const extra of [{ jobId: '../private' }, { jobId: ['job'] }, { label: '' }, { label: 'x\nsecret' },
    { label: 'x'.repeat(81) }, { scopeFingerprint: 'secret' }, { scopeFingerprint: scope.toUpperCase() },
    { expiresAt: new Date(Date.now() + 60000).toISOString() }, { expiresAt: new Date(Date.now() + 366 * 86400000).toISOString() }]) {
    await assert.rejects(w.store.create(input(extra)), error => error.code === 'EDISTRIBUTIONVALIDATION' && !error.message.includes('secret'));
  }
  assert.deepEqual(await fs.readdir(w.parent), []);
});

test('corrupt store cannot be authenticated or overwritten; exceptions exclude corrupted contents', async t => {
  const w = await setup(t);
  const a = await w.store.create(input());
  const corrupt = '{invalid-test-secret';
  await fs.writeFile(w.filename, corrupt);
  for (const operation of [() => w.store.load(), () => w.store.authenticate(a.token, 'job', scope), () => w.store.create(input())]) {
    await assert.rejects(operation(), error => error.code === 'EDISTRIBUTIONSTORE' && !error.message.includes('test-secret'));
  }
  assert.equal(await fs.readFile(w.filename, 'utf8'), corrupt);
  assert.deepEqual(await fs.readdir(w.directory), ['distribution-tokens.json']);
});

test('a separate writer lock blocks mutation without stale-lock removal or lost updates', async t => {
  const w = await setup(t);
  await w.store.create(input());
  const lockPath = path.join(w.directory, '.distribution-tokens.lock');
  const marker = JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z' });
  await fs.writeFile(lockPath, marker);
  await assert.rejects(w.create().create(input()), { code: 'EDISTRIBUTIONBUSY' });
  assert.equal(await fs.readFile(lockPath, 'utf8'), marker);
  await fs.unlink(lockPath);
  const results = await Promise.allSettled([w.create().create(input({ label: 'one' })), w.create().create(input({ label: 'two' }))]);
  const succeeded = results.filter(result => result.status === 'fulfilled');
  assert.ok(succeeded.length >= 1);
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'EDISTRIBUTIONBUSY');
  assert.equal((await w.create().list()).length, 1 + succeeded.length);
});

test('same-process usage updates and immediate revocation are serialized, bounded, and flushable', async t => {
  const w = await setup(t);
  const { token, grant } = await w.store.create(input());
  const used = w.store.recordUse(grant.id);
  const revoked = w.store.revoke(grant.id);
  await w.store.flush();
  assert.ok((await used).lastUsedAt);
  assert.ok((await revoked).revokedAt);
  assert.equal(await w.create().authenticate(token, 'job', scope), null);
  const queued = Array.from({ length: 65 }, () => w.store.revoke(grant.id));
  const results = await Promise.allSettled(queued);
  await w.store.flush();
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 64);
  assert.equal(results.at(-1).reason.statusCode, 429);
});

test('redirected directories, linked files and broad permissions fail closed', async t => {
  const w = await setup(t);
  await w.store.create(input());
  const elsewhere = path.join(w.parent, 'elsewhere');
  await fs.rename(w.directory, elsewhere);
  await fs.symlink(elsewhere, w.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(w.store.load(), { code: 'EDISTRIBUTIONSTORE' });
  await fs.unlink(w.directory);
  await fs.rename(elsewhere, w.directory);
  const linked = path.join(w.directory, 'copy.json');
  await fs.link(w.filename, linked);
  await assert.rejects(w.store.load(), { code: 'EDISTRIBUTIONSTORE' });
  await fs.unlink(linked);
  if (process.platform !== 'win32') {
    await fs.chmod(w.filename, 0o644);
    await assert.rejects(w.store.load(), { code: 'EDISTRIBUTIONSTORE' });
    await fs.chmod(w.filename, 0o600);
    await fs.chmod(w.directory, 0o755);
    await assert.rejects(w.store.load(), { code: 'EDISTRIBUTIONSTORE' });
  }
});

test('untrusted writable parent cannot replace the token store', { skip: process.platform === 'win32' }, async t => {
  const w = await setup(t);
  await w.store.create(input());
  await fs.chmod(w.parent, 0o777);
  try {
    await assert.rejects(w.store.load(), { code: 'EDISTRIBUTIONSTORE' });
    await assert.rejects(w.store.create(input()), { code: 'EDISTRIBUTIONSTORE' });
  } finally { await fs.chmod(w.parent, 0o700); }
  assert.equal((await w.create().list()).length, 1);
});
