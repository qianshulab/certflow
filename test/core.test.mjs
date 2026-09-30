import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { processCleanupError } from '../src/process-safety.mjs';
import { ACME_DIAGNOSTICS } from '../src/acme-diagnostics.mjs';
import {
  buildArgs, getStatus, inspectCertificate, jobPaths, loadConfig, plan,
  runOnce, runProcess, validateConfig,
} from '../src/core.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const certificate = await fs.readFile(path.join(fixtures, 'single-domain-cert.test.txt'));
const wildcardCertificate = await fs.readFile(path.join(fixtures, 'server-cert.test.txt'));
const privateKey = await fs.readFile(path.join(fixtures, 'server-key.test.txt'));
const otherKey = await fs.readFile(path.join(fixtures, 'other-key.test.txt'));
const expectedFingerprint = new X509Certificate(certificate).fingerprint256;
const success = { code: 0, stdout: '', stderr: '' };
const help = { ...success, stdout: '--cert.name value --renew-force --http.webroot value' };
const version = { ...success, stdout: 'lego version 5.5.2 windows/amd64\n' };

function rawConfig(overrides = {}) {
  return {
    email: 'operator@example.com', acceptTerms: true,
    jobs: [{ id: 'site', domains: ['example.com'], challenge: { type: 'http', webroot: './web root' } }],
    ...overrides,
  };
}

async function workspace(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'https-cert-core-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = validateConfig(rawConfig(overrides), directory);
  for (const job of config.jobs) {
    if (job.challenge.type === 'http') await fs.mkdir(job.challenge.webroot, { recursive: true });
  }
  return { directory, config, job: config.jobs[0] };
}

async function issueFixture(config, job) {
  const files = jobPaths(config, job);
  await fs.mkdir(path.dirname(files.certificate), { recursive: true });
  await fs.writeFile(files.certificate, job.domains.includes('*.example.com') ? wildcardCertificate : certificate);
  await fs.writeFile(files.privateKey, privateKey);
}

async function stateFor(config, job) {
  return JSON.parse(await fs.readFile(jobPaths(config, job).state, 'utf8'));
}

test('domain validation normalizes IDNs, removes duplicates, and maps DNSPod to Tencent Cloud', () => {
  const config = validateConfig(rawConfig({ jobs: [{
    id: 'dns-site', domains: ['EXAMPLE.COM', '*.Example.com', '例子.测试', 'example.com'],
    challenge: { type: 'dns', provider: 'dnspod' },
  }] }));
  assert.equal(config.environment, 'staging');
  assert.deepEqual(config.jobs[0].domains, ['example.com', '*.example.com', 'xn--fsqu00a.xn--0zwm56d']);
  assert.deepEqual(config.jobs[0].challenge, { type: 'dns', provider: 'tencentcloud' });
  const args = buildArgs(config, config.jobs[0]);
  assert.equal(args[args.indexOf('--dns') + 1], 'tencentcloud');
});

test('invalid domains and domain strings containing URL components are rejected', () => {
  const values = [
    'https://example.com', 'example.com:443', '127.0.0.1', 'localhost', '-bad.example',
    'bad_.example', 'example..com', '*.*.example.com', 'example.com.',
    'example.com/path', 'example.com?query=1', 'example.com#fragment', 'example.com\\path',
    'user@example.com', 'example.com ',
  ];
  for (const value of values) {
    assert.throws(() => validateConfig(rawConfig({ jobs: [{
      id: 'site', domains: [value], challenge: { type: 'dns', provider: 'cloudflare' },
    }] })), undefined, `must reject ${JSON.stringify(value)}`);
  }
});

test('wildcards require DNS validation and staging cannot configure deployment', () => {
  assert.throws(() => validateConfig(rawConfig({ jobs: [{
    id: 'site', domains: ['*.example.com'], challenge: { type: 'http', webroot: '.' },
  }] })), /DNS/);
  assert.throws(() => validateConfig(rawConfig({ jobs: [{
    ...rawConfig().jobs[0], deployment: { directory: './live', checkCommand: ['check'], reloadCommand: ['reload'] },
  }] })), /测试环境/);
});

test('duplicate job IDs, unsafe filenames, and overlapping deployment directories are rejected', () => {
  const job = rawConfig().jobs[0];
  assert.throws(() => validateConfig(rawConfig({ jobs: [job, { ...job }] })), /重复/);
  for (const id of ['../site', 'CON', 'con', 'lpt9', 'site/name', 'site.name']) {
    assert.throws(() => validateConfig(rawConfig({ jobs: [{ ...job, id }] })), /id/);
  }
  const deployment = { directory: './live', checkCommand: ['check'], reloadCommand: ['reload'] };
  assert.throws(() => validateConfig(rawConfig({ environment: 'production', jobs: [
    { ...job, id: 'one', deployment }, { ...job, id: 'two', deployment: { ...deployment, directory: './live/.' } },
  ] })), /任务 one 与 two 不能部署到相同目录/);
});

test('configuration paths resolve against the config file and preview has no filesystem side effects', async (t) => {
  const { directory } = await workspace(t);
  const nested = path.join(directory, '配置 folder');
  await fs.mkdir(nested);
  const filename = path.join(nested, 'config.json');
  await fs.writeFile(filename, '\uFEFF' + JSON.stringify(rawConfig({ legoPath: './bin/lego.exe' })));
  const config = await loadConfig(filename);
  assert.equal(config.dataDir, path.join(nested, 'data'));
  assert.equal(config.legoPath, path.join(nested, 'bin', 'lego.exe'));
  const output = await plan(config);
  assert.equal(output.environment, 'staging');
  assert.equal(output.jobs[0].args[0], 'run');
  assert.equal(output.jobs[0].files.certificate, path.join(nested, 'data', 'staging', 'site', 'lego', 'certificates', 'site.crt'));
  await assert.rejects(fs.stat(config.dataDir), { code: 'ENOENT' });
  const production = validateConfig(rawConfig({ environment: 'production' }), nested);
  assert.notEqual(jobPaths(production, production.jobs[0]).lego, jobPaths(config, config.jobs[0]).lego);
});

test('process arguments containing shell syntax and spaces stay literal data', async () => {
  const values = ['space and 中文', '$(echo injected)', 'a;b', 'x&y', '|', '"quoted"', '%PATH%', '$HOME', 'trailing\\'];
  const result = await runProcess(process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...values], { timeoutMs: 10000 });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), values);
});

test('certificate validation rejects mismatched keys, missing SANs, future validity, and expiry', () => {
  const cert = new X509Certificate(certificate);
  const from = Date.parse(cert.validFrom), to = Date.parse(cert.validTo);
  const validTime = from + 1000;
  assert.equal(inspectCertificate(certificate, privateKey, ['example.com'], validTime).fingerprint, expectedFingerprint);
  assert.throws(() => inspectCertificate(wildcardCertificate, privateKey, ['example.com']), /移除的域名/);
  assert.throws(() => inspectCertificate(certificate, otherKey, ['example.com'], validTime), /私钥不匹配/);
  assert.throws(() => inspectCertificate(certificate, privateKey, ['missing.example.com'], validTime), /全部配置域名/);
  assert.throws(() => inspectCertificate(certificate, privateKey, ['example.com'], from - 1000), /尚未生效/);
  assert.throws(() => inspectCertificate(certificate, privateKey, ['example.com'], to), /已经过期/);
});

test('failed issuance persists exponential backoff and does not save raw subprocess output', async (t) => {
  const { config, job } = await workspace(t);
  const calls = [];
  const executor = async (executable, args) => {
    calls.push({ executable, args });
    if (args.includes('--version')) return version;
    if (args.includes('--help')) return help;
    return { code: 1, stdout: 'secret-output-marker', stderr: 'secret-credential-marker' };
  };
  const initialTime = Date.now();
  const [first] = await runOnce(config, { executor });
  assert.equal(first.action, 'failed');
  assert.match(first.error, /申请／续期失败/);
  assert.equal(calls.length, 3);
  let state = await stateFor(config, job);
  assert.equal(state.failureCount, 1);
  assert.ok(Date.parse(state.nextAttemptAt) >= initialTime + 59000);
  assert.ok(Date.parse(state.nextAttemptAt) <= Date.now() + 61000);
  assert.equal(JSON.stringify(state).includes('secret-'), false);
  const callsBeforeBackoff = calls.length;
  const [second] = await runOnce(config, { executor });
  assert.equal(second.action, 'backoff');
  assert.equal(calls.length, callsBeforeBackoff);
  assert.deepEqual(await stateFor(config, job), state);
  await runOnce(config, { executor, ignoreBackoff: true });
  state = await stateFor(config, job);
  assert.equal(state.failureCount, 2);
  assert.ok(Date.parse(state.nextAttemptAt) >= Date.now() + 599000);
  await assert.rejects(fs.stat(path.join(config.dataDir, config.environment, '.run.lock')), { code: 'ENOENT' });
});

test('ACME failure classification persists only a fixed diagnosis and never raw domains or secrets', async (t) => {
  const { config, job } = await workspace(t);
  const privateText = 'secret-domain.example token-private-value';
  let mode = 'classified';
  const executor = async (_executable, args) => {
    if (args.includes('--version')) return version;
    if (args.includes('--help')) return help;
    return mode === 'classified'
      ? { code: 1, stdout: '', stderr: `Could not obtain certificates:\n[${privateText}] urn:ietf:params:acme:error:rateLimited` }
      : { code: 'private-exit-code', stdout: privateText, stderr: 'unrecognized error' };
  };
  const [classified] = await runOnce(config, { executor });
  assert.equal(classified.error, ACME_DIAGNOSTICS.RATE_LIMITED);
  assert.equal((await stateFor(config, job)).lastError, ACME_DIAGNOSTICS.RATE_LIMITED);
  mode = 'unknown';
  const [fallback] = await runOnce(config, { executor, ignoreBackoff: true });
  assert.match(fallback.error, /退出码 未知/);
  assert.equal(JSON.stringify(await stateFor(config, job)).includes(privateText), false);
  assert.equal(JSON.stringify(fallback).includes('private-'), false);
});

test('only one run may hold the environment lock and the lock is released after completion', async (t) => {
  const { config, job } = await workspace(t);
  let release, entered;
  const block = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const executor = async (executable, args) => {
    if (args.includes('--version')) return version;
    if (args.includes('--help')) { entered(); await block; return help; }
    await issueFixture(config, job);
    return success;
  };
  const first = runOnce(config, { executor });
  await started;
  try {
    await assert.rejects(runOnce(config, { executor: async () => assert.fail('overlapping run reached executor') }), /运行.*锁|运行锁/);
  } finally {
    release();
  }
  assert.equal((await first)[0].ok, true);
  await assert.rejects(fs.stat(path.join(config.dataDir, config.environment, '.run.lock')), { code: 'ENOENT' });
  const [next] = await runOnce(config, { executor });
  assert.equal(next.ok, true);
  assert.equal(next.action, 'unchanged');
});

test('deployment failure is retried from the saved certificate without another lego call', async (t) => {
  const { config, job } = await workspace(t, {
    environment: 'production', jobs: [{ ...rawConfig().jobs[0], deployment: {
      directory: './live certs', checkCommand: ['mock-check', 'literal;argument'], reloadCommand: ['mock-reload'],
    } }],
  });
  let legoRuns = 0, failCheck = true;
  const calls = [];
  const executor = async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (executable === config.legoPath) {
      if (args.includes('--version')) return version;
      if (args.includes('--help')) return help;
      legoRuns += 1;
      await issueFixture(config, job);
      return success;
    }
    if (executable === 'mock-check') {
      assert.deepEqual(args, ['literal;argument']);
      assert.equal(options.env.CERT_FULLCHAIN, path.join(job.deployment.directory, 'fullchain.pem'));
      return failCheck ? { ...success, code: 2 } : success;
    }
    assert.equal(executable, 'mock-reload');
    return success;
  };
  const [first] = await runOnce(config, { executor });
  assert.equal(first.ok, false);
  assert.equal(legoRuns, 1);
  const failedState = await stateFor(config, job);
  assert.equal(failedState.issuedFingerprint, expectedFingerprint);
  assert.equal(failedState.deployedFingerprint, undefined);
  // A deployment retry must also work when the original ACME prerequisites disappear.
  await fs.rmdir(job.challenge.webroot);
  failCheck = false;
  const priorCalls = calls.length;
  const [retried] = await runOnce(config, { executor, ignoreBackoff: true });
  assert.equal(retried.ok, true);
  assert.equal(retried.action, 'deployed');
  assert.ok(retried.exportFiles?.certificate);
  assert.ok(retried.exportFiles?.privateKey);
  assert.equal(JSON.stringify(retried).includes('BEGIN PRIVATE KEY'), false);
  assert.equal(legoRuns, 1);
  assert.equal(calls.slice(priorCalls).some(call => call.executable === config.legoPath), false);
  assert.deepEqual(await fs.readFile(path.join(job.deployment.directory, 'fullchain.pem')), certificate);
  assert.deepEqual(await fs.readFile(path.join(job.deployment.directory, 'privkey.pem')), privateKey);
  const state = await stateFor(config, job);
  assert.deepEqual(state.exportFiles, retried.exportFiles);
  assert.equal(JSON.stringify(state).includes('BEGIN PRIVATE KEY'), false);
  assert.equal(JSON.stringify(state).includes('BEGIN CERTIFICATE'), false);
  assert.equal(state.failureCount, 0);
  assert.equal(state.nextAttemptAt, null);
  assert.equal(state.lastError, null);
  assert.equal(state.deployedFingerprint, expectedFingerprint);
  const [status] = await getStatus(config);
  assert.equal(status.certificate.fingerprint, expectedFingerprint);
  assert.equal(status.deployment.lastDeployedFingerprint, expectedFingerprint);
});

test('declined CA terms and unknown job selection stop before any subprocess runs', async (t) => {
  const { config } = await workspace(t);
  const executor = async () => assert.fail('must not run external commands');
  await assert.rejects(runOnce({ ...config, acceptTerms: false }, { executor }), /acceptTerms/);
  await assert.rejects(runOnce(config, { only: 'missing', executor }), /不存在任务/);
});

test('session DNS credentials validate and reach every lego invocation without modifying process.env', async (t) => {
  const { config, job } = await workspace(t, { jobs: [{
    id: 'site', domains: ['example.com', '*.example.com'],
    challenge: { type: 'dns', provider: 'tencentcloud' },
  }] });
  const names = ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY',
    'TENCENTCLOUD_SECRET_ID_FILE', 'TENCENTCLOUD_SECRET_KEY_FILE'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    const env = { ...process.env,
      TENCENTCLOUD_SECRET_ID: 'session-id-only-for-core-test',
      TENCENTCLOUD_SECRET_KEY: 'session-key-only-for-core-test',
    };
    const calls = [];
    const [result] = await runOnce(config, { env, executor: async (executable, args, options) => {
      calls.push(args);
      assert.equal(executable, config.legoPath);
      assert.equal(options.env.TENCENTCLOUD_SECRET_ID, env.TENCENTCLOUD_SECRET_ID);
      assert.equal(options.env.TENCENTCLOUD_SECRET_KEY, env.TENCENTCLOUD_SECRET_KEY);
      for (const name of names) assert.equal(process.env[name], undefined);
      if (args.includes('--version')) return version;
      if (args.includes('--help')) return help;
      await issueFixture(config, job);
      return success;
    } });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'issued');
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], ['--version']);
    assert.deepEqual(calls[1], ['run', '--help']);
    assert.deepEqual(calls[2], buildArgs(config, job));
    for (const name of names) assert.equal(process.env[name], undefined);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('legacy DNSPod is a distinct provider using lego exec with credentials only in the child environment', async (t) => {
  const { config, job } = await workspace(t, { jobs: [{
    id: 'site', domains: ['example.com', '*.example.com'], challenge: { type: 'dns', provider: 'dnspod-token' },
  }] });
  const env = { ...process.env, DNSPOD_API_ID: '7', DNSPOD_API_TOKEN: 'legacy-test-token' };
  const args = buildArgs(config, job);
  assert.equal(args[args.indexOf('--dns') + 1], 'exec');
  const preview = await plan(config);
  assert.deepEqual(preview.jobs[0].requiredEnvironment, ['DNSPOD_API_ID', 'DNSPOD_API_TOKEN']);
  assert.equal(JSON.stringify(preview).includes(env.DNSPOD_API_TOKEN), false);
  const [result] = await runOnce(config, { env, executor: async (executable, actualArgs, options) => {
    assert.equal(JSON.stringify(actualArgs).includes(env.DNSPOD_API_TOKEN), false);
    if (actualArgs.includes('--version')) return version;
    if (actualArgs.includes('--help')) return help;
    assert.equal(options.env.DNSPOD_API_TOKEN, env.DNSPOD_API_TOKEN);
    assert.equal(options.env.EXEC_PATH, process.execPath);
    assert.match(options.env.NODE_OPTIONS, /^--dns-result-order=ipv4first --import=file:/);
    assert.equal(options.env.EXEC_MODE, '');
    assert.equal(options.env.CERTFLOW_DNSPOD_STATE_DIR, path.join(jobPaths(config, job).directory, 'dnspod-challenges'));
    await issueFixture(config, job);
    return success;
  } });
  assert.equal(result.ok, true);
  assert.equal(env.EXEC_PATH, undefined);
  assert.equal(JSON.stringify(await stateFor(config, job)).includes(env.DNSPOD_API_TOKEN), false);
});

test('legacy provider errors persist an actionable allowlisted diagnosis without raw output', async (t) => {
  const { config, job } = await workspace(t, { jobs: [{
    id: 'site', domains: ['example.com'], challenge: { type: 'dns', provider: 'dnspod-token' },
  }] });
  const [result] = await runOnce(config, {
    env: { DNSPOD_API_ID: '7', DNSPOD_API_TOKEN: 'private-test-token' },
    executor: async (executable, args) => {
      if (args.includes('--version')) return version;
      if (args.includes('--help')) return help;
      return { code: 1, stdout: 'raw private-test-token', stderr: 'INFO CERTFLOW_DNSPOD_ERROR:AUTH_FAILED raw-secret-text urn:ietf:params:acme:error:rateLimited' };
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /DNSPod 鉴权失败/);
  const state = await stateFor(config, job);
  assert.equal(state.lastError, result.error);
  assert.equal(JSON.stringify(state).includes('raw-'), false);
  assert.equal(JSON.stringify(state).includes('private-test-token'), false);
});

test('successful issuance keeps the certificate usable while exposing a DNS cleanup warning', async (t) => {
  const { config, job } = await workspace(t, { jobs: [{
    id: 'site', domains: ['example.com'], challenge: { type: 'dns', provider: 'dnspod-token' },
  }] });
  const [result] = await runOnce(config, {
    env: { DNSPOD_API_ID: '7', DNSPOD_API_TOKEN: 'private-test-token' },
    executor: async (executable, args) => {
      if (args.includes('--version')) return version;
      if (args.includes('--help')) return help;
      await issueFixture(config, job);
      const directory = path.join(jobPaths(config, job).directory, 'dnspod-challenges');
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, `${'a'.repeat(64)}.json`), '{}');
      return { code: 0, stdout: '', stderr: 'INFO CERTFLOW_DNSPOD_ERROR:RECORD_CHANGED' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'issued');
  assert.ok(result.exportFiles.certificate);
  assert.match(result.warning, /清理未完成/);
  const state = await stateFor(config, job);
  assert.equal(state.dnsCleanupPendingCount, 1);
  assert.equal(state.lastWarning, result.warning);
});

test('unfinished deployment recovers before backoff even when no source certificate is available', async (t) => {
  const { config, job } = await workspace(t, {
    environment: 'production', jobs: [{ ...rawConfig().jobs[0], deployment: {
      directory: './live', checkCommand: ['mock-check'], reloadCommand: ['mock-reload'],
    } }],
  });
  const live = job.deployment.directory;
  const id = 'aabbccdd-1234-5678-9abc-123456789abc';
  const backup = path.join(live, '.cert-backups', id);
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'fullchain.pem'), certificate);
  await fs.writeFile(path.join(backup, 'privkey.pem'), privateKey);
  await fs.writeFile(path.join(live, 'fullchain.pem'), 'interrupted partial certificate');
  await fs.writeFile(path.join(live, 'privkey.pem'), otherKey);
  const journal = path.join(live, '.cert-deploy-journal.json');
  await fs.writeFile(journal, JSON.stringify({ version: 1, id, existed: [true, true], reloadAttempted: true }));
  const files = jobPaths(config, job);
  await fs.mkdir(path.dirname(files.state), { recursive: true });
  const nextAttemptAt = new Date(Date.now() + 3600000).toISOString();
  await fs.writeFile(files.state, JSON.stringify({ nextAttemptAt, failureCount: 2,
    deployedFingerprint: 'stale-claim', deploymentSignature: 'stale-signature', lastError: 'previous failure' }));
  const calls = [];
  const [result] = await runOnce(config, { executor: async (executable, args) => {
    calls.push({ executable, args });
    assert.equal(executable, 'mock-reload');
    assert.deepEqual(await fs.readFile(path.join(live, 'fullchain.pem')), certificate);
    assert.deepEqual(await fs.readFile(path.join(live, 'privkey.pem')), privateKey);
    return success;
  } });
  assert.equal(result.action, 'backoff');
  assert.equal(result.nextAttemptAt, nextAttemptAt);
  assert.deepEqual(calls, [{ executable: 'mock-reload', args: [] }]);
  await assert.rejects(fs.stat(journal), { code: 'ENOENT' });
  await assert.rejects(fs.stat(files.certificate), { code: 'ENOENT' });
  const state = await stateFor(config, job);
  assert.equal(state.deployedFingerprint, null);
  assert.equal(state.deploymentSignature, null);
  assert.equal(state.failureCount, 2);
});

test('unsupported lego versions and a missing v5 flag fail before creating an ACME order', async (t) => {
  for (const candidate of ['lego version 4.31.0 windows/amd64', 'lego version 6.0.0 windows/amd64', 'unrecognized output']) {
    await t.test(candidate, async (t) => {
      const { config } = await workspace(t);
      const commands = [];
      const [result] = await runOnce(config, { executor: async (executable, args) => {
        commands.push(args);
        return { ...success, stdout: candidate };
      } });
      assert.equal(result.ok, false);
      assert.match(result.error, /v5/);
      assert.deepEqual(commands, [['--version']]);
    });
  }
  await t.test('required renewal flag absent', async (t) => {
    const { config } = await workspace(t);
    const commands = [];
    const [result] = await runOnce(config, { executor: async (executable, args) => {
      commands.push(args);
      return args.includes('--version') ? version : { ...success, stdout: '--cert.name value' };
    } });
    assert.equal(result.ok, false);
    assert.match(result.error, /v5/);
    assert.deepEqual(commands, [['--version'], ['run', '--help']]);
  });
});

test('paused jobs are omitted from bulk runs but remain available for an explicit one-time run', async (t) => {
  const first = rawConfig().jobs[0];
  const { config } = await workspace(t, { jobs: [{ ...first, id: 'paused', enabled: false }, { ...first, id: 'active' }] });
  assert.equal(config.jobs[0].enabled, false);
  assert.equal(config.jobs[1].enabled, true);
  const issuedIds = [];
  const executor = async (executable, args) => {
    if (args.includes('--version')) return version;
    if (args.includes('--help')) return help;
    const id = args[args.indexOf('--cert.name') + 1];
    issuedIds.push(id);
    await issueFixture(config, config.jobs.find(job => job.id === id));
    return success;
  };
  assert.deepEqual((await runOnce(config, { executor })).map(item => item.id), ['active']);
  assert.deepEqual((await runOnce(config, { only: 'paused', executor })).map(item => item.id), ['paused']);
  assert.deepEqual(issuedIds, ['active', 'paused']);
  const status = await getStatus(config);
  assert.deepEqual(status.map(item => item.enabled), [false, true]);
  assert.deepEqual((await plan(config)).jobs.map(item => item.enabled), [false, true]);
  assert.throws(() => validateConfig(rawConfig({ jobs: [{ ...first, enabled: 'false' }] })), /enabled/);
});

test('an all-paused bulk run is a successful no-op without consent, a lock, or subprocess calls', async (t) => {
  const { config } = await workspace(t, { acceptTerms: false, jobs: [{ ...rawConfig().jobs[0], enabled: false }] });
  assert.deepEqual(await runOnce(config, { executor: async () => assert.fail('paused run invoked a subprocess') }), []);
  await assert.rejects(fs.stat(config.dataDir), { code: 'ENOENT' });
  await assert.rejects(runOnce(config, { only: 'site' }), /acceptTerms/);
});

test('batch progress reports each serial job including corrupt state, backoff and failure without changing results', async (t) => {
  const first = rawConfig().jobs[0];
  const { config } = await workspace(t, { jobs: ['paused', 'broken', 'backoff', 'failed', 'healthy'].map(id => ({ ...first, id, enabled: id !== 'paused' })) });
  for (const [id, contents] of [
    ['broken', '{ invalid JSON'],
    ['backoff', JSON.stringify({ nextAttemptAt: new Date(Date.now() + 60000).toISOString(), lastError: 'previous failure' })],
  ]) {
    const filename = jobPaths(config, config.jobs.find(job => job.id === id)).state;
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, contents);
  }
  const events = [];
  const results = await runOnce(config, {
    onProgress: async (event) => {
      events.push(structuredClone(event));
      if (event.result) event.result.ok = 'changed by observer';
      throw new Error('observer failure must not alter a certificate job');
    },
    executor: async (_executable, args) => {
      if (args.includes('--version')) return version;
      if (args.includes('--help')) return help;
      const job = config.jobs.find(item => item.id === args[args.indexOf('--cert.name') + 1]);
      assert.equal(events.at(-1).type, 'job-phase');
      assert.equal(events.at(-1).id, job.id);
      assert.equal(events.at(-1).phase, 'acme');
      if (job.id === 'failed') return { ...success, code: 1 };
      await issueFixture(config, job);
      return success;
    },
  });
  assert.deepEqual(events.filter(event => event.type !== 'job-phase').map(({ type, id, index, total }) => ({ type, id, index, total })),
    ['broken', 'backoff', 'failed', 'healthy'].flatMap((id, offset) => ['job-start', 'job-complete'].map(type => ({ type, id, index: offset + 1, total: 4 }))));
  assert.deepEqual(events.filter(event => event.type === 'job-phase').map(({ id, phase }) => [id, phase]), [
    ['broken', 'preparing'], ['backoff', 'preparing'],
    ['failed', 'preparing'], ['failed', 'credentials'], ['failed', 'client'], ['failed', 'acme'],
    ['healthy', 'preparing'], ['healthy', 'credentials'], ['healthy', 'acme'], ['healthy', 'certificate'], ['healthy', 'export'],
  ]);
  assert.deepEqual(events.filter(event => event.type === 'job-complete').map(event => event.result), results);
  assert.deepEqual(results.map(result => [result.id, result.ok, result.action]), [
    ['broken', false, 'failed'], ['backoff', false, 'backoff'], ['failed', false, 'failed'], ['healthy', true, 'issued'],
  ]);
  const explicit = [];
  await runOnce(config, { only: 'paused', onProgress: event => explicit.push(event), executor: async (_executable, args) => {
    if (args.includes('--version')) return version;
    if (args.includes('--help')) return help;
    await issueFixture(config, config.jobs[0]);
    return success;
  } });
  assert.deepEqual(explicit.filter(event => event.type !== 'job-phase').map(({ type, id, index, total }) => ({ type, id, index, total })), [
    { type: 'job-start', id: 'paused', index: 1, total: 1 }, { type: 'job-complete', id: 'paused', index: 1, total: 1 },
  ]);
});

test('certificate status validates the private key and exact current SANs before reporting usable', async (t) => {
  const { config, job } = await workspace(t);
  const files = jobPaths(config, job);
  assert.equal((await getStatus(config))[0].certificate.status, 'not-issued');
  await issueFixture(config, job);
  assert.equal((await getStatus(config))[0].certificate.status, 'valid');
  await fs.unlink(files.privateKey);
  assert.equal((await getStatus(config))[0].certificate.status, 'missing-key');
  await fs.writeFile(files.privateKey, otherKey);
  let status = (await getStatus(config))[0];
  assert.equal(status.certificate.status, 'invalid');
  assert.match(status.certificate.error, /私钥不匹配/);
  await fs.writeFile(files.privateKey, privateKey);
  await fs.writeFile(files.certificate, wildcardCertificate);
  status = (await getStatus(config))[0];
  assert.equal(status.certificate.status, 'invalid');
  assert.match(status.certificate.error, /移除的域名/);
  await fs.writeFile(files.certificate, certificate);
  job.domains = ['other.example.com'];
  status = (await getStatus(config))[0];
  assert.equal(status.certificate.status, 'invalid');
  assert.match(status.certificate.error, /全部配置域名/);
  await fs.writeFile(files.certificate, 'not a certificate');
  assert.equal((await getStatus(config))[0].certificate.status, 'unreadable');
});

test('corrupt or semantically invalid job state is preserved and does not hide or stop other certificates', async (t) => {
  const first = rawConfig().jobs[0];
  const { config } = await workspace(t, { jobs: [{ ...first, id: 'broken' }, { ...first, id: 'healthy' }] });
  const statePath = jobPaths(config, config.jobs[0]).state;
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  for (const badState of ['{broken JSON', '{"failureCount":"2"}', '{"nextAttemptAt":"not a date"}']) {
    await fs.writeFile(statePath, badState);
    const statuses = await getStatus(config);
    assert.equal(statuses.length, 2);
    assert.match(statuses[0].stateError, /状态文件损坏/);
    assert.equal(statuses[1].stateError, null);
    const results = await runOnce(config, { executor: async (executable, args) => {
      if (args.includes('--version')) return version;
      if (args.includes('--help')) return help;
      assert.equal(args[args.indexOf('--cert.name') + 1], 'healthy');
      await issueFixture(config, config.jobs[1]);
      return success;
    } });
    assert.equal(results[0].ok, false);
    assert.equal(results[0].stateError, true);
    assert.equal(results[1].ok, true);
    assert.equal(await fs.readFile(statePath, 'utf8'), badState);
  }
});

test('state persistence failure is reported for its job without interrupting the remaining batch', async (t) => {
  const first = rawConfig().jobs[0];
  const { config } = await workspace(t, { jobs: [{ ...first, id: 'broken' }, { ...first, id: 'healthy' }] });
  const results = await runOnce(config, { executor: async (executable, args) => {
    if (args.includes('--version')) return version;
    if (args.includes('--help')) return help;
    const job = config.jobs.find(item => item.id === args[args.indexOf('--cert.name') + 1]);
    await issueFixture(config, job);
    if (job.id === 'broken') await fs.mkdir(jobPaths(config, job).state);
    return success;
  } });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].stateError, true);
  assert.equal(results[0].nextAttemptAt, null);
  assert.match(results[0].error, /无法保存任务状态/);
  assert.equal(results[1].ok, true);
});

test('a lock from another container namespace is retained even if its PID is locally absent', async (t) => {
  const { config } = await workspace(t);
  const directory = path.join(config.dataDir, config.environment);
  await fs.mkdir(directory, { recursive: true });
  const lock = path.join(directory, '.run.lock');
  const content = JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z' });
  await fs.writeFile(lock, content);
  await assert.rejects(runOnce(config, { executor: async () => assert.fail('must not bypass an existing lock') }), /确认相关进程全部结束/);
  assert.equal(await fs.readFile(lock, 'utf8'), content);
});

test('a subprocess timeout stops its child and grandchild before reporting completed cleanup', async (t) => {
  const { directory } = await workspace(t);
  const marker = path.join(directory, 'delayed-marker');
  const ready = path.join(directory, 'grandchild-ready');
  const pids = path.join(directory, 'fixture-pids');
  const register = `require('node:fs').appendFileSync(${JSON.stringify(pids)}, String(process.pid) + '\\n');`;
  const grandchild = `${register} require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); let ticks = 0; setInterval(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(++ticks)), 100);`;
  const child = `${register} require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true }); setInterval(() => {}, 1000);`;
  const parent = `${register} require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true }); setInterval(() => {}, 1000);`;
  try {
    await assert.rejects(runProcess(process.execPath, ['-e', parent], { cwd: directory, timeoutMs: 2500 }), /超时，已终止进程树/);
    assert.equal(await fs.readFile(ready, 'utf8'), 'ready', 'the grandchild must start so this exercises tree termination');
    const before = await fs.readFile(marker, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    await new Promise(resolve => setTimeout(resolve, 1800));
    const after = await fs.readFile(marker, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    assert.equal(after, before, 'the grandchild must not write after process cleanup reports success');
  } finally {
    // In the event of a regression, stop only PIDs recorded by this test fixture.
    const content = await fs.readFile(pids, 'utf8').catch(() => '');
    for (const pid of content.trim().split('\n').map(Number).filter(pid => Number.isInteger(pid) && pid > 0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already terminated */ }
    }
  }
});

test('unconfirmed process-tree termination stops the batch and retains its run lock for manual recovery', async (t) => {
  const first = rawConfig().jobs[0];
  const { config } = await workspace(t, { jobs: [{ ...first, id: 'first' }, { ...first, id: 'second' }] });
  let calls = 0;
  const results = await runOnce(config, { executor: async () => {
    calls += 1;
    throw new AggregateError([processCleanupError()], 'nested cleanup failure');
  } });
  assert.equal(calls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].requiresProcessCleanup, true);
  const filename = path.join(config.dataDir, config.environment, '.run.lock');
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).pid, process.pid);
  await assert.rejects(runOnce(config, { executor: async () => assert.fail('must not start another process') }), /遗留运行锁/);
});
