import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

// Small original shield icon, rasterized locally. No external assets or packages.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
function inside(x, y, polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [a, b] = polygon[i], [c, d] = polygon[j];
    if (((b > y) !== (d > y)) && x < (c - a) * (y - b) / (d - b) + a) result = !result;
  }
  return result;
}
function segmentDistance(x, y, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
}
const shield = [[.5,.06],[.88,.2],[.88,.48],[.82,.68],[.68,.83],[.5,.95],[.32,.83],[.18,.68],[.12,.48],[.12,.2]];
await mkdir(new URL('../extension/icons/', import.meta.url), { recursive: true });
for (const size of [16,32,48,128]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r=0,g=0,b=0,a=0;
    for(let sy=0;sy<4;sy++) for(let sx=0;sx<4;sx++) {
      const px=(x+(sx+.5)/4)/size, py=(y+(sy+.5)/4)/size;
      if (!inside(px,py,shield)) continue;
      const check=Math.min(segmentDistance(px,py,.32,.48,.46,.61),segmentDistance(px,py,.46,.61,.71,.35))<.046;
      r+=check?218:43;g+=check?237:96;b+=check?185:68;a+=255;
    }
    const offset=y*(size*4+1)+1+x*4;
    const samples=a/255;
    raw[offset]=samples?r/samples:0;raw[offset+1]=samples?g/samples:0;raw[offset+2]=samples?b/samples:0;raw[offset+3]=a/16;
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
  await writeFile(new URL(`../extension/icons/icon${size}.png`, import.meta.url),png);
}
console.log('Created four local Harbor Guard PNG icons.');
