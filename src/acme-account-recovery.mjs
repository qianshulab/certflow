import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const MAX_ACCOUNT_FILE_BYTES = 64 * 1024;
export const ACCOUNT_RECOVERY_DURABILITY_ERROR = '未完成的 ACME 账户已隔离保留，但无法确认目录已同步到磁盘。已停止自动重试，请检查磁盘和隔离目录，确认原账户完整后再人工恢复。';
export const ACCOUNT_RECOVERY_CHECKPOINT_ERROR = '检测到未确认的 ACME 账户恢复记录。为避免重复注册，已停止自动申请；请检查当前账户、隔离目录和任务状态，保留全部文件后再人工恢复。';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink;
const guard = (condition) => { if (!condition) throw new Error('Account recovery guard failed'); };

// Account recovery happens before lego starts DNS validation. Require that
// exact v5 failure context, not an arbitrary account error elsewhere in output.
export function isMissingAccountRecoveryFailure(result) {
  if (!Number.isSafeInteger(result?.code) || result.code <= 0) return false;
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-131072);
  const markers = [...text.matchAll(/(?:Could not|Unable to) obtain certificates:/gi)];
  const failure = markers.length ? text.slice(markers.at(-1).index) : text;
  return /\bresolve account by key:\s*[^\n]*urn:ietf:params:acme:error:accountDoesNotExist\b/.test(failure);
}

async function inspectAncestors(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  const ancestors = [];
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    guard(stat.isDirectory() && !stat.isSymbolicLink());
    ancestors.push({ filename: current, stat });
  }
  return ancestors;
}

async function checkAncestors(ancestors) {
  for (const { filename, stat } of ancestors) {
    const current = await fs.lstat(filename);
    guard(current.isDirectory() && !current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino);
  }
}

async function inspectTree(directory) {
  const entries = [];
  const visit = async (filename, depth) => {
    guard(depth <= 16 && entries.length < 1024);
    const stat = await fs.lstat(filename);
    guard(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()));
    if (stat.isFile()) guard(stat.nlink === 1);
    entries.push({ filename, stat });
    if (stat.isDirectory()) for (const name of (await fs.readdir(filename)).sort()) await visit(path.join(filename, name), depth + 1);
  };
  await visit(directory, 0);
  return entries;
}

async function readRegularFile(filename, privateFile = false) {
  const before = await fs.lstat(filename);
  guard(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= MAX_ACCOUNT_FILE_BYTES);
  if (privateFile && process.platform !== 'win32') guard((before.mode & 0o077) === 0 && before.uid === process.getuid());
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    guard(sameFile(before, await handle.stat()));
    const bytes = await handle.readFile();
    guard(bytes.length <= MAX_ACCOUNT_FILE_BYTES && sameFile(before, await handle.stat()));
    return bytes;
  } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return; // Windows does not expose directory fsync through Node.
  const handle = await fs.open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

function validateKey(bytes, keyType) {
  const key = createPrivateKey(bytes);
  const actualType = key.asymmetricKeyType === 'ec'
    ? ({ prime256v1: 'EC256', secp384r1: 'EC384' })[key.asymmetricKeyDetails?.namedCurve]
    : key.asymmetricKeyType === 'rsa' ? `RSA${key.asymmetricKeyDetails?.modulusLength}` : null;
  guard(['EC256', 'EC384', 'RSA2048', 'RSA3072', 'RSA4096', 'RSA8192'].includes(actualType) && actualType === keyType);
  const probe = Buffer.from('CertFlow local ACME account key validation');
  guard(verify('sha256', probe, createPublicKey(key), sign('sha256', probe, key)));
}

function recoveryLayout(config, job, server) {
  guard(['staging', 'production'].includes(config.environment) && config.jobs.includes(job));
  guard(typeof job.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(job.id));
  guard(path.isAbsolute(config.dataDir));
  guard(server === `https://acme${config.environment === 'staging' ? '-staging' : ''}-v02.api.letsencrypt.org/directory`);
  const email = config.email;
  guard(typeof email === 'string' && email === email.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  guard(!/[<>:"/\\|?*\x00-\x1f]/.test(email) && !/[. ]$/.test(email) && path.basename(email) === email);
  const lego = path.join(config.dataDir, config.environment, job.id, 'lego');
  return {
    email, lego,
    accountDirectory: path.join(lego, 'accounts', new URL(server).host, email),
    quarantineDirectory: path.join(lego, `.certflow-account-quarantine-${hash(JSON.stringify([server, email]))}`),
  };
}

// Check before the first lego invocation, not only after another account error.
// A crash after rename but before the state checkpoint leaves no active account,
// so lego would otherwise register a new one without entering recovery again.
export async function accountRecoveryNeedsReview(config, job, server, checkpoint) {
  let layout;
  try { layout = recoveryLayout(config, job, server); }
  catch { return false; } // Unsupported layouts cannot opt into recovery.
  let marker;
  try { marker = await fs.lstat(layout.quarantineDirectory); }
  catch (error) { return error.code === 'ENOENT' ? checkpoint?.quarantineDirectory === layout.quarantineDirectory : true; }
  try {
    guard(marker.isDirectory() && !marker.isSymbolicLink());
    await inspectAncestors(layout.quarantineDirectory);
    guard(checkpoint && checkpoint.quarantineDirectory === layout.quarantineDirectory && [undefined, false].includes(checkpoint.durabilityUnconfirmed));
    const manifest = JSON.parse((await readRegularFile(path.join(layout.quarantineDirectory, 'manifest.json'), true)).toString('utf8'));
    guard(manifest.format === 1 && manifest.reason === 'incomplete-acme-account' && Number.isFinite(Date.parse(manifest.attemptedAt)) && manifest.attemptedAt === checkpoint.attemptedAt);
    const preserved = await fs.lstat(path.join(layout.quarantineDirectory, 'account'));
    guard(preserved.isDirectory() && !preserved.isSymbolicLink());
    return false;
  } catch { return true; }
}

// The caller holds the environment run lock and has received the exact lego
// recovery error. This intentionally supports only our selected v5 account
// layout; uncertain, legacy, linked, or already registered accounts stay put.
export async function quarantineIncompleteAccount(config, job, server, { synchronize = syncDirectory } = {}) {
  let movedOutcome = null;
  try {
    const { email, lego, accountDirectory, quarantineDirectory } = recoveryLayout(config, job, server);
    const ancestors = await inspectAncestors(accountDirectory);
    const tree = await inspectTree(accountDirectory);
    const json = await readRegularFile(path.join(accountDirectory, 'account.json'));
    const account = JSON.parse(json.toString('utf8'));
    guard(account && !Array.isArray(account) && typeof account === 'object');
    guard(Object.hasOwn(account, 'registration') && account.registration === null);
    guard(account.id === email && account.email === email && account.server === server);
    const key = await readRegularFile(path.join(accountDirectory, `${email}.key`), true);
    validateKey(key, account.keyType);

    // Exclusive creation is also a persistent one-time marker. Never reuse,
    // overwrite, or remove it, even after a crash or an unsuccessful retry.
    await checkAncestors(ancestors);
    await fs.mkdir(quarantineDirectory, { mode: 0o700 });
    const quarantineStat = await fs.lstat(quarantineDirectory);
    guard(quarantineStat.isDirectory() && !quarantineStat.isSymbolicLink() && quarantineStat.dev === tree[0].stat.dev);
    if (process.platform !== 'win32') guard((quarantineStat.mode & 0o077) === 0 && quarantineStat.uid === process.getuid());
    const attemptedAt = new Date().toISOString();
    const manifest = await fs.open(path.join(quarantineDirectory, 'manifest.json'), 'wx', 0o600);
    try {
      await manifest.writeFile(`${JSON.stringify({ format: 1, attemptedAt, reason: 'incomplete-acme-account' }, null, 2)}\n`);
      await manifest.sync();
    } finally { await manifest.close(); }
    await synchronize(quarantineDirectory);
    await synchronize(lego);

    await checkAncestors(ancestors);
    const currentQuarantine = await fs.lstat(quarantineDirectory);
    guard(currentQuarantine.isDirectory() && !currentQuarantine.isSymbolicLink() && currentQuarantine.ino === quarantineStat.ino && currentQuarantine.dev === quarantineStat.dev);
    if (process.platform !== 'win32') guard((currentQuarantine.mode & 0o077) === 0 && currentQuarantine.uid === process.getuid());
    const currentTree = await inspectTree(accountDirectory);
    guard(currentTree.length === tree.length && tree.every((entry, index) => entry.filename === currentTree[index].filename && sameFile(entry.stat, currentTree[index].stat)));
    guard((await readRegularFile(path.join(accountDirectory, 'account.json'))).equals(json));
    guard((await readRegularFile(path.join(accountDirectory, `${email}.key`), true)).equals(key));
    // The private, newly-created destination is a sibling of accounts and is
    // on the same filesystem, so rename preserves the whole account atomically.
    await fs.rename(accountDirectory, path.join(quarantineDirectory, 'account'));
    movedOutcome = { attemptedAt, quarantineDirectory };
    await synchronize(quarantineDirectory);
    await synchronize(path.dirname(accountDirectory));
    return movedOutcome;
  } catch {
    // Once rename succeeds, never pretend that nothing moved. Persist this
    // distinction so a later scheduled run cannot bypass an unconfirmed flush.
    if (movedOutcome) return { ...movedOutcome, durabilityUnconfirmed: true };
    // Guard, read, or backup failures do not authorize a new registration.
    // The caller reports the original fixed ACME diagnosis without raw paths.
    return null;
  }
}
