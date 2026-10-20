'use strict';
/**
 * Renders the Microsoft Store (MSIX) visual assets into build/appx/, where
 * electron-builder picks them up for `--win appx` and indexes the scale and
 * targetsize variants with makepri.
 *
 *   npx electron scripts/make-store-assets.js
 *
 * Square logos are the app icon itself (build/icon.svg; build/icon-small.svg at
 * 24 px and below, as scripts/make-app-icon.js does), so the Store, the Start
 * menu and the taskbar show the same mark as the exe. The wide and large tiles
 * put the same glyph beside the name, in the site's Inter, on the icon's own
 * dark gradient.
 *
 * Rasterisation is Chromium's, drawn into a canvas at each target size in a
 * window that is never shown, with the GPU off so the output does not depend
 * on the machine's driver. No dependency beyond Electron.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'appx');
const MASTER = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8');
const SMALL = fs.readFileSync(path.join(ROOT, 'build', 'icon-small.svg'), 'utf8');
const FONT = fs.readFileSync(path.join(ROOT, 'site', 'assets', 'fonts', 'InterVariable-subset.woff2')).toString('base64');

/** [file, width, height, kind] */
const JOBS = [];
const scales = (base, w, h, kind, list) => {
  for (const s of list) JOBS.push([`${base}.scale-${s}.png`, Math.round((w * s) / 100), Math.round((h * s) / 100), kind]);
};
scales('StoreLogo', 50, 50, 'icon', [100, 125, 150, 200, 400]);
scales('Square44x44Logo', 44, 44, 'icon', [100, 125, 150, 200, 400]);
scales('Square150x150Logo', 150, 150, 'icon', [100, 125, 150, 200, 400]);
scales('SmallTile', 71, 71, 'icon', [100, 200, 400]);
scales('Wide310x150Logo', 310, 150, 'wide', [100, 125, 150, 200, 400]);
scales('LargeTile', 310, 310, 'large', [100, 200, 400]);
// Taskbar / Start list sizes, with and without the accent plate.
for (const size of [16, 24, 32, 48, 256]) {
  JOBS.push([`Square44x44Logo.targetsize-${size}.png`, size, size, 'icon']);
  JOBS.push([`Square44x44Logo.targetsize-${size}_altform-unplated.png`, size, size, 'icon']);
  JOBS.push([`Square44x44Logo.targetsize-${size}_altform-lightunplated.png`, size, size, 'icon']);
}

/** The page script: renders every job and returns { file: base64 PNG }. */
function renderScript(jobs) {
  return `(async () => {
    const face = new FontFace('Inter', 'url(data:font/woff2;base64,${FONT})', { weight: '100 900' });
    await face.load();
    document.fonts.add(face);
    const load = async (svg) => { const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(svg); await img.decode(); return img; };
    const master = await load(${JSON.stringify(MASTER)});
    const small = await load(${JSON.stringify(SMALL)});

    function glyph(ctx, cx, cy, size) {
      // The icon's glyph (build/icon.svg): a 24-unit box, ring r 8.5, stroke 4.2.
      const u = size / 24;
      ctx.lineWidth = 4.2 * u;
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#2A3432';
      ctx.beginPath(); ctx.arc(cx, cy, 8.5 * u, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#3FB89E';
      const sweep = (20.3 / (2 * Math.PI * 8.5)) * Math.PI * 2;
      ctx.beginPath(); ctx.arc(cx, cy, 8.5 * u, -Math.PI / 2, -Math.PI / 2 + sweep); ctx.stroke();
      ctx.fillStyle = '#C96442';
      ctx.beginPath(); ctx.arc(cx, cy, 2.3 * u, 0, Math.PI * 2); ctx.fill();
    }
    function background(ctx, w, h) {
      // CSS 155deg, #212B2A -> #121817 at 70%, as the icon tile.
      const a = (155 - 90) * Math.PI / 180;
      const len = Math.abs(w * Math.sin(155 * Math.PI / 180)) + Math.abs(h * Math.cos(155 * Math.PI / 180));
      const dx = Math.cos(a) * len / 2, dy = Math.sin(a) * len / 2;
      const g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
      g.addColorStop(0, '#212B2A'); g.addColorStop(0.7, '#121817'); g.addColorStop(1, '#121817');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }

    const out = {};
    for (const [file, w, h, kind] of ${JSON.stringify(jobs)}) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      if (kind === 'icon') {
        ctx.drawImage(w <= 24 ? small : master, 0, 0, w, h);
      } else if (kind === 'wide') {
        background(ctx, w, h);
        const k = h / 150;
        const g = 62 * k, gap = 16 * k;
        ctx.font = '600 ' + (30 * k) + 'px Inter';
        const tw = ctx.measureText('LimitPeek').width;
        const x0 = (w - (g + gap + tw)) / 2;
        glyph(ctx, x0 + g / 2, h / 2, g);
        ctx.fillStyle = '#EDF2F0';
        ctx.textBaseline = 'middle';
        ctx.fillText('LimitPeek', x0 + g + gap, h / 2 + 1 * k);
      } else if (kind === 'large') {
        background(ctx, w, h);
        const k = w / 310;
        glyph(ctx, w / 2, h * 0.43, 120 * k);
        ctx.font = '600 ' + (30 * k) + 'px Inter';
        ctx.fillStyle = '#EDF2F0';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('LimitPeek', w / 2, h * 0.78);
      }
      out[file] = c.toDataURL('image/png').split(',')[1];
    }
    return out;
  })()`;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8">');
    const out = await win.webContents.executeJavaScript(renderScript(JOBS));
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    for (const [file, b64] of Object.entries(out)) fs.writeFileSync(path.join(OUT, file), Buffer.from(b64, 'base64'));
    process.stdout.write(`make-store-assets: ${Object.keys(out).length} files -> build/appx\n`);
    app.exit(0);
  } catch (err) {
    process.stderr.write(`make-store-assets: ${err && err.stack ? err.stack : err}\n`);
    app.exit(1);
  }
});
