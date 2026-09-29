// A small ZIP writer for four PEM files. STORE avoids compression dependencies;
// archive names are fixed by the server, never taken from a filesystem path.
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw new Error('Invalid ZIP entries');
  const names = new Set(), localParts = [], centralParts = [];
  let offset = 0, totalSize = 0;
  for (const { name, content } of entries) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,100}$/.test(name) || names.has(name)) throw new Error('Invalid ZIP entry name');
    names.add(name);
    const filename = Buffer.from(name), data = Buffer.from(content);
    totalSize += data.length;
    if (totalSize > 10 * 1024 * 1024) throw new Error('ZIP content too large');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12); // 1980-01-01, deterministic archive timestamps.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    localParts.push(header, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += header.length + filename.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
