import { mkdir, chmod, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requiresProcessCleanup } from './process-safety.mjs';

const JOURNAL = '.cert-deploy-journal.json';
const LOCK = '.cert-deploy.lock';
const BACKUPS = '.cert-backups';
const FILES = ['fullchain.pem', 'privkey.pem'];

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Certificate deployment directories must be regular directories.');
  }
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

async function readRegular(file, optional = false) {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Expected a regular certificate deployment file: ${path.basename(file)}`);
  }
  return readFile(file);
}

// Each rename replaces ONE file atomically. The certificate/key pair is not atomic.
async function atomicWrite(file, content, temporary) {
  let handle;
  try {
    await rm(temporary, { force: true });
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function transactionPaths(directory, id) {
  return {
    journal: path.join(directory, JOURNAL),
    journalTemporary: path.join(directory, `${JOURNAL}.${id}.tmp`),
    backup: path.join(directory, BACKUPS, id),
  };
}

async function saveJournal(directory, journal) {
  const paths = transactionPaths(directory, journal.id);
  await atomicWrite(paths.journal, `${JSON.stringify(journal)}\n`, paths.journalTemporary);
}

async function loadJournal(directory) {
  const raw = await readRegular(path.join(directory, JOURNAL), true);
  if (raw === null) return null;
  let journal;
  try {
    journal = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('The certificate deployment journal is invalid; manual recovery is required.');
  }
  if (journal?.version !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(journal.id)
      || !Array.isArray(journal.existed) || journal.existed.length !== 2
      || journal.existed.some(value => typeof value !== 'boolean')
      || typeof journal.reloadAttempted !== 'boolean') {
    throw new Error('The certificate deployment journal is invalid; manual recovery is required.');
  }
  return journal;
}

async function cleanTransaction(directory, journal) {
  const paths = transactionPaths(directory, journal.id);
  for (const name of FILES) {
    await rm(path.join(paths.backup, `new-${name}.tmp`), { force: true });
    await rm(path.join(paths.backup, `restore-${name}.tmp`), { force: true });
  }
  await rm(paths.journalTemporary, { force: true });
  // Retain the previous files in the backup directory; removing the journal commits.
  await rm(paths.journal);
}

async function rollback(directory, journal, reloadCommand, runCommand, environment) {
  const paths = transactionPaths(directory, journal.id);
  const failures = [];
  let previous;
  try {
    // Read all required backups first so a missing backup cannot cause half a restore.
    previous = await Promise.all(FILES.map((name, index) => journal.existed[index]
      ? readRegular(path.join(paths.backup, name)) : null));
  } catch (error) {
    return [error];
  }
  for (let index = 0; index < FILES.length; index += 1) {
    const target = path.join(directory, FILES[index]);
    try {
      if (journal.existed[index]) {
        await atomicWrite(target, previous[index], path.join(paths.backup, `restore-${FILES[index]}.tmp`));
      } else {
        await rm(target, { force: true });
      }
    } catch (error) {
      failures.push(error);
    }
  }
  // Never reload a pair known to have failed restoration.
  if (failures.length === 0 && journal.reloadAttempted) {
    try {
      if (reloadCommand.length === 0) throw new Error('The recovery reload command is missing.');
      await runCommand(reloadCommand, environment);
    } catch (error) {
      failures.push(new Error('Reloading the previous configuration failed.', { cause: error }));
    }
  }
  if (failures.length === 0) {
    try {
      await cleanTransaction(directory, journal);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function validateDeployment(deployment, runCommand) {
  const { directory, checkCommand = [], reloadCommand = [] } = deployment;
  if (!path.isAbsolute(directory)) throw new Error('The deployment directory must be absolute.');
  if (![checkCommand, reloadCommand].every(command => Array.isArray(command)
      && command.every(part => typeof part === 'string'))) {
    throw new Error('Deployment commands must be argument arrays.');
  }
  if ((checkCommand.length || reloadCommand.length) && typeof runCommand !== 'function') {
    throw new Error('A command runner is required for deployment commands.');
  }
  return { directory, checkCommand, reloadCommand };
}

async function withDeploymentLock(directory, action) {
  await privateDirectory(directory);
  const lockPath = path.join(directory, LOCK);
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const locked = new Error(`Certificate deployment lock exists: ${lockPath}. Confirm the previous process has stopped before manually removing this lock.`, { cause: error });
    locked.code = 'EDEPLOYLOCKED';
    throw locked;
  }
  let result;
  let original;
  let failed = false;
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    await handle.sync();
    result = await action();
  } catch (error) {
    original = error;
    failed = true;
  }
  const cleanupErrors = [];
  try { await handle.close(); } catch (error) { cleanupErrors.push(error); }
  if (!requiresProcessCleanup(original)) {
    try { await rm(lockPath); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(failed ? [original, ...cleanupErrors] : cleanupErrors,
      'Certificate deployment lock cleanup failed.', failed ? { cause: original } : undefined);
  }
  if (failed) throw original;
  return result;
}

function deploymentEnvironment(directory) {
  return {
    CERT_FULLCHAIN: path.join(directory, FILES[0]),
    CERT_PRIVATE_KEY: path.join(directory, FILES[1]),
  };
}

async function recoverUnlocked(deployment, runCommand) {
  const { directory, reloadCommand } = deployment;
  const pending = await loadJournal(directory);
  if (pending) {
    const failures = await rollback(directory, pending, reloadCommand, runCommand, deploymentEnvironment(directory));
    if (failures.length) {
      throw new AggregateError(failures, 'Unfinished certificate deployment recovery failed; rollback failed.');
    }
  }
  return { recovered: pending !== null, directory };
}

/** Recover before ACME/network/credential work; no new certificate is needed. */
export async function recoverDeployment({ deployment, runCommand }) {
  const validated = validateDeployment(deployment, runCommand);
  return withDeploymentLock(validated.directory, () => recoverUnlocked(validated, runCommand));
}

/**
 * The caller validates certificate contents. A directory lock serializes deployments.
 * After a process crash the operator must confirm the old process has stopped and
 * remove its stale lock; a surviving journal can then recover using the current
 * reload command. This is not pair-atomic replacement or a power-loss guarantee.
 * The server must load files only on reload. POSIX files are 0600 and directories
 * 0700; Windows ACLs are managed by the operator.
 */
export async function deployCertificate(parameters) {
  const deployment = validateDeployment(parameters.deployment, parameters.runCommand);
  return withDeploymentLock(deployment.directory, () => deployUnlocked({ ...parameters, deployment }));
}

async function deployUnlocked({ certificate, privateKey, fingerprint, deployment, runCommand }) {
  const { directory, checkCommand, reloadCommand } = deployment;
  await recoverUnlocked(deployment, runCommand);
  const environment = deploymentEnvironment(directory);
  const previous = await Promise.all(FILES.map(name => readRegular(path.join(directory, name), true)));
  let journal = { version: 1, id: randomUUID(), existed: previous.map(value => value !== null), reloadAttempted: false };
  const paths = transactionPaths(directory, journal.id);
  await privateDirectory(path.join(directory, BACKUPS));
  await privateDirectory(paths.backup);
  for (let index = 0; index < FILES.length; index += 1) {
    if (previous[index] !== null) {
      const backup = path.join(paths.backup, FILES[index]);
      await atomicWrite(backup, previous[index], `${backup}.tmp`);
    }
  }
  // No live file changes until both backups and the journal have been written.
  await saveJournal(directory, journal);
  try {
    for (const [index, content] of [certificate, privateKey].entries()) {
      await atomicWrite(path.join(directory, FILES[index]), content, path.join(paths.backup, `new-${FILES[index]}.tmp`));
    }
    if (checkCommand.length) await runCommand(checkCommand, environment);
    if (reloadCommand.length) {
      const attempted = { ...journal, reloadAttempted: true };
      await saveJournal(directory, attempted);
      journal = attempted;
      await runCommand(reloadCommand, environment);
    }
    await cleanTransaction(directory, journal);
    return { fingerprint, directory };
  } catch (error) {
    if (requiresProcessCleanup(error)) {
      throw new AggregateError([error], '无法确认部署子进程已停止，已保留部署锁和恢复记录；确认进程全部结束后再恢复，暂不并发回滚。', { cause: error });
    }
    const failures = await rollback(directory, journal, reloadCommand, runCommand, environment);
    if (failures.length) {
      throw new AggregateError([error, ...failures], 'Certificate deployment failed; rollback failed. The journal was retained for recovery.', { cause: error });
    }
    throw error;
  }
}
