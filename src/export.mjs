import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';

// One immutable directory per issued certificate prevents mixing export generations.
export async function exportCertificate({ directory, certificate, privateKey }) {
  const blocks = certificate.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks?.length) throw new Error('没有可导出的 PEM 证书。');
  for (const block of blocks) new X509Certificate(block);
  const leaf = new X509Certificate(blocks[0]);
  const id = createHash('sha256').update(leaf.raw).digest('hex');
  const destination = path.join(directory, id);
  const contents = {
    'cert.pem': `${blocks[0]}\n`,
    'chain.pem': blocks.length > 1 ? `${blocks.slice(1).join('\n')}\n` : '',
    'fullchain.pem': `${blocks.join('\n')}\n`,
    'privkey.pem': privateKey,
  };
  const files = {
    directory: destination, certificate: path.join(destination, 'cert.pem'),
    chain: path.join(destination, 'chain.pem'), fullchain: path.join(destination, 'fullchain.pem'),
    privateKey: path.join(destination, 'privkey.pem'),
  };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let existing;
  try { existing = await fs.lstat(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('导出目标必须是普通目录。');
    for (const [filename, content] of Object.entries(contents)) {
      let saved;
      try { saved = await fs.readFile(path.join(destination, filename)); }
      catch { throw new Error('已有证书导出文件缺失或不可读取，请检查对应导出目录后再重试。'); }
      if (!saved.equals(Buffer.from(content))) throw new Error('已有证书导出文件被修改，请检查对应导出目录后再重试。');
    }
    return files;
  }
  const temporary = path.join(directory, `.export-${randomUUID()}`);
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    for (const [filename, content] of Object.entries(contents)) {
      await fs.writeFile(path.join(temporary, filename), content, { mode: 0o600, flag: 'wx' });
    }
    await fs.rename(temporary, destination);
  } finally {
    // Remove only known files in our staging directory, never recursively delete.
    for (const filename of Object.keys(contents)) await fs.rm(path.join(temporary, filename), { force: true });
    try { await fs.rmdir(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files;
}
