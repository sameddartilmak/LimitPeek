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
 * The panel's window MATERIAL (concept "A · Gerçek Windows camı"; the
 * "Saydamlık" slider): a fitted window that is the panel itself, with
 * Windows' accent glass behind it — frosted or clear, as see-through as the
 * level says — or the opaque base whenever the glass is not wanted or not
 * available.
 */

/**
 * A fitted panel over a recorded DWM helper. `accents` is every accent asked
 * for; `refuse` makes setAccent answer false, `throws` makes it throw.
 */
function fitted(options = {}, { refuse = false, throws = false } = {}) {
  const dwmCalls = [];
  const accents = [];
  const dwm = {
    setFlyoutShape: (h) => dwmCalls.push(['shape', h]),
    setDarkMode: (h, d) => dwmCalls.push(['dark', h, d]),
    setBorderColour: (h, c) => dwmCalls.push(['edge', h, c]),
    setAccent: (h, a) => {
      accents.push({ h, ...a });
      if (throws) throw Object.assign(new Error('x'), { code: 'EACCENT' });
      return !refuse;
    },
  };
  const panel = new PanelWindow({ entry: __filename, frame: 'fitted', dwm: () => dwm, ...options });
  panel.create();
  return { panel, dwmCalls, accents, dwm };
}

const FROSTED = material.ACCENT_FROSTED;
const CLEAR = material.ACCENT_CLEAR;

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

  test('the slider is the level, unless Windows asks for less; only a fitted window has glass at all', () => {
    const level = (o) => material.effectiveTransparency({ frame: 'fitted', transparency: 45, ...o });
    assert.equal(level({}), 45);
    assert.equal(level({ transparency: 0 }), 0, '"Saydamlık" at Düz');
    assert.equal(level({ transparency: 100 }), 100);
    assert.equal(level({ transparency: 'x' }), 45, 'an odd value is the default');
    assert.equal(level({ systemReduced: true }), 0, 'Windows: transparency off, or high contrast');
    assert.equal(level({ frame: 'canvas' }), 0);
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

  test('the look is rebuilt from the settings and Windows on every call, re-sanitised', () => {
    let settings = { theme: 'system', transparency: 45 };
    let reduced = false;
    let dark = true;
    const look = material.createPanelLook({
      frame: 'fitted', getSettings: () => settings, systemReduced: () => reduced, systemDark: () => dark,
    });
    assert.deepEqual(look(), { transparency: 45, dark: true });
    dark = false;
    assert.deepEqual(look(), { transparency: 45, dark: false }, "'system' follows Windows' app mode");
    settings = { theme: 'dark', transparency: 0 };
    assert.deepEqual(look(), { transparency: 0, dark: true });
    settings = { theme: 'nocturne', transparency: 'yes' };
    assert.deepEqual(look(), { transparency: 45, dark: false }, 'an odd file is the defaults: system theme, the default glass');
    settings = { theme: 'dark', transparency: 100 };
    reduced = true;
    assert.equal(look().transparency, 0);
    settings = null;
    assert.doesNotThrow(() => look());
    const canvas = material.createPanelLook({
      frame: 'canvas', getSettings: () => ({ transparency: 100 }), systemReduced: () => false, systemDark: () => true,
    });
    assert.equal(canvas().transparency, 0);
  });

  test('THE RULE: 0 opaque, 1–55 frosted from 0xE6 to 0x30, 56–100 clear from 0x70 to 0', () => {
    const a = (level, dark = true) => material.panelAccent(level, dark);
    assert.deepEqual(a(0), { mode: 'opaque', state: 0, flags: 0, alpha: 0, color: 0 });
    assert.deepEqual([a(1).mode, a(1).state, a(1).flags, a(1).alpha], ['frosted', FROSTED, 2, 0xE6]);
    assert.deepEqual([a(55).mode, a(55).state, a(55).alpha], ['frosted', FROSTED, 0x30], '0x30: below it state 4 renders black');
    assert.deepEqual([a(56).mode, a(56).state, a(56).flags, a(56).alpha], ['clear', CLEAR, 2, 0x70]);
    assert.deepEqual(a(100), { mode: 'clear', state: CLEAR, flags: 2, alpha: 0, color: 0 }, "truly clear: the spike's 0x00000000");
    assert.equal(FROSTED, 4);
    assert.equal(CLEAR, 2);
    // Linear inside each band, and never thicker as the slider goes right.
    assert.equal(a(28).alpha, Math.round(0xE6 + (0x30 - 0xE6) * (27 / 54)));
    assert.equal(a(78).alpha, Math.round(0x70 * (22 / 44)));
    for (let n = 2; n <= 100; n += 1) {
      if (n === 56) continue;
      assert.ok(a(n).alpha <= a(n - 1).alpha, `alpha grew at ${n}`);
    }
    for (let n = 1; n <= 55; n += 1) assert.ok(a(n).alpha >= 0x30, `frosted below the floor at ${n}`);
  });

  test("the rule's colour: the theme's tint at the alpha, 0xAABBGGRR", () => {
    assert.equal(material.panelAccent(1, true).color, 0xE6221E1E, 'dark #1E1E22');
    assert.equal(material.panelAccent(1, false).color, 0xE6F8F6F6, 'light #F6F6F8');
    assert.equal(material.panelAccent(56, false).color, 0x70F8F6F6);
    assert.equal(material.gradientColor('#112233', 0x80), 0x80332211);
    assert.equal(material.gradientColor('#112233', 0), 0);
  });

  test('the rule clamps and survives garbage: NaN and strings are the default, out of range is the end', () => {
    const a = (level) => material.panelAccent(level, true);
    assert.deepEqual(a(NaN), a(45));
    assert.deepEqual(a('100'), a(45));
    assert.deepEqual(a(undefined), a(45));
    assert.deepEqual(a(150), a(100));
    assert.deepEqual(a(-10), a(0));
    assert.deepEqual(a(54.6), a(55));
    assert.deepEqual(a(55.4), a(55));
  });

  test('the accent policy goes to Windows as the 16 bytes it reads', () => {
    const { accentPolicyBuffer } = require('../src/main/win32');
    const buf = accentPolicyBuffer(material.panelAccent(1, true));
    assert.equal(buf.length, 16);
    assert.equal(buf.readInt32LE(0), 4, 'AccentState');
    assert.equal(buf.readInt32LE(4), 2, 'AccentFlags');
    assert.equal(buf.readUInt32LE(8), 0xE6221E1E, 'GradientColor');
    assert.equal(buf.readInt32LE(12), 0, 'AnimationId');
  });

  test('win32 setAccent: WCA_ACCENT_POLICY on our window, guarded', () => {
    const { makeDwm } = require('../src/main/win32');
    const calls = [];
    const dwm = makeDwm({
      DwmSetWindowAttribute: () => 0,
      SetWindowCompositionAttribute: (h, data) => { calls.push({ h, ...data }); return true; },
    });
    assert.equal(dwm.setAccent(4242, material.panelAccent(80, true)), true);
    assert.equal(calls[0].h, 4242);
    assert.equal(calls[0].Attrib, 19);
    assert.equal(calls[0].cbData, 16);
    assert.equal(calls[0].pvData.readInt32LE(0), 2);
    assert.equal(dwm.setAccent(0, material.panelAccent(80, true)), false, 'no window, no call');
    assert.equal(calls.length, 1);
    const broken = makeDwm({ DwmSetWindowAttribute: () => 0, SetWindowCompositionAttribute: () => { throw new Error('gone'); } });
    assert.equal(broken.setAccent(4242, material.panelAccent(80, true)), false, 'a throw is a refusal');
    const refused = makeDwm({ DwmSetWindowAttribute: () => 0, SetWindowCompositionAttribute: () => false });
    assert.equal(refused.setAccent(4242, material.panelAccent(80, true)), false);
  });

  test('Preferences carry what the window IS, and only the exact literals', () => {
    const { createPreferences } = require('../src/main/language-ipc');
    const base = { getSettings: () => ({}), currentLocale: () => ({ language: 'en', resolvedLanguage: 'en', formatLocale: 'en-US' }), readOs: () => ({}) };
    const p = (m, f) => createPreferences({ ...base, material: m, frame: f })();
    assert.deepEqual([p(() => 'acrylic', () => 'fitted').material, p(() => 'acrylic', () => 'fitted').frame], ['acrylic', 'fitted']);
    assert.deepEqual([p(() => 'mica', () => 'round').material, p(() => 'mica', () => 'round').frame], ['none', 'canvas']);
    const older = createPreferences(base)();
    assert.equal(older.material, 'none');
    assert.equal(older.frame, 'canvas');
  });

  test('index.js builds the panel in its look, re-applies it on every push and theme change, and sizes it', () => {
    const code = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n').replace(/\s+/g, ' ');
    for (const needle of [
      'const PANEL_FRAME = panelFrameFor(process.platform, os.release());',
      'const panelLook = createPanelLook({ frame: PANEL_FRAME, getSettings: () => settings,',
      'panel = new PanelWindow({ frame: PANEL_FRAME, look: panelLook(), dwm: () => win32.loadDwm(),',
      'ipcMain.on(IPC.PANEL_SIZE, (event, height) => { if (!fromPanel(event)) return; panel.setContentHeight(height); });',
      "nativeTheme.on('updated', () => { log.trace('os.theme', { ground: trayGround() }); if (collector && collector.snapshot) updateTray(collector.snapshot); if (panel) panel.setLook(panelLook());",
    ]) {
      assert.ok(code.includes(needle), `index.js no longer wires: ${needle}`);
    }
  });

  test('a DWM colour is a COLORREF, 0x00BBGGRR', () => {
    assert.equal(colorrefOfHex('#112233'), 0x00332211);
    assert.equal(colorrefOfHex('#454548'), 0x00484545);
    assert.equal(colorrefOfHex('red'), null);
    assert.equal(colorrefOfHex('#12345'), null);
  });
});

test.describe('the fitted window is made the way the spike measured', () => {
  test('opaque to Windows, its shadow, NO system backdrop, transparent page over the glass', () => {
    const { panel, accents } = fitted({ look: { transparency: 45, dark: true } });
    const o = panel.win.options;
    assert.equal(o.transparent, false, 'a transparent window gets square corners and no shadow');
    assert.equal(o.thickFrame, false, 'a thick frame brings invisible borders that take clicks beside the panel');
    assert.equal(o.frame, false);
    assert.equal(o.hasShadow, true);
    assert.equal(o.backgroundMaterial, 'none', "the system backdrop changes colour when the window is inactive");
    assert.equal(o.backgroundColor, '#00000000', 'the page shows the glass through');
    assert.equal(o.width, FITTED_WIDTH);
    assert.equal(panel.material(), 'acrylic');
    assert.deepEqual(accents.map((a) => [a.h, a.state, a.flags, a.color]), [[4242, FROSTED, 2, material.panelAccent(45, true).color]]);
    assert.equal(panel.win.colours.at(-1), '#00000000');
    assert.equal(panel.win.materials, undefined, 'never asks Electron for a material');
  });

  test('at 0 it is born opaque, in the panel base of its theme, and the accent is off', () => {
    const { panel, accents } = fitted({ look: { transparency: 0, dark: false } });
    assert.equal(panel.win.options.backgroundMaterial, 'none');
    assert.equal(panel.win.options.backgroundColor, material.PANEL_BASE.light);
    assert.equal(panel.material(), 'none');
    assert.deepEqual(accents.map((a) => a.state), [0]);
  });

  test('no look at all is the opaque base', () => {
    const { panel } = fitted();
    assert.equal(panel.material(), 'none');
  });

  test('the canvas window is untouched: transparent, no material, never any glass', () => {
    const panel = new PanelWindow({ entry: __filename, look: { transparency: 100 } });
    panel.create();
    assert.equal(panel.win.options.transparent, true);
    assert.equal('backgroundMaterial' in panel.win.options, false);
    assert.equal(panel.setLook({ transparency: 100, dark: true }), 'none');
    assert.equal(panel.win.materials, undefined, 'a canvas never asks for a material');
    assert.equal(panel.win.colours, undefined, 'nor recolours its transparent frame');
  });

  test('Windows is told the theme and a neutral hairline, on the fitted window only', () => {
    const { dwmCalls } = fitted({ look: { transparency: 45, dark: true } });
    assert.deepEqual(dwmCalls, [['shape', 4242], ['dark', 4242, true], ['edge', 4242, material.PANEL_EDGE.dark]]);
    const calls = [];
    const canvas = new PanelWindow({ entry: __filename, dwm: () => { calls.push('loaded'); return null; } });
    canvas.create();
    assert.deepEqual(calls, [], 'a canvas never loads the DWM helper');
  });

  test('no DWM helper (koffi unavailable) costs the glass and the refinements, nothing else', () => {
    const panel = new PanelWindow({ entry: __filename, frame: 'fitted', dwm: () => null, look: { transparency: 45 } });
    assert.doesNotThrow(() => panel.create());
    assert.equal(panel.material(), 'none');
    assert.equal(panel.win.colours.at(-1), material.PANEL_BASE.dark);
  });
});

test.describe('the material follows the slider live', () => {
  test('frosted, clear, opaque and back without reopening, background colour in step', () => {
    const { panel, accents } = fitted({ look: { transparency: 45, dark: true } });
    accents.length = 0;
    assert.equal(panel.setLook({ transparency: 90, dark: true }), 'acrylic');
    assert.deepEqual(accents.map((a) => a.state), [CLEAR]);
    assert.equal(panel.win.colours.at(-1), '#00000000');
    assert.equal(panel.setLook({ transparency: 0, dark: true }), 'none');
    assert.deepEqual(accents.map((a) => a.state), [CLEAR, 0], 'the accent is taken away, not left behind the base');
    assert.equal(panel.win.colours.at(-1), material.PANEL_BASE.dark);
    assert.equal(panel.setLook({ transparency: 20, dark: true }), 'acrylic');
    assert.deepEqual(accents.map((a) => a.state), [CLEAR, 0, FROSTED]);
    assert.equal(accents.at(-1).color, material.panelAccent(20, true).color);
    assert.equal(panel.win.colours.at(-1), '#00000000');
  });

  test('an unchanged look re-asserts the same accent; a theme flip re-tints the glass', () => {
    const { panel, dwmCalls, accents } = fitted({ look: { transparency: 45, dark: true } });
    accents.length = 0;
    dwmCalls.length = 0;
    panel.setLook({ transparency: 45, dark: true });
    assert.deepEqual(accents.map((a) => a.color), [material.panelAccent(45, true).color], 'put back, never trusted');
    accents.length = 0;
    panel.setLook({ transparency: 45, dark: false });
    assert.deepEqual(accents.map((a) => a.color), [material.panelAccent(45, false).color]);
    assert.deepEqual(dwmCalls.slice(-3), [['shape', 4242], ['dark', 4242, false], ['edge', 4242, material.PANEL_EDGE.light]]);
    panel.setLook({ transparency: 0, dark: false });
    assert.equal(panel.win.colours.at(-1), material.PANEL_BASE.light);
  });

  test('Windows refusing the glass falls back to the opaque base once, with a warning, and is never asked again', () => {
    const warnings = [];
    const warn = log.warn;
    log.warn = (m) => warnings.push(m);
    try {
      const { panel, accents } = fitted({ look: { transparency: 0, dark: true } }, { refuse: true });
      assert.equal(panel.setLook({ transparency: 45, dark: true }), 'none');
      assert.equal(panel.material(), 'none');
      assert.equal(panel.win.colours.at(-1), material.PANEL_BASE.dark);
      assert.equal(warnings.filter((w) => w.includes('glass refused')).length, 1);
      const asked = accents.filter((a) => a.state !== 0).length;
      assert.equal(panel.setLook({ transparency: 90, dark: true }), 'none');
      assert.equal(accents.filter((a) => a.state !== 0).length, asked, 'not retried');
      assert.equal(warnings.filter((w) => w.includes('glass refused')).length, 1, 'warned once');
    } finally {
      log.warn = warn;
    }
  });

  test('a setAccent that throws is a refusal too, and never reaches the caller', () => {
    const { panel } = fitted({ look: { transparency: 0, dark: true } }, { throws: true });
    assert.doesNotThrow(() => panel.setLook({ transparency: 80, dark: true }));
    assert.equal(panel.material(), 'none');
    assert.equal(panel.win.colours.at(-1), material.PANEL_BASE.dark);
  });

  test('a destroyed window answers none and throws nothing', () => {
    const { panel } = fitted({ look: { transparency: 45 } });
    panel.win.destroyed = true;
    assert.equal(panel.material(), 'none');
    assert.doesNotThrow(() => panel.setLook({ transparency: 0 }));
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
