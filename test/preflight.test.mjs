import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preflight } from '../src/preflight.mjs';
import { jobPaths, validateConfig } from '../src/core.mjs';

async function workspace(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'certflow-preflight-'));
  t.after(async () => { assert.equal(path.dirname(directory), parent); assert.match(path.basename(directory), /^certflow-preflight-/); await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
}
const raw = () => ({ email: 'operator@mydomain.test', acceptTerms: true, environment: 'staging', jobs: [{ id: 'nas', domains: ['nas.mydomain.test'], challenge: { type: 'dns', provider: 'dnspod-token' } }] });
const env = { DNSPOD_API_ID: '12', DNSPOD_API_TOKEN: 'fake-token-for-preflight' };

test('preflight checks readiness without creating storage, issuing or changing DNS', async (t) => {
  const directory = await workspace(t);
  const calls = [];
  const result = await preflight(validateConfig(raw(), directory), { env, executor: async (_exe, args) => { calls.push(args); return { code: 0, stdout: 'lego version 5.5.2 linux/amd64' }; } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['--version']]);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(result.checks.find(check => check.id === 'nas:credentials').status, 'pass');
  assert.match(result.checks.find(check => check.id === 'nas:credentials').detail, /不验证远端权限/);
  assert.equal(JSON.stringify(result).includes(env.DNSPOD_API_TOKEN), false);
});

test('missing credentials, wrong client, placeholders and terms each produce actionable failures', async (t) => {
  const directory = await workspace(t);
  const value = raw(); value.email = 'you@example.com'; value.acceptTerms = false;
  const result = await preflight(validateConfig(value, directory), { env: {}, executor: async () => ({ code: 0, stdout: 'lego version 4.31.0' }) });
  assert.equal(result.ok, false);
  for (const id of ['account', 'terms', 'client', 'nas:credentials']) assert.equal(result.checks.find(check => check.id === id).status, 'fail');
});

test('paused jobs are excluded from readiness checks unless explicitly selected', async (t) => {
  const directory = await workspace(t);
  const value = raw(); value.jobs[0].enabled = false;
  const config = validateConfig(value, directory);
  const executor = async () => ({ code: 0, stdout: 'lego version 5.5.2' });
  const all = await preflight(config, { env: {}, executor });
  assert.equal(all.checks.some(check => check.id === 'nas:credentials'), false);
  const selected = await preflight(config, { env: {}, executor, only: 'nas' });
  assert.equal(selected.checks.find(check => check.id === 'nas:credentials').status, 'fail');
  await assert.rejects(preflight(config, { only: 'absent', executor }), /不存在/);
});

test('preflight reports existing run and deployment locks without removing or trusting their PID', async (t) => {
  const directory = await workspace(t);
  const value = raw();
  value.environment = 'production';
  value.jobs[0].deployment = { directory: './live', checkCommand: ['never-run-check'], reloadCommand: ['never-run-reload'] };
  const config = validateConfig(value, directory);
  const runLock = path.join(config.dataDir, config.environment, '.run.lock');
  const deployLock = path.join(config.jobs[0].deployment.directory, '.cert-deploy.lock');
  const content = JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z' });
  for (const filename of [runLock, deployLock]) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
  }
  const calls = [];
  const result = await preflight(config, { env, executor: async (_exe, args) => { calls.push(args); return { code: 0, stdout: 'lego version 5.5.2' }; } });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.id === 'run-lock').status, 'fail');
  assert.equal(result.checks.find(check => check.id === 'nas:deployment').status, 'fail');
  assert.deepEqual(calls, [['--version']]);
  for (const filename of [runLock, deployLock]) assert.equal(await fs.readFile(filename, 'utf8'), content);
});

test('preflight isolates corrupt job state, checks only selected jobs, and preserves its bytes', async (t) => {
  const directory = await workspace(t);
  const value = raw();
  value.jobs.push({ ...value.jobs[0], id: 'other', enabled: false });
  const config = validateConfig(value, directory);
  const filename = jobPaths(config, config.jobs[1]).state;
  const content = '{broken-local-state';
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
  const executor = async () => ({ code: 0, stdout: 'lego version 5.5.2' });
  const all = await preflight(config, { env, executor });
  assert.equal(all.ok, true);
  assert.equal(all.checks.some(check => check.id === 'other:state'), false);
  const selected = await preflight(config, { env, executor, only: 'other' });
  assert.equal(selected.ok, false);
  assert.equal(selected.checks.find(check => check.id === 'other:state').status, 'fail');
  assert.equal(await fs.readFile(filename, 'utf8'), content);
  await assert.rejects(fs.stat(jobPaths(config, config.jobs[0]).state), { code: 'ENOENT' });
});
