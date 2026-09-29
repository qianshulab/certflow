import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { localPaths, savedEnvironment } from '../src/local-state.mjs';

async function setup(t) {
  const parent = path.resolve(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(parent, 'certflow-persist-'));
  const configPath = path.join(dir, 'config.json');
  const config = { email: 'test@example.com', acceptTerms: true, environment: 'staging', jobs: [{ id: 'site', domains: ['example.com'], challenge: { type: 'dns', provider: 'tencentcloud' } }] };
  await fs.writeFile(configPath, JSON.stringify(config));
  const apps = [];
  t.after(async () => { for (const app of apps) await app.close(); assert.equal(path.dirname(dir), parent); assert.match(path.basename(dir), /^certflow-persist-/); await fs.rm(dir, { recursive: true, force: true }); });
  async function start(options = {}) {
    const app = await createApp({ configPath, run: async () => [{ id: 'site', ok: true, action: 'unchanged' }], ...options });
    apps.push(app);
    app.state = async () => (await fetch(`${app.url}/api/state`)).json();
    const { csrfToken } = await app.state();
    app.post = (route, body) => fetch(`${app.url}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Origin: app.url }, body: JSON.stringify(body) });
    return app;
  }
  return { dir, configPath, start };
}

test('saved credentials survive restart encrypted, feed CLI, and clear durably', async (t) => {
  const { dir, configPath, start } = await setup(t);
  const marker = 'fake-private-token-persist-1137';
  const first = await start();
  const saved = await first.post('credentials', { provider: 'dnspod-token', values: { DNSPOD_API_ID: '12', DNSPOD_API_TOKEN: marker } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).credentials['dnspod-token'].source, 'saved');
  await first.close();
  // Inspect a quiescent directory. Starting the next app queues a new atomic
  // history write whose temporary filename may disappear between readdir/read.
  for (const filename of await fs.readdir(path.join(dir, '.certflow'))) {
    assert.equal((await fs.readFile(path.join(dir, '.certflow', filename))).includes(Buffer.from(marker)), false);
  }
  const second = await start();
  const state = await second.state();
  assert.equal(state.credentials['dnspod-token'].configured, true);
  assert.equal(state.credentials['dnspod-token'].source, 'saved');
  assert.equal(JSON.stringify(state).includes(marker), false);
  assert.equal((await savedEnvironment(configPath, {})).DNSPOD_API_TOKEN, marker);
  assert.equal((await second.post('credentials/clear', { provider: 'dnspod-token' })).status, 200);
  await second.close();
  const third = await start();
  assert.equal((await third.state()).credentials['dnspod-token'].configured, false);
  assert.equal((await savedEnvironment(configPath, {})).DNSPOD_API_TOKEN, undefined);
});

test('automatic renewal setting and activity history survive service restarts', async (t) => {
  const { start } = await setup(t);
  let runs = 0;
  const run = async () => { runs++; return [{ id: 'site', ok: true, action: 'unchanged' }]; };
  const first = await start({ run });
  assert.equal((await first.post('scheduler', { enabled: true })).status, 200);
  await first.close();
  const second = await start({ run });
  assert.equal((await second.state()).scheduler.enabled, true);
  assert.equal(runs, 2);
  assert.ok((await second.state()).logs.some((entry) => entry.message.includes('已恢复')));
  assert.equal((await second.post('scheduler', { enabled: false })).status, 200);
  await second.close();
  const third = await start({ run });
  assert.equal((await third.state()).scheduler.enabled, false);
  assert.equal(runs, 2);
});

test('unreadable vault is reported and never overwritten by saving or clearing credentials', async (t) => {
  const { start } = await setup(t);
  let saves = 0;
  const app = await start({ credentialStore: { metadata: { protection: 'test', label: 'test' }, load: async () => { throw new Error('corrupt'); }, save: async () => { saves++; } } });
  assert.ok((await app.state()).credentialStorage.error);
  assert.equal((await app.post('credentials', { provider: 'dnspod-token', values: { DNSPOD_API_ID: '12', DNSPOD_API_TOKEN: 'fake-token-12345' } })).status, 409);
  assert.equal((await app.post('credentials/clear', { provider: 'dnspod-token' })).status, 409);
  assert.equal(saves, 0);
});

test('closing during an in-flight credential save waits for its final history write', async (t) => {
  const { configPath, start } = await setup(t);
  let startSave, finishSave, startHistory, finishHistory;
  const saveStarted = new Promise(resolve => { startSave = resolve; });
  const saveGate = new Promise(resolve => { finishSave = resolve; });
  const historyStarted = new Promise(resolve => { startHistory = resolve; });
  const historyGate = new Promise(resolve => { finishHistory = resolve; });
  const app = await start({ credentialStore: {
    metadata: { protection: 'test', label: 'test' }, load: async () => ({}),
    save: async () => { startSave(); await saveGate; },
  } });
  const history = localPaths(configPath).history;
  const deadline = Date.now() + 3000;
  for (;;) {
    try { assert.ok(JSON.parse(await fs.readFile(history, 'utf8')).some(entry => entry.message.includes('图形界面已启动'))); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target === history) { startHistory(); await historyGate; }
    return rename(source, target);
  });
  let closing, closed = false;
  try {
    const { csrfToken } = await app.state();
    const saving = fetch(`${app.url}/api/credentials`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Origin: app.url, Connection: 'close',
    }, body: JSON.stringify({ provider: 'dnspod-token', values: { DNSPOD_API_ID: '12', DNSPOD_API_TOKEN: 'fake-inflight-save-token' } }) });
    await saveStarted;
    const serverClosed = new Promise(resolve => app.server.once('close', resolve));
    closing = app.close().then(() => { closed = true; });
    finishSave();
    const response = await saving;
    assert.equal(response.status, 200);
    await response.json();
    await historyStarted;
    await serverClosed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'shutdown must wait for the history write queued by the already-admitted request');
    finishHistory();
    await closing;
    assert.ok(JSON.parse(await fs.readFile(history, 'utf8')).some(entry => entry.message.includes('DNS 凭据已加密保存')));
  } finally {
    finishSave(); finishHistory();
    if (closing) await closing;
  }
});
