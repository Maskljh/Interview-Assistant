// Generates public/pwa-192x192.png and public/pwa-512x512.png.
// Dependency-free: encodes PNGs with node:zlib. Colors from src/styles/tokens.css
// and the brand palette in public/favicon.svg: background #171717, bubble #ffffff,
// tail #863bff.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BG = [0x17, 0x17, 0x17];
const WHITE = [0xff, 0xff, 0xff];
const VIOLET = [0x86, 0x3b, 0xff];

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function coverage(px, py, cx, cy, r) {
  const d = Math.hypot(px - cx, py - cy);
  return Math.max(0, Math.min(1, r + 0.5 - d));
}

function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const r = size * 0.36; // bubble radius
  const tail = { x: c + r * 0.45, y: c + r * 0.4, radius: r * 0.5 };
  const dots = [
    { x: c - size * 0.1, y: c, radius: size * 0.035 },
    { x: c, y: c, radius: size * 0.035 },
    { x: c + size * 0.1, y: c, radius: size * 0.035 },
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const col = BG.slice();
      const paint = (target, cover) => {
        for (let i = 0; i < 3; i++) col[i] = Math.round(col[i] + (target[i] - col[i]) * cover);
      };
      paint(VIOLET, coverage(px, py, tail.x, tail.y, tail.radius));
      paint(WHITE, coverage(px, py, c, c, r));
      for (const d of dots) paint(BG, coverage(px, py, d.x, d.y, d.radius));
      const off = (y * size + x) * 4;
      buf[off] = col[0];
      buf[off + 1] = col[1];
      buf[off + 2] = col[2];
      buf[off + 3] = 255;
    }
  }
  return buf;
}

function writePng(path, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const pixels = renderIcon(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

writePng(join(outDir, 'pwa-192x192.png'), 192);
writePng(join(outDir, 'pwa-512x512.png'), 512);
console.log('icons written to', outDir);
