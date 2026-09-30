import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { jobPaths, loadConfig, runOnce } from '../src/core.mjs';
import { exportCertificate } from '../src/export.mjs';

const rawConfig = () => ({
  email: 'operator@example.com',
  acceptTerms: true,
  environment: 'staging',
  legoPath: 'not-a-real-acme-client',
  dataDir: './data',
  jobs: [{
    id: 'site', domains: ['example.com', '*.example.com'],
    challenge: { type: 'dns', provider: 'tencentcloud' }, deployment: null,
  }],
});

async function workspace(t, options = {}) {
  const parent = path.resolve(os.tmpdir());
  const directory = path.resolve(await fs.mkdtemp(path.join(parent, 'https-cert-server-')));
  assert.equal(path.dirname(directory), parent);
  assert.ok(path.basename(directory).startsWith('https-cert-server-'));
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(rawConfig(), null, 2));
  let app;
  t.after(async () => {
    if (app) await app.close();
    // The removal target is the verified, freshly-created test directory only.
    assert.equal(path.dirname(directory), parent);
    await fs.rm(directory, { recursive: true, force: true });
  });
  app = await createApp({
    configPath, port: 0,
    run: async () => assert.fail('test must never invoke an ACME client'),
    ...options,
  });
  const state = await (await fetch(`${app.url}/api/state`)).json();
  async function post(route, body = {}, headers = {}) {
    return fetch(`${app.url}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': state.csrfToken,
        Origin: app.url,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }
  return { ...app, directory, configPath, state, post };
}

function rawRequest(url, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const address = new URL(url);
    const request = http.request({
      hostname: '127.0.0.1', port: address.port, path: requestPath,
      headers: { Host: address.host, ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString(),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test('GUI state provides a CSRF token and a file version without issuing a certificate', async (t) => {
  const app = await workspace(t);
  assert.equal(new URL(app.url).hostname, '127.0.0.1');
  assert.ok(Number(new URL(app.url).port) > 0);
  assert.equal(typeof app.state.csrfToken, 'string');
  assert.ok(app.state.csrfToken.length >= 32);
  assert.match(app.state.configVersion, /^[a-f0-9]{64}$/);
  assert.equal(app.state.config.email, 'operator@example.com');
  assert.equal(app.state.runtime.running, false);
  assert.equal(app.state.runtime.currentPhase, null);
  assert.deepEqual(app.state.runtime.phaseHistory, []);
  assert.equal(app.state.scheduler.enabled, false);
  const response = await fetch(`${app.url}/api/state`);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  await assert.rejects(fs.stat(path.join(app.directory, 'data')), { code: 'ENOENT' });
});

test('Host and Origin checks reject DNS rebinding and cross-site reads', async (t) => {
  const app = await workspace(t);
  const port = new URL(app.url).port;
  for (const host of ['attacker.example', `localhost:${port}`, `127.0.0.1:${Number(port) + 1}`, `127.0.0.1:${port}.attacker.example`]) {
    const response = await rawRequest(app.url, '/api/state', { Host: host });
    assert.equal(response.status, 403, `must reject Host ${host}`);
    assert.equal(response.text.includes(app.state.csrfToken), false);
  }
  for (const origin of ['https://attacker.example', 'null', `http://127.0.0.1:${Number(port) + 1}`]) {
    const response = await fetch(`${app.url}/api/state`, { headers: { Origin: origin } });
    assert.equal(response.status, 403, `must reject Origin ${origin}`);
    assert.equal((await response.text()).includes(app.state.csrfToken), false);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const crossSite = await rawRequest(app.url, '/api/state', { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.text.includes(app.state.csrfToken), false);
});

test('state-changing requests require CSRF and JSON while local clients may omit Origin', async (t) => {
  const app = await workspace(t);
  const payload = { config: { ...rawConfig(), email: 'changed@example.com' }, version: app.state.configVersion };
  for (const headers of [
    { 'X-CSRF-Token': '' },
    { 'X-CSRF-Token': 'wrong-token' },
    { 'X-CSRF-Token': 'é'.repeat(app.state.csrfToken.length) },
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
  ]) {
    assert.equal((await app.post('/api/config', payload, headers)).status, 403);
  }
  const nonJson = await app.post('/api/config', payload, { 'Content-Type': 'text/plain' });
  assert.ok([400, 415].includes(nonJson.status));
  assert.equal(JSON.parse(await fs.readFile(app.configPath, 'utf8')).email, 'operator@example.com');
  const local = await fetch(`${app.url}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': app.state.csrfToken },
    body: JSON.stringify(payload),
  });
  assert.equal(local.status, 200);
  assert.equal(JSON.parse(await fs.readFile(app.configPath, 'utf8')).email, 'changed@example.com');
});

test('malformed JSON and invalid operation selectors do not start a runner', async (t) => {
  const app = await workspace(t);
  const malformed = await fetch(`${app.url}/api/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': app.state.csrfToken },
    body: '{broken JSON',
  });
  assert.equal(malformed.status, 400);
  for (const body of [null, [], { only: 'not-configured' }, { only: ['site'] }, { retry: 'true' }]) {
    assert.equal((await app.post('/api/run', body)).status, 400);
  }
  assert.equal((await app.post('/api/scheduler', { enabled: 'true' })).status, 400);
  const state = await (await fetch(`${app.url}/api/state`)).json();
  assert.equal(state.runtime.running, false);
  assert.equal(state.scheduler.enabled, false);
});

test('unknown URLs and traversal requests cannot read workspace configuration or private files', async (t) => {
  const app = await workspace(t);
  const marker = 'local-private-file-marker-DO-NOT-SERVE';
  await fs.writeFile(path.join(app.directory, 'private.txt'), marker);
  for (const requestPath of [
    '/config.json', '/server.mjs', '/private.txt', '/api/unknown',
    '/../private.txt', '/%2e%2e/private.txt', '/%2e%2e%5cprivate.txt',
    '/brand.svg/../server.mjs', '/brand.svg%2f..%2fserver.mjs', '/brand.svg/../../config.json',
    '/api/export?id=site&kind=privateKey',
  ]) {
    const response = await rawRequest(app.url, requestPath);
    assert.ok(response.status >= 400, `must reject ${requestPath}`);
    assert.equal(response.text.includes(marker), false);
    assert.equal(response.text.includes('operator@example.com'), false);
  }
});

test('config saves use optimistic versions and preserve the current file on conflicts or invalid input', async (t) => {
  const app = await workspace(t);
  const next = { ...rawConfig(), email: 'new@example.com' };
  assert.equal((await app.post('/api/config', { config: next, version: app.state.configVersion })).status, 200);
  const saved = await fs.readFile(app.configPath, 'utf8');
  const fresh = await (await fetch(`${app.url}/api/state`)).json();
  assert.notEqual(fresh.configVersion, app.state.configVersion);
  assert.equal(fresh.config.email, 'new@example.com');
  const stale = await app.post('/api/config', { config: rawConfig(), version: app.state.configVersion });
  assert.equal(stale.status, 409);
  assert.equal(await fs.readFile(app.configPath, 'utf8'), saved);
  const invalid = await app.post('/api/config', {
    config: { ...next, jobs: [{ ...next.jobs[0], domains: ['https://not-a-domain.example'] }] },
    version: fresh.configVersion,
  });
  assert.equal(invalid.status, 400);
  assert.equal(await fs.readFile(app.configPath, 'utf8'), saved);
});

test('100 jobs with 100 domains save beyond 128 KiB while oversized requests preserve config and drain before shutdown', async (t) => {
  const app = await workspace(t);
  const config = rawConfig();
  config.jobs = Array.from({ length: 100 }, (_, index) => ({
    ...rawConfig().jobs[0], id: `site-${index}`, enabled: index % 3 !== 0,
    domains: Array.from({ length: 100 }, (_, domain) => `domain-${domain}.site-${index}.example.com`),
  }));
  const payload = { config, version: app.state.configVersion };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 128 * 1024);
  const savedResponse = await app.post('/api/config', payload);
  assert.equal(savedResponse.status, 200);
  const state = await savedResponse.json();
  assert.equal(state.statuses.length, 100);
  assert.deepEqual(state.config.jobs.map(job => job.domains), config.jobs.map(job => job.domains));
  assert.deepEqual((await loadConfig(app.configPath)).jobs.map(job => job.enabled), config.jobs.map(job => job.enabled));
  const saved = await fs.readFile(app.configPath, 'utf8');
  for (const [route, limitBytes] of [['/api/config', 2 * 1024 * 1024], ['/api/plan', 128 * 1024]]) {
    const response = await app.post(route, { config, version: state.configVersion, padding: 'x'.repeat(limitBytes) });
    assert.equal(response.status, 413);
    const error = await response.json();
    assert.equal(error.code, 'REQUEST_BODY_TOO_LARGE');
    assert.equal(error.limitBytes, limitBytes);
    assert.match(error.error, /上限/);
    assert.equal(await fs.readFile(app.configPath, 'utf8'), saved);
  }
  const after = await (await fetch(`${app.url}/api/state`)).json();
  assert.equal(after.configVersion, state.configVersion);
  assert.equal(after.config.jobs.length, 100);
  let strandedConnection = false;
  const guard = setTimeout(() => { strandedConnection = true; app.server.closeAllConnections(); }, 3000);
  try { await app.close(); } finally { clearTimeout(guard); }
  assert.equal(strandedConnection, false, 'oversized uploads must not strand a socket and block clean shutdown');
});

test('an invalid config remains recoverable from the GUI without silently overwriting it', async (t) => {
  const app = await workspace(t);
  await fs.writeFile(app.configPath, '{ invalid JSON');
  const response = await fetch(`${app.url}/api/state`);
  assert.equal(response.status, 200);
  const broken = await response.json();
  assert.equal(broken.config, null);
  assert.equal(typeof broken.configError, 'string');
  assert.match(broken.configVersion, /^[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(app.configPath, 'utf8'), '{ invalid JSON');
  const repair = await app.post('/api/config', { config: rawConfig(), version: broken.configVersion });
  assert.equal(repair.status, 200);
  assert.equal(JSON.parse(await fs.readFile(app.configPath, 'utf8')).email, 'operator@example.com');
});

test('only one asynchronous run is admitted and running jobs prevent config and credentials edits', async (t) => {
  const entered = deferred(), release = deferred();
  let calls = 0, options;
  const app = await workspace(t, { run: async (_config, opts) => {
    calls += 1;
    options = opts;
    entered.resolve();
    await release.promise;
    return [{ id: 'site', ok: true, action: 'unchanged' }];
  } });
  try {
    const response = await app.post('/api/run', { only: 'site', retry: true });
    assert.equal(response.status, 202);
    assert.ok((await response.json()).runId);
    await entered.promise;
    assert.equal(options.only, 'site');
    assert.equal(options.ignoreBackoff, true);
    assert.equal((await app.post('/api/run')).status, 409);
    assert.equal((await app.post('/api/config', { config: rawConfig(), version: app.state.configVersion })).status, 409);
    assert.equal((await app.post('/api/credentials', {
      provider: 'tencentcloud', values: { TENCENTCLOUD_SECRET_ID: 'fake-id', TENCENTCLOUD_SECRET_KEY: 'fake-key' },
    })).status, 409);
    assert.equal(calls, 1);
    assert.equal((await (await fetch(`${app.url}/api/state`)).json()).runtime.running, true);
  } finally { release.resolve(); }
  await until(async () => !(await (await fetch(`${app.url}/api/state`)).json()).runtime.running,
    'the GUI must clear the running flag after completion');
  const finished = (await (await fetch(`${app.url}/api/state`)).json()).runtime;
  assert.equal(finished.currentJob, null);
  assert.equal(finished.completedCount, 1, 'a runner without progress events still reports its final completion');
  assert.equal(finished.totalJobs, 1);
});

test('the real serial runner exposes current and completed jobs immediately and logs each result once', async (t) => {
  const entered = deferred(), release = deferred();
  const certificate = await fs.readFile(new URL('./fixtures/single-domain-cert.test.txt', import.meta.url));
  const privateKey = await fs.readFile(new URL('./fixtures/server-key.test.txt', import.meta.url));
  const app = await workspace(t, { run: (config, options) => runOnce(config, { ...options, executor: async (_executable, args) => {
    if (args.includes('--version')) return { code: 0, stdout: 'lego version 5.5.2', stderr: '' };
    if (args.includes('--help')) return { code: 0, stdout: '--cert.name --renew-force', stderr: '' };
    const job = config.jobs.find(item => item.id === args[args.indexOf('--cert.name') + 1]);
    assert.notEqual(job.id, 'paused');
    if (job.id === 'second') { entered.resolve(); await release.promise; return { code: 1, stdout: '', stderr: '' }; }
    const files = jobPaths(config, job);
    await fs.mkdir(path.dirname(files.certificate), { recursive: true });
    await fs.writeFile(files.certificate, certificate);
    await fs.writeFile(files.privateKey, privateKey);
    return { code: 0, stdout: '', stderr: '' };
  } }) });
  const config = rawConfig();
  config.jobs = ['first', 'paused', 'second'].map(id => ({ id, enabled: id !== 'paused', domains: ['example.com'], challenge: { type: 'http', webroot: '.' } }));
  const saved = await app.post('/api/config', { config, version: app.state.configVersion });
  assert.equal(saved.status, 200); await saved.json();
  try {
    const response = await app.post('/api/run');
    assert.equal(response.status, 202); await response.json();
    await entered.promise;
    const partial = await (await fetch(`${app.url}/api/state`)).json();
    assert.equal(partial.runtime.running, true);
    assert.equal(partial.runtime.currentJob, 'second');
    assert.equal(partial.runtime.currentPhase, 'acme');
    assert.ok(Date.parse(partial.runtime.phaseStartedAt) > 0);
    assert.deepEqual(partial.runtime.phaseHistory[0].phase, 'acme');
    assert.equal(partial.runtime.phaseHistory[0].jobId, 'second');
    assert.equal(partial.runtime.completedCount, 1);
    assert.equal(partial.runtime.totalJobs, 2);
    assert.deepEqual(partial.runtime.results.map(result => [result.id, result.ok]), [['first', true]]);
    assert.equal(partial.logs.filter(entry => entry.message.startsWith('first：')).length, 1);
    assert.equal((await app.post('/api/run')).status, 409);
  } finally { release.resolve(); }
  await until(async () => !(await (await fetch(`${app.url}/api/state`)).json()).runtime.running, 'batch must finish');
  const finished = await (await fetch(`${app.url}/api/state`)).json();
  assert.equal(finished.runtime.currentJob, null);
  assert.equal(finished.runtime.currentPhase, null);
  assert.equal(finished.runtime.phaseStartedAt, null);
  assert.ok(finished.runtime.phaseHistory.length > 0);
  assert.equal(finished.runtime.completedCount, 2);
  assert.equal(finished.runtime.totalJobs, 2);
  assert.deepEqual(finished.runtime.results.map(result => [result.id, result.ok]), [['first', true], ['second', false]]);
  assert.equal(finished.logs.filter(entry => entry.message.startsWith('first：')).length, 1);
  assert.equal(finished.logs.filter(entry => entry.message.startsWith('second：')).length, 1);
});

test('phase progress is bounded, allowlisted and cleared after a failed job without exposing runner output', async (t) => {
  const entered = deferred(), release = deferred();
  const marker = 'private-acme-output-marker';
  const app = await workspace(t, { run: async (_config, options) => {
    options.onProgress({ type: 'job-start', id: 'site' });
    options.onProgress({ type: 'job-phase', id: 'site', phase: marker });
    for (let index = 0; index < 25; index++) {
      options.onProgress({ type: 'job-phase', id: 'site', phase: index % 2 ? 'credentials' : 'preparing' });
    }
    options.onProgress({ type: 'job-phase', id: 'site', phase: 'acme', rawOutput: marker });
    entered.resolve();
    await release.promise;
    const result = { id: 'site', ok: false, action: 'failed', error: '模拟签发失败' };
    options.onProgress({ type: 'job-complete', id: 'site', result });
    return [result];
  } });
  try {
    assert.equal((await app.post('/api/run', { only: 'site' })).status, 202);
    await entered.promise;
    const response = await fetch(`${app.url}/api/state`);
    const text = await response.text();
    assert.equal(text.includes(marker), false, 'private runner output must never enter public state');
    const { runtime } = JSON.parse(text);
    assert.equal(runtime.currentJob, 'site');
    assert.equal(runtime.currentPhase, 'acme');
    assert.ok(Date.parse(runtime.phaseStartedAt) > 0);
    assert.equal(runtime.phaseHistory.length, 20);
    assert.equal(runtime.phaseHistory[0].phase, 'acme');
    assert.equal(runtime.phaseHistory[0].jobId, 'site');
    assert.ok(runtime.phaseHistory.every(event => /^[0-9a-f-]{36}$/.test(event.id) && Date.parse(event.at) > 0));
  } finally { release.resolve(); }
  await until(async () => !(await (await fetch(`${app.url}/api/state`)).json()).runtime.running, 'failed phase run must finish');
  const { runtime } = await (await fetch(`${app.url}/api/state`)).json();
  assert.equal(runtime.currentJob, null);
  assert.equal(runtime.currentPhase, null);
  assert.equal(runtime.phaseStartedAt, null);
  assert.equal(runtime.results[0].action, 'failed');
  assert.equal(runtime.phaseHistory[0].phase, 'acme', 'bounded phase history remains available for diagnosis');
});

test('optional session credentials reach run through env and never appear in public state or config', async (t) => {
  const secretId = 'temporary-id-marker-62da58';
  const secretKey = 'temporary-key-marker-97fea6';
  const inheritedId = process.env.TENCENTCLOUD_SECRET_ID;
  const inheritedKey = process.env.TENCENTCLOUD_SECRET_KEY;
  const seen = [];
  const app = await workspace(t, { run: async (_config, options) => {
    seen.push(options.env);
    options.onProgress({ type: 'job-start', id: 'site', index: 1, total: 1 });
    // Raw runner errors must be redacted before they become UI logs.
    throw new Error(`runner failed with ${secretId} and ${secretKey}`);
  } });
  const credentials = await app.post('/api/credentials', {
    persist: false,
    provider: 'tencentcloud', values: { TENCENTCLOUD_SECRET_ID: secretId, TENCENTCLOUD_SECRET_KEY: secretKey },
  });
  assert.equal(credentials.status, 200);
  const savedResponse = await credentials.text();
  assert.equal(savedResponse.includes(secretId), false);
  assert.equal(savedResponse.includes(secretKey), false);
  assert.equal((await app.post('/api/run')).status, 202);
  await until(async () => seen.length === 1 && !(await (await fetch(`${app.url}/api/state`)).json()).runtime.running,
    'failed runner must finish without leaking session credentials');
  const failed = (await (await fetch(`${app.url}/api/state`)).json()).runtime;
  assert.equal(failed.currentJob, null, 'a rejected runner must clear its last active job');
  assert.equal(failed.completedCount, 0);
  assert.equal(failed.totalJobs, 1);
  assert.match(failed.error, /runner failed/);
  assert.equal(seen[0].TENCENTCLOUD_SECRET_ID, secretId);
  assert.equal(seen[0].TENCENTCLOUD_SECRET_KEY, secretKey);
  assert.equal(process.env.TENCENTCLOUD_SECRET_ID, inheritedId);
  assert.equal(process.env.TENCENTCLOUD_SECRET_KEY, inheritedKey);
  for (const content of [await fs.readFile(app.configPath, 'utf8'), await (await fetch(`${app.url}/api/state`)).text()]) {
    assert.equal(content.includes(secretId), false);
    assert.equal(content.includes(secretKey), false);
  }
  assert.deepEqual((await fs.readdir(app.directory)).sort(), ['.certflow', 'config.json']);
  assert.equal((await app.post('/api/credentials/clear', { provider: 'tencentcloud' })).status, 200);
  assert.equal((await app.post('/api/run')).status, 202);
  await until(async () => seen.length === 2 && !(await (await fetch(`${app.url}/api/state`)).json()).runtime.running,
    'run after clearing credentials must complete');
  assert.equal(seen[1].TENCENTCLOUD_SECRET_ID, inheritedId);
  assert.equal(seen[1].TENCENTCLOUD_SECRET_KEY, inheritedKey);
  const finalState = await (await fetch(`${app.url}/api/state`)).text();
  assert.equal(finalState.includes(secretId), false, 'previously-used values must stay redacted after clearing');
  assert.equal(finalState.includes(secretKey), false);
});

test('credential API rejects arbitrary environment injection and incomplete credential pairs', async (t) => {
  const app = await workspace(t);
  for (const payload of [
    { provider: 'tencentcloud', values: { TENCENTCLOUD_SECRET_ID: 'id' } },
    { provider: 'tencentcloud', values: { TENCENTCLOUD_SECRET_ID: 'id', TENCENTCLOUD_SECRET_KEY: 'key', NODE_OPTIONS: '--require evil' } },
    { provider: 'tencentcloud', values: { TENCENTCLOUD_SECRET_ID_FILE: '/private/file', TENCENTCLOUD_SECRET_KEY_FILE: '/private/file' } },
    { provider: 'unknown', values: {} },
  ]) {
    assert.equal((await app.post('/api/credentials', payload)).status, 400);
  }
  assert.deepEqual((await fs.readdir(app.directory)).sort(), ['.certflow', 'config.json']);
});

test('short credentials are rejected without corrupting CSRF tokens or configuration versions', async (t) => {
  const app = await workspace(t);
  for (const values of [
    { TENCENTCLOUD_SECRET_ID: 'a', TENCENTCLOUD_SECRET_KEY: 'b' },
    { TENCENTCLOUD_SECRET_ID: app.state.csrfToken.slice(0, 8), TENCENTCLOUD_SECRET_KEY: 'short' },
    { TENCENTCLOUD_SECRET_ID: app.state.configVersion.slice(0, 8), TENCENTCLOUD_SECRET_KEY: 'short' },
  ]) {
    assert.equal((await app.post('/api/credentials', { provider: 'tencentcloud', values })).status, 400);
    const fresh = await (await fetch(`${app.url}/api/state`)).json();
    assert.equal(fresh.csrfToken, app.state.csrfToken);
    assert.equal(fresh.configVersion, app.state.configVersion);
  }
  const saved = await app.post('/api/config', { config: rawConfig(), version: app.state.configVersion });
  assert.equal(saved.status, 200, 'rejected credentials must not lock the user out of the GUI');
  assert.equal((await saved.json()).csrfToken, app.state.csrfToken);
});

test('stopping the scheduler leaves an already-running issuance intact', async (t) => {
  const entered = deferred(), release = deferred();
  let completed = false;
  const app = await workspace(t, { run: async () => {
    entered.resolve();
    await release.promise;
    completed = true;
    return [{ id: 'site', ok: true, action: 'unchanged' }];
  } });
  try {
    assert.equal((await app.post('/api/run')).status, 202);
    await entered.promise;
    assert.equal((await app.post('/api/scheduler', { enabled: false })).status, 200);
    const running = await (await fetch(`${app.url}/api/state`)).json();
    assert.equal(running.scheduler.enabled, false);
    assert.equal(running.runtime.running, true);
    assert.equal(completed, false);
  } finally { release.resolve(); }
  await until(async () => !(await (await fetch(`${app.url}/api/state`)).json()).runtime.running,
    'in-flight run must still finish after stopping the scheduler');
  assert.equal(completed, true);
});

test('an enabled scheduler permits edits while idle and preserves its enabled state', async (t) => {
  const app = await workspace(t, { run: async () => [{ id: 'site', ok: true, action: 'unchanged' }] });
  assert.equal((await app.post('/api/scheduler', { enabled: true })).status, 200);
  await until(async () => !(await (await fetch(`${app.url}/api/state`)).json()).runtime.running,
    'the initial scheduler run must complete');
  assert.equal((await (await fetch(`${app.url}/api/state`)).json()).scheduler.enabled, true);
  assert.equal((await app.post('/api/config', { config: rawConfig(), version: app.state.configVersion })).status, 200);
  assert.equal((await app.post('/api/credentials', {
    provider: 'tencentcloud', persist: false, values: { TENCENTCLOUD_SECRET_ID: 'fake-identifier', TENCENTCLOUD_SECRET_KEY: 'fake-test-key' },
  })).status, 200);
  assert.equal((await (await fetch(`${app.url}/api/state`)).json()).scheduler.enabled, true);
  assert.equal((await app.post('/api/scheduler', { enabled: false })).status, 200);
});

test('certificate download accepts only configured jobs and fixed export kinds', async (t) => {
  const app = await workspace(t);
  const config = await loadConfig(app.configPath);
  const files = jobPaths(config, config.jobs[0]);
  const certificate = await fs.readFile(new URL('./fixtures/server-cert.test.txt', import.meta.url));
  const privateKey = await fs.readFile(new URL('./fixtures/server-key.test.txt', import.meta.url));
  await fs.mkdir(path.dirname(files.certificate), { recursive: true });
  await fs.writeFile(files.certificate, certificate);
  await fs.writeFile(files.privateKey, privateKey);
  const exportFiles = await exportCertificate({ directory: files.exports, certificate, privateKey });
  await fs.writeFile(files.state, JSON.stringify({ exportFiles }));
  for (const kind of ['certificate', 'chain', 'fullchain', 'privateKey']) {
    const response = await app.post('/api/export', { id: 'site', kind });
    assert.equal(response.status, 200, `must export ${kind}`);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(exportFiles[kind]));
  }
  for (const [kind, original, filename] of [['certificateCrt', 'certificate', 'cert.crt'], ['privateKeyKey', 'privateKey', 'privkey.key']]) {
    const response = await app.post('/api/export', { id: 'site', kind });
    assert.equal(response.status, 200, `must export ${kind}`);
    assert.match(response.headers.get('content-disposition'), new RegExp(filename.replace('.', '\\.')));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(exportFiles[original]));
  }
  const bundle = await app.post('/api/export', { id: 'site', kind: 'bundle' });
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get('content-type'), 'application/zip');
  assert.match(bundle.headers.get('content-disposition'), /site-certificates\.zip/);
  const zipBytes = Buffer.from(await bundle.arrayBuffer());
  assert.equal(zipBytes.readUInt32LE(0), 0x04034b50);
  for (const file of ['cert.pem', 'chain.pem', 'fullchain.pem', 'privkey.pem']) assert.ok(zipBytes.includes(Buffer.from(file)));
  for (const payload of [
    { id: '../config.json', kind: 'privateKey' },
    { id: 'missing', kind: 'privateKey' },
    { id: 'site', kind: '../../config.json' },
    { id: 'site', kind: 'directory' },
    { id: 'site', kind: 'toString' },
  ]) {
    const response = await app.post('/api/export', payload);
    assert.ok(response.status >= 400);
    assert.equal((await response.text()).includes('operator@example.com'), false);
  }
  const marker = 'arbitrary-local-file-72a5c7';
  const outside = path.join(app.directory, 'outside.txt');
  await fs.writeFile(outside, marker);
  await fs.writeFile(files.state, JSON.stringify({ exportFiles: { ...exportFiles, privateKey: outside } }));
  const response = await app.post('/api/export', { id: 'site', kind: 'privateKey' });
  assert.equal((await response.text()).includes(marker), false, 'state paths may never authorize arbitrary local file reads');

  // Even a linked directory containing a byte-identical certificate must not bypass the export boundary.
  const redirected = path.join(app.directory, 'redirected-certificate-bundle');
  await fs.rename(exportFiles.directory, redirected);
  await fs.symlink(redirected, exportFiles.directory, process.platform === 'win32' ? 'junction' : 'dir');
  const redirectedResponse = await app.post('/api/export', { id: 'site', kind: 'privateKey' });
  assert.equal(redirectedResponse.status, 403);
  assert.equal((await redirectedResponse.text()).includes('BEGIN PRIVATE KEY'), false);
});

test('fullchain and ZIP downloads follow the renewed certificate instead of stale export state', async (t) => {
  const app = await workspace(t);
  const config = await loadConfig(app.configPath);
  const files = jobPaths(config, config.jobs[0]);
  const original = await fs.readFile(new URL('./fixtures/server-cert.test.txt', import.meta.url));
  const renewed = await fs.readFile(new URL('./fixtures/tls-renewed-cert.test.txt', import.meta.url));
  const privateKey = await fs.readFile(new URL('./fixtures/server-key.test.txt', import.meta.url));
  await fs.mkdir(path.dirname(files.certificate), { recursive: true });
  await fs.writeFile(files.certificate, original);
  await fs.writeFile(files.privateKey, privateKey);
  const oldExport = await exportCertificate({ directory: files.exports, certificate: original, privateKey });
  await fs.writeFile(files.state, JSON.stringify({ exportFiles: oldExport }));

  await fs.writeFile(files.certificate, renewed);
  const newExport = await exportCertificate({ directory: files.exports, certificate: renewed, privateKey });
  assert.notEqual(newExport.directory, oldExport.directory);
  const currentFullchain = await fs.readFile(newExport.fullchain);

  const response = await app.post('/api/export', { id: 'site', kind: 'fullchain' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /site-fullchain\.pem/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), currentFullchain);

  const bundle = await app.post('/api/export', { id: 'site', kind: 'bundle' });
  assert.equal(bundle.status, 200);
  const zipBytes = Buffer.from(await bundle.arrayBuffer());
  assert.ok(zipBytes.includes(Buffer.from('fullchain.pem')));
  assert.ok(zipBytes.includes(currentFullchain), 'the ZIP must contain the renewed fullchain bytes');
  assert.equal(zipBytes.includes(await fs.readFile(oldExport.fullchain)), false, 'the ZIP must not contain the prior certificate');
});

test('preflight is read-only, rejects unknown jobs and does not expose credentials', async (t) => {
  const marker = 'preflight-only-fake-token-marker';
  let seen;
  const app = await workspace(t, { inspect: async (_config, options) => {
    seen = options;
    return { ok: true, checkedAt: new Date().toISOString(), checks: [{ id: 'fake', label: 'mock', status: 'pass', detail: `probe ${options.env.DNSPOD_API_TOKEN}` }] };
  } });
  assert.equal((await app.post('/api/credentials', { provider: 'dnspod-token', persist: false, values: { DNSPOD_API_ID: '12', DNSPOD_API_TOKEN: marker } })).status, 200);
  const before = await fs.readFile(app.configPath, 'utf8');
  const invalid = await app.post('/api/preflight', { only: 'missing' });
  assert.equal(invalid.status, 400);
  assert.equal(seen, undefined);
  const checked = await app.post('/api/preflight', { only: 'site' });
  assert.equal(checked.status, 200);
  assert.equal(seen.only, 'site');
  assert.equal(seen.env.DNSPOD_API_TOKEN, marker);
  assert.equal((await checked.text()).includes(marker), false);
  assert.equal(await fs.readFile(app.configPath, 'utf8'), before);
  await assert.rejects(fs.stat(path.join(app.directory, 'data')), { code: 'ENOENT' });
});

test('task pause persists through config save without removing the task', async (t) => {
  const app = await workspace(t);
  const config = structuredClone(app.state.config);
  config.jobs[0].enabled = false;
  const result = await app.post('/api/config', { config, version: app.state.configVersion });
  assert.equal(result.status, 200);
  const state = await result.json();
  assert.equal(state.config.jobs.length, 1);
  assert.equal(state.config.jobs[0].enabled, false);
  assert.equal(state.statuses[0].enabled, false);
  assert.equal((await loadConfig(app.configPath)).jobs[0].enabled, false);
});
