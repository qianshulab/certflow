import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { createApp } from '../server.mjs';
import { jobPaths, validateConfig } from '../src/core.mjs';

const certificate = await fs.readFile(new URL('./fixtures/server-cert.test.txt', import.meta.url));
const privateKey = await fs.readFile(new URL('./fixtures/server-key.test.txt', import.meta.url));
const password = 'distribution-api-test-password';
const publicUrl = 'https://manager.example.com:3390';
const domains = ['example.com', '*.example.com'];

function configuration() {
  return {
    email: 'operator@example.com', acceptTerms: true, environment: 'production', legoPath: 'unused-lego', dataDir: './data',
    jobs: ['management', 'target', 'other'].map(id => ({ id, domains, challenge: { type: 'dns', provider: 'cloudflare' }, deployment: null })),
  };
}

async function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'certflow-pull-api-'));
  const configPath = path.join(directory, 'config.json');
  const config = configuration();
  await fs.writeFile(configPath, JSON.stringify(config));
  const normalized = validateConfig(config, directory);
  for (const job of normalized.jobs) {
    const files = jobPaths(normalized, job);
    await fs.mkdir(path.dirname(files.certificate), { recursive: true });
    await fs.writeFile(files.certificate, certificate);
    await fs.writeFile(files.privateKey, privateKey);
    const id = createHash('sha256').update(new X509Certificate(certificate).raw).digest('hex');
    const exports = path.join(files.exports, id);
    await fs.mkdir(exports, { recursive: true });
    await fs.writeFile(path.join(exports, 'cert.pem'), certificate);
    await fs.writeFile(path.join(exports, 'chain.pem'), '');
    await fs.writeFile(path.join(exports, 'fullchain.pem'), certificate);
    await fs.writeFile(path.join(exports, 'privkey.pem'), privateKey);
  }
  const apps = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    assert.equal(path.dirname(directory), parent);
    assert.match(path.basename(directory), /^certflow-pull-api-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, configPath, async start(secure = true) {
    const app = await createApp({ configPath, port: 0, publicUrl: secure ? publicUrl : 'http://manager.example.com:3390',
      adminPassword: password, tlsJobId: secure ? 'management' : undefined,
      run: async () => assert.fail('must not run ACME') });
    apps.push(app);
    return app;
  } };
}

function request(app, route, { body, cookie, csrfToken, authorization, host = 'manager.example.com:3390' } = {}) {
  const secure = new URL(app.url).protocol === 'https:';
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({ hostname: '127.0.0.1', port: new URL(app.url).port, path: route,
      ...(secure ? { servername: 'manager.example.com', ca: certificate } : {}), method: body === undefined ? 'GET' : 'POST',
      headers: { Host: host, ...(body === undefined ? {} : { Origin: secure ? publicUrl : 'http://manager.example.com:3390', 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        ...(authorization ? { Authorization: authorization } : {}) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: response.statusCode, headers: response.headers, bytes, text: bytes.toString(), json() { return JSON.parse(this.text); } });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function login(app) {
  const response = await request(app, '/auth/login', { body: { password } });
  assert.equal(response.status, 200);
  const cookie = response.headers?.['set-cookie']?.[0]?.split(';')[0];
  // The helper returns headers below only after a successful login.
  assert.ok(cookie);
  const state = (await request(app, '/api/state', { cookie })).json();
  return { cookie, csrfToken: state.csrfToken, state };
}

test('target pull requires HTTPS, job-scoped bearer, live certificate and revocable persisted grant', async t => {
  const ws = await fixture(t);
  const app = await ws.start();
  const session = await login(app);
  assert.deepEqual(session.state.distributionTokens, []);
  assert.equal((await request(app, '/api/distribution-tokens', { ...session, body: { jobId: 'target', label: 'Target A' }, csrfToken: '' })).status, 403);
  const created = await request(app, '/api/distribution-tokens', { ...session,
    body: { jobId: 'target', label: 'Target A', expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() } });
  assert.equal(created.status, 201);
  const { token, grant } = created.json();
  assert.match(token, /^cfp_[A-Za-z0-9_-]{43}$/);
  assert.equal(grant.jobId, 'target');
  assert.equal(grant.label, 'Target A');
  assert.equal(Object.hasOwn(grant, 'tokenHash'), false);
  const state = (await request(app, '/api/state', session)).json();
  assert.equal(state.distributionTokens.length, 1);
  assert.equal(JSON.stringify(state).includes(token), false);
  assert.equal((await fs.readFile(path.join(ws.directory, '.certflow', 'distribution-tokens.json'), 'utf8')).includes(token), false);
  const url = '/api/pull/target/bundle.zip';
  assert.equal((await request(app, url)).status, 401);
  assert.equal((await request(app, url, { authorization: 'Bearer cfp_' + 'A'.repeat(43) })).status, 401);
  assert.equal((await request(app, url + '?token=' + token, { authorization: `Bearer ${token}` })).status, 400);
  assert.equal((await request(app, url, { authorization: `Bearer ${token}`, host: 'attacker.example' })).status, 403);
  assert.equal((await request(app, '/api/pull/other/bundle.zip', { authorization: `Bearer ${token}` })).status, 401);
  const bundle = await request(app, url, { authorization: `Bearer ${token}` });
  assert.equal(bundle.status, 200);
  assert.equal(bundle.bytes.subarray(0, 4).toString('hex'), '504b0304');
  const revoked = await request(app, '/api/distribution-tokens/revoke', { ...session, body: { id: grant.id } });
  assert.equal(revoked.status, 200);
  assert.equal((await request(app, url, { authorization: `Bearer ${token}` })).status, 401);
  assert.ok((await request(app, '/api/state', session)).json().distributionTokens[0].revokedAt);
});

test('removed and re-added job IDs cannot resurrect target grants', async t => {
  const ws = await fixture(t);
  const app = await ws.start();
  const session = await login(app);
  const created = (await request(app, '/api/distribution-tokens', { ...session, body: { jobId: 'target', label: 'Target B' } })).json();
  const changed = structuredClone(session.state.config);
  changed.jobs = changed.jobs.filter(job => job.id !== 'target');
  const removed = await request(app, '/api/config', { ...session, body: { version: session.state.configVersion, config: changed } });
  assert.equal(removed.status, 200, removed.text);
  assert.ok(removed.json().distributionTokens[0].revokedAt);
  changed.jobs.push(session.state.config.jobs.find(job => job.id === 'target'));
  const restored = await request(app, '/api/config', { ...session, body: { version: removed.json().configVersion, config: changed } });
  assert.equal(restored.status, 200, restored.text);
  assert.equal((await request(app, '/api/pull/target/bundle.zip', { authorization: `Bearer ${created.token}` })).status, 401);
  await app.close();
  const restarted = await ws.start();
  assert.equal((await request(restarted, '/api/pull/target/bundle.zip', { authorization: `Bearer ${created.token}` })).status, 401);
});

test('HTTP bootstrap never accepts machine pull or target token creation', async t => {
  const ws = await fixture(t);
  const app = await ws.start(false);
  const session = await login(app);
  assert.equal((await request(app, '/api/distribution-tokens', { ...session, body: { jobId: 'target', label: 'Target C' } })).status, 409);
  assert.equal((await request(app, '/api/pull/target/bundle.zip', { authorization: 'Bearer cfp_' + 'A'.repeat(43) })).status, 403);
});
