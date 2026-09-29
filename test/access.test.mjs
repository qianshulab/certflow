import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAccess } from '../src/access.mjs';
import { createApp } from '../server.mjs';

const fakePassword = 'qa-only-management-password-1849';
test('network binding requires explicit origin and a strong management password', () => {
  assert.throws(() => createAccess({ host: '0.0.0.0' }), /PUBLIC_URL/);
  assert.throws(() => createAccess({ host: '0.0.0.0', publicUrl: 'http://nas.test:3390', adminPassword: 'short' }), /12/);
  for (const publicUrl of ['ftp://nas.test', 'https://user:password@nas.test', 'https://nas.test/subpath', 'https://nas.test/?token=secret']) assert.throws(() => createAccess({ host: '0.0.0.0', publicUrl, adminPassword: fakePassword }));
});

test('login sessions are opaque, expire on logout, and rate-limit wrong passwords', () => {
  const access = createAccess({ host: '0.0.0.0', publicUrl: 'https://nas.test', adminPassword: fakePassword });
  const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(access.authorized(request), false);
  for (let i = 0; i < 8; i++) assert.equal(access.login(request, 'incorrect-password-123').status, 401);
  assert.equal(access.login(request, fakePassword).status, 429);
  const fresh = { headers: {}, socket: { remoteAddress: '127.0.0.2' } };
  const success = access.login(fresh, fakePassword);
  assert.equal(success.status, 200);
  assert.match(success.cookie, /HttpOnly; SameSite=Strict/);
  assert.match(success.cookie, /; Secure$/);
  assert.equal(success.cookie.includes(fakePassword), false);
  fresh.headers.cookie = success.cookie.split(';')[0];
  assert.equal(access.authorized(fresh), true);
  assert.match(access.logout(fresh), /Max-Age=0/);
  assert.equal(access.authorized(fresh), false);
});

test('remote GUI protects state, static app, mutations and exports behind login', async (t) => {
  const parent = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'certflow-auth-'));
  const app = await createApp({ configPath: path.join(directory, 'config.json'), host: '0.0.0.0', publicUrl: 'http://nas.test:3390', adminPassword: fakePassword, run: async () => assert.fail('no real run') });
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), parent); assert.match(path.basename(directory), /^certflow-auth-/); await fs.rm(directory, { recursive: true, force: true }); });
  const request = (route, options) => new Promise((resolve, reject) => {
    const req = http.request(`${app.url}${route}`, options, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value])) })));
    });
    req.on('error', reject); req.end(options.body);
  });
  const get = (route, extra = {}) => request(route, { headers: { Host: 'nas.test:3390', ...extra } });
  const post = (route, body, extra = {}) => request(route, { method: 'POST', headers: { Host: 'nas.test:3390', Origin: 'http://nas.test:3390', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await get('/')).status, 302);
  assert.equal((await get('/app.js')).status, 302);
  assert.equal((await get('/login')).status, 200);
  assert.equal((await get('/api/state')).status, 401);
  assert.equal((await post('/api/export', { id: 'example', kind: 'privateKey' })).status, 401);
  assert.equal((await post('/auth/login', { password: fakePassword }, { Origin: 'http://malicious.test' })).status, 403);
  assert.equal((await post('/auth/login', { password: fakePassword }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('/auth/login', { password: 'incorrect-password-123' })).status, 401);
  const login = await post('/auth/login', { password: fakePassword });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const stateResponse = await get('/api/state', { Cookie: cookie });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.app.authentication, true);
  assert.equal(state.app.remote, true);
  assert.equal(JSON.stringify(state).includes(fakePassword), false);
  assert.equal((await post('/api/plan', {}, { Cookie: cookie })).status, 403);
  assert.equal((await post('/api/plan', {}, { Cookie: cookie, 'X-CSRF-Token': state.csrfToken })).status, 200);
  assert.equal((await get('/api/state', { Cookie: cookie, Host: 'attacker.test' })).status, 403);
  assert.equal((await post('/auth/logout', {}, { Cookie: cookie })).status, 200);
  assert.equal((await get('/api/state', { Cookie: cookie })).status, 401);
  assert.equal((await fetch(`${app.url}/api/health`)).status, 200, 'loopback container health probe must stay available');
});
