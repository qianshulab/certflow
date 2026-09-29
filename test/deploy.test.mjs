import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deployCertificate, recoverDeployment } from '../src/deploy.mjs';
import { processCleanupError, requiresProcessCleanup } from '../src/process-safety.mjs';

const OLD_CERT = 'old certificate\n';
const OLD_KEY = 'old private key\n';
const NEW_CERT = 'new certificate\n';
const NEW_KEY = 'new private key\n';
const JOURNAL = '.cert-deploy-journal.json';

async function fixture(t, existing = true) {
  const prefix = path.join(tmpdir(), 'https-cert-deploy-test-');
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  });
  if (existing) {
    await writeFile(path.join(directory, 'fullchain.pem'), OLD_CERT);
    await writeFile(path.join(directory, 'privkey.pem'), OLD_KEY);
  }
  return directory;
}

function parameters(directory, runCommand) {
  return {
    certificate: Buffer.from(NEW_CERT),
    privateKey: NEW_KEY,
    fingerprint: 'test-fingerprint',
    deployment: { directory, checkCommand: ['check', '--test'], reloadCommand: ['reload'] },
    runCommand,
  };
}

async function contents(directory) {
  return Promise.all(['fullchain.pem', 'privkey.pem'].map(name => readFile(path.join(directory, name), 'utf8')));
}

async function assertMissing(file) {
  await assert.rejects(stat(file), { code: 'ENOENT' });
}

test('successful deployment validates before reload and preserves private backups', async t => {
  const directory = await fixture(t);
  const calls = [];
  const result = await deployCertificate(parameters(directory, async (argv, environment) => {
    calls.push(argv);
    assert.deepEqual(environment, {
      CERT_FULLCHAIN: path.join(directory, 'fullchain.pem'),
      CERT_PRIVATE_KEY: path.join(directory, 'privkey.pem'),
    });
    assert.deepEqual(await contents(directory), [NEW_CERT, NEW_KEY]);
    const journal = await readFile(path.join(directory, JOURNAL), 'utf8');
    for (const secret of [NEW_KEY.trim(), OLD_KEY.trim(), NEW_CERT.trim(), OLD_CERT.trim()]) {
      assert.equal(journal.includes(secret), false);
    }
  }));
  assert.deepEqual(calls, [['check', '--test'], ['reload']]);
  assert.deepEqual(result, { fingerprint: 'test-fingerprint', directory });
  await assertMissing(path.join(directory, JOURNAL));
  const backups = path.join(directory, '.cert-backups');
  const entries = await readdir(backups);
  assert.equal(entries.length, 1);
  const backup = path.join(backups, entries[0]);
  assert.deepEqual(await contents(backup), [OLD_CERT, OLD_KEY]);
  assert.deepEqual((await readdir(backup)).sort(), ['fullchain.pem', 'privkey.pem']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(backup)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, 'privkey.pem'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(backup, 'privkey.pem'))).mode & 0o777, 0o600);
  }
});

test('a failed configuration check restores the pair and never reloads', async t => {
  const directory = await fixture(t);
  const failure = new Error('configuration check failed');
  const calls = [];
  await assert.rejects(deployCertificate(parameters(directory, async argv => {
    calls.push(argv);
    throw failure;
  })), error => error === failure);
  assert.deepEqual(calls, [['check', '--test']]);
  assert.deepEqual(await contents(directory), [OLD_CERT, OLD_KEY]);
  await assertMissing(path.join(directory, JOURNAL));
});

test('a failed first deployment removes new live files and still reports its error', async t => {
  const directory = await fixture(t, false);
  const failure = new Error('first deployment check failed');
  await assert.rejects(deployCertificate(parameters(directory, async () => { throw failure; })), error => error === failure);
  await assertMissing(path.join(directory, 'fullchain.pem'));
  await assertMissing(path.join(directory, 'privkey.pem'));
  await assertMissing(path.join(directory, JOURNAL));
});

test('reload failure restores the files and attempts to reload the previous configuration', async t => {
  const directory = await fixture(t);
  const failure = new Error('new reload failed');
  let reloads = 0;
  await assert.rejects(deployCertificate(parameters(directory, async argv => {
    if (argv[0] !== 'reload') return;
    reloads += 1;
    if (reloads === 1) {
      assert.deepEqual(await contents(directory), [NEW_CERT, NEW_KEY]);
      throw failure;
    }
    assert.deepEqual(await contents(directory), [OLD_CERT, OLD_KEY]);
  })), error => error === failure);
  assert.equal(reloads, 2);
  assert.deepEqual(await contents(directory), [OLD_CERT, OLD_KEY]);
  await assertMissing(path.join(directory, JOURNAL));
});

test('rollback failure preserves the original error and a recoverable journal', async t => {
  const directory = await fixture(t);
  const original = new Error('new configuration failed');
  const recovery = new Error('old configuration failed');
  let reloads = 0;
  await assert.rejects(deployCertificate(parameters(directory, async argv => {
    if (argv[0] === 'reload') throw ++reloads === 1 ? original : recovery;
  })), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /rollback failed/);
    assert.equal(error.cause, original);
    assert.equal(error.errors[0], original);
    assert.equal(error.errors[1].cause, recovery);
    return true;
  });
  assert.deepEqual(await contents(directory), [OLD_CERT, OLD_KEY]);
  const journal = JSON.parse(await readFile(path.join(directory, JOURNAL), 'utf8'));
  assert.equal(journal.reloadAttempted, true);
  let calls = 0;
  await deployCertificate(parameters(directory, async argv => {
    if (calls++ === 0) {
      assert.deepEqual(argv, ['reload']);
      assert.deepEqual(await contents(directory), [OLD_CERT, OLD_KEY]);
    }
  }));
  assert.equal(calls, 3);
  await assertMissing(path.join(directory, JOURNAL));
});

test('an interrupted replacement is restored before a later deployment starts', async t => {
  const directory = await fixture(t);
  const id = 'aabbccdd-1234-5678-9abc-123456789abc';
  const backup = path.join(directory, '.cert-backups', id);
  await mkdir(backup, { recursive: true });
  await writeFile(path.join(backup, 'fullchain.pem'), OLD_CERT);
  await writeFile(path.join(backup, 'privkey.pem'), OLD_KEY);
  await writeFile(path.join(backup, 'new-privkey.pem.tmp'), 'abandoned key');
  await writeFile(path.join(directory, 'fullchain.pem'), 'interrupted certificate');
  await writeFile(path.join(directory, JOURNAL), JSON.stringify({ version: 1, id, existed: [true, true], reloadAttempted: true }));
  const seen = [];
  await deployCertificate(parameters(directory, async argv => {
    seen.push(argv[0]);
    assert.deepEqual(await contents(directory), seen.length === 1 ? [OLD_CERT, OLD_KEY] : [NEW_CERT, NEW_KEY]);
  }));
  assert.deepEqual(seen, ['reload', 'check', 'reload']);
  await assertMissing(path.join(directory, JOURNAL));
  await assertMissing(path.join(backup, 'new-privkey.pem.tmp'));
  assert.deepEqual(await contents(backup), [OLD_CERT, OLD_KEY]);
});

test('invalid journals cannot choose paths outside the backup directory', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, JOURNAL), JSON.stringify({ version: 1, id: '../outside', existed: [true, true], reloadAttempted: false }));
  await assert.rejects(deployCertificate(parameters(directory, async () => assert.fail('must not run'))), /journal is invalid/);
  assert.deepEqual(await contents(directory), [OLD_CERT, OLD_KEY]);
});

test('standalone recovery repairs files without needing a new certificate or an ACME operation', async t => {
  const directory = await fixture(t);
  const id = 'aabbccdd-1234-5678-9abc-123456789abc';
  const backup = path.join(directory, '.cert-backups', id);
  await mkdir(backup, { recursive: true });
  await writeFile(path.join(backup, 'fullchain.pem'), OLD_CERT);
  await writeFile(path.join(backup, 'privkey.pem'), OLD_KEY);
  await writeFile(path.join(directory, 'fullchain.pem'), 'interrupted certificate');
  await writeFile(path.join(directory, JOURNAL), JSON.stringify({ version: 1, id, existed: [true, true], reloadAttempted: true }));
  const calls = [];
  const input = {
    deployment: { directory, reloadCommand: ['reload'] },
    runCommand: async argv => {
      calls.push(argv);
      assert.deepEqual(await contents(directory), [OLD_CERT, OLD_KEY]);
    },
  };
  assert.deepEqual(await recoverDeployment(input), { recovered: true, directory });
  assert.deepEqual(calls, [['reload']]);
  assert.deepEqual(await recoverDeployment(input), { recovered: false, directory });
  await assertMissing(path.join(directory, JOURNAL));
  await assertMissing(path.join(directory, '.cert-deploy.lock'));
});

test('directory lock rejects concurrent deploy and recovery calls, then permits a later call', async t => {
  const directory = await fixture(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let reachedCheck;
  const started = new Promise(resolve => { reachedCheck = resolve; });
  const running = deployCertificate(parameters(directory, async argv => {
    if (argv[0] === 'check') {
      reachedCheck();
      await blocked;
    }
  }));
  try {
    await started;
    await assert.rejects(deployCertificate(parameters(directory, async () => assert.fail('must not run'))), { code: 'EDEPLOYLOCKED' });
    await assert.rejects(recoverDeployment({ deployment: { directory } }), { code: 'EDEPLOYLOCKED' });
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, '.cert-deploy.lock'), 'utf8')).pid, process.pid);
  } finally {
    release();
    await running;
  }
  await assertMissing(path.join(directory, '.cert-deploy.lock'));
  assert.deepEqual(await recoverDeployment({ deployment: { directory } }), { recovered: false, directory });
});

test('a preexisting lock is retained and requires explicit manual recovery', async t => {
  const directory = await fixture(t);
  const lock = path.join(directory, '.cert-deploy.lock');
  await writeFile(lock, 'existing lock');
  await assert.rejects(recoverDeployment({ deployment: { directory } }), error => {
    assert.equal(error.code, 'EDEPLOYLOCKED');
    assert.match(error.message, /Confirm the previous process has stopped/);
    return true;
  });
  assert.equal(await readFile(lock, 'utf8'), 'existing lock');
  assert.deepEqual(await contents(directory), [OLD_CERT, OLD_KEY]);
});

test('ordinary deployment errors release the directory lock', async t => {
  const directory = await fixture(t);
  const failure = new Error('failed check');
  await assert.rejects(deployCertificate(parameters(directory, async () => { throw failure; })), error => error === failure);
  await assertMissing(path.join(directory, '.cert-deploy.lock'));
  assert.deepEqual(await recoverDeployment({ deployment: { directory } }), { recovered: false, directory });
});

test('unconfirmed command termination retains the deployment lock and journal without racing a rollback', async t => {
  const directory = await fixture(t);
  const calls = [];
  await assert.rejects(deployCertificate(parameters(directory, async (argv) => {
    calls.push(argv);
    throw processCleanupError();
  })), error => requiresProcessCleanup(error) && /暂不并发回滚/.test(error.message));
  assert.deepEqual(calls, [['check', '--test']]);
  assert.deepEqual(await contents(directory), [NEW_CERT, NEW_KEY]);
  const journal = JSON.parse(await readFile(path.join(directory, JOURNAL), 'utf8'));
  assert.equal(journal.reloadAttempted, false);
  assert.equal(JSON.parse(await readFile(path.join(directory, '.cert-deploy.lock'), 'utf8')).pid, process.pid);
  await assert.rejects(recoverDeployment({ deployment: { directory } }), { code: 'EDEPLOYLOCKED' });
  // This fixture has no running subprocess. Model the operator-confirmed recovery.
  await rm(path.join(directory, '.cert-deploy.lock'));
  await recoverDeployment({ deployment: { directory } });
  assert.deepEqual(await contents(directory), [OLD_CERT, OLD_KEY]);
  await assertMissing(path.join(directory, JOURNAL));
});
