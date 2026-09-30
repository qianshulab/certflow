// Isolated, restartable UI fixture. Never point this helper at a user workspace.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from '../server.mjs';
import { validateConfig, jobPaths } from '../src/core.mjs';
import { localPaths, writeLocalJson } from '../src/local-state.mjs';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '3392' },
  jobs: { type: 'string', default: '100' },
  workspace: { type: 'string' },
  'simulate-run': { type: 'boolean', default: false },
  'step-ms': { type: 'string', default: '750' },
  cleanup: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('Create:   node scripts/ui-fixture.mjs --port 3392 --jobs 100\nSimulate: node scripts/ui-fixture.mjs --port 3393 --jobs 100 --simulate-run --step-ms 750\nResume:   node scripts/ui-fixture.mjs --port 3392 --workspace "<printed path>" (repeat --simulate-run for a simulated workspace)\nCleanup:  node scripts/ui-fixture.mjs --cleanup --workspace "<printed path>"\nOnly fake .test domains; real issuance and preflight executables are disabled.');
  process.exit(0);
}
const port = Number(values.port), count = Number(values.jobs);
const simulate = values['simulate-run'], stepMs = Number(values['step-ms']);
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 3390) throw new Error('Use a fixture port from 1–65535 other than the user service port 3390.');
if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('--jobs must be an integer from 1 to 500.');
if (!Number.isInteger(stepMs) || stepMs < 25 || stepMs > 5000) throw new Error('--step-ms must be an integer from 25 to 5000.');
if (values.cleanup && !values.workspace) throw new Error('--cleanup requires the exact --workspace path previously printed by this helper.');

// Discard inherited real provider credentials in this process before createApp
// collects its environment. The normal CertFlow process is never affected.
for (const name of ['DNSPOD_API_ID', 'DNSPOD_API_TOKEN', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY', 'CF_DNS_API_TOKEN', 'ALICLOUD_ACCESS_KEY', 'ALICLOUD_SECRET_KEY']) {
  delete process.env[name]; delete process.env[`${name}_FILE`];
}
const parent = path.join(await fs.realpath(os.tmpdir()), 'certflow-ui-fixtures');
await fs.mkdir(parent, { recursive: true, mode: 0o700 });
if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('Fixture parent must not be a symbolic link.');
const parentReal = await fs.realpath(parent);
const markerName = '.certflow-ui-fixture.json';
const markerKind = 'certflow-ui-fixture-v1';

async function checkedWorkspace(input) {
  const resolved = path.resolve(input);
  if (path.dirname(resolved) !== parentReal || !path.basename(resolved).startsWith('workspace-')) throw new Error('Workspace is outside the dedicated fixture directory.');
  const info = await fs.lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(resolved) !== resolved) throw new Error('Fixture workspace must be an ordinary directory.');
  const markerPath = path.join(resolved, markerName);
  const markerInfo = await fs.lstat(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4096) throw new Error('Fixture marker is not a regular file.');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  if (marker.kind !== markerKind || marker.workspace !== resolved) throw new Error('Fixture ownership marker does not match.');
  if (!values.cleanup && Boolean(marker.simulateRun) !== simulate) throw new Error('Fixture mode mismatch. Restart with the same --simulate-run setting used when this workspace was created.');
  return resolved;
}

let workspace;
if (values.workspace) {
  workspace = await checkedWorkspace(values.workspace);
} else {
  workspace = await fs.mkdtemp(path.join(parentReal, 'workspace-'));
  await fs.writeFile(path.join(workspace, markerName), JSON.stringify({ kind: markerKind, workspace, simulateRun: simulate, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  const webroot = path.join(workspace, 'http-fixture');
  if (simulate) await fs.mkdir(webroot, { mode: 0o700 });
  const config = {
    // Acceptance is synthetic test metadata only. No real CA is ever contacted.
    email: 'qa@example.test', acceptTerms: simulate, environment: 'staging',
    legoPath: 'certflow-ui-fixture-execution-disabled', dataDir: './data',
    jobs: Array.from({ length: count }, (_, index) => {
      const id = `qa-${String(index + 1).padStart(3, '0')}`;
      return { id, enabled: (index + 1) % 7 !== 0,
        domains: simulate ? [`${id}.example.test`] : [`${id}.example.test`, `*.${id}.example.test`],
        challenge: simulate ? { type: 'http', webroot } : { type: 'dns', provider: 'dnspod-token' }, deployment: null };
    }),
  };
  const configPath = path.join(workspace, 'cert-config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const normalized = validateConfig(config, workspace);
  for (const [index, job] of normalized.jobs.entries()) {
    if ((index + 1) % 11 !== 0) continue;
    const files = jobPaths(normalized, job);
    await fs.mkdir(files.directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(files.state, JSON.stringify({
      lastError: 'UI fixture: 模拟 DNS 验证失败（未连接任何服务商）',
      failureCount: 1, lastAttemptAt: new Date().toISOString(),
    }), { flag: 'wx', mode: 0o600 });
  }
}
const lockPath = path.join(workspace, '.fixture-running');

async function simulateRun(config, { only, onProgress } = {}) {
  const jobs = only ? config.jobs.filter(job => job.id === only) : config.jobs.filter(job => job.enabled !== false);
  if (config.environment !== 'staging' || jobs.some(job => job.challenge.type !== 'http' || job.deployment || job.domains.some(domain => !domain.endsWith('.test')))) throw new Error('UI fixture: 模拟执行仅接受测试环境、.test 域名、HTTP 验证及无部署的任务。');
  const results = [];
  for (const [index, job] of jobs.entries()) {
    const simulatedFailure = (config.jobs.indexOf(job) + 1) % 11 === 0;
    await onProgress?.({ type: 'job-start', id: job.id, index: index + 1, total: jobs.length });
    const shortStep = Math.max(1, Math.floor(stepMs / 10));
    const reportPhase = async (phase, delayMs = shortStep) => {
      await onProgress?.({ type: 'job-phase', id: job.id, index: index + 1, total: jobs.length, phase });
      await new Promise(resolve => setTimeout(resolve, delayMs));
    };
    await reportPhase('preparing');
    await reportPhase('credentials');
    await reportPhase('client');
    await reportPhase('acme', Math.max(1, stepMs - 5 * shortStep));
    if (!simulatedFailure) {
      await reportPhase('certificate');
      await reportPhase('export');
    }
    const result = simulatedFailure
      ? { id: job.id, ok: false, action: 'failed', error: 'UI fixture: 模拟失败结果，未联系 CA / DNS，也未生成证书。' }
      : { id: job.id, ok: true, action: 'unchanged', warning: 'UI fixture: 模拟完成结果，未联系 CA / DNS，也未生成证书。' };
    results.push(result);
    await onProgress?.({ type: 'job-complete', id: job.id, index: index + 1, total: jobs.length, result });
  }
  return results;
}

if (values.cleanup) {
  try { await fs.access(lockPath); throw new Error('Fixture is still running or was not shut down cleanly. Stop it before cleanup.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Repeat ownership and absolute-path checks immediately before recursive removal.
  await checkedWorkspace(workspace);
  await fs.rm(workspace, { recursive: true, force: false });
  console.log(`Removed only fixture workspace: ${workspace}`);
} else {
  const lock = await fs.open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('This fixture is already running or has a stale .fixture-running lock. Stop the previous helper first.');
    throw error;
  });
  await lock.writeFile(JSON.stringify({ pid: process.pid, port }));
  await lock.close();
  let app, released = false;
  async function release() {
    if (released) return;
    released = true;
    await fs.unlink(lockPath);
  }
  try {
    const configPath = path.join(workspace, 'cert-config.json');
    // Restart preserves saved task edits, while this fixture always starts with
    // automatic renewal off. Even if enabled through the UI, run cannot issue.
    await writeLocalJson(localPaths(configPath).preferences, { autoRenew: false });
    app = await createApp({
      configPath, host: '127.0.0.1', port,
      run: simulate ? simulateRun : async () => { throw new Error('UI fixture: 真实申请、续期和部署已硬性禁用。'); },
      inspect: async () => ({ ok: false, checkedAt: new Date().toISOString(), checks: [
        { id: 'fixture', label: '界面验收环境', status: 'warning', detail: '仅用于列表、编辑和保存交互验收。外部客户端与 DNS API 调用已禁用。' },
      ] }),
      credentialStore: {
        metadata: { protection: 'fixture-disabled', label: 'UI fixture：凭据保存禁用' },
        load: async () => ({}),
        save: async () => { throw new Error('UI fixture: 不保存任何 DNS 凭据。'); },
        update: async () => { throw new Error('UI fixture: 不保存任何 DNS 凭据。'); },
      },
    });
    const stop = async () => { await app.close(); await release(); };
    process.once('SIGINT', () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
    process.once('SIGTERM', () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
    app.server.once('close', () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
    console.log(`UI fixture: ${app.url}\nWorkspace: ${workspace}\nConfig: ${configPath}\nMode: ${simulate ? `simulated progress, ${stepMs} ms per task` : 'execution disabled'}\nFake tasks only. Real issuance, deployment, credential storage and external preflight are disabled.\nClose with Ctrl+C or the fixture page's shutdown action. The workspace is preserved for restart.`);
  } catch (error) {
    if (app) await app.close();
    await release();
    throw error;
  }
}
