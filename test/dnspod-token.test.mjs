import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/core.mjs';
import {
  createDnsPodClient, DnsPodError, dnsPodExecEnvironment, findDnsPodZone,
  loadDnsPodCredentials, runDnsPodChallenge, validateDnsPodCredentials, readDnsPodDiagnostic, dnsPodDiagnostic,
} from '../src/dnspod-token.mjs';

const valueA = 'a'.repeat(43);
const valueB = 'b'.repeat(43);
const fqdn = '_acme-challenge.example.com.';

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), '证书 DNSPod 测试 '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function fakeDns({ zone = 'example.com' } = {}) {
  const records = new Map();
  const calls = [];
  let sequence = 100;
  const client = async (action, params) => {
    calls.push({ action, params });
    if (action === 'Domain.Info') {
      if (params.domain !== zone) throw new DnsPodError(action, '6');
      return { domain: { id: '42', punycode: zone, status: 'enable' } };
    }
    if (action === 'Record.Create') {
      const id = String(++sequence);
      records.set(id, { id, domain_id: params.domain_id, sub_domain: params.sub_domain, record_type: params.record_type, value: params.value });
      return { record: { id } };
    }
    if (action === 'Record.Info') return { record: records.get(params.record_id) };
    if (action === 'Record.Remove') { records.delete(params.record_id); return {}; }
    assert.fail(`Unexpected ${action}`);
  };
  return { client, calls, records };
}

test('legacy ID and Token are separate, support short numeric IDs and credential files', async (t) => {
  assert.deepEqual(validateDnsPodCredentials('7', 'test-token-value'), { id: '7', token: 'test-token-value' });
  assert.throws(() => validateDnsPodCredentials('SecretId', 'test-token-value'), /正整数/);
  assert.throws(() => validateDnsPodCredentials('7', '7,test-token-value'), /分别填写/);
  const directory = await workspace(t);
  const id = path.join(directory, 'id'), token = path.join(directory, 'token');
  await fs.writeFile(id, '12\n'); await fs.writeFile(token, 'token-file-value\n');
  assert.deepEqual(await loadDnsPodCredentials({ DNSPOD_API_ID_FILE: id, DNSPOD_API_TOKEN_FILE: token }), { id: '12', token: 'token-file-value' });
});

test('legacy API uses form POST over fixed HTTPS and never forwards credential-bearing errors', async () => {
  const calls = [];
  const client = createDnsPodClient({ id: '7', token: 'secret-test-token', contact: 'operator@example.com', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ status: { code: '1' }, domain: { id: '4' } }));
  } });
  await client('Domain.Info', { domain: 'example.com' });
  assert.equal(calls[0].url, 'https://dnsapi.cn/Domain.Info');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body.get('login_token'), '7,secret-test-token');
  assert.equal(calls[0].options.body.get('domain'), 'example.com');
  assert.equal(calls[0].options.headers['User-Agent'], 'CertFlow/0.3 (operator@example.com)');
  const bad = createDnsPodClient({ id: '7', token: 'secret-test-token', contact: 'operator@example.com', fetchImpl: async () =>
    new Response(JSON.stringify({ status: { code: '-1', message: 'secret-test-token' } })) });
  await assert.rejects(bad('Domain.Info', {}), error => error.code === '-1' && !error.message.includes('secret-test-token'));
  const broken = createDnsPodClient({ id: '7', token: 'secret-test-token', contact: 'operator@example.com', fetchImpl: async () => { throw new Error('secret-test-token'); } });
  await assert.rejects(broken('Domain.Info', {}), error => !error.message.includes('secret-test-token'));
});

test('zone discovery handles nested zones and CNAME target apex without assuming a public suffix', async () => {
  const nested = fakeDns({ zone: 'hosting.example.co.uk' });
  assert.deepEqual(await findDnsPodZone('_acme-challenge.app.hosting.example.co.uk', nested.client), {
    zone: 'hosting.example.co.uk', domainId: '42', subDomain: '_acme-challenge.app',
  });
  assert.deepEqual(nested.calls.map(call => call.params.domain), ['app.hosting.example.co.uk', 'hosting.example.co.uk']);
  const target = fakeDns({ zone: 'validation.example.com' });
  assert.equal((await findDnsPodZone('validation.example.com', target.client)).subDomain, '@');
  await assert.rejects(findDnsPodZone('example.com', async action => { throw new DnsPodError(action, '-1'); }), /鉴权失败/);
});

test('two challenges sharing a TXT name retain independent records and only delete owned IDs', async (t) => {
  const directory = await workspace(t);
  const dns = fakeDns();
  dns.records.set('999', { id: '999', domain_id: '42', sub_domain: '_acme-challenge', record_type: 'TXT', value: 'unrelated-record' });
  const options = { directory, client: dns.client };
  const first = await runDnsPodChallenge('present', fqdn, valueA, options);
  const second = await runDnsPodChallenge('present', fqdn, valueB, options);
  assert.notEqual(first.recordId, second.recordId);
  assert.equal(dns.records.size, 3);
  const retry = await runDnsPodChallenge('present', fqdn, valueA, options);
  assert.equal(retry.action, 'existing');
  assert.equal(dns.calls.filter(v => v.action === 'Record.Create').length, 2);
  await runDnsPodChallenge('cleanup', fqdn, valueA, options);
  assert.equal(dns.records.has(first.recordId), false);
  assert.equal(dns.records.has(second.recordId), true);
  assert.equal(dns.records.has('999'), true);
  await runDnsPodChallenge('cleanup', fqdn, valueB, options);
  const before = dns.calls.length;
  assert.equal((await runDnsPodChallenge('cleanup', fqdn, valueB, options)).action, 'absent');
  assert.equal(dns.calls.length, before, 'no receipt must mean no remote reads or deletes');
  assert.deepEqual([...dns.records.keys()], ['999']);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('cleanup refuses a remotely modified record and retains the receipt', async (t) => {
  const directory = await workspace(t);
  const dns = fakeDns(), options = { directory, client: dns.client };
  const created = await runDnsPodChallenge('present', fqdn, valueA, options);
  dns.records.get(created.recordId).value = 'user-edited-value';
  await assert.rejects(runDnsPodChallenge('cleanup', fqdn, valueA, options), /已被修改/);
  assert.equal(dns.calls.some(v => v.action === 'Record.Remove'), false);
  assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.json')).length, 1);
});

test('duplicate provider records are not adopted or removed and invalid challenge arguments never reach DNS', async (t) => {
  const directory = await workspace(t);
  const dns = fakeDns();
  const client = async (action, params) => {
    if (action === 'Record.Create') throw new DnsPodError(action, '104');
    return dns.client(action, params);
  };
  await assert.rejects(runDnsPodChallenge('present', fqdn, valueA, { directory, client }), /不会接管/);
  assert.deepEqual(await fs.readdir(directory), []);
  for (const invalid of ['https://example.com', '../../secrets', 'example.com;echo injected']) {
    await assert.rejects(runDnsPodChallenge('present', invalid, valueA, { directory, client: async () => assert.fail('network must not run') }), /域名无效/);
  }
  await assert.rejects(runDnsPodChallenge('present', fqdn, 'unsafe-value', { directory, client }), /验证值无效/);
});

test('the actual shell-free Node executable bridge handles Windows/Unix paths with spaces and Unicode', async (t) => {
  const directory = await workspace(t);
  const originalOptions = process.env.NODE_OPTIONS;
  const env = dnsPodExecEnvironment({ ...process.env, DNSPOD_API_ID: '7', DNSPOD_API_TOKEN: 'test-placeholder-only' }, directory, 'operator@example.com');
  assert.equal(env.EXEC_PATH, process.execPath);
  assert.equal(env.EXEC_MODE, '');
  assert.equal(process.env.NODE_OPTIONS, originalOptions);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(env.EXEC_PATH, ['cleanup', fqdn, valueA], { env, cwd: directory, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('bundled lego v5 invokes the bridge through a local mock ACME server without contacting DNSPod', async (t) => {
  const binary = fileURLToPath(new URL(`../.tools/lego-v5.5.2/lego${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
  try { await fs.access(binary); } catch {
    assert.notEqual(process.env.CERTFLOW_REQUIRE_LEGO_TEST, '1', 'CI requires the pinned lego integration binary');
    t.skip('Optional integration: bundled lego is not installed.'); return;
  }
  const directory = await workspace(t);
  let base;
  const routes = [];
  const server = https.createServer({
    cert: await fs.readFile(new URL('./fixtures/server-cert.test.txt', import.meta.url)),
    key: await fs.readFile(new URL('./fixtures/server-key.test.txt', import.meta.url)),
  }, async (request, response) => {
    for await (const chunk of request) { /* Drain ACME JWS; no real account or order. */ }
    routes.push(request.url);
    response.setHeader('Replay-Nonce', Buffer.from(String(Date.now()) + Math.random()).toString('base64url'));
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/directory') return response.end(JSON.stringify({
      newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order`,
      revokeCert: `${base}/revoke`, keyChange: `${base}/keychange`,
    }));
    if (request.url === '/nonce') return response.end();
    if (request.url === '/account') {
      response.statusCode = 201; response.setHeader('Location', `${base}/account/1`);
      return response.end(JSON.stringify({ status: 'valid', contact: ['mailto:operator@example.com'], orders: `${base}/orders` }));
    }
    if (request.url === '/order') {
      response.statusCode = 201; response.setHeader('Location', `${base}/order/1`);
      return response.end(JSON.stringify({ status: 'pending', identifiers: [{ type: 'dns', value: 'example.com' }],
        authorizations: [`${base}/authz/1`], finalize: `${base}/finalize` }));
    }
    if (request.url === '/authz/1') return response.end(JSON.stringify({ status: 'pending', identifier: { type: 'dns', value: 'example.com' },
      challenges: [{ type: 'dns-01', status: 'pending', url: `${base}/challenge/1`, token: 'local-mock-challenge-token' }] }));
    response.statusCode = 404; response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = dnsPodExecEnvironment({ ...process.env,
    // A deliberate local validation error proves the bridge ran, before it can
    // issue an HTTPS call. CNAME resolution is disabled only for this fixture.
    DNSPOD_API_ID: 'invalid-local-test-id', DNSPOD_API_TOKEN: 'test-placeholder-only', LEGO_DISABLE_CNAME_SUPPORT: 'true',
  }, path.join(directory, 'receipts'), 'operator@example.com');
  const result = await runProcess(binary, ['run', '--server', `${base}/directory`, '--email', 'operator@example.com',
    '--accept-tos', '--tls-skip-verify', '--path', directory, '--domains', 'example.com', '--dns', 'exec'], { env, cwd: directory, timeoutMs: 15000 });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /CERTFLOW_DNSPOD_ERROR:INVALID_CREDENTIALS/);
  assert.equal((result.stdout + result.stderr).includes('test-placeholder-only'), false);
  assert.ok(routes.includes('/authz/1'));
  assert.equal(routes.includes('/finalize'), false);
});

test('bridge diagnostics accept only bounded known codes and never reproduce raw output', () => {
  assert.equal(dnsPodDiagnostic(new DnsPodError('Domain.Info', '-1')), 'AUTH_FAILED');
  assert.equal(dnsPodDiagnostic(new DnsPodError('Record.Create', '7')), 'PERMISSION_DENIED');
  assert.match(readDnsPodDiagnostic('log INFO CERTFLOW_DNSPOD_ERROR:AUTH_FAILED secret-value'), /鉴权失败/);
  assert.equal(readDnsPodDiagnostic('secret-value CERTFLOW_DNSPOD_ERROR:UNKNOWN_CODE'), null);
  assert.equal(readDnsPodDiagnostic('CERTFLOW_DNSPOD_ERROR:AUTH_FAILED_MALICIOUS'), null);
  assert.equal(readDnsPodDiagnostic('arbitrary provider message with credentials'), null);
});
