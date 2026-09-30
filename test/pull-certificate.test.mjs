import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('portable pull client: real HTTPS, validated bundles, private storage and service rollback', { timeout: 120000 }, async t => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const python = process.env.CERTFLOW_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const candidates = [process.env.CERTFLOW_TEST_OPENSSL, 'openssl', process.platform === 'win32' && path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe')].filter(Boolean);
  const openssl = candidates.find(command => spawnSync(command, ['version'], { windowsHide: true, shell: false }).status === 0);
  const available = spawnSync(python, ['--version'], { windowsHide: true, shell: false }).status === 0 && openssl;
  if (!available) {
    if (process.env.CI || process.env.CERTFLOW_REQUIRE_LEGO_TEST === '1') assert.fail('Python 3 and OpenSSL are required for pull-client regression tests.');
    return t.skip('Python 3 or OpenSSL is unavailable on this development host.');
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(python, ['-B', path.join(root, 'test', 'pull_certificate_test.py')], {
      cwd: root, shell: false, windowsHide: true,
      env: { ...process.env, CERTFLOW_TEST_OPENSSL: openssl, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Ran 11 tests/);
  if (process.platform === 'linux') assert.doesNotMatch(result.output, /skipped=/, 'Linux must exercise all pull-client tests.');
  else if (result.output.includes('skipped=')) t.diagnostic('Some POSIX symlink/crash transaction cases require Linux; the complete suite also runs on Linux CI.');
});
