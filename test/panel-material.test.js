'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fakeElectron = require('./helpers/fake-electron');
const log = require('../src/core/log');
log.setTrace(false);

const electron = fakeElectron.install();
const {
  PanelWindow, FITTED_WIDTH, FITTED_MAX_HEIGHT, FITTED_GAP, FITTED_MIN_HEIGHT, POINTER_POLL_MS, LEAVE_GRACE_MS,
  placeNear,
} = require('../src/main/panel-window');
const material = require('../src/core/panel-material');
const { colorrefOfHex } = require('../src/main/win32');

test.after(() => electron.restore());

const ROOT = path.join(__dirname, '..');
const { DISPLAY } = fakeElectron;
const WORK = { ...DISPLAY.workArea };
const TRAY = { x: 1800, y: 1032, width: 24, height: 48 };

/**
 * The panel's window MATERIAL (concept "A · Gerçek Windows camı"): a fitted
 * window that is the panel itself, with the real Windows 11 acrylic behind it,
 * or the opaque base whenever acrylic is not available or not wanted.
 */

function fitted(options = {}) {
  const dwmCalls = [];
  const dwm = { setDarkMode: (h, d) => dwmCalls.push(['dark', h, d]), setBorderColour: (h, c) => dwmCalls.push(['edge', h, c]) };
  const panel = new PanelWindow({ entry: __filename, frame: 'fitted', dwm: () => dwm, ...options });
  panel.create();
  return { panel, dwmCalls };
}

test.describe('which frame and which material (src/core/panel-material.js)', () => {
  test('Windows 11 gets the fitted frame; Windows 10 and anything else keeps the canvas', () => {
    assert.equal(material.windowsBuild('10.0.26200'), 26200);
    assert.equal(material.windowsBuild('6.3.9600'), 0);
    assert.equal(material.windowsBuild(undefined), 0);
    assert.equal(material.panelFrameFor('win32', '10.0.22000'), 'fitted');
    assert.equal(material.panelFrameFor('win32', '10.0.26200'), 'fitted');
    assert.equal(material.panelFrameFor('win32', '10.0.19045'), 'canvas', 'Windows 10 22H2');
    assert.equal(material.panelFrameFor('linux', '10.0.26200'), 'canvas');
  });

  test('acrylic needs 22H2 (22621), the build Electron itself checks', () => {
    assert.equal(material.acrylicAvailable('win32', '10.0.22621'), true);
    assert.equal(material.acrylicAvailable('win32', '10.0.22000'), false, '21H2: rounded, but no backdrop');
    assert.equal(material.acrylicAvailable('win32', '10.0.19045'), false);
  });

  test('every request for less transparency wins, and only a fitted window is ever acrylic', () => {
    const want = (o) => material.wantsAcrylic({ frame: 'fitted', available: true, ...o });
    assert.equal(want({}), true);
    assert.equal(want({ reduceTransparency: true }), false, 'Saydamlığı azalt');
    assert.equal(want({ systemReduced: true }), false, 'Windows: transparency off, or high contrast');
    assert.equal(want({ available: false }), false);
    assert.equal(want({ frame: 'canvas' }), false);
  });

  test('the panel theme resolves like the renderer: system follows Windows app mode', () => {
    assert.equal(material.panelDark('dark', false), true);
    assert.equal(material.panelDark('light', true), false);
    assert.equal(material.panelDark('system', true), true);
    assert.equal(material.panelDark('system', false), false);
  });

  test('the window base is the panel base in tokens.css, per theme', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');
    const ink900 = (selector) => {
      const start = css.indexOf(selector);
      return /--ink-900:\s*(#[0-9A-Fa-f]{6})/.exec(css.slice(start, css.indexOf('\n}', start)))[1];
    };
    assert.equal(material.PANEL_BASE.dark, ink900(':root {'));
    assert.equal(material.PANEL_BASE.light, ink900(':root[data-theme="light"] {'));
  });

  test('a DWM colour is a COLORREF, 0x00BBGGRR', () => {
    assert.equal(colorrefOfHex('#112233'), 0x00332211);
    assert.equal(colorrefOfHex('#454548'), 0x00484545);
    assert.equal(colorrefOfHex('red'), null);
    assert.equal(colorrefOfHex('#12345'), null);
  });
});

test.describe('the fitted window is made the way the spike measured', () => {
  test('opaque to Windows, its shadow, the acrylic option, transparent page', () => {
    const { panel } = fitted({ look: { acrylic: true, dark: true } });
    const o = panel.win.options;
    assert.equal(o.transparent, false, 'a transparent window gets square corners and no shadow');
    assert.equal(o.frame, false);
    assert.equal(o.hasShadow, true);
    assert.equal(o.backgroundMaterial, 'acrylic');
    assert.equal(o.backgroundColor, '#00000000', 'the page shows the acrylic through');
    assert.equal(o.width, FITTED_WIDTH);
    assert.equal(panel.material(), 'acrylic');
  });

  test('without acrylic it is born opaque, in the panel base of its theme', () => {
    const { panel } = fitted({ look: { acrylic: false, dark: false } });
    assert.equal(panel.win.options.backgroundMaterial, 'none');
    assert.equal(panel.win.options.backgroundColor, material.PANEL_BASE.light);
    assert.equal(panel.material(), 'none');
  });

  test('the canvas window is untouched: transparent, no material, never acrylic', () => {
    const panel = new PanelWindow({ entry: __filename, look: { acrylic: true } });
    panel.create();
    assert.equal(panel.win.options.transparent, true);
    assert.equal('backgroundMaterial' in panel.win.options, false);
    assert.equal(panel.setLook({ acrylic: true, dark: true }), 'none');
    assert.equal(panel.win.materials, undefined, 'a canvas never asks for a material');
  });

  test('Windows is told the theme and a neutral hairline, on the fitted window only', () => {
    const { dwmCalls } = fitted({ look: { acrylic: true, dark: true } });
    assert.deepEqual(dwmCalls, [['dark', 4242, true], ['edge', 4242, material.PANEL_EDGE.dark]]);
    const calls = [];
    const canvas = new PanelWindow({ entry: __filename, dwm: () => { calls.push('loaded'); return null; } });
    canvas.create();
    assert.deepEqual(calls, [], 'a canvas never loads the DWM helper');
  });

  test('no DWM helper (koffi unavailable) costs nothing but the refinement', () => {
    const panel = new PanelWindow({ entry: __filename, frame: 'fitted', dwm: () => null, look: { acrylic: true } });
    assert.doesNotThrow(() => panel.create());
    assert.equal(panel.material(), 'acrylic');
  });
});

test.describe('the material switches live', () => {
  test('reduce transparency on and off without reopening, base colour in step', () => {
    const { panel, dwmCalls } = fitted({ look: { acrylic: true, dark: true } });
    dwmCalls.length = 0;
    assert.equal(panel.setLook({ acrylic: false, dark: true }), 'none');
    assert.deepEqual(panel.win.materials, ['none']);
    assert.equal(panel.win.colours.at(-1), material.PANEL_BASE.dark);
    assert.equal(panel.setLook({ acrylic: true, dark: true }), 'acrylic');
    assert.deepEqual(panel.win.materials, ['none', 'acrylic']);
    assert.equal(panel.win.colours.at(-1), '#00000000');
    assert.deepEqual(dwmCalls.filter((c) => c[0] === 'dark').map((c) => c[2]), [true, true]);
  });

  test('a theme flip re-tints without asking for the same material again', () => {
    const { panel, dwmCalls } = fitted({ look: { acrylic: true, dark: true } });
    dwmCalls.length = 0;
    panel.setLook({ acrylic: true, dark: false });
    assert.equal(panel.win.materials, undefined, 'still acrylic: no material call');
    assert.deepEqual(dwmCalls, [['dark', 4242, false], ['edge', 4242, material.PANEL_EDGE.light]]);
    panel.setLook({ acrylic: false, dark: false });
    assert.equal(panel.win.colours.at(-1), material.PANEL_BASE.light);
  });

  test('a refused acrylic falls back to the opaque base and is never asked for again', () => {
    const { panel } = fitted({ look: { acrylic: false, dark: true } });
    panel.win.refuseMaterial = true;
    assert.equal(panel.setLook({ acrylic: true, dark: true }), 'none');
    assert.equal(panel.material(), 'none');
    assert.equal(panel.win.colours.at(-1), material.PANEL_BASE.dark);
    panel.win.refuseMaterial = false;
    assert.equal(panel.setLook({ acrylic: true, dark: true }), 'none');
    assert.equal(panel.win.materials, undefined, 'not retried');
  });

  test('a destroyed window answers none and throws nothing', () => {
    const { panel } = fitted({ look: { acrylic: true } });
    panel.win.destroyed = true;
    assert.equal(panel.material(), 'none');
    assert.doesNotThrow(() => panel.setLook({ acrylic: false }));
  });
});

test.describe('the fitted window is placed where the panel goes', () => {
  test('bottom taskbar: 12 above it, centred on the icon, clamped to the work area', () => {
    const { panel } = fitted();
    const anchor = panel.positionFor(TRAY);
    const b = panel.win.getBounds();
    assert.equal(b.width, FITTED_WIDTH);
    assert.equal(b.y + b.height, WORK.y + WORK.height - FITTED_GAP);
    assert.equal(b.x + b.width, WORK.x + WORK.width - FITTED_GAP, 'the icon is at the corner: clamped');
    assert.equal(anchor.edge, 'bottom');
    assert.equal(anchor.maxHeight, FITTED_MAX_HEIGHT);
    assert.deepEqual(anchor.window, b);
  });

  test('every taskbar edge holds its own side', () => {
    const size = { width: 400, height: 300 };
    const work = { x: 0, y: 0, width: 1920, height: 1032 };
    const at = (edge, p) => placeNear(p, edge, work, size, FITTED_GAP);
    assert.equal(at('top', { x: 960, y: 10 }).y, FITTED_GAP);
    assert.equal(at('bottom', { x: 960, y: 1050 }).y, 1032 - FITTED_GAP - 300);
    assert.equal(at('left', { x: 10, y: 500 }).x, FITTED_GAP);
    assert.equal(at('right', { x: 1910, y: 500 }).x, 1920 - FITTED_GAP - 400);
    assert.equal(at('left', { x: 10, y: 500 }).y, 350, 'centred on the icon down the side');
    assert.equal(at('right', { x: 1910, y: 1020 }).y, 1032 - FITTED_GAP - 300, 'and clamped at the corner');
    assert.equal(at('bottom', { x: 960, y: 1050 }).x, 760);
  });

  test('a small work area (150 % laptop) caps the window and reports the cap', () => {
    const { panel } = fitted();
    const saved = { ...DISPLAY.workArea };
    try {
      DISPLAY.workArea = { x: 0, y: 0, width: 1280, height: 632 };
      DISPLAY.bounds = { x: 0, y: 0, width: 1280, height: 680 };
      panel.setContentHeight(900);
      const anchor = panel.positionFor({ x: 1200, y: 640, width: 24, height: 40 });
      assert.equal(anchor.maxHeight, 632 - 2 * FITTED_GAP);
      assert.equal(panel.win.getBounds().height, 632 - 2 * FITTED_GAP);
      assert.ok(panel.win.getBounds().y >= FITTED_GAP);
    } finally {
      DISPLAY.workArea = saved;
      DISPLAY.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    }
  });

  test('a canvas anchor reports its own height as the most the panel may use', () => {
    const panel = new PanelWindow({ entry: __filename });
    panel.create();
    const anchor = panel.positionFor(TRAY);
    assert.equal(anchor.maxHeight, anchor.window.height);
  });
});

test.describe('the fitted window follows the panel height', () => {
  test('while open it grows away from the taskbar; the taskbar side stays put', () => {
    const { panel } = fitted();
    panel.open(TRAY, () => {});
    const before = panel.win.getBounds();
    assert.equal(panel.setContentHeight(520), true);
    const after = panel.win.getBounds();
    assert.equal(after.height, 520);
    assert.equal(after.y + after.height, before.y + before.height, 'bottom edge held');
    assert.equal(after.x, before.x);
    panel.setContentHeight(5000);
    assert.equal(panel.win.getBounds().height, 520, 'a height past any panel is ignored');
  });

  test('re-placed from the open\'s anchor, never from the cursor', () => {
    const { panel } = fitted();
    electron.moveCursor(100, 100);
    panel.open(TRAY, () => {});
    const x = panel.win.getBounds().x;
    electron.moveCursor(300, 300);
    panel.setContentHeight(500);
    assert.equal(panel.win.getBounds().x, x);
  });

  test('anything that is not a plausible height changes nothing', () => {
    const { panel } = fitted();
    panel.open(TRAY, () => {});
    const b = panel.win.getBounds();
    for (const bad of [NaN, -1, 0, FITTED_MIN_HEIGHT - 1, '500', null, undefined, {}, Infinity]) {
      assert.equal(panel.setContentHeight(bad), false, String(bad));
    }
    assert.deepEqual(panel.win.getBounds(), b);
  });

  test('concealed, it remembers the height for the next open and parks at its size', () => {
    const { panel } = fitted();
    panel.open(TRAY, () => {});
    panel.hide('test');
    assert.equal(panel.win.getBounds().x, -32000);
    assert.equal(panel.setContentHeight(333), true);
    assert.equal(panel.win.getBounds().x, -32000, 'not brought back on screen by a resize');
    panel.open(TRAY, () => {});
    assert.equal(panel.win.getBounds().height, 333);
    panel.hide('test');
    assert.equal(panel.win.getBounds().height, 333, 'parked at the panel size, not the canvas size');
  });

  test('a canvas window ignores reports; its size is the canvas', () => {
    const panel = new PanelWindow({ entry: __filename });
    panel.create();
    panel.open(TRAY, () => {});
    const b = panel.win.getBounds();
    assert.equal(panel.setContentHeight(300), false);
    assert.deepEqual(panel.win.getBounds(), b);
  });
});

test.describe('the fitted window takes every click on itself', () => {
  test('never click-through, whatever the renderer reports', () => {
    const { panel } = fitted();
    panel.open(TRAY, () => {});
    panel.setPointerOverPanel(false);
    panel.setPointerOverPanel(true);
    panel.setPointerOverPanel(false);
    panel.hide('test');
    panel.open(TRAY, () => {});
    assert.ok(panel.win.ignoreCalls.length >= 1);
    assert.ok(panel.win.ignoreCalls.every((c) => c.ignore === false), JSON.stringify(panel.win.ignoreCalls));
  });

  test('the canvas keeps its click-through margin', () => {
    const panel = new PanelWindow({ entry: __filename });
    panel.create();
    assert.equal(panel.win.ignoreCalls[0].ignore, true);
    panel.setPointerOverPanel(true);
    assert.equal(panel.win.ignoreCalls.at(-1).ignore, false);
  });

  test('the leave rule reads the window, which is now exactly the panel', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel } = fitted();
    panel.open(TRAY, () => {});
    const b = panel.win.getBounds();
    electron.moveCursor(b.x + 10, b.y + 10);
    t.mock.timers.tick(POINTER_POLL_MS);
    // One pixel above the panel is outside it now, where the canvas's margin
    // used to count as inside.
    electron.moveCursor(b.x + 10, b.y - 1);
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(LEAVE_GRACE_MS + 10);
    assert.equal(panel.isVisible(), false);
  });
});
