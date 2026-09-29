// Executed through `docker exec -i ... node --input-type=module` by docker-smoke.mjs.
// This container has no network interface other than loopback. All credentials are fake.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const phase = process.argv[2];
const url = `http://127.0.0.1:${process.env.CERTFLOW_PORT}`;
const token = 'container-smoke-fake-dnspod-token';
assert.equal(process.getuid(), 1000, 'the service must run as the unprivileged node user');
assert.match(await fs.readFile('/usr/share/licenses/lego/LICENSE', 'utf8'), /Permission is hereby granted/);
const call = (route, options = {}) => fetch(`${url}${route}`, { redirect: 'manual', ...options });
assert.equal((await call('/api/state')).status, 401);
assert.equal((await call('/')).status, 302);
assert.equal((await call('/login')).status, 200);
assert.equal((await call('/api/health')).status, 200);
const login = await call('/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url },
  body: JSON.stringify({ password: process.env.CERTFLOW_ADMIN_PASSWORD }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
const state = async () => {
  const response = await call('/api/state', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(token), false, 'API must never return saved secrets');
  return JSON.parse(text);
};
let current = await state();
const post = (route, body) => call(`/api/${route}`, {
  method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: url, 'X-CSRF-Token': current.csrfToken },
  body: JSON.stringify(body),
});
assert.equal(current.app.authentication, true);
assert.equal(current.app.platform, 'linux');
assert.equal(current.scheduler.enabled, false);
assert.equal(current.runtime.running, false);

if (phase === 'save') {
  assert.equal(current.config.acceptTerms, false, 'fresh install must not accept CA terms automatically');
  const config = {
    ...current.config, email: 'container-smoke@example.com', acceptTerms: false,
    jobs: [{ id: 'smoke', domains: ['example.com'], challenge: { type: 'dns', provider: 'dnspod-token' }, deployment: null }],
  };
  assert.equal((await post('config', { config, version: current.configVersion })).status, 200);
  assert.equal((await post('credentials', { provider: 'dnspod-token', persist: true, values: { DNSPOD_API_ID: '12', DNSPOD_API_TOKEN: token } })).status, 200);
  current = await state();
  assert.equal(current.credentials['dnspod-token'].source, 'saved');
  const protectedDirectory = '/data/.certflow';
  assert.equal((await fs.stat(protectedDirectory)).mode & 0o777, 0o700);
  for (const filename of ['credentials.key', 'credentials.vault.json']) {
    assert.equal((await fs.stat(`${protectedDirectory}/${filename}`)).mode & 0o777, 0o600);
    assert.equal((await fs.readFile(`${protectedDirectory}/${filename}`)).includes(Buffer.from(token)), false);
  }
  const envelope = JSON.parse(await fs.readFile(`${protectedDirectory}/credentials.vault.json`, 'utf8'));
  assert.equal(envelope.protection, 'aes-256-gcm-local-key');
  await assert.rejects(fs.writeFile('/app/.smoke-read-only', 'probe'), error => ['EROFS', 'EACCES'].includes(error.code));
  await fs.writeFile('/tmp/certflow-smoke-probe', 'writable tmpfs');
} else if (phase === 'reload') {
  assert.equal(current.config.email, 'container-smoke@example.com');
  assert.equal(current.config.jobs[0].challenge.provider, 'dnspod-token');
  assert.equal(current.credentials['dnspod-token'].configured, true);
  assert.equal(current.credentials['dnspod-token'].source, 'saved');
  assert.equal(current.credentialStorage.error, null);
  assert.equal((await post('plan', {})).status, 200);
  assert.equal((await post('credentials/clear', { provider: 'dnspod-token' })).status, 200);
} else if (phase === 'cleared') {
  assert.equal(current.credentials['dnspod-token'].configured, false);
  assert.equal(current.config.email, 'container-smoke@example.com');
} else {
  throw new Error(`Unsupported smoke phase: ${phase}`);
}
const logout = await call('/auth/logout', {
  method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: url }, body: '{}',
});
assert.equal(logout.status, 200);
assert.equal((await call('/api/state', { headers: { Cookie: cookie } })).status, 401);
console.log(`Container ${phase}: login, protected state and persistence checks passed.`);
