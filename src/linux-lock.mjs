import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MARKER = '{"protocol":"certflow-flock-v1"}\n';
const locked = message => Object.assign(new Error(message), { code: 'ELOCKED' });

// A permanent, private inode is required for flock. An atomic hard link makes
// the marker visible only after its complete contents have been written. It
// also excludes older wx-based CertFlow processes from starting on this path.
async function ensureMarker(filename, legacyMessage) {
  for (;;) {
    let info;
    try { info = await fs.lstat(filename); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) ||
          info.size !== Buffer.byteLength(MARKER) || await fs.readFile(filename, 'utf8') !== MARKER) {
        throw locked(legacyMessage);
      }
      return;
    }
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const staged = await fs.open(temporary, 'wx', 0o600);
      try { await staged.writeFile(MARKER); await staged.sync(); }
      finally { await staged.close(); }
      try { await fs.link(temporary, filename); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { await fs.rm(temporary, { force: true }); }
  }
}

/** Hold a Linux kernel flock through a cat subprocess. Closing the parent's
 * pipe on normal exit or process death releases the lock. The caller must
 * retain the marker inode and release only after all protected work ends.
 */
export async function acquireLinuxLock(filename, { busyMessage, legacyMessage } = {}) {
  if (process.platform !== 'linux') throw new Error('Linux kernel locking is only available on Linux.');
  await ensureMarker(filename, legacyMessage ?? `旧版运行锁需要人工核查：${filename}。`);
  const holder = spawn('/usr/bin/flock', ['-x', '-n', '-E', '75', filename, '/bin/cat'],
    { stdio: ['pipe', 'pipe', 'ignore'], env: {} });
  holder.stdin.on('error', () => { /* A rejected lock may close stdin first. */ });
  const closed = new Promise(resolve => holder.once('close', resolve));
  const acquired = new Promise((resolve, reject) => {
    holder.once('error', () => reject(new Error('无法启动系统文件锁；Linux 需要 util-linux flock。')));
    holder.stdout.once('data', chunk => chunk.length === 1 && chunk[0] === 0x43
      ? resolve() : reject(new Error('运行锁响应无效，证书任务未启动。')));
    void closed.then(code => reject(code === 75
      ? locked(busyMessage ?? `运行锁正在使用：${filename}。`)
      : new Error('无法取得系统文件锁，证书任务未启动。')));
    holder.stdin.write('C');
  });
  try { await acquired; }
  catch (error) { holder.stdin.end(); await closed; throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    holder.stdin.end();
    const code = await closed;
    if (code !== 0) throw new Error('系统运行锁异常退出；请检查证书任务及子进程状态。');
  };
}

/** Keep unsafe subprocess cleanup blocked even if a new marker cannot be
 * written: invalidating the persistent flock marker is the last resort.
 */
export async function markUnsafeLinuxLock(filename) {
  const unsafe = `${filename}.unsafe`;
  let marker;
  try {
    marker = await fs.open(unsafe, 'wx', 0o600);
    await marker.writeFile('process cleanup unconfirmed\n');
    await marker.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') {
      // A failed write after successful creation still leaves the presence
      // marker. If creation failed, make future protocol validation fail.
      await fs.writeFile(filename, 'unsafe cleanup state\n').catch(() => {});
      throw new Error('无法安全记录进程清理状态；运行锁需要人工核查。', { cause: error });
    }
  } finally { await marker?.close(); }
}
