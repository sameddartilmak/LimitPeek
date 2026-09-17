'use strict';
/**
 * Renders the APP icon (exe, installer, shortcuts, windows) from build/icon.svg.
 *
 * Not the tray icon: that is the dynamic donut (src/main/tray-icon.js) with its
 * static fallback from scripts/make-icon.js. Leave both alone.
 *
 *   npx electron scripts/make-app-icon.js [--log <file>]
 *
 * Inputs
 *   build/icon.svg        master artwork, used for every size above SMALL_MAX
 *   build/icon-small.svg  hinted variant (heavier ring, larger dot, lighter
 *                         track) used for 16/20/24, where the master's track
 *                         and dot fall below a pixel of contrast
 * Outputs
 *   build/icon.png        1024, electron-builder's generic icon
 *   build/icon.ico        16..256, PNG-encoded entries (Vista+ format)
 *   assets/app-icon.png   256, runtime BrowserWindow icon
 *
 * Rasterisation is Chromium's own SVG renderer, drawn straight into a canvas at
 * each target size (vector at size, not a downscale of the 1024 bitmap), in a
 * window that is never shown. GPU is disabled so the output does not depend on
 * the machine's graphics driver. No dependency beyond Electron.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const MASTER = path.join(ROOT, 'build', 'icon.svg');
const SMALL = path.join(ROOT, 'build', 'icon-small.svg');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const SMALL_MAX = 24;
const TIMEOUT_MS = 60_000;

const logIdx = process.argv.indexOf('--log');
const LOG_FILE = logIdx > 0 ? path.resolve(process.argv[logIdx + 1]) : null;
const dumpIdx = process.argv.indexOf('--dump');
const DUMP_DIR = dumpIdx > 0 ? path.resolve(process.argv[dumpIdx + 1]) : null;

function fail(err) {
  const text = `[make-app-icon] ${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`;
  process.stderr.write(text);
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, text); } catch { /* stderr already has it */ }
  }
  app.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

/**
 * ICONDIR + ICONDIRENTRY[] + PNG blobs. A width/height byte of 0 means 256.
 * @param {{size:number, png:Buffer}[]} images ascending by size
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ size, png }, i) => {
    const o = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, o);
    entries.writeUInt8(size >= 256 ? 0 : size, o + 1);
    entries.writeUInt8(0, o + 2);          // palette colours
    entries.writeUInt8(0, o + 3);          // reserved
    entries.writeUInt16LE(1, o + 4);       // planes
    entries.writeUInt16LE(32, o + 6);      // bits per pixel
    entries.writeUInt32LE(png.length, o + 8);
    entries.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
}

/** Runs in the hidden page. Returns base64 PNGs keyed by size. */
const RENDER_FN = `async (jobs) => {
  const out = {};
  const cache = new Map();
  for (const { svg, size } of jobs) {
    let img = cache.get(svg);
    if (!img) {
      img = new Image();
      img.src = 'data:image/svg+xml;base64,' + btoa(svg);
      await img.decode();
      cache.set(svg, img);
    }
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    out[size] = c.toDataURL('image/png').split(',')[1];
  }
  return out;
}`;

async function main() {
  const master = fs.readFileSync(MASTER, 'utf8');
  const small = fs.existsSync(SMALL) ? fs.readFileSync(SMALL, 'utf8') : master;
  const pick = (size) => (size <= SMALL_MAX ? small : master);

  const sizes = [...ICO_SIZES, 1024];
  const jobs = sizes.map((size) => ({ size, svg: pick(size) }));

  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true },
  });
  await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8">');
  const b64 = await win.webContents.executeJavaScript(`(${RENDER_FN})(${JSON.stringify(jobs)})`);
  win.destroy();

  const pngs = Object.fromEntries(sizes.map((s) => [s, Buffer.from(b64[s], 'base64')]));

  const write = (file, buf) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    process.stdout.write(`wrote ${path.relative(ROOT, file)} (${buf.length} bytes)\n`);
  };
  write(path.join(ROOT, 'build', 'icon.png'), pngs[1024]);
  write(path.join(ROOT, 'build', 'icon.ico'), encodeIco(ICO_SIZES.map((size) => ({ size, png: pngs[size] }))));
  write(path.join(ROOT, 'assets', 'app-icon.png'), pngs[256]);
  if (DUMP_DIR) {
    for (const s of sizes) write(path.join(DUMP_DIR, `icon-${s}.png`), pngs[s]);
  }
}

setTimeout(() => fail(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS).unref();
app.disableHardwareAcceleration();
app.setPath('userData', path.join(os.tmpdir(), 'usage-notch-make-app-icon'));
app.whenReady().then(main).then(() => app.exit(0), fail);
