'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { installDom, mirrorRenderer } = require('./helpers/fake-dom');
const { makeDwm } = require('../src/main/win32');

const ROOT = path.join(__dirname, '..');

/**
 * The Liquid Glass (2026-11-02): the window is clear, main copies the screen
 * region the panel is about to cover, and the page draws the glass from that
 * picture (components/glass.ts). Here, without a window or a canvas:
 *
 *   - the copy (win32 captureScreen): only ever a READ of the screen into
 *     our own bitmap, every GDI handle released on every path, a bad rect
 *     never reaching Windows;
 *   - the payload's gate (sanitize.ts sanitizeBackdrop): exact sizes or
 *     nothing, a move without pixels, null to drop;
 *   - the glass itself (glass.ts refract): the window's region cut out of the
 *     picture, softened, bent at the rim, never reading outside the picture;
 *   - the stylesheet: drawn only over a clear, fitted window, never under
 *     high contrast or reduced transparency.
 */

let mirror;
let restoreDom;
let glass;
let sanitize;

test.before(async () => {
  restoreDom = installDom();
  mirror = mirrorRenderer();
  glass = await mirror.load('components/glass.js');
  sanitize = await mirror.load('sanitize.js');
});

test.after(() => {
  if (restoreDom) restoreDom();
  if (mirror) mirror.cleanup();
});

// ----------------------------------------------------------------- the copy

/** A recording stand-in for the GDI functions makeDwm binds. */
function gdi({ blt = true, lines = null } = {}) {
  const calls = [];
  const f = {
    DwmSetWindowAttribute: () => 0,
    SetWindowCompositionAttribute: () => true,
    SetWindowDisplayAffinity: (h, a) => { calls.push(['Affinity', h, a]); return true; },
    GetDC: (h) => { calls.push(['GetDC', h]); return 11; },
    ReleaseDC: (h, dc) => { calls.push(['ReleaseDC', h, dc]); return 1; },
    CreateCompatibleDC: () => { calls.push(['CreateCompatibleDC']); return 22; },
    CreateCompatibleBitmap: (_dc, w, h) => { calls.push(['CreateCompatibleBitmap', w, h]); return 33; },
    SelectObject: (dc, obj) => { calls.push(['SelectObject', dc, obj]); return obj === 33 ? 44 : 33; },
    BitBlt: (...args) => { calls.push(['BitBlt', ...args]); return blt; },
    GetDIBits: (_dc, _bm, _start, h, bits) => { calls.push(['GetDIBits', h]); bits.fill(9); return lines === null ? h : lines; },
    DeleteObject: (obj) => { calls.push(['DeleteObject', obj]); return true; },
    DeleteDC: (dc) => { calls.push(['DeleteDC', dc]); return true; },
  };
  return { f, calls };
}

test.describe('win32 captureScreen', () => {
  test('a plain copy of the screen at the rect into our own bitmap, read top-down, every handle released', () => {
    const { f, calls } = gdi();
    const shot = makeDwm(f).captureScreen({ x: 1500.4, y: 100, width: 40, height: 30 });
    assert.equal(shot.width, 40);
    assert.equal(shot.height, 30);
    assert.equal(shot.bgra.length, 40 * 30 * 4);
    const blt = calls.find((c) => c[0] === 'BitBlt');
    assert.deepEqual(blt.slice(1), [22, 0, 0, 40, 30, 11, 1500, 100, 0x00CC0020], 'from the screen DC, SRCCOPY');
    const names = calls.map((c) => c[0]);
    assert.ok(names.indexOf('SelectObject', names.indexOf('BitBlt')) < names.indexOf('GetDIBits'), 'the bitmap is deselected before it is read');
    assert.deepEqual(names.slice(-3), ['DeleteObject', 'DeleteDC', 'ReleaseDC']);
  });

  test('a failed copy or a short read is no picture, and still releases everything', () => {
    for (const opts of [{ blt: false }, { lines: 3 }]) {
      const { f, calls } = gdi(opts);
      assert.equal(makeDwm(f).captureScreen({ x: 0, y: 0, width: 10, height: 10 }), null, JSON.stringify(opts));
      const names = calls.map((c) => c[0]);
      assert.deepEqual(names.slice(-3), ['DeleteObject', 'DeleteDC', 'ReleaseDC'], JSON.stringify(opts));
    }
  });

  test('a rect that is not one never reaches Windows', () => {
    for (const bad of [null, 'x', { x: 0, y: 0, width: 0, height: 5 }, { x: 0, y: 0, width: 5000, height: 5 }, { x: NaN, y: 0, width: 5, height: 5 }]) {
      const { f, calls } = gdi();
      assert.equal(makeDwm(f).captureScreen(bad), null, JSON.stringify(bad));
      assert.deepEqual(calls, [], JSON.stringify(bad));
    }
  });

  test('captureBehind leaves our window out for the copy only, and puts it back on every path', () => {
    const { f, calls } = gdi();
    const shot = makeDwm(f).captureBehind(4242, { x: 10, y: 10, width: 8, height: 8 });
    assert.equal(shot.width, 8);
    const names = calls.map((c) => c[0]);
    assert.deepEqual(calls[0], ['Affinity', 4242, 0x11], 'WDA_EXCLUDEFROMCAPTURE first');
    assert.deepEqual(calls.at(-1), ['Affinity', 4242, 0], 'and back to WDA_NONE last');
    assert.ok(names.indexOf('BitBlt') > 0 && names.indexOf('BitBlt') < names.length - 1);

    const failing = gdi({ blt: false });
    assert.equal(makeDwm(failing.f).captureBehind(4242, { x: 0, y: 0, width: 4, height: 4 }), null);
    assert.deepEqual(failing.calls.at(-1), ['Affinity', 4242, 0], 'reset after a failed copy too');

    const refused = gdi();
    refused.f.SetWindowDisplayAffinity = () => false;
    assert.equal(makeDwm(refused.f).captureBehind(4242, { x: 0, y: 0, width: 4, height: 4 }), null);
    assert.deepEqual(refused.calls, [], 'no affinity, no copy: it would copy the panel itself');

    const none = gdi();
    assert.equal(makeDwm(none.f).captureBehind(0, { x: 0, y: 0, width: 4, height: 4 }), null);
    assert.deepEqual(none.calls, []);
  });

  test('a throwing binding is a missing picture, never a throw', () => {
    const { f } = gdi();
    f.BitBlt = () => { throw new Error('boom'); };
    assert.equal(makeDwm(f).captureScreen({ x: 0, y: 0, width: 4, height: 4 }), null);
  });
});

// ---------------------------------------------------------------- the gate

test.describe('sanitizeBackdrop', () => {
  const bgra = (w, h) => new Uint8Array(w * h * 4);

  test('a picture with exactly its pixels; a move without; null drops', () => {
    const full = sanitize.sanitizeBackdrop({ x: 0, y: -200, width: 320, height: 680, image: { pixelWidth: 4, pixelHeight: 2, bgra: bgra(4, 2) } });
    assert.equal(full.image.pixelWidth, 4);
    assert.equal(full.y, -200);
    assert.deepEqual(sanitize.sanitizeBackdrop({ x: 0, y: -150, width: 320, height: 680, image: null }), { x: 0, y: -150, width: 320, height: 680, image: null });
    assert.equal(sanitize.sanitizeBackdrop(null), null);
  });

  test('anything malformed is undefined: ignored, never drawn half, never dropping a good picture', () => {
    const at = { x: 0, y: 0, width: 320, height: 680 };
    for (const bad of [
      undefined,
      'x',
      { ...at, width: 0 },
      { ...at, x: NaN },
      { ...at, image: 'pixels' },
      { ...at, image: { pixelWidth: 4, pixelHeight: 2, bgra: bgra(4, 1) } },
      { ...at, image: { pixelWidth: 4.5, pixelHeight: 2, bgra: bgra(4, 2) } },
      { ...at, image: { pixelWidth: 5000, pixelHeight: 1, bgra: bgra(5000, 1) } },
      { ...at, image: { pixelWidth: 1, pixelHeight: 1, bgra: [0, 0, 0, 0] } },
    ]) {
      assert.equal(sanitize.sanitizeBackdrop(bad), undefined, JSON.stringify(bad && bad.image ? { ...bad, image: '…' } : bad));
    }
  });
});

// --------------------------------------------------------------- the glass

test.describe('glass.ts refract', () => {
  /** A picture `w` x `h`: a white square in its middle on black, RGBA. */
  function picture(w, h) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const lit = x >= w / 4 && x < (3 * w) / 4 && y >= h / 4 && y < (3 * h) / 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = lit ? 255 : 0;
        rgba[i + 3] = 255;
      }
    }
    return rgba;
  }

  test('BGRA rows become RGBA with a full alpha', () => {
    const out = glass.rgbaOfBgra(new Uint8Array([1, 2, 3, 0, 10, 20, 30, 7]));
    assert.deepEqual([...out], [3, 2, 1, 255, 30, 20, 10, 255]);
  });

  test('the window\'s region at the picture\'s scale, every pixel opaque', () => {
    const src = { rgba: picture(200, 300), width: 200, height: 300, scale: 2, originX: 0, originY: 100 };
    const out = glass.refract(src, 100, 100);
    assert.equal(out.width, 200);
    assert.equal(out.height, 200);
    for (let i = 3; i < out.rgba.length; i += 4) assert.equal(out.rgba[i], 255);
  });

  test('softened: the square\'s edge is a ramp, not a step; its middle stays white', () => {
    const src = { rgba: picture(120, 120), width: 120, height: 120, scale: 1, originX: 0, originY: 0 };
    const out = glass.refract(src, 120, 120);
    const at = (x, y) => out.rgba[(y * 120 + x) * 4];
    assert.equal(at(60, 60), 255);
    const ramp = [28, 29, 30, 31, 32].map((x) => at(x, 60));
    assert.ok(ramp.some((v) => v > 0 && v < 255), `no soft edge: ${ramp}`);
  });

  test('bent at the rim only: the middle reads straight through, the edge reads from further in', () => {
    // A horizontal ramp: each column's grey is its x, so the column a pixel
    // was read from is its value.
    const w = 200;
    const h = 120;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = x;
      rgba[i + 3] = 255;
    }
    const out = glass.refract({ rgba, width: w, height: h, scale: 1, originX: 0, originY: 0 }, w, h);
    const at = (x, y) => out.rgba[(y * w + x) * 4];
    // Saturation leaves a grey grey, so the value is the column read.
    assert.ok(Math.abs(at(100, 60) - 100) <= 1, `the middle moved: ${at(100, 60)}`);
    assert.ok(at(2, 60) > 2 + 4, `the left rim was not bent inward: ${at(2, 60)}`);
    assert.ok(at(w - 3, 60) < w - 3 - 4, `the right rim was not bent inward: ${at(w - 3, 60)}`);
  });

  test('a window larger than the picture clamps to its edge, never reads outside it', () => {
    const src = { rgba: picture(10, 10), width: 10, height: 10, scale: 1, originX: -5, originY: -5 };
    const out = glass.refract(src, 30, 30);
    assert.equal(out.rgba.length, 30 * 30 * 4);
    for (let i = 0; i < out.rgba.length; i++) assert.ok(Number.isFinite(out.rgba[i]));
  });

  test('createGlass: decorative, ready only once a picture is drawn, and null drops it', () => {
    const handle = glass.createGlass();
    assert.equal(handle.el.getAttribute('aria-hidden'), 'true');
    assert.equal(handle.el.getAttribute('data-ready'), 'false');
    // No canvas in the fake DOM: a payload is taken without a throw.
    assert.doesNotThrow(() => handle.apply({ x: 0, y: -10, width: 2, height: 2, image: { pixelWidth: 2, pixelHeight: 2, bgra: new Uint8Array(16) } }));
    assert.doesNotThrow(() => handle.apply({ x: 0, y: -5, width: 2, height: 2, image: null }));
    handle.apply(null);
    assert.equal(handle.el.getAttribute('data-ready'), 'false');
    handle.destroy();
  });
});

// ---------------------------------------------------------- the stylesheet

test.describe('the glass layer in panel.css', () => {
  // Line endings as git checked them out: compare on \n either way.
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'panel.css'), 'utf8').replace(/\r\n/g, '\n');
  const LIVE = 'html[data-material="acrylic"][data-frame="fitted"]:not([data-reduce-transparency]) .glass';

  test('not drawn at all unless the window is clear and fitted, and nobody asked for less', () => {
    assert.match(css, /\n\.glass \{ display: none; \}/);
    assert.ok(css.includes(`${LIVE} {\n  display: block;\n  position: fixed;\n  inset: 0;\n  z-index: -1;`), 'fixed to the window, under #app');
    assert.match(css, /@media \(prefers-reduced-transparency: reduce\), \(forced-colors: active\) \{\s*html\[data-material="acrylic"\]\[data-frame="fitted"\]:not\(\[data-reduce-transparency\]\) \.glass \{ display: none; \}/);
  });

  test('the thick tint until the picture arrives; the corners are the glass\'s own', () => {
    assert.match(css, /\.glass\[data-ready="false"\] \.glass__tint \{ background: var\(--glass-tint-bare\); \}/);
    const tokens = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');
    assert.match(tokens, /--glass-radius: 22px;/);
    assert.match(tokens, /--glass-tint-bare: rgba\(28, 28, 30, \.86\);/);
  });

  test('app.ts puts the layer in <body>, outside the animated panel', () => {
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'app.ts'), 'utf8');
    assert.match(app, /const glass = createGlass\(\);\s*container\.parentNode\?\.insertBefore\(glass\.el, container\);/);
  });
});

test.describe('glass.ts on the GPU', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'components', 'glass.ts'), 'utf8');

  test('the picture goes up as it came and is read swizzled: the CPU touches no pixel', () => {
    assert.match(src, /gl\.texImage2D\(gl\.TEXTURE_2D, 0, gl\.RGBA, source\.width, source\.height, 0, gl\.RGBA, gl\.UNSIGNED_BYTE, source\.bgra\)/);
    assert.match(src, /texture2D\(u_src, \(p \+ u_origin\) \/ u_srcSize\)\.bgr/);
  });

  test('the shader is the same lens as refract: the rounded rect\'s distance, t squared times the depth, inward', () => {
    assert.match(src, /float t = clamp\(1\.0 \+ d \/ u_band, 0\.0, 1\.0\);/);
    assert.match(src, /vec2 s = p - \(t \* t \* u_depth\) \* n \/ max\(length\(n\), 0\.0001\);/);
    assert.match(src, /gl\.uniform1f\(u\.radius, GLASS_RADIUS \* s\);/);
  });

  test('no WebGL: the 2D fallback, from the same picture', () => {
    assert.match(src, /if \(gpu === undefined\) gpu = gpuGlass\(canvas\);/);
    assert.match(src, /if \(!source\.rgba\) source\.rgba = rgbaOfBgra\(source\.bgra\);/);
  });
});
