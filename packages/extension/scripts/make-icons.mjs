// Generates public/icons/{16,48,128}.png: a rounded indigo tile with a white "resync" arrow.
// Dependency-free PNG writer (zlib + CRC32). Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(out, { recursive: true });

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** Coverage of pixel (x, y) in a size x size icon, 4x4 supersampled. Returns [r, g, b, a]. */
function pixel(x, y, size) {
  let tile = 0;
  let arrow = 0;
  const S = 4;
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < S; j++) {
      const u = (x + (i + 0.5) / S) / size; // 0..1
      const v = (y + (j + 0.5) / S) / size;
      // Rounded square, corner radius 0.22.
      const r = 0.22;
      const dx = Math.max(r - u, 0, u - (1 - r));
      const dy = Math.max(r - v, 0, v - (1 - r));
      if (dx * dx + dy * dy <= r * r) tile++;
      // Arrow: shaft + head pointing right.
      const shaft = u > 0.2 && u < 0.6 && v > 0.42 && v < 0.58;
      const head = u >= 0.5 && u < 0.82 && Math.abs(v - 0.5) < (0.82 - u) * 0.95;
      if (shaft || head) arrow++;
    }
  }
  const t = tile / (S * S);
  const a = arrow / (S * S);
  const bg = [79, 70, 229]; // indigo
  const rgb = bg.map((c) => Math.round(c * (1 - a) + 255 * a));
  return [...rgb, Math.round(255 * t)];
}

for (const size of [16, 48, 128]) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = pixel(x, y, size);
      p.forEach((val, k) => (raw[y * (size * 4 + 1) + 1 + x * 4 + k] = val));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(path.join(out, `${size}.png`), png);
  console.log(`wrote ${size}.png (${png.length} bytes)`);
}
