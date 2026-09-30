import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ACME_DIAGNOSTICS } from '../src/acme-diagnostics.mjs';
import { ACCOUNT_RECOVERY_CHECKPOINT_ERROR, ACCOUNT_RECOVERY_DURABILITY_ERROR, accountRecoveryNeedsReview, isMissingAccountRecoveryFailure, quarantineIncompleteAccount } from '../src/acme-account-recovery.mjs';
import { jobPaths, runOnce, runProcess, validateConfig } from '../src/core.mjs';

const certificate = await fs.readFile(new URL('./fixtures/single-domain-cert.test.txt', import.meta.url));
const privateKey = await fs.readFile(new URL('./fixtures/server-key.test.txt', import.meta.url));
const replacementKey = await fs.readFile(new URL('./fixtures/other-key.test.txt', import.meta.url));
const success = { code: 0, stdout: '', stderr: '' };
const missingAccount = { code: 1, stdout: '', stderr: 'resolve account by key: acme: error: 400 :: POST :: urn:ietf:params:acme:error:accountDoesNotExist :: private-output-marker' };
const serverFor = config => `https://acme${config.environment === 'staging' ? '-staging' : ''}-v02.api.letsencrypt.org/directory`;
const accountDirectory = (config, job) => path.join(jobPaths(config, job).lego, 'accounts', new URL(serverFor(config)).host, config.email);

async function writeAccount(config, job, { fields = {}, key = privateKey } = {}) {
  const directory = accountDirectory(config, job);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const account = { id: config.email, email: config.email, server: serverFor(config), keyType: 'EC256', registration: null, ...fields };
  await fs.writeFile(path.join(directory, 'account.json'), JSON.stringify(account, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(directory, `${config.email}.key`), key, { mode: 0o600 });
  return directory;
}

async function workspace(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = path.resolve(await fs.mkdtemp(path.join(parent, 'certflow-account-recovery-')));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('certflow-account-recovery-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const config = validateConfig({
    email: 'operator@example.com', acceptTerms: true, environment: 'staging', dataDir: './data',
    jobs: [{ id: 'site', domains: ['example.com'], challenge: { type: 'http', webroot: './webroot' } }],
  }, directory);
  const job = config.jobs[0];
  await fs.mkdir(job.challenge.webroot, { mode: 0o700 });
  const account = await writeAccount(config, job);
  return { directory, config, job, account, server: serverFor(config), files: jobPaths(config, job) };
}

test('account recovery requires the precise terminal resolve-by-key failure and a normal failed exit', () => {
  assert.equal(isMissingAccountRecoveryFailure(missingAccount), true);
  assert.equal(isMissingAccountRecoveryFailure({ ...missingAccount, stderr: `Could not obtain certificates:\n${missingAccount.stderr}` }), true);
  for (const result of [
    { ...missingAccount, code: 0 }, { ...missingAccount, code: null }, { ...missingAccount, code: -1 },
    { ...missingAccount, stderr: 'urn:ietf:params:acme:error:accountDoesNotExist' },
    { ...missingAccount, stderr: missingAccount.stderr.replace('accountDoesNotExist', 'accountDoesNotExistExtra') },
    { ...missingAccount, stderr: `${missingAccount.stderr}\nCould not obtain certificates: unrelated error` },
    { ...missingAccount, stderr: missingAccount.stderr.replace('resolve account by key:', 'new order:') },
  ]) assert.equal(isMissingAccountRecoveryFailure(result), false);
});

test('an incomplete account is atomically quarantined with all data and a private one-time record', async t => {
  const { config, job, account, server, files } = await workspace(t);
  const accountBytes = await fs.readFile(path.join(account, 'account.json'));
  await fs.mkdir(path.join(account, 'notes'), { mode: 0o700 });
  await fs.writeFile(path.join(account, 'notes', 'previous-attempt.txt'), 'preserve this entire directory', { mode: 0o600 });
  const otherConfig = { ...config, email: 'another@example.com' };
  const otherAccount = await writeAccount(otherConfig, job);
  const production = { ...config, environment: 'production' };
  const productionAccount = await writeAccount(production, job);
  const otherJob = { ...job, id: 'other-job' };
  const otherJobAccount = await writeAccount(config, otherJob);

  const result = await quarantineIncompleteAccount(config, job, server);
  assert.ok(result);
  assert.equal(path.dirname(result.quarantineDirectory), files.lego);
  assert.match(path.basename(result.quarantineDirectory), /^\.certflow-account-quarantine-[a-f0-9]{64}$/);
  const preserved = path.join(result.quarantineDirectory, 'account');
  await assert.rejects(fs.lstat(account), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(preserved, 'account.json')), accountBytes);
  assert.deepEqual(await fs.readFile(path.join(preserved, `${config.email}.key`)), privateKey);
  assert.equal(await fs.readFile(path.join(preserved, 'notes', 'previous-attempt.txt'), 'utf8'), 'preserve this entire directory');
  for (const untouched of [otherAccount, productionAccount, otherJobAccount]) assert.deepEqual(await fs.readFile(path.join(untouched, `${untouched === otherAccount ? otherConfig.email : config.email}.key`)), privateKey);
  const manifest = await fs.readFile(path.join(result.quarantineDirectory, 'manifest.json'), 'utf8');
  assert.equal(manifest.includes(config.email), false);
  assert.equal(manifest.includes('PRIVATE KEY'), false);
  assert.equal(JSON.parse(manifest).attemptedAt, result.attemptedAt);
  assert.equal(await accountRecoveryNeedsReview(config, job, server, result), false);
  assert.equal(await accountRecoveryNeedsReview(config, job, server, undefined), true);
  assert.equal(await accountRecoveryNeedsReview(otherConfig, job, server, result), false, 'a confirmed recovery for an earlier email must not block an intentional email change');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(result.quarantineDirectory)).mode & 0o077, 0);
    assert.equal((await fs.stat(path.join(result.quarantineDirectory, 'manifest.json'))).mode & 0o077, 0);
  }
  await writeAccount(config, job, { key: replacementKey });
  assert.equal(await quarantineIncompleteAccount(config, job, server), null, 'a later run cannot start another recovery for this account');
  assert.deepEqual(await fs.readFile(path.join(account, `${config.email}.key`)), replacementKey);
  assert.deepEqual(await fs.readFile(path.join(preserved, `${config.email}.key`)), privateKey);
});

test('uncertain metadata, key or selected scope fails closed without changing the account', async t => {
  const cases = [
    ['registered account', async ctx => writeAccount(ctx.config, ctx.job, { fields: { registration: { status: 'valid' } } })],
    ['missing registration field', async ctx => {
      const filename = path.join(ctx.account, 'account.json');
      const value = JSON.parse(await fs.readFile(filename, 'utf8')); delete value.registration;
      await fs.writeFile(filename, JSON.stringify(value));
    }],
    ['wrong account ID', async ctx => writeAccount(ctx.config, ctx.job, { fields: { id: 'another@example.com' } })],
    ['wrong email', async ctx => writeAccount(ctx.config, ctx.job, { fields: { email: 'another@example.com' } })],
    ['wrong server', async ctx => writeAccount(ctx.config, ctx.job, { fields: { server: serverFor({ environment: 'production' }) } })],
    ['wrong key type', async ctx => writeAccount(ctx.config, ctx.job, { fields: { keyType: 'RSA2048' } })],
    ['invalid key', async ctx => writeAccount(ctx.config, ctx.job, { key: 'not a private key' })],
    ['missing key', async ctx => fs.unlink(path.join(ctx.account, `${ctx.config.email}.key`))],
    ['invalid JSON', async ctx => fs.writeFile(path.join(ctx.account, 'account.json'), '{ invalid JSON')],
    ['wrong job object', async ctx => { ctx.job = { ...ctx.job }; }],
    ['wrong environment endpoint', async ctx => { ctx.server = serverFor({ environment: 'production' }); }],
    ['email path escape', async ctx => { ctx.config.email = '../operator@example.com'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const ctx = await workspace(t);
    await mutate(ctx);
    const original = await fs.readFile(path.join(ctx.account, 'account.json'));
    assert.equal(await quarantineIncompleteAccount(ctx.config, ctx.job, ctx.server), null);
    assert.deepEqual(await fs.readFile(path.join(ctx.account, 'account.json')), original);
    assert.deepEqual(await fs.readdir(ctx.files.lego), ['accounts']);
  });
});

test('directory junctions and hard-linked files cannot authorize automatic recovery', async t => {
  for (const location of ['data', 'account', 'nested']) await t.test(`${location} linked directory`, async t => {
    const ctx = await workspace(t);
    const outside = path.join(ctx.directory, 'outside');
    const linked = location === 'data' ? ctx.config.dataDir : location === 'account' ? ctx.account : path.join(ctx.account, 'nested');
    if (location === 'nested') await fs.mkdir(outside, { mode: 0o700 });
    else await fs.rename(linked, outside);
    await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const source = location === 'data' ? path.join(outside, path.relative(ctx.config.dataDir, ctx.account)) : location === 'account' ? outside : ctx.account;
    const key = await fs.readFile(path.join(source, `${ctx.config.email}.key`));
    assert.equal(await quarantineIncompleteAccount(ctx.config, ctx.job, ctx.server), null);
    assert.equal((await fs.lstat(linked)).isSymbolicLink(), true);
    assert.deepEqual(await fs.readFile(path.join(source, `${ctx.config.email}.key`)), key);
  });
  await t.test('hard-linked key', async t => {
    const ctx = await workspace(t);
    await fs.link(path.join(ctx.account, `${ctx.config.email}.key`), path.join(ctx.directory, 'external-key'));
    assert.equal(await quarantineIncompleteAccount(ctx.config, ctx.job, ctx.server), null);
    assert.deepEqual(await fs.readFile(path.join(ctx.directory, 'external-key')), privateKey);
  });
});

test('a changing account or failed rename preserves the original and never removes its recovery reservation', async t => {
  for (const cause of ['changed', 'rename-failed']) await t.test(cause, async t => {
    const ctx = await workspace(t);
    if (cause === 'changed') {
      const originalMkdir = fs.mkdir.bind(fs);
      t.mock.method(fs, 'mkdir', async (filename, ...args) => {
        const result = await originalMkdir(filename, ...args);
        if (path.basename(filename).startsWith('.certflow-account-quarantine-')) await fs.writeFile(path.join(ctx.account, 'account.json'), JSON.stringify({ registration: { status: 'valid' } }));
        return result;
      });
    } else t.mock.method(fs, 'rename', async () => { const error = new Error('test blocked rename'); error.code = 'EACCES'; throw error; });
    assert.equal(await quarantineIncompleteAccount(ctx.config, ctx.job, ctx.server), null);
    assert.deepEqual(await fs.readFile(path.join(ctx.account, `${ctx.config.email}.key`)), privateKey);
    const [reservation] = (await fs.readdir(ctx.files.lego)).filter(name => name.startsWith('.certflow-account-quarantine-'));
    assert.ok(reservation);
    assert.deepEqual(await fs.readdir(path.join(ctx.files.lego, reservation)), ['manifest.json']);
    assert.equal(await quarantineIncompleteAccount(ctx.config, ctx.job, ctx.server), null);
  });
});

test('runOnce retries an incomplete account once under the same lock and preserves the original key', async t => {
  const { config, job, account, files } = await workspace(t);
  let attempts = 0;
  const [result] = await runOnce(config, { executor: async (_executable, args) => {
    if (args.includes('--version')) return { ...success, stdout: 'lego version 5.5.2' };
    if (args.includes('--help')) return { ...success, stdout: '--cert.name --renew-force' };
    attempts += 1;
    assert.equal(JSON.parse(await fs.readFile(path.join(config.dataDir, config.environment, '.run.lock'), 'utf8')).pid, process.pid);
    if (attempts === 1) return missingAccount;
    assert.equal(attempts, 2);
    await assert.rejects(fs.lstat(account), { code: 'ENOENT' });
    const checkpoint = JSON.parse(await fs.readFile(files.state, 'utf8'));
    assert.ok(checkpoint.acmeAccountRecovery, 'the preserved account location is recorded before starting another client');
    await writeAccount(config, job, { fields: { registration: { status: 'valid' } }, key: replacementKey });
    await fs.mkdir(path.dirname(files.certificate), { recursive: true, mode: 0o700 });
    await fs.writeFile(files.certificate, certificate);
    await fs.writeFile(files.privateKey, privateKey, { mode: 0o600 });
    return success;
  } });
  assert.equal(attempts, 2);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'issued');
  assert.deepEqual(await fs.readFile(path.join(result.accountRecovery.quarantineDirectory, 'account', `${config.email}.key`)), privateKey);
  assert.deepEqual(await fs.readFile(path.join(account, `${config.email}.key`)), replacementKey);
  const state = JSON.parse(await fs.readFile(files.state, 'utf8'));
  assert.deepEqual(state.acmeAccountRecovery, result.accountRecovery);
  assert.equal(state.lastError, null);
  assert.equal(JSON.stringify(state).includes('private-output-marker'), false);
  await assert.rejects(fs.stat(path.join(config.dataDir, config.environment, '.run.lock')), { code: 'ENOENT' });
  let normalCalls = 0;
  const [normal] = await runOnce(config, { executor: async (_executable, args) => {
    if (args.includes('--version')) return { ...success, stdout: 'lego version 5.5.2' };
    if (args.includes('--help')) return { ...success, stdout: '--cert.name --renew-force' };
    normalCalls += 1;
    return success;
  } });
  assert.equal(normal.ok, true, 'the matching confirmed checkpoint allows later normal renewal');
  assert.equal(normal.action, 'unchanged');
  assert.equal(normalCalls, 1);
});

test('a fresh process blocks before lego after a crash between account rename and state checkpoint', async t => {
  const { config, job, account, files, directory } = await workspace(t);
  const coreUrl = new URL('../src/core.mjs', import.meta.url).href;
  const child = await runProcess(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { runOnce } from ${JSON.stringify(coreUrl)};
    const config = ${JSON.stringify(config)};
    console.log(process.pid);
    const originalRename = fs.rename.bind(fs);
    fs.rename = async (source, target) => {
      await originalRename(source, target);
      if (path.basename(target) === 'account') process.exit(0);
    };
    await runOnce(config, { executor: async (_exe, args) => {
      if (args.includes('--version')) return { code: 0, stdout: 'lego version 5.5.2', stderr: '' };
      if (args.includes('--help')) return { code: 0, stdout: '--cert.name --renew-force', stderr: '' };
      return ${JSON.stringify(missingAccount)};
    } });
    process.exitCode = 99;
  `], { cwd: directory, timeoutMs: 15000 });
  assert.equal(child.code, 0);
  await assert.rejects(fs.lstat(account), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(files.state), { code: 'ENOENT' });
  const lock = path.join(config.dataDir, config.environment, '.run.lock');
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).pid, Number(child.stdout.trim()));
  // The fixture process has exited and never spawned children. Model a user
  // safely clearing only this verified stale test lock before restarting.
  await fs.unlink(lock);
  const restarted = await runProcess(process.execPath, ['--input-type=module', '-e', `
    import { runOnce } from ${JSON.stringify(coreUrl)};
    const result = await runOnce(${JSON.stringify(config)}, { executor: async () => { throw new Error('ACME must not run after an unconfirmed move'); } });
    console.log(JSON.stringify(result));
  `], { cwd: directory, timeoutMs: 15000 });
  assert.equal(restarted.code, 0);
  const [result] = JSON.parse(restarted.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error, ACCOUNT_RECOVERY_CHECKPOINT_ERROR);
  const [marker] = (await fs.readdir(files.lego)).filter(name => name.startsWith('.certflow-account-quarantine-'));
  assert.deepEqual(await fs.readFile(path.join(files.lego, marker, 'account', `${config.email}.key`)), privateKey);
  await assert.rejects(fs.lstat(account), { code: 'ENOENT' });
});

test('directory sync failure after rename reports the preserved account and blocks subsequent registration', async t => {
  const { config, job, account, server, files } = await workspace(t);
  let syncCalls = 0;
  const recovered = await quarantineIncompleteAccount(config, job, server, { synchronize: async () => {
    syncCalls += 1;
    if (syncCalls === 3) throw new Error('simulated post-rename disk failure');
  } });
  assert.equal(recovered.durabilityUnconfirmed, true);
  await assert.rejects(fs.lstat(account), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(recovered.quarantineDirectory, 'account', `${config.email}.key`)), privateKey);
  await fs.writeFile(files.state, JSON.stringify({ acmeAccountRecovery: recovered }), { mode: 0o600 });
  const [result] = await runOnce(config, { ignoreBackoff: true, executor: async () => assert.fail('unconfirmed account durability must prevent another ACME process') });
  assert.equal(result.ok, false);
  assert.equal(result.error, ACCOUNT_RECOVERY_DURABILITY_ERROR);
  assert.equal(JSON.parse(await fs.readFile(files.state, 'utf8')).acmeAccountRecovery.durabilityUnconfirmed, true);
});

test('failure to checkpoint a moved account stops before the extra lego invocation', async t => {
  const { config, job, files } = await workspace(t);
  const originalRename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target === files.state) throw new Error('test state checkpoint failure');
    return originalRename(source, target);
  });
  let attempts = 0;
  const [result] = await runOnce(config, { executor: async (_executable, args) => {
    if (args.includes('--version')) return { ...success, stdout: 'lego version 5.5.2' };
    if (args.includes('--help')) return { ...success, stdout: '--cert.name --renew-force' };
    attempts += 1;
    return missingAccount;
  } });
  assert.equal(attempts, 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /隔离保留.*尚未开始重试/);
  assert.equal(result.stateError, true);
  assert.deepEqual(await fs.readFile(path.join(result.accountRecovery.quarantineDirectory, 'account', `${config.email}.key`)), privateKey);
});

test('a failed account retry uses the new safe diagnosis and cannot loop on later runs', async t => {
  const { config, job, account, files } = await workspace(t);
  let attempts = 0;
  const executor = async (_executable, args) => {
    if (args.includes('--version')) return { ...success, stdout: 'lego version 5.5.2' };
    if (args.includes('--help')) return { ...success, stdout: '--cert.name --renew-force' };
    attempts += 1;
    if (attempts === 2) {
      await writeAccount(config, job, { key: replacementKey });
      return { code: 1, stdout: '', stderr: 'urn:ietf:params:acme:error:rateLimited private-retry-output' };
    }
    return missingAccount;
  };
  const [first] = await runOnce(config, { executor });
  assert.equal(attempts, 2);
  assert.equal(first.ok, false);
  assert.match(first.error, /隔离保留.*重试一次.*请勿删除/);
  assert.ok(first.error.endsWith(ACME_DIAGNOSTICS.RATE_LIMITED));
  assert.equal(first.error.includes('private-retry-output'), false);
  assert.deepEqual(await fs.readFile(path.join(first.accountRecovery.quarantineDirectory, 'account', `${config.email}.key`)), privateKey);
  assert.deepEqual(await fs.readFile(path.join(account, `${config.email}.key`)), replacementKey);
  const [backoff] = await runOnce(config, { executor });
  assert.equal(backoff.action, 'backoff');
  assert.equal(attempts, 2);
  const [later] = await runOnce(config, { executor, ignoreBackoff: true });
  assert.equal(attempts, 3, 'the durable marker forbids another automatic quarantine/retry');
  assert.equal(later.error, ACME_DIAGNOSTICS.ACCOUNT_NOT_FOUND);
  assert.deepEqual(await fs.readFile(path.join(account, `${config.email}.key`)), replacementKey);
  assert.equal((await fs.readdir(files.lego)).filter(name => name.startsWith('.certflow-account-quarantine-')).length, 1);
});

test('an account error outside the resolve phase or with a registered account keeps the original failure', async t => {
  for (const kind of ['registered', 'wrong-phase']) await t.test(kind, async t => {
    const { config, job, account, files } = await workspace(t);
    if (kind === 'registered') await writeAccount(config, job, { fields: { registration: { status: 'valid' } } });
    const original = await fs.readFile(path.join(account, 'account.json'));
    let attempts = 0;
    const [result] = await runOnce(config, { executor: async (_executable, args) => {
      if (args.includes('--version')) return { ...success, stdout: 'lego version 5.5.2' };
      if (args.includes('--help')) return { ...success, stdout: '--cert.name --renew-force' };
      attempts += 1;
      return kind === 'wrong-phase' ? { ...missingAccount, stderr: missingAccount.stderr.replace('resolve account by key:', 'new order:') } : missingAccount;
    } });
    assert.equal(attempts, 1);
    assert.equal(result.error, ACME_DIAGNOSTICS.ACCOUNT_NOT_FOUND);
    assert.deepEqual(await fs.readFile(path.join(account, 'account.json')), original);
    assert.deepEqual(await fs.readdir(files.lego), ['accounts']);
  });
});
