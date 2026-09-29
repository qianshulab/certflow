import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { exportCertificate } from '../src/export.mjs';

const certificate = await fs.readFile(new URL('./fixtures/server-cert.test.txt', import.meta.url));
const privateKey = await fs.readFile(new URL('./fixtures/server-key.test.txt', import.meta.url));
const canonical = certificate.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0] + '\n';

async function directoryFor(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'https-cert-export-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('self-signed certificate exports an empty chain and preserves the matching private key', async (t) => {
  const directory = await directoryFor(t);
  const files = await exportCertificate({ directory, certificate, privateKey });
  assert.equal(await fs.readFile(files.certificate, 'utf8'), canonical);
  assert.equal(await fs.readFile(files.chain, 'utf8'), '');
  assert.equal(await fs.readFile(files.fullchain, 'utf8'), canonical);
  const exportedKey = await fs.readFile(files.privateKey);
  assert.deepEqual(exportedKey, privateKey);
  assert.ok(new X509Certificate(await fs.readFile(files.certificate)).checkPrivateKey(createPrivateKey(exportedKey)));
  assert.match(path.basename(files.directory), /^[a-f0-9]{64}$/);
  assert.equal(path.dirname(files.directory), directory);
});

test('PEM bundle exports the first block as leaf and remaining blocks as the chain', async (t) => {
  const directory = await directoryFor(t);
  // Duplicate test blocks exercise splitting only; this is not a real trust chain.
  const bundle = Buffer.from(canonical + canonical + canonical);
  const files = await exportCertificate({ directory, certificate: bundle, privateKey });
  assert.equal(await fs.readFile(files.certificate, 'utf8'), canonical);
  assert.equal(await fs.readFile(files.chain, 'utf8'), canonical + canonical);
  assert.equal(await fs.readFile(files.fullchain, 'utf8'), bundle.toString());
});

test('re-exporting an identical certificate returns the same paths without changing contents or modification times', async (t) => {
  const directory = await directoryFor(t);
  const first = await exportCertificate({ directory, certificate, privateKey });
  const filePaths = Object.entries(first).filter(([name]) => name !== 'directory').map(([, filename]) => filename);
  const before = await Promise.all(filePaths.map(async filename => ({
    bytes: await fs.readFile(filename), mtime: (await fs.stat(filename)).mtimeMs,
  })));
  const second = await exportCertificate({ directory, certificate, privateKey });
  assert.deepEqual(second, first);
  for (const [index, filename] of filePaths.entries()) {
    assert.deepEqual(await fs.readFile(filename), before[index].bytes);
    assert.equal((await fs.stat(filename)).mtimeMs, before[index].mtime);
  }
  assert.deepEqual(await fs.readdir(directory), [path.basename(first.directory)]);
});

test('tampered exported files are rejected and the modified file is never silently overwritten', async (t) => {
  for (const name of ['certificate', 'chain', 'fullchain', 'privateKey']) {
    await t.test(name, async (t) => {
      const directory = await directoryFor(t);
      const files = await exportCertificate({ directory, certificate, privateKey });
      const changed = `modified test file: ${name}\n`;
      await fs.writeFile(files[name], changed);
      await assert.rejects(exportCertificate({ directory, certificate, privateKey }), /被修改/);
      assert.equal(await fs.readFile(files[name], 'utf8'), changed);
    });
  }
});

test('invalid PEM is rejected before creating an export directory', async (t) => {
  const base = await directoryFor(t);
  const directory = path.join(base, 'not-created');
  await assert.rejects(exportCertificate({ directory, certificate: Buffer.from('not a certificate'), privateKey }), /PEM/);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});
