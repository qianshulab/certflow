// Install only the pinned upstream executable used by integration tests.
// The release archive is verified before extraction or execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const version = '5.5.2';
const targets = {
  'win32-x64': { archive: `lego_v${version}_windows_amd64.zip`, binary: 'lego.exe', sha256: 'fc544130a2716329cad73a47b674e3aeea019c4753c3963d259bd45d946bbd34' },
  'linux-x64': { archive: `lego_v${version}_linux_amd64.tar.gz`, binary: 'lego', sha256: '2a35505089e7772c92e1e9ac144df91151ef2eca8568630db0ff91fca06d9bef' },
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`Pinned test client supports Windows x64 and Linux x64, received ${process.platform}-${process.arch}.`);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const toolsDirectory = path.join(root, '.tools');
await fs.mkdir(toolsDirectory, { recursive: true });
const temporary = await fs.mkdtemp(path.join(toolsDirectory, 'lego-setup-'));

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} failed (${code}): ${Buffer.concat(stderr).toString()}`));
      else resolve(Buffer.concat(stdout).toString().trim());
    });
  });
}

try {
  const url = `https://github.com/go-acme/lego/releases/download/v${version}/${target.archive}`;
  console.log(`Downloading ${target.archive} from the upstream release.`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), headers: { 'User-Agent': 'CertFlow-test-client-setup' } });
  if (!response.ok || !response.body) throw new Error(`Upstream release download failed: HTTP ${response.status}.`);
  const archivePath = path.join(temporary, target.archive);
  const file = await fs.open(archivePath, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) throw new Error('Upstream archive exceeded the 128 MiB limit.');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    await file.sync();
  } finally { await file.close(); }
  if (hash.digest('hex') !== target.sha256) throw new Error('Upstream archive SHA-256 mismatch; refusing to extract or execute it.');
  const extracted = path.join(temporary, 'extracted');
  await fs.mkdir(extracted);
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:CERTFLOW_TEST_ARCHIVE -DestinationPath $env:CERTFLOW_TEST_EXTRACT";
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      ...process.env, CERTFLOW_TEST_ARCHIVE: archivePath, CERTFLOW_TEST_EXTRACT: extracted,
    });
  } else {
    await run('tar', ['-xzf', archivePath, '-C', extracted, target.binary]);
  }
  const source = path.join(extracted, target.binary);
  const sourceInfo = await fs.lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('Upstream executable is not a regular file.');
  const directory = path.join(toolsDirectory, `lego-v${version}`);
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, target.binary);
  const expected = await fs.readFile(source);
  const existing = await fs.readFile(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!existing?.equals(expected)) await fs.copyFile(source, destination);
  if (process.platform !== 'win32') await fs.chmod(destination, 0o755);
  const result = await run(destination, ['--version']);
  if (!new RegExp(`version ${version.replaceAll('.', '\\.')}\\b`).test(result)) throw new Error('Installed executable version did not match the pinned release.');
  console.log(`SHA-256 verified. ${result}`);
} finally {
  // Remove only this invocation's freshly created extraction directory.
  if (path.dirname(temporary) !== toolsDirectory || !path.basename(temporary).startsWith('lego-setup-')) throw new Error('Refusing unsafe temporary directory cleanup.');
  await fs.rm(temporary, { recursive: true, force: true });
}
