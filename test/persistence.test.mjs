import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { savedEnvironment } from '../src/local-state.mjs';

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
  const second = await start();
  const state = await second.state();
  assert.equal(state.credentials['dnspod-token'].configured, true);
  assert.equal(state.credentials['dnspod-token'].source, 'saved');
  assert.equal(JSON.stringify(state).includes(marker), false);
  for (const filename of await fs.readdir(path.join(dir, '.certflow'))) {
    assert.equal((await fs.readFile(path.join(dir, '.certflow', filename))).includes(Buffer.from(marker)), false);
  }
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
