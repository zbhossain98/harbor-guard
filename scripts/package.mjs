import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PACKAGE_DOCUMENTS, excludePackageEntry } from './package-files.mjs';

// A portable ZIP packager using only Node built-ins. No execution-policy change,
// package download, or external archiver is needed.
const root = new URL('../', import.meta.url);
for (const script of ['scripts/check.mjs', 'scripts/update-rules.mjs']) {
  const args = [fileURLToPath(new URL(script, root)), ...(script.includes('update-rules') ? ['--check'] : [])];
  const checked = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (checked.status !== 0) process.exit(checked.status || 1);
}
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
async function entries(directory, prefix = '') {
  const output = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (excludePackageEntry(item.name)) continue;
    const name = `${prefix}${item.name}`;
    if (item.isDirectory()) output.push(...await entries(new URL(`${item.name}/`, directory), `${name}/`));
    else if (item.isFile()) output.push({ name, data: await readFile(new URL(item.name, directory)) });
    else throw new Error(`Unsupported package entry: ${name}`);
  }
  return output;
}
function buildZip(files) {
  const localRecords = [];
  const directoryRecords = [];
  let offset = 0;
  for (const { name, data } of files) {
  const filename = Buffer.from(name, 'utf8');
  const compressed = deflateRawSync(data);
  const checksum = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(33, 12); // Stable ZIP date: January 1, 1980.
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(filename.length, 26);
  localRecords.push(header, filename, compressed);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(33, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(offset, 42);
  directoryRecords.push(central, filename);
  offset += header.length + filename.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(directoryRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}
const manifest = JSON.parse(await readFile(new URL('extension/manifest.json', root), 'utf8'));
const output = new URL(`dist/harbor-guard-${manifest.version}.zip`, root);
await mkdir(new URL('dist/', root), { recursive: true });
const files = await entries(new URL('extension/', root));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  files.push({ name, data: await readFile(new URL(name, root)) });
}
await writeFile(output, buildZip(files));
console.log(`Created ${fileURLToPath(output)} (${files.length} files).\nExtract it, then select the extracted folder with Load unpacked in Chrome or Edge.`);

// Deliver the local source, reproducible filter inputs and notices alongside the
// installable archive. Only known project directories are included, never .git,
// credentials, build output, or user/browser data.
const sourceFiles = [];
for (const name of PACKAGE_DOCUMENTS) sourceFiles.push({ name, data: await readFile(new URL(name, root)) });
for (const name of ['.github', 'android', 'extension', 'scripts', 'tests', 'windows', 'data']) {
  try { sourceFiles.push(...await entries(new URL(`${name}/`, root), `${name}/`)); }
  catch (error) { if (name !== 'data' || error.code !== 'ENOENT') throw error; }
}
const sourceOutput = new URL(`dist/harbor-guard-${manifest.version}-source.zip`, root);
await writeFile(sourceOutput, buildZip(sourceFiles));
console.log(`Created ${fileURLToPath(sourceOutput)} (${sourceFiles.length} source files).`);
