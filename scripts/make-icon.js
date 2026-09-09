'use strict';
/**
 * Generates the tray icon as a PNG with no image dependency.
 *
 * The glyph is a "notch": a gauge ring with a gap at the bottom, which is the
 * same shape the panel draws. Two sizes are emitted so Electron can pick the
 * right representation on a HiDPI display (`tray-icon.png` = 16px logical,
 * `tray-icon@2x.png` = 32px).
 *
 *   node scripts/make-icon.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Supersampled ring so the 16px version does not look like a staircase. */
function drawNotch(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 4;                       // samples per axis
  const c = (size - 1) / 2;
  const outer = size * 0.46;
  const inner = size * 0.28;
  const gapHalf = 0.62;               // radians, gap centred at the bottom
  const color = [0xf2, 0xf2, 0xf2];   // near-white; Windows tray is dark

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss - 0.5;
          const py = y + (sy + 0.5) / ss - 0.5;
          const dx = px - c;
          const dy = py - c;
          const r = Math.sqrt(dx * dx + dy * dy);
          if (r < inner || r > outer) continue;
          const a = Math.atan2(dy, dx);          // +PI/2 is straight down
          let d = Math.abs(a - Math.PI / 2);
          if (d > Math.PI) d = 2 * Math.PI - d;
          if (d < gapHalf) continue;
          hits++;
        }
      }
      const alpha = Math.round((hits / (ss * ss)) * 255);
      const o = (y * size + x) * 4;
      rgba[o] = color[0];
      rgba[o + 1] = color[1];
      rgba[o + 2] = color[2];
      rgba[o + 3] = alpha;
    }
  }
  return rgba;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [size, name] of [[16, 'tray-icon.png'], [32, 'tray-icon@2x.png'], [64, 'tray-icon@4x.png']]) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, encodePng(size, size, drawNotch(size)));
  process.stdout.write(`wrote ${file}\n`);
}
