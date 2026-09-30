import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getStatus, runProcess } from './core.mjs';
import { loadDnsPodCredentials } from './dnspod-token.mjs';

const PROVIDERS = {
  'dnspod-token': ['DNSPOD_API_ID', 'DNSPOD_API_TOKEN'],
  tencentcloud: ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'],
  cloudflare: ['CF_DNS_API_TOKEN'],
  alidns: ['ALICLOUD_ACCESS_KEY', 'ALICLOUD_SECRET_KEY'],
};

const LINUX_LOCK_MARKER = '{"protocol":"certflow-flock-v1"}\n';

async function probeKernelLock(fd) {
  return new Promise((resolve, reject) => {
    // Pass an already-open read-only descriptor. This probe must never create
    // or alter the persistent lock marker just to check readiness.
    const child = spawn('/usr/bin/flock', ['-x', '-n', '-E', '75', '3'],
      { stdio: ['ignore', 'ignore', 'ignore', fd], env: {} });
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}

async function lockState(filename) {
  if (process.platform !== 'linux') {
    try { await fs.lstat(filename); return 'busy'; }
    catch (error) { if (error.code === 'ENOENT') return 'free'; throw error; }
  }
  try { await fs.lstat(`${filename}.unsafe`); return 'unsafe'; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let marker;
  try { marker = await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return 'free'; throw error; }
  if (!marker.isFile() || marker.isSymbolicLink() || marker.uid !== process.getuid() ||
      (marker.mode & 0o077) || marker.size !== Buffer.byteLength(LINUX_LOCK_MARKER)) return 'legacy';
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== marker.dev || opened.ino !== marker.ino ||
        await handle.readFile('utf8') !== LINUX_LOCK_MARKER) return 'legacy';
    const code = await probeKernelLock(handle.fd);
    return code === 0 ? 'free' : code === 75 ? 'busy' : 'error';
  } finally { await handle.close(); }
}

async function writableAncestor(directory) {
  let current = directory;
  for (;;) {
    try {
      const info = await fs.stat(current);
      if (!info.isDirectory()) throw new Error('not a directory');
      await fs.access(current, constants.R_OK | constants.W_OK);
      return current === directory;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function preflight(config, { only, env = process.env, executor = runProcess } = {}) {
  const jobs = only ? config.jobs.filter((job) => job.id === only) : config.jobs.filter((job) => job.enabled !== false);
  if (only && !jobs.length) throw new Error('证书任务不存在。');
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  add('selection', '任务范围', jobs.length ? 'pass' : 'warning', jobs.length ? `本次检查 ${jobs.length} 个任务。` : '所有任务均已暂停；全部执行与自动续期将跳过这些任务。');
  add('environment', '签发环境', config.environment === 'production' ? 'pass' : 'warning', config.environment === 'production' ? '正式环境，将申请浏览器信任的证书。' : '当前为测试环境，测试证书不会被浏览器信任。');
  const placeholders = config.email === 'you@example.com' || jobs.some((job) => job.domains.some((domain) => /^(?:\*\.)?example\.(?:com|net|org)$/.test(domain)));
  add('account', '邮箱与域名', placeholders ? 'fail' : 'pass', placeholders ? '请替换示例邮箱和 example.com 等示例域名。' : '邮箱和域名格式有效。');
  add('terms', '服务条款', config.acceptTerms ? 'pass' : 'fail', config.acceptTerms ? '已确认服务条款。' : '请阅读并同意服务条款后再申请。');
  try {
    const client = await executor(config.legoPath, ['--version'], { cwd: config.baseDir, env, timeoutMs: 15000 });
    const version = client.stdout?.match(/\blego version v?(5\.\d+\.\d+)/)?.[1];
    add('client', 'ACME 客户端', client.code === 0 && version ? 'pass' : 'fail', client.code === 0 && version ? `lego ${version} 可以启动。` : '需要可运行的 lego v5；请检查高级设置中的客户端路径。');
  } catch { add('client', 'ACME 客户端', 'fail', '无法启动 lego，请检查客户端安装、执行权限和路径。'); }
  try {
    const exists = await writableAncestor(config.dataDir);
    add('storage', '证书数据目录', 'pass', exists ? '数据目录可读取和写入。' : '上级目录可写，首次运行时会创建数据目录。');
  } catch { add('storage', '证书数据目录', 'fail', '数据目录不可读写。Docker 中请检查持久化挂载和运行用户权限。'); }
  if (jobs.length) {
    try {
      const state = await lockState(path.join(config.dataDir, config.environment, '.run.lock'));
      const detail = state === 'free' ? '未发现阻止本轮执行的运行锁。'
        : state === 'busy' ? process.platform === 'linux'
          ? '已有任务正在运行。请等待当前执行结束后再检查；本检查不会移除锁。'
          : '已有任务运行或遗留运行锁。请先确认所有实例及相关子进程已停止，再按故障恢复说明处理；本检查不会移除锁。'
          : state === 'unsafe' ? '上次进程树清理未确认。请确认相关子进程全部结束，再按故障恢复说明移除 .unsafe 标记。'
            : state === 'legacy' ? '发现旧版或无效的运行锁标记。请确认相关进程已停止，再按故障恢复说明处理。'
              : '无法探测系统运行锁；请检查 util-linux flock 与数据目录权限。';
      add('run-lock', '执行锁', state === 'free' ? 'pass' : 'fail', detail);
    } catch (error) {
      add('run-lock', '执行锁', 'fail', process.platform === 'linux'
        ? '无法检查运行锁，请检查数据目录权限与 util-linux flock。'
        : '无法检查运行锁，请检查数据目录权限。');
    }
  }
  const statuses = await getStatus({ ...config, jobs });
  for (const job of jobs) {
    const status = statuses.find((item) => item.id === job.id);
    add(`${job.id}:state`, `${job.id} · 本地运行状态`, status.stateError ? 'fail' : 'pass', status.stateError
      ? '任务状态文件损坏或不可读取。请先备份数据并修复该任务的 state.json；原文件不会被自动覆盖。'
      : '本地运行状态可读取，或将在首次运行时建立。');
    if (job.challenge.type === 'dns') {
      try {
        if (job.challenge.provider === 'dnspod-token') await loadDnsPodCredentials(env);
        else for (const key of PROVIDERS[job.challenge.provider]) {
          const value = env[key] || (env[`${key}_FILE`] ? await fs.readFile(env[`${key}_FILE`], 'utf8') : '');
          if (!value.trim()) throw new Error('Missing credential');
        }
        add(`${job.id}:credentials`, `${job.id} · DNS 凭据`, 'pass', '凭据字段完整，可供申请使用；本检查不访问 DNS API，不验证远端权限。');
      } catch { add(`${job.id}:credentials`, `${job.id} · DNS 凭据`, 'fail', '凭据缺失、格式无效或凭据文件不可读取，请在 DNS 凭据中检查。'); }
    } else {
      try {
        if (!(await fs.stat(job.challenge.webroot)).isDirectory()) throw new Error();
        await fs.access(job.challenge.webroot, constants.R_OK | constants.W_OK);
        add(`${job.id}:webroot`, `${job.id} · HTTP 验证目录`, 'warning', '目录可读写。仍需确保公网 80 端口可以访问 /.well-known/acme-challenge/。');
      } catch { add(`${job.id}:webroot`, `${job.id} · HTTP 验证目录`, 'fail', 'HTTP 验证目录不存在或不可读写。'); }
    }
    if (job.deployment) {
      try {
        await writableAncestor(job.deployment.directory);
        const state = await lockState(path.join(job.deployment.directory, '.cert-deploy.lock'));
        const detail = state === 'free'
          ? '目标目录或上级目录可写。检查与重载命令仅在实际部署时执行，本次未运行。'
          : state === 'busy' ? process.platform === 'linux'
            ? '部署目录正在由另一进程使用。请等待当前部署完成后再检查。'
            : '发现部署锁。请确认之前的部署进程已结束，再按故障恢复说明处理；本检查不会删除锁或更改证书。'
            : state === 'unsafe' ? '上次部署子进程清理未确认。请确认相关进程已停止，再按故障恢复说明移除 .unsafe 标记。'
              : state === 'legacy' ? '发现旧版或无效的部署锁标记。请确认相关进程已停止，再按故障恢复说明处理。'
                : '无法探测系统部署锁；请检查 util-linux flock 与目录权限。';
        add(`${job.id}:deployment`, `${job.id} · 自动部署`, state === 'free' ? 'warning' : 'fail', detail);
      }
      catch { add(`${job.id}:deployment`, `${job.id} · 自动部署`, 'fail', '部署目录或运行锁无法检查，请检查路径权限、容器挂载与 util-linux flock。'); }
    } else add(`${job.id}:deployment`, `${job.id} · 使用方式`, 'warning', '签发后下载并安装证书。NAS 管理页面在每次续期后需要重新导入。');
  }
  return { ok: !checks.some((check) => check.status === 'fail'), checkedAt: new Date().toISOString(), checks };
}
