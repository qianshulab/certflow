import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp, checkHealth } from '../server.mjs';
import { jobPaths, validateConfig } from '../src/core.mjs';

const fixture = name => fs.readFile(new URL(`./fixtures/${name}.test.txt`, import.meta.url));
const [certificate, renewed, expired, privateKey, otherKey, single] = await Promise.all([
  'server-cert', 'tls-renewed-cert', 'tls-expired-cert', 'server-key', 'other-key', 'single-domain-cert',
].map(fixture));
const fingerprint = pem => new X509Certificate(pem).fingerprint256;
const publicUrl = 'https://manager.example.com:3390';
const password = 'https-test-management-password';
const configuration = () => ({
  email: 'operator@example.com', acceptTerms: true, environment: 'production', legoPath: 'never-run-acme', dataDir: './data',
  jobs: [{ id: 'management', domains: ['example.com', '*.example.com'], challenge: { type: 'dns', provider: 'cloudflare' }, deployment: null }],
});

async function workspace(t, { config = configuration(), cert = certificate, key = privateKey } = {}) {
  const parent = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'certflow-https-'));
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const normalized = validateConfig(config, directory);
  const files = jobPaths(normalized, normalized.jobs[0]);
  await fs.mkdir(path.dirname(files.certificate), { recursive: true });
  if (cert !== null) await fs.writeFile(files.certificate, cert);
  if (key !== null) await fs.writeFile(files.privateKey, key);
  const apps = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    assert.equal(path.dirname(directory), parent);
    assert.match(path.basename(directory), /^certflow-https-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, configPath, files, config, start: async (options = {}) => {
    const app = await createApp({ configPath, port: 0, publicUrl, adminPassword: password, tlsJobId: 'management',
      run: async () => assert.fail('must not invoke real ACME'), ...options });
    apps.push(app);
    return app;
  } };
}

function request(app, route, { body, cookie, csrfToken, headers = {}, agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: new URL(app.url).port, path: route,
      servername: 'manager.example.com', ca: [certificate, renewed], agent,
      method: body === undefined ? 'GET' : 'POST', headers: {
        Host: 'manager.example.com:3390', ...(body === undefined ? {} : { Origin: publicUrl, 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...headers,
      } }, response => {
      const peer = response.socket.getPeerCertificate().fingerprint256;
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString(), fingerprint: peer,
        json() { return JSON.parse(this.text); } }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function login(app) {
  const response = await request(app, '/auth/login', { body: { password } });
  assert.equal(response.status, 200);
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const state = (await request(app, '/api/state', { cookie })).json();
  return { cookie, csrfToken: state.csrfToken, state, login: response };
}

async function waitForCompletion(app, session) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = (await request(app, '/api/state', session)).json();
    if (!state.runtime.running) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('HTTPS certificate run did not finish');
}

test('HTTPS serves the same application with login, Secure cookies, host checks and health probes', async t => {
  const ws = await workspace(t);
  const app = await ws.start();
  assert.equal(new URL(app.url).protocol, 'https:');
  assert.equal((await request(app, '/')).status, 302);
  assert.equal((await request(app, '/login')).status, 200);
  assert.equal((await request(app, '/api/state')).status, 401);
  assert.equal((await request(app, '/api/health')).status, 200);
  assert.equal((await request(app, '/api/health', { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await request(app, '/auth/login', { body: { password }, headers: { Origin: 'https://attacker.example' } })).status, 403);
  const session = await login(app);
  assert.match(session.login.headers['set-cookie'][0], /; Secure/);
  assert.equal(session.state.app.tls.enabled, true);
  assert.equal(session.state.app.tls.jobId, 'management');
  assert.equal(session.state.app.tls.publicUrl, publicUrl);
  assert.equal(session.state.app.tls.fingerprint, fingerprint(certificate));
  assert.equal((await request(app, '/', session)).status, 200);
  assert.equal((await request(app, '/api/plan', { cookie: session.cookie, body: {} })).status, 403);
  assert.equal((await request(app, '/api/plan', { ...session, body: {} })).status, 200);
  assert.equal(JSON.stringify(session.state).includes(privateKey.toString()), false);
  assert.equal(JSON.stringify(session.state).includes(password), false);
  await checkHealth({ host: '127.0.0.1', port: app.server.address().port, publicUrl, tlsJobId: 'management', ca: certificate });
  await promisify(execFile)(process.execPath, ['server.mjs', '--healthcheck'], { cwd: path.resolve('.'),
    env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('./fixtures/server-cert.test.txt', import.meta.url)),
      CERTFLOW_HOST: '127.0.0.1', CERTFLOW_PORT: String(app.server.address().port), CERTFLOW_PUBLIC_URL: publicUrl, CERTFLOW_TLS_JOB_ID: 'management' } });
  await assert.rejects(checkHealth({ host: '127.0.0.1', port: app.server.address().port, publicUrl: 'https://not-covered.invalid:3390', tlsJobId: 'management', ca: certificate }));
  await assert.rejects(checkHealth({ host: '127.0.0.1', port: app.server.address().port, publicUrl, tlsJobId: 'management' }), /self-signed|certificate/i);
});

test('HTTP remains the default bootstrap transport and supports configured-host health checks', async t => {
  const ws = await workspace(t, { cert: null, key: null });
  const app = await ws.start({ tlsJobId: undefined, publicUrl: 'http://nas.test:3390' });
  assert.equal(new URL(app.url).protocol, 'http:');
  await checkHealth({ host: '127.0.0.1', port: app.server.address().port, publicUrl: 'http://nas.test:3390', tlsJobId: '' });
});

test('successful management renewal swaps the TLS certificate without restarting the listener or sessions', async t => {
  const ws = await workspace(t);
  const app = await ws.start({ run: async () => {
    await fs.writeFile(ws.files.certificate, renewed);
    return [{ id: 'management', ok: true, action: 'renewed' }];
  } });
  const server = app.server;
  const port = server.address().port;
  const session = await login(app);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const oldConnection = await request(app, '/api/health', { agent });
    assert.equal(oldConnection.fingerprint, fingerprint(certificate));
    assert.equal((await request(app, '/api/run', { ...session, body: { only: 'management' } })).status, 202);
    const state = await waitForCompletion(app, session);
    assert.equal(app.server, server);
    assert.equal(server.address().port, port);
    assert.equal(state.app.tls.fingerprint, fingerprint(renewed));
    assert.equal(state.app.tls.error, null);
    assert.ok(state.logs.some(entry => entry.message.includes('管理 HTTPS 已加载更新后的证书')));
    assert.equal((await request(app, '/api/state', session)).fingerprint, fingerprint(renewed));
    assert.equal((await request(app, '/api/health', { agent })).fingerprint, fingerprint(certificate), 'an existing TLS connection remains usable');
  } finally { agent.destroy(); }
});

test('invalid renewed material keeps the working TLS context and reports a safe status', async t => {
  const ws = await workspace(t);
  const app = await ws.start({ run: async () => {
    await fs.writeFile(ws.files.privateKey, otherKey);
    return [{ id: 'management', ok: true, action: 'renewed' }];
  } });
  const session = await login(app);
  await request(app, '/api/run', { ...session, body: { only: 'management' } });
  const state = await waitForCompletion(app, session);
  assert.equal(state.app.tls.fingerprint, fingerprint(certificate));
  assert.match(state.app.tls.error, /私钥不匹配/);
  assert.ok(state.logs.some(entry => entry.message.includes('继续使用已加载的证书')));
  assert.equal((await request(app, '/api/health')).fingerprint, fingerprint(certificate));
  assert.equal(JSON.stringify(state).includes(otherKey.toString()), false);
});

test('failed management renewals do not reload certificate files', async t => {
  const ws = await workspace(t);
  const app = await ws.start({ run: async () => {
    await fs.writeFile(ws.files.certificate, renewed);
    return [{ id: 'management', ok: false, action: 'failed', error: 'simulated ACME failure' }];
  } });
  const session = await login(app);
  await request(app, '/api/run', { ...session, body: { only: 'management' } });
  const state = await waitForCompletion(app, session);
  assert.equal(state.app.tls.fingerprint, fingerprint(certificate));
  assert.match(state.app.tls.error, /任务未成功/);
  assert.equal((await request(app, '/api/health')).fingerprint, fingerprint(certificate));
});

test('TLS context replacement errors retain the current certificate and hide low-level details', async t => {
  const ws = await workspace(t);
  const app = await ws.start({ run: async () => {
    await fs.writeFile(ws.files.certificate, renewed);
    return [{ id: 'management', ok: true, action: 'renewed' }];
  } });
  const session = await login(app);
  const original = app.server.setSecureContext;
  app.server.setSecureContext = () => { throw new Error('LOW_LEVEL_DETAIL_MUST_NOT_LEAK'); };
  try {
    await request(app, '/api/run', { ...session, body: { only: 'management' } });
    const state = await waitForCompletion(app, session);
    assert.match(state.app.tls.error, /上下文更新失败/);
    assert.equal(state.app.tls.fingerprint, fingerprint(certificate));
    assert.equal((await request(app, '/api/health')).fingerprint, fingerprint(certificate));
    assert.equal(JSON.stringify(state).includes('LOW_LEVEL_DETAIL_MUST_NOT_LEAK'), false);
  } finally { app.server.setSecureContext = original; }
});

test('HTTPS startup rejects absent, malformed, expired, mismatched or nonregular certificate inputs', async t => {
  for (const [name, options] of [
    ['missing certificate', { cert: null }], ['missing private key', { key: null }], ['malformed certificate', { cert: 'not PEM' }],
    ['expired certificate', { cert: expired }], ['wrong private key', { key: otherKey }], ['wrong SAN set', { cert: single }],
  ]) {
    await t.test(name, async child => {
      const ws = await workspace(child, options);
      await assert.rejects(ws.start(), /管理 HTTPS 证书/);
    });
  }
  await t.test('directory in place of certificate', async child => {
    const ws = await workspace(child, { cert: null });
    await fs.mkdir(ws.files.certificate);
    await assert.rejects(ws.start(), /路径无效/);
  });
  await t.test('symbolic link outside stable certificate paths', async child => {
    const ws = await workspace(child, { cert: null });
    const outside = path.join(ws.directory, 'outside.pem');
    await fs.writeFile(outside, certificate);
    try { await fs.symlink(outside, ws.files.certificate); }
    catch (error) { if (error.code === 'EPERM') { child.skip('OS does not allow creating symbolic links'); return; } throw error; }
    await assert.rejects(ws.start(), /路径无效/);
  });
  await t.test('junction or symlink in a certificate parent directory', async child => {
    const ws = await workspace(child);
    const certificateDirectory = path.dirname(ws.files.certificate);
    const otherDirectory = path.join(ws.directory, 'other-certificates');
    await fs.rename(certificateDirectory, otherDirectory);
    await fs.symlink(otherDirectory, certificateDirectory, 'junction');
    await assert.rejects(ws.start(), /路径无效/);
  });
});

test('HTTPS requires a configured enabled production DNS job and a matching HTTPS public origin', async t => {
  for (const [name, mutate, options] of [
    ['staging', config => { config.environment = 'staging'; }, {}],
    ['disabled job', config => { config.jobs[0].enabled = false; }, {}],
    ['HTTP challenge', config => { config.jobs[0].domains = ['example.com']; config.jobs[0].challenge = { type: 'http', webroot: './webroot' }; }, {}],
    ['unknown job', () => {}, { tlsJobId: '../../outside' }],
    ['HTTP public URL', () => {}, { publicUrl: 'http://manager.example.com:3390' }],
    ['IP public URL', () => {}, { publicUrl: 'https://127.0.0.1:3390' }],
    ['wrong public hostname', () => {}, { publicUrl: 'https://unrelated.invalid:3390' }],
  ]) {
    await t.test(name, async child => {
      const config = configuration(); mutate(config);
      const ws = await workspace(child, { config });
      await assert.rejects(ws.start(options), /HTTPS|CERTFLOW_TLS_JOB_ID/);
    });
  }
});

test('active HTTPS configuration cannot remove or disable its management job', async t => {
  const ws = await workspace(t);
  const app = await ws.start();
  const session = await login(app);
  const original = await fs.readFile(ws.configPath, 'utf8');
  for (const changes of [{ enabled: false }, { id: 'other-job' }, { domains: ['unrelated.invalid'] }]) {
    const config = { ...ws.config, jobs: [{ ...ws.config.jobs[0], ...changes }] };
    assert.equal((await request(app, '/api/config', { ...session, body: { config, version: session.state.configVersion } })).status, 400);
    assert.equal(await fs.readFile(ws.configPath, 'utf8'), original);
  }
  for (const config of [
    { ...ws.config, jobs: [{ ...ws.config.jobs[0], domains: [...ws.config.jobs[0].domains, 'extra.example.com'] }] },
    { ...ws.config, dataDir: './moved-data' },
  ]) {
    const response = await request(app, '/api/config', { ...session, body: { config, version: session.state.configVersion } });
    assert.equal(response.status, 400);
    assert.match(response.json().error, /管理 HTTPS/);
    assert.equal(await fs.readFile(ws.configPath, 'utf8'), original);
  }
});
