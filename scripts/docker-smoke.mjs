import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const image = process.argv[2] ?? 'certflow:local';
const name = `certflow-smoke-${randomUUID().slice(0, 12)}`;
const volume = `${name}-data`;
const password = `fake-container-password-${randomUUID()}`;
const probe = await fs.readFile(new URL('./container-probe.mjs', import.meta.url), 'utf8');

function docker(args, { input, quiet = false, includeStderr = false, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', data => stdout.push(data));
    child.stderr.on('data', data => stderr.push(data));
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString();
      const err = Buffer.concat(stderr).toString();
      if (code !== 0) reject(new Error(`docker ${args[0]} failed (${code}): ${err || out}`));
      else { const output = includeStderr ? out + err : out; if (!quiet && output.trim()) console.log(output.trim()); resolve(output.trim()); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function healthy() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const status = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', name], { quiet: true }));
    if (!status.Running) throw new Error(`Container stopped before becoming healthy (exit ${status.ExitCode}).`);
    if (status.Health?.Status === 'healthy') return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Container health check timed out.');
}

let created = false, volumeCreated = false;
try {
  await docker(['volume', 'create', volume], { quiet: true }); volumeCreated = true;
  // A network-less container makes accidental CA or DNS-provider requests impossible.
  await docker([
    'run', '--detach', '--name', name, '--network', 'none', '--init', '--read-only',
    '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--mount', `type=volume,src=${volume},dst=/data`,
    '--health-interval', '1s', '--health-start-period', '1s', '--health-timeout', '5s', '--health-retries', '10',
    '--env', 'CERTFLOW_PORT=3391', '--env', 'CERTFLOW_PUBLIC_URL=http://127.0.0.1:3391',
    '--env', `CERTFLOW_ADMIN_PASSWORD=${password}`, image,
  ], { quiet: true }); created = true;
  await healthy();
  const detail = JSON.parse(await docker(['inspect', name], { quiet: true }))[0];
  assert.equal(detail.Config.User, '1000:1000');
  assert.equal(detail.HostConfig.ReadonlyRootfs, true);
  assert.equal(detail.HostConfig.NetworkMode, 'none');
  await docker(['exec', name, 'lego', '--version']);
  for (const phase of ['save', 'reload', 'cleared']) {
    if (phase !== 'save') { await docker(['restart', '--time', '15', name], { quiet: true }); await healthy(); }
    await docker(['exec', '-i', name, 'node', '--input-type=module', '-', phase], { input: probe });
  }
  console.log('Docker smoke passed: Linux lego, dynamic health port, nonroot/read-only runtime, authentication, encrypted credentials and config persistence across two restarts. No external network or ACME requests.');
} catch (error) {
  if (created) {
    const logs = await docker(['logs', '--tail', '60', name], { quiet: true, includeStderr: true }).catch(() => '');
    if (logs) console.error(logs.replaceAll(password, '[redacted]'));
  }
  throw error;
} finally {
  // Only remove this invocation's uniquely named disposable container and volume.
  if (created) await docker(['rm', '--force', name], { quiet: true });
  if (volumeCreated) await docker(['volume', 'rm', volume], { quiet: true });
}
