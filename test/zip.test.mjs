import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createZip } from '../src/zip.mjs';

test('certificate ZIP can be read by the platform ZIP implementation', async (t) => {
  const parent = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'certflow-zip-'));
  t.after(async () => { assert.equal(path.dirname(directory), parent); assert.match(path.basename(directory), /^certflow-zip-/); await fs.rm(directory, { recursive: true, force: true }); });
  const archivePath = path.join(directory, 'bundle.zip');
  await fs.writeFile(archivePath, createZip([{ name: 'cert.pem', content: 'CERTIFICATE\n' }, { name: 'chain.pem', content: '' }, { name: 'privkey.pem', content: 'TEST KEY\n' }]));
  let result;
  if (process.platform === 'win32') {
    const script = "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($env:CERTFLOW_TEST_ZIP); try { $rows = @($z.Entries | ForEach-Object { $r = [IO.StreamReader]::new($_.Open()); try { [pscustomobject]@{ name=$_.FullName; content=$r.ReadToEnd() } } finally { $r.Dispose() } }); ConvertTo-Json -InputObject $rows -Compress } finally { $z.Dispose() }";
    result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, CERTFLOW_TEST_ZIP: archivePath }, encoding: 'utf8', windowsHide: true });
  } else {
    result = spawnSync('python3', ['-c', 'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps([dict(name=n,content=z.read(n).decode()) for n in z.namelist()]))', archivePath], { encoding: 'utf8' });
  }
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), [{ name: 'cert.pem', content: 'CERTIFICATE\n' }, { name: 'chain.pem', content: '' }, { name: 'privkey.pem', content: 'TEST KEY\n' }]);
});

test('ZIP refuses directory traversal, duplicate names, and oversized content', () => {
  assert.throws(() => createZip([{ name: '../private.key', content: '' }]));
  assert.throws(() => createZip([{ name: 'a', content: '' }, { name: 'a', content: '' }]));
  assert.throws(() => createZip([{ name: 'a', content: Buffer.alloc(10 * 1024 * 1024 + 1) }]));
});
