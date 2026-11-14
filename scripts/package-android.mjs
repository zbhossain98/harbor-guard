import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PACKAGE_DOCUMENTS, excludePackageEntry } from './package-files.mjs';

// Only known source trees are packaged; local SDKs, keys, profiles and Android
// build output stay outside the archive. Node built-ins keep packaging portable.
const root = fileURLToPath(new URL('../', import.meta.url));
async function entries(directory, prefix) {
  const output = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (excludePackageEntry(item.name)) continue;
    const name = `${prefix}${item.name}`;
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) output.push(...await entries(filename, `${name}/`));
    else if (item.isFile()) output.push({ name, data: await readFile(filename) });
    else throw new Error(`Unsupported source entry: ${name}`);
  }
  return output;
}
const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  table[n] = crc >>> 0;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const records = [], directory = [];
  let offset = 0;
  for (const { name, data } of files) {
    const filename = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    records.push(local, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, central, end]);
}
const files = [];
for (const name of PACKAGE_DOCUMENTS) files.push({ name, data: await readFile(path.join(root, name)) });
for (const name of ['.github', 'android', 'extension', 'scripts', 'tests', 'windows', 'data']) files.push(...await entries(path.join(root, name), `${name}/`));
const metadata = JSON.parse(await readFile(path.join(root, 'android/app/src/main/assets/build-info.json'), 'utf8'));
const output = path.join(root, `dist/harbortube-${metadata.version}-source.zip`);
await mkdir(path.dirname(output), { recursive: true });
const bytes = zip(files);
await writeFile(output, bytes);
await writeFile(`${output}.sha256`, `${createHash('sha256').update(bytes).digest('hex')}  ${path.basename(output)}\n`);
console.log(`Created ${output} (${files.length} source files).`);
