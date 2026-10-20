'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const i18n = require('../src/core/i18n');
const { stripTiles, groundFor } = require('../src/core/strip-tiles');
const { RAMPS } = require('../src/core/donut');
const { STATE_THRESHOLDS } = require('../src/shared/contract');
const {
  TaskbarStrip, placement, samplePoint, barMostlyOffscreen, isFullscreen,
  TILE_WIDTH, STRIP_HEIGHT, TRAY_GAP, ICON_GAP, POLL_MS, GUARD_MS, MAX_REBUILDS, PAGE, PRELOAD,
} = require('../src/main/taskbar-strip');
const { IconProbe, unionOfRects, WORKER: ICON_WORKER } = require('../src/main/taskbar-icons');
const { IPC_STRIP } = require('../src/shared/contract');

const ROOT = path.join(__dirname, '..');

/**
 * The taskbar strip (src/main/taskbar-strip.js, src/core/strip-tiles.js).
 *
 * Win32 and the BrowserWindow are fakes: nothing here touches the real
 * taskbar. What is tested is what decides anything — which tiles, which
 * colours, where the window goes in physical pixels, and the lifecycle around
 * a shell that can disappear under it (Explorer restarting) or a native module
 * that cannot load.
 */

const NOW = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 3600_000;
const later = (ms) => new Date(NOW + ms).toISOString();
const win = (pct, over = {}) => ({ usedPercentage: pct, certainty: 'known', resetsAt: later(2 * HOUR), ...over });

function provider(id, over = {}) {
  return {
    id,
    displayName: { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', kimi: 'Kimi Code', qwen: 'Qwen Code', grok: 'Grok Build' }[id],
    enabled: true,
    connected: true,
    fiveHour: null,
    sevenDay: null,
    setupAction: null,
    ...over,
  };
}

test.beforeEach(() => i18n.setLocale('tr', 'tr-TR'));

/* ----------------------------------------------------------------- tiles */

test.describe('tiles from a snapshot', () => {
  test('one tile per visible tool, in the snapshot (panel) order, each with its windows', () => {
    const snap = {
      providers: [
        provider('codex', { sevenDay: win(41) }),
        provider('claude', { fiveHour: win(38), sevenDay: win(62) }),
      ],
    };
    const tiles = stripTiles(snap, NOW, 'dark');
    assert.deepEqual(tiles.map((t) => t.id), ['codex', 'claude']);
    assert.deepEqual(tiles[1].rows.map((r) => [r.kind, r.label, r.percent]), [['fiveHour', '5sa', 38], ['sevenDay', '7g', 62]]);
  });

  test('each row carries its figure and the time left, worded tight (owner, 2026-10-20)', () => {
    const p = provider('claude', {
      fiveHour: win(22, { resetsAt: later(97 * 60_000) }),
      sevenDay: win(35, { resetsAt: later(60 * HOUR) }),
    });
    const rows = stripTiles({ providers: [p] }, NOW)[0].rows;
    assert.deepEqual(rows.map((r) => [r.percentText, r.left]), [['%22', '1sa 37dk'], ['%35', '2gün 12sa']]);
    // From 24 hours on the strip counts days, unlike the panel's 48.
    const day = stripTiles({ providers: [provider('claude', { sevenDay: win(37, { resetsAt: later(41 * HOUR + 18 * 60_000) }) })] }, NOW)[0].rows[0];
    assert.equal(day.left, '1gün 17sa');
    // No reset instant: the figure stays, the countdown is left out.
    const bare = stripTiles({ providers: [provider('codex', { sevenDay: win(41, { resetsAt: undefined }) })] }, NOW)[0].rows[0];
    assert.equal(bare.percentText, '%41');
    assert.equal(bare.left, null);
  });

  test('a tool with only one window shows only that row (Codex: weekly only)', () => {
    const tiles = stripTiles({ providers: [provider('codex', { sevenDay: win(41) })] }, NOW);
    assert.deepEqual(tiles[0].rows.map((r) => r.kind), ['sevenDay']);
    const fiveOnly = stripTiles({ providers: [provider('antigravity', { fiveHour: win(12) })] }, NOW);
    assert.deepEqual(fiveOnly[0].rows.map((r) => r.kind), ['fiveHour']);
  });

  test('left out: not added, not installed, disconnected, and no defensible window', () => {
    const snap = {
      providers: [
        provider('claude', { enabled: false, fiveHour: win(10) }),
        provider('kimi', { setupAction: { kind: 'not-installed' }, fiveHour: win(10) }),
        provider('qwen', { connected: false, fiveHour: win(10) }),
        provider('grok', { fiveHour: win(10, { certainty: 'unknown' }), sevenDay: null }),
        provider('antigravity', { fiveHour: win(250) }),
        provider('codex', { sevenDay: win(70, { resetsAt: later(10_000) }) }),
      ],
    };
    assert.deepEqual(stripTiles(snap, NOW), []);
  });

  test('the colour is the tray ramp for the ground, stepped on the ROUNDED value', () => {
    const at = (pct, ground = 'dark') => stripTiles({ providers: [provider('claude', { fiveHour: win(pct) })] }, NOW, ground)[0].rows[0].colour;
    assert.deepEqual(STATE_THRESHOLDS, { watch: 60, ember: 85, spent: 100 });
    assert.equal(at(38), RAMPS.dark.calm);
    assert.equal(at(59.4), RAMPS.dark.calm);
    assert.equal(at(59.6), RAMPS.dark.watch, '59.6 prints %60, so it is already watch');
    assert.equal(at(85), RAMPS.dark.ember);
    assert.equal(at(100), RAMPS.dark.spent);
    assert.equal(at(62, 'light'), RAMPS.light.watch, 'a light taskbar gets the light ramp');
  });

  test('the five-hour slot is the tray\'s: the most-consumed model group where one exists', () => {
    const p = provider('antigravity', {
      fiveHour: win(20),
      modelQuotas: { groups: [{ usedPercentage: 91, resetsAt: later(HOUR) }, { usedPercentage: 20, resetsAt: later(HOUR) }] },
    });
    assert.equal(stripTiles({ providers: [p] }, NOW)[0].rows[0].percent, 91);
  });

  test('the hover text names the tool and both figures, in the current language', () => {
    const snap = { providers: [provider('claude', { fiveHour: win(38), sevenDay: win(62) })] };
    assert.equal(stripTiles(snap, NOW)[0].title, 'Claude Code — 5 saatlik %38 · Haftalık %62');
    i18n.setLocale('en', 'en-US');
    const en = stripTiles(snap, NOW)[0];
    assert.equal(en.title, 'Claude Code — 5-hour 38% · Weekly 62%');
    assert.deepEqual(en.rows.map((r) => r.label), ['5h', '7d']);
    i18n.setLocale('zh', 'zh-CN');
    assert.deepEqual(stripTiles(snap, NOW)[0].rows.map((r) => r.label), ['5时', '7天']);
  });

  test('nothing to show for no snapshot or a malformed one', () => {
    assert.deepEqual(stripTiles(null, NOW), []);
    assert.deepEqual(stripTiles({ providers: 'x' }, NOW), []);
    assert.deepEqual(stripTiles({ providers: [null, 7] }, NOW), []);
  });

  test('the ground follows the sampled taskbar colour', () => {
    assert.equal(groundFor('#202020'), 'dark');
    assert.equal(groundFor('#1C2B33'), 'dark');
    assert.equal(groundFor('#F3F3F3'), 'light');
    assert.equal(groundFor('#EEEEEE'), 'light');
    assert.equal(groundFor('nonsense'), 'dark');
  });
});

/* ------------------------------------------------------------- placement */

// This machine, measured 2026-10-20: 1920x1080 at 125 %, a LEFT-aligned
// taskbar whose buttons (UI Automation, taskbar-icons-worker.js) run 0..784.
const BAR = { left: 0, top: 1020, right: 1920, bottom: 1080 };
const TRAY = { left: 1481, top: 1020, right: 1920, bottom: 1080 };
const ICONS_LEFT = { left: 0, top: 1020, right: 784, bottom: 1080 };
const MONITOR = { left: 0, top: 0, right: 1920, bottom: 1080 };
const tileW125 = Math.round(TILE_WIDTH * 1.25);
const overlaps = (a, b) => a.left < b.right && b.left < a.right;
const screenRect = (p, bar = BAR) => ({ left: bar.left + p.x, right: bar.left + p.x + p.width });

test.describe('placement, in physical pixels relative to the taskbar', () => {
  test('left of the tray with a gap, vertically centred, tiles scaled by the DPI', () => {
    const p = placement({ bar: BAR, tray: TRAY, icons: ICONS_LEFT, dpi: 120, tileCount: 2 });
    const right = 1481 - Math.round(TRAY_GAP * 1.25);
    const height = Math.round(STRIP_HEIGHT * 1.25);
    assert.deepEqual(p, { x: right - 2 * tileW125, y: Math.round((60 - height) / 2), width: 2 * tileW125, height, count: 2, scale: 1.25 });
  });

  test('at 100 % the same layout in unscaled pixels', () => {
    const bar = { left: 0, top: 1032, right: 1920, bottom: 1080 };
    const tray = { left: 1600, top: 1032, right: 1920, bottom: 1080 };
    const icons = { left: 700, top: 1032, right: 1220, bottom: 1080 };
    const p = placement({ bar, tray, icons, dpi: 96, tileCount: 1 });
    assert.deepEqual(p, { x: 1600 - TRAY_GAP - TILE_WIDTH, y: 4, width: TILE_WIDTH, height: 40, count: 1, scale: 1 });
  });

  test('coordinates are relative to the taskbar, not the screen (a second monitor to the left)', () => {
    const bar = { left: -1920, top: 1032, right: 0, bottom: 1080 };
    const tray = { left: -320, top: 1032, right: 0, bottom: 1080 };
    const icons = { left: -1920, top: 1032, right: -1200, bottom: 1080 };
    assert.equal(placement({ bar, tray, icons, dpi: 96, tileCount: 1 }).x, 1600 - TRAY_GAP - TILE_WIDTH);
  });

  test('the review case: CENTRED icons straddling the middle are never covered', () => {
    // 1920 px at 125 %, Start + Search + pinned buttons centred and reaching
    // x=1015 (past the middle at 960). The old "never past the middle" cap
    // put four tiles at x=1011, over the icons.
    const centred = { left: 905, top: 1020, right: 1015, bottom: 1080 };
    const p = placement({ bar: BAR, tray: TRAY, icons: centred, dpi: 120, tileCount: 4 });
    assert.ok(p, 'one still fits');
    assert.equal(p.count, Math.floor((1481 - 10 - (1015 + 15)) / tileW125), 'the rest are dropped');
    assert.ok(p.count < 4);
    assert.equal(overlaps(screenRect(p), centred), false);
    assert.ok(screenRect(p).left >= centred.right + Math.round(ICON_GAP * 1.25), 'and keeps the gap');
  });

  test('never overlaps the icon group, wherever it is, for any number of tiles', () => {
    const groups = [
      ICONS_LEFT,
      { left: 0, top: 1020, right: 1300, bottom: 1080 },
      { left: 600, top: 1020, right: 1320, bottom: 1080 },
      { left: 900, top: 1020, right: 1020, bottom: 1080 },
      { left: 40, top: 1020, right: 1440, bottom: 1080 },
    ];
    for (const icons of groups) {
      for (let n = 1; n <= 8; n += 1) {
        const p = placement({ bar: BAR, tray: TRAY, icons, dpi: 120, tileCount: n });
        if (!p) continue;
        assert.equal(overlaps(screenRect(p), icons), false, `${JSON.stringify(icons)} n=${n}`);
        assert.ok(screenRect(p).right <= TRAY.left, 'and never the tray');
        assert.ok(p.count <= n);
      }
    }
  });

  test('tiles are dropped from the END of the order until the rest fit', () => {
    const icons = { left: 0, top: 1020, right: 700, bottom: 1080 };
    const p = placement({ bar: BAR, tray: TRAY, icons, dpi: 120, tileCount: 6 });
    assert.equal(p.count, Math.floor((1481 - 10 - (700 + 15)) / tileW125));
    assert.equal(p.count, 3);
  });

  test('not even one tile fits, or the buttons were not measured: nothing is placed', () => {
    assert.equal(placement({ bar: BAR, tray: TRAY, icons: { left: 0, top: 1020, right: 1400, bottom: 1080 }, dpi: 120, tileCount: 1 }), null);
    assert.equal(placement({ bar: BAR, tray: TRAY, icons: null, dpi: 120, tileCount: 2 }), null, 'unmeasured is not safe');
  });

  test('nothing to place: no tiles, a vertical or collapsed taskbar', () => {
    assert.equal(placement({ bar: BAR, tray: TRAY, icons: ICONS_LEFT, dpi: 120, tileCount: 0 }), null);
    assert.equal(placement({ bar: { left: 0, top: 0, right: 48, bottom: 1080 }, tray: TRAY, icons: ICONS_LEFT, dpi: 96, tileCount: 1 }), null);
    assert.equal(placement({ bar: { left: 0, top: 0, right: 0, bottom: 0 }, tray: TRAY, icons: ICONS_LEFT, dpi: 96, tileCount: 1 }), null);
    assert.equal(placement({ bar: null, tray: TRAY, icons: ICONS_LEFT, dpi: 96, tileCount: 1 }), null);
  });

  test('the colour is read in the gap the strip never covers', () => {
    const pt = samplePoint({ bar: BAR, tray: TRAY, dpi: 120 });
    const p = placement({ bar: BAR, tray: TRAY, icons: ICONS_LEFT, dpi: 120, tileCount: 2 });
    assert.ok(pt.x < TRAY.left && pt.x >= BAR.left + p.x + p.width, 'between the strip and the tray');
    assert.equal(pt.y, 1050);
  });
});

test.describe('the button area', () => {
  test('the union of real rectangles; empty and infinite ones (no layout) are ignored', () => {
    assert.deepEqual(unionOfRects([
      { left: 0, top: 1020, right: 69, bottom: 1080 },
      { left: 0, top: 0, right: 0, bottom: 0 },
      { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
      { left: 69, top: 1020, right: 784, bottom: 1080 },
    ]), ICONS_LEFT);
    assert.equal(unionOfRects([]), null);
    assert.equal(unionOfRects([null, { left: 5, top: 5, right: 5, bottom: 9 }]), null);
  });

  test('the probe keeps the latest answer, reports a change, and stops its worker', () => {
    class FakeWorker extends EventEmitter {
      constructor(file, opts) { super(); this.file = file; this.opts = opts; this.posted = []; FakeWorker.last = this; }
      postMessage(m) { this.posted.push(m); }
      unref() {}
    }
    const changes = [];
    const probe = new IconProbe({ Worker: FakeWorker, log: { info() {}, warn() {} }, onChange: (r) => changes.push(r) });
    probe.start();
    assert.equal(FakeWorker.last.file, ICON_WORKER);
    assert.equal(probe.latest(), null, 'nothing until the worker answers');
    FakeWorker.last.emit('message', { rect: ICONS_LEFT });
    assert.deepEqual(probe.latest(), ICONS_LEFT);
    FakeWorker.last.emit('message', { rect: ICONS_LEFT });
    assert.equal(changes.length, 1, 'the same answer is not a change');
    FakeWorker.last.emit('message', { rect: null, code: 'NO_FRAME' });
    assert.equal(probe.latest(), null);
    probe.remeasure();
    assert.deepEqual(FakeWorker.last.posted, ['measure']);
    const w = FakeWorker.last;
    probe.stop();
    assert.deepEqual(w.posted, ['measure', 'stop']);
    assert.equal(probe.latest(), null);
  });

  test('a worker that errors leaves the probe without an answer, so the strip stays hidden', () => {
    class FakeWorker extends EventEmitter { postMessage() {} unref() {} constructor() { super(); FakeWorker.last = this; } }
    const probe = new IconProbe({ Worker: FakeWorker, log: { info() {}, warn() {} } });
    probe.start();
    FakeWorker.last.emit('message', { rect: ICONS_LEFT });
    FakeWorker.last.emit('error', Object.assign(new Error('x'), { code: 'ERR' }));
    assert.equal(probe.latest(), null);
    probe.start();
    assert.equal(probe.worker, null, 'not restarted in a loop');
  });

  test('the worker releases every COM object it reads and only reads', () => {
    const src = fs.readFileSync(ICON_WORKER, 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    // Read-only UIA: no Invoke, SetFocus, patterns or property writes.
    for (const banned of ['Invoke', 'SetFocus', 'GetCurrentPattern', 'SetWindowPos', 'PostMessage', 'SendMessage']) {
      assert.equal(code.includes(banned), false, banned);
    }
    assert.match(code, /CoInitializeEx\(null, 0\)/, 'an MTA client');
    assert.match(code, /release\(frame\);\s*release\(root\);/);
    assert.match(code, /SysFreeString/);
    assert.match(code, /release\(walker\)/);
    assert.match(code, /release\(uia\)/);
  });
});

test.describe('auto-hide and full screen', () => {
  test('a taskbar mostly off its monitor is auto-hidden', () => {
    assert.equal(barMostlyOffscreen(BAR, MONITOR), false);
    assert.equal(barMostlyOffscreen({ left: 0, top: 1078, right: 1920, bottom: 1138 }, MONITOR), true);
    assert.equal(barMostlyOffscreen({ left: 0, top: 1040, right: 1920, bottom: 1100 }, MONITOR), false, 'two thirds still on screen');
    assert.equal(barMostlyOffscreen(BAR, null), false, 'no monitor, no claim');
  });

  test('a foreground window covering the monitor is full screen; the desktop, the shell and maximised windows are not', () => {
    const full = { hwnd: 5, cls: 'Chrome_WidgetWin_1', rect: { ...MONITOR } };
    assert.equal(isFullscreen(full, MONITOR, 777), true);
    assert.equal(isFullscreen({ ...full, rect: { left: -8, top: -8, right: 1928, bottom: 1028 } }, MONITOR, 777), false, 'maximised stops at the taskbar');
    for (const cls of ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Windows.UI.Core.CoreWindow']) {
      assert.equal(isFullscreen({ ...full, cls }, MONITOR, 777), false, cls);
    }
    assert.equal(isFullscreen({ ...full, hwnd: 777 }, MONITOR, 777), false, 'never our own window');
    assert.equal(isFullscreen(null, MONITOR, 777), false);
  });
});

/* ------------------------------------------------------------- lifecycle */

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.shown = 0;
    this.hidden = 0;
    this.loaded = null;
    const wc = new EventEmitter();
    wc.sent = [];
    wc.send = (channel, payload) => wc.sent.push({ channel, payload });
    this.webContents = wc;
    FakeWindow.all.push(this);
  }
  loadFile(file) { this.loaded = file; }
  setMenu() {}
  showInactive() { this.shown += 1; }
  hide() { this.hidden += 1; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  /** What Electron does once the page has loaded. */
  finishLoad() { this.webContents.emit('did-finish-load'); }
}
FakeWindow.all = [];

function fakeWin32({ available = true } = {}) {
  const state = {
    bar: 100,
    tray: 200,
    barRect: { ...BAR },
    trayRect: { ...TRAY },
    monitor: { ...MONITOR },
    dpi: 120,
    colour: '#1C1C1C',
    foreground: { hwnd: 9, cls: 'Notepad', rect: { left: 100, top: 100, right: 900, bottom: 700 } },
    below: false,
    placeOk: true,
    own: null,
    attached: [],
    placed: [],
    raised: 0,
    samples: 0,
    loads: 0,
    pids: {},
    live: new Set([9]),
    handed: [],
    desktop: 5,
  };
  const api = {
    findTaskbar: () => state.bar,
    findTrayNotify: (bar) => (bar ? state.tray : 0),
    windowRect: (h) => (h === state.bar ? { ...state.barRect } : h === state.tray ? { ...state.trayRect } : h === 777 ? state.own && { ...state.own } : null),
    monitorRect: () => ({ ...state.monitor }),
    foreground: () => state.foreground,
    dpiFor: () => state.dpi,
    attach: (hwnd) => { state.attached.push(hwnd); return true; },
    place: (hwnd, x, y, w, h) => {
      state.placed.push([hwnd, x, y, w, h]);
      if (!state.placeOk) return false;
      state.own = { left: x, top: y, right: x + w, bottom: y + h };
      return true;
    },
    isBelow: () => state.below,
    raise: () => { state.raised += 1; state.below = false; return true; },
    sampleColour: () => { state.samples += 1; return state.colour; },
    pidOf: (h) => state.pids[h] || 4242,
    isLiveWindow: (h) => state.live.has(h),
    setForeground: (h) => { state.handed.push(h); return true; },
    findDesktop: () => state.desktop,
  };
  return {
    state,
    load: () => { state.loads += 1; return available ? api : null; },
    handleOf: () => 777,
  };
}

function fakeProbe(rect = ICONS_LEFT) {
  const probe = {
    rect,
    started: 0,
    stopped: 0,
    remeasured: 0,
    onChange: null,
    start() { probe.started += 1; },
    stop() { probe.stopped += 1; },
    latest() { return probe.rect; },
    remeasure() { probe.remeasured += 1; },
  };
  return probe;
}

function rig(opts = {}) {
  FakeWindow.all = [];
  const w32 = fakeWin32(opts);
  const probe = fakeProbe(opts.icons === undefined ? ICONS_LEFT : opts.icons);
  const timers = [];
  const logs = [];
  const changes = [];
  const strip = new TaskbarStrip({
    BrowserWindow: FakeWindow,
    win32: w32,
    makeIconProbe: ({ onChange }) => { probe.onChange = onChange; return probe; },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    onChange: (s) => changes.push(s),
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearInterval: (t) => { t.cleared = true; },
    now: () => NOW,
  });
  const run = (ms) => { for (const t of timers) if (!t.cleared && t.ms === ms) t.fn(); };
  const tick = () => run(POLL_MS);
  const guard = () => run(GUARD_MS);
  return { strip, w32, probe, timers, logs, changes, tick, guard };
}

const SNAP = { providers: [provider('claude', { fiveHour: win(38), sevenDay: win(62) }), provider('codex', { sevenDay: win(41) })] };
const lastData = (w) => w.webContents.sent.filter((m) => m.channel === IPC_STRIP.DATA).at(-1)?.payload;
function shownRig(opts) {
  const r = rig(opts);
  r.strip.enable();
  r.strip.update(SNAP);
  FakeWindow.all[0].finishLoad();
  return r;
}
const target = (count = 2) => {
  const p = placement({ bar: BAR, tray: TRAY, icons: ICONS_LEFT, dpi: 120, tileCount: count });
  return [777, BAR.left + p.x, BAR.top + p.y, p.width, p.height];
};

test.describe('enable and disable', () => {
  test('off by default; enable starts the button probe, a poll and a guard, and builds the window once there is something to show', () => {
    const r = rig();
    assert.equal(r.strip.status(), 'off');
    assert.equal(r.strip.enable(), true);
    assert.equal(r.probe.started, 1);
    assert.deepEqual(r.timers.map((t) => t.ms), [POLL_MS, GUARD_MS]);
    assert.equal(FakeWindow.all.length, 0, 'no snapshot yet, nothing to show');
    assert.equal(r.strip.status(), 'hidden');
    r.strip.update(SNAP);
    assert.equal(FakeWindow.all.length, 1);
  });

  test('the window: transparent, unfocusable, hardened, its own preload and its local page', () => {
    const r = rig();
    r.strip.enable();
    r.strip.update(SNAP);
    const w = FakeWindow.all[0];
    const o = w.options;
    assert.equal(o.transparent, true, 'the taskbar shows between the tiles');
    assert.equal(o.focusable, false);
    assert.equal(o.skipTaskbar, true);
    assert.equal(o.show, false);
    assert.equal(o.frame, false);
    assert.equal(o.backgroundColor, '#00000000');
    assert.equal(o.thickFrame, false, 'no resize border or shadow');
    assert.equal(o.webPreferences.sandbox, true);
    assert.equal(o.webPreferences.contextIsolation, true);
    assert.equal(o.webPreferences.nodeIntegration, false);
    assert.equal(o.webPreferences.spellcheck, false);
    assert.equal(o.webPreferences.devTools, false);
    assert.equal(o.webPreferences.preload, PRELOAD);
    assert.equal(w.loaded, PAGE);
    assert.ok(fs.existsSync(PAGE) && fs.existsSync(PRELOAD));
  });

  test('after the page loads: prepared once, placed in physical screen px, shown, sent its tiles', () => {
    const r = rig();
    r.strip.enable();
    r.strip.update(SNAP);
    const w = FakeWindow.all[0];
    assert.deepEqual(r.w32.state.attached, [], 'not before the page has loaded');
    w.finishLoad();
    assert.deepEqual(r.w32.state.attached, [777]);
    assert.deepEqual(r.w32.state.placed, [target()]);
    assert.equal(w.shown, 1);
    const data = lastData(w);
    assert.equal(data.ground, 'dark');
    assert.deepEqual(Object.keys(data).sort(), ['ground', 'tileWidth', 'tiles']);
    assert.equal(data.tileWidth, TILE_WIDTH);
    assert.deepEqual(data.tiles.map((t) => t.id), ['claude', 'codex']);
    assert.equal(r.strip.status(), 'shown');
    assert.deepEqual(r.changes, ['hidden', 'shown'], 'each status change is reported once');
  });

  test('an unchanged snapshot sends nothing, places nothing and reads no pixel', () => {
    const r = shownRig();
    const sent = FakeWindow.all[0].webContents.sent.length;
    const samples = r.w32.state.samples;
    r.strip.update(SNAP);
    r.strip.update(SNAP);
    assert.equal(FakeWindow.all[0].webContents.sent.length, sent);
    assert.equal(r.w32.state.placed.length, 1);
    assert.equal(r.w32.state.samples, samples, 'the screen is read on the poll, not per snapshot');
    r.tick();
    assert.equal(r.w32.state.samples, samples + 1);
    assert.equal(r.w32.state.placed.length, 1, 'the real rect matches the target: no re-place');
  });

  test('a new figure is sent; a tool that loses its windows narrows the strip', () => {
    const r = shownRig();
    const w = FakeWindow.all[0];
    r.strip.update({ providers: [provider('claude', { fiveHour: win(90), sevenDay: win(62) })] });
    assert.equal(lastData(w).tiles.length, 1);
    assert.equal(lastData(w).tiles[0].rows[0].percent, 90);
    assert.deepEqual(r.w32.state.placed.at(-1), target(1));
  });

  test('nothing to show hides the window; something again shows it', () => {
    const r = shownRig();
    const w = FakeWindow.all[0];
    r.strip.update({ providers: [] });
    assert.equal(w.hidden, 1);
    assert.equal(r.strip.status(), 'hidden');
    r.strip.update(SNAP);
    assert.equal(w.shown, 2);
    assert.equal(r.strip.status(), 'shown');
  });

  test('disable destroys the window, stops both timers and the probe; enable again starts over', () => {
    const r = shownRig();
    r.strip.disable();
    assert.equal(FakeWindow.all[0].destroyed, true);
    assert.ok(r.timers.every((t) => t.cleared));
    assert.equal(r.probe.stopped, 1);
    assert.equal(r.strip.status(), 'off');
    r.strip.update(SNAP);
    assert.equal(FakeWindow.all.length, 1, 'off means off: a snapshot builds nothing');
    r.strip.enable();
    assert.equal(FakeWindow.all.length, 2);
  });

  test('enable twice is one strip, one set of timers', () => {
    const r = rig();
    r.strip.enable();
    r.strip.enable();
    assert.equal(r.timers.length, 2);
    assert.equal(r.w32.state.loads, 1);
  });

  test('only the strip page is the strip\'s sender', () => {
    const r = rig();
    r.strip.enable();
    r.strip.update(SNAP);
    assert.equal(r.strip.isSender(FakeWindow.all[0].webContents), true);
    assert.equal(r.strip.isSender({}), false);
    r.strip.disable();
    assert.equal(r.strip.isSender(FakeWindow.all[0].webContents), false);
  });
});

test.describe('room on the taskbar', () => {
  test('until the buttons are measured the strip is hidden as "no-room"; the answer arriving shows it', () => {
    const r = rig({ icons: null });
    r.strip.enable();
    r.strip.update(SNAP);
    assert.equal(FakeWindow.all.length, 0, 'never placed blind');
    assert.equal(r.strip.status(), 'no-room');
    r.probe.rect = ICONS_LEFT;
    r.probe.onChange(ICONS_LEFT);
    assert.equal(FakeWindow.all.length, 1);
    FakeWindow.all[0].finishLoad();
    assert.equal(r.strip.status(), 'shown');
  });

  test('icons growing toward the strip drop tiles from the end, then hide it as "no-room"', () => {
    const r = shownRig();
    const w = FakeWindow.all[0];
    r.probe.rect = { left: 0, top: 1020, right: 1150, bottom: 1080 };
    r.probe.onChange(r.probe.rect);
    assert.deepEqual(lastData(w).tiles.map((t) => t.id), ['claude'], 'codex, last in the order, goes first');
    r.probe.rect = { left: 0, top: 1020, right: 1400, bottom: 1080 };
    r.probe.onChange(r.probe.rect);
    assert.equal(r.strip.status(), 'no-room');
    assert.equal(w.hidden, 1);
  });
});

test.describe('the foreground after the panel closes (owner, 2026-10-20: the strip blinked)', () => {
  const TASKBAR_FG = { hwnd: 100, cls: 'Shell_TrayWnd', rect: { ...BAR } };
  const panelFg = () => ({ hwnd: 31, cls: 'Chrome_WidgetWin_1', rect: { left: 1240, top: 110, right: 1840, bottom: 1010 } });

  test('the panel closing hands the foreground back to the window the user was in', () => {
    const r = shownRig();
    r.guard(); // Notepad (hwnd 9) is the foreground: remembered
    r.w32.state.pids[31] = process.pid;
    r.w32.state.foreground = panelFg();
    r.guard(); // our own panel is never remembered
    assert.equal(r.strip.handBackFocus(), true);
    assert.deepEqual(r.w32.state.handed, [9]);
  });

  test('a foreground taskbar is handed on too; a closed window falls back to the desktop', () => {
    const r = shownRig();
    r.guard();
    r.w32.state.live.delete(9);
    r.w32.state.foreground = TASKBAR_FG;
    r.guard(); // the shell is never remembered
    assert.equal(r.strip.handBackFocus(), true);
    assert.deepEqual(r.w32.state.handed, [5]);
  });

  test('a panel closed by clicking another app leaves that app alone', () => {
    const r = shownRig();
    r.guard();
    r.w32.state.live.add(12);
    r.w32.state.foreground = { hwnd: 12, cls: 'Chrome_WidgetWin_1', rect: { left: 0, top: 0, right: 800, bottom: 600 } };
    assert.equal(r.strip.handBackFocus(), false);
    assert.deepEqual(r.w32.state.handed, []);
  });

  test('with the strip off or not shown, nothing is touched', () => {
    const r = rig();
    assert.equal(r.strip.handBackFocus(), false);
    r.strip.enable();
    assert.equal(r.strip.handBackFocus(), false, 'enabled but nothing shown yet');
    assert.deepEqual(r.w32.state.handed, []);
  });
});

test.describe('z-order, placement and full screen', () => {
  test('z-order is asserted once at attach; moves never re-assert it', () => {
    const r = shownRig();
    assert.deepEqual(r.w32.state.attached, [777]);
    r.w32.state.trayRect = { ...TRAY, left: 1400 };
    r.tick();
    r.tick();
    assert.deepEqual(r.w32.state.attached, [777], 'attach (the one z-order call) ran once');
    assert.equal(r.w32.state.raised, 0, 'a move is not a raise');
  });

  test('the guard re-raises only when the taskbar is above the strip', () => {
    const r = shownRig();
    r.guard();
    r.guard();
    assert.equal(r.w32.state.raised, 0);
    r.w32.state.below = true;
    r.guard();
    assert.equal(r.w32.state.raised, 1);
    r.guard();
    assert.equal(r.w32.state.raised, 1, 'once above, left alone');
  });

  test('a full-screen foreground window hides the strip; it comes back when the window goes', () => {
    const r = shownRig();
    const w = FakeWindow.all[0];
    r.w32.state.foreground = { hwnd: 5, cls: 'Chrome_WidgetWin_1', rect: { ...MONITOR } };
    r.guard();
    assert.equal(w.hidden, 1);
    assert.equal(r.strip.status(), 'covered');
    r.tick();
    assert.equal(r.strip.status(), 'covered', 'the poll does not bring it back over the full-screen window');
    r.w32.state.foreground = { hwnd: 9, cls: 'Notepad', rect: { left: 0, top: 0, right: 800, bottom: 600 } };
    r.guard();
    assert.equal(r.strip.status(), 'shown');
    assert.equal(w.shown, 2);
  });

  test('an auto-hidden taskbar hides the strip', () => {
    const r = shownRig();
    r.w32.state.barRect = { left: 0, top: 1078, right: 1920, bottom: 1138 };
    r.tick();
    assert.equal(r.strip.status(), 'covered');
    assert.equal(FakeWindow.all[0].hidden, 1);
  });

  test('a window moved by someone else is put back on the next poll', () => {
    const r = shownRig();
    r.w32.state.own = { left: 10, top: 10, right: 50, bottom: 50 };
    r.tick();
    assert.equal(r.w32.state.placed.length, 2);
    assert.deepEqual(r.w32.state.placed.at(-1), target());
  });

  test('a failed place claims nothing: not shown, no key, retried on the next poll', () => {
    const r = rig();
    r.w32.state.placeOk = false;
    r.strip.enable();
    r.strip.update(SNAP);
    const w = FakeWindow.all[0];
    w.finishLoad();
    assert.equal(w.shown, 0, 'never showInactive after a failed place');
    assert.equal(r.strip.status(), 'waiting');
    r.w32.state.placeOk = true;
    r.tick();
    assert.equal(w.shown, 1);
    assert.equal(r.strip.status(), 'shown');
  });
});

test.describe('when it cannot be shown', () => {
  test('koffi did not load: enable answers false, "unavailable", no window, no timer, no probe', () => {
    const r = rig({ available: false });
    assert.equal(r.strip.enable(), false);
    assert.equal(r.strip.status(), 'unavailable');
    assert.equal(r.strip.available(), false);
    r.strip.update(SNAP);
    assert.equal(FakeWindow.all.length, 0);
    assert.equal(r.timers.length, 0);
    assert.equal(r.probe.started, 0);
    assert.deepEqual(r.changes, ['unavailable']);
    r.strip.disable();
    assert.equal(r.strip.status(), 'off');
  });

  test('the real win32.js answers null, once, when the native module cannot be had', () => {
    const win32 = require('../src/main/win32');
    const log = require('../src/core/log');
    const seen = [];
    log.setSink((level, msg) => seen.push(`${level}:${msg}`));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      win32.__resetForTest();
      assert.equal(win32.load(), null);
      assert.equal(win32.load(), null);
      assert.equal(seen.filter((m) => m.includes('taskbar strip unavailable')).length, 1, 'tried once, reported once');
      assert.ok(seen[0].includes('code=NOT_WIN32'), seen.join('|'));
    } finally {
      Object.defineProperty(process, 'platform', platform);
      win32.__resetForTest();
      log.setSink(null);
    }
  });

  test('a COLORREF is 0x00BBGGRR, and CLR_INVALID is no colour', () => {
    const { hexOfColorref } = require('../src/main/win32');
    assert.equal(hexOfColorref(0x00332211), '#112233');
    assert.equal(hexOfColorref(0x00F3F3F3), '#F3F3F3');
    assert.equal(hexOfColorref(0xFFFFFFFF), null);
    assert.equal(hexOfColorref(-1), null, 'koffi may hand it back signed');
  });

  test('win32.js: neither parent nor owner, z-order only at attach and raise, moves with SWP_NOZORDER', () => {
    const { MOVE_FLAGS, RAISE_FLAGS } = require('../src/main/win32');
    const SWP_NOZORDER = 0x4;
    const SWP_NOOWNERZORDER = 0x200;
    const SWP_NOACTIVATE = 0x10;
    assert.equal(MOVE_FLAGS & SWP_NOZORDER, SWP_NOZORDER);
    assert.equal(MOVE_FLAGS & SWP_NOOWNERZORDER, SWP_NOOWNERZORDER);
    assert.equal(MOVE_FLAGS & SWP_NOACTIVATE, SWP_NOACTIVATE);
    assert.equal(RAISE_FLAGS & SWP_NOACTIVATE, SWP_NOACTIVATE);
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'win32.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    // A child gets no input on Windows 11; an owner couples input queues (measured).
    assert.equal(code.includes('SetParent'), false);
    assert.equal(code.includes('GWLP_HWNDPARENT'), false);
    assert.equal((code.match(/HWND_TOPMOST, 0, 0, 0, 0, RAISE_FLAGS/g) || []).length, 2, 'attach and raise, nowhere else');
    assert.match(code, /SetWindowPos\(hwnd, 0, Math\.round\(x\),[\s\S]{0,90}?MOVE_FLAGS\)/);
    assert.deepEqual([...code.matchAll(/koffi\.load\('([^']+)'\)/g)].map((m) => m[1]), ['user32.dll', 'gdi32.dll']);
  });

  test('handleOf reads the HWND buffer without koffi, and a bad window is 0', () => {
    const { handleOf } = require('../src/main/win32');
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(65942n);
    assert.equal(handleOf({ getNativeWindowHandle: () => buf }), 65942);
    assert.equal(handleOf({ getNativeWindowHandle: () => { throw new Error('gone'); } }), 0);
    assert.equal(handleOf({}), 0);
  });
});

test.describe('the shell moving under it', () => {
  test('Explorer restarts: hidden while there is no taskbar, placed again on the new one, buttons re-measured', () => {
    const r = shownRig();
    const w = FakeWindow.all[0];
    const measured = r.probe.remeasured;
    r.w32.state.bar = 0;
    r.tick();
    assert.equal(r.strip.status(), 'waiting');
    assert.equal(w.hidden, 1);
    r.w32.state.bar = 101;
    r.w32.state.tray = 201;
    r.tick();
    assert.equal(FakeWindow.all.length, 1, 'a window nobody owns survives Explorer');
    assert.equal(r.probe.remeasured, measured + 1, 'the new taskbar is measured again');
    assert.equal(r.strip.status(), 'shown');
  });

  test('the window was destroyed under us: the next poll rebuilds it', () => {
    const r = shownRig();
    FakeWindow.all[0].destroy();
    r.tick();
    assert.equal(FakeWindow.all.length, 2);
  });

  test('the tray widens or the DPI changes: re-placed, not rebuilt', () => {
    const r = shownRig();
    r.w32.state.trayRect = { ...TRAY, left: 1400 };
    r.tick();
    assert.equal(FakeWindow.all.length, 1);
    const p = placement({ bar: BAR, tray: { ...TRAY, left: 1400 }, icons: ICONS_LEFT, dpi: 120, tileCount: 2 });
    assert.deepEqual(r.w32.state.placed.at(-1), [777, BAR.left + p.x, BAR.top + p.y, p.width, p.height]);
    r.w32.state.dpi = 144;
    r.tick();
    assert.equal(r.w32.state.placed.at(-1)[3], 2 * Math.round(TILE_WIDTH * 1.5));
  });

  test('a renderer crash, a failed load or a failed preload drops the window; the poll rebuilds it', () => {
    for (const fire of [
      (wc) => wc.emit('render-process-gone'),
      (wc) => wc.emit('did-fail-load', {}, -6, 'x', 'file://x', true),
      (wc) => wc.emit('preload-error'),
    ]) {
      const r = shownRig();
      fire(FakeWindow.all[0].webContents);
      assert.equal(FakeWindow.all[0].destroyed, true);
      r.tick();
      assert.equal(FakeWindow.all.length, 2);
    }
  });

  test('a sub-frame load failure is not a dead window', () => {
    const r = shownRig();
    FakeWindow.all[0].webContents.emit('did-fail-load', {}, -6, 'x', 'file://x', false);
    assert.equal(FakeWindow.all[0].destroyed, false);
  });

  test('a window that keeps dying: given up after MAX_REBUILDS, timers and probe stopped, logged once', () => {
    const r = shownRig();
    for (let i = 0; i < 40; i += 1) {
      FakeWindow.all.at(-1).webContents.emit('did-fail-load', {}, -6, 'x', 'file://x', true);
      r.tick();
    }
    assert.equal(r.strip.status(), 'unavailable');
    assert.equal(FakeWindow.all.length, MAX_REBUILDS);
    assert.ok(r.timers.every((t) => t.cleared), 'the poll and the guard stopped');
    assert.equal(r.probe.stopped, 1);
    assert.equal(r.logs.filter((m) => m.includes('giving up')).length, 1);
    const before = FakeWindow.all.length;
    r.strip.update(SNAP);
    r.strip.themeChanged();
    assert.equal(FakeWindow.all.length, before, 'terminal: nothing builds a window again');
  });
});

test.describe('the taskbar colour', () => {
  test('a changed colour is adopted only when read twice in a row (a flyout passing is not a theme)', () => {
    const r = shownRig();
    const w = FakeWindow.all[0];
    r.w32.state.colour = '#EEEEEE';
    r.tick();
    assert.equal(lastData(w).ground, 'dark');
    r.tick();
    assert.equal(lastData(w).ground, 'light');
  });

  test('a one-poll blip is ignored', () => {
    const r = shownRig();
    const w = FakeWindow.all[0];
    r.w32.state.colour = '#FFFFFF';
    r.tick();
    r.w32.state.colour = '#1C1C1C';
    r.tick();
    r.tick();
    assert.equal(lastData(w).ground, 'dark');
    assert.equal(w.webContents.sent.length, 1, 'nothing was repainted');
  });

  test('a Windows theme change is taken at once, with the light ramp for a light taskbar', () => {
    const r = shownRig();
    r.w32.state.colour = '#EEEEEE';
    r.strip.themeChanged();
    const data = lastData(FakeWindow.all[0]);
    assert.equal(data.ground, 'light');
    assert.equal(data.tiles[0].rows[0].colour, RAMPS.light.calm);
  });

  test('an unreadable pixel keeps the last colour', () => {
    const r = shownRig();
    r.w32.state.colour = '#EEEEEE';
    r.strip.themeChanged();
    r.w32.state.colour = null;
    r.tick();
    r.tick();
    assert.equal(lastData(FakeWindow.all[0]).ground, 'light');
  });
});

/* ------------------------------------------------- the page and its wiring */

test.describe('the strip page', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('strict CSP, local files only, no inline script', () => {
    const html = read('src/main/strip/strip.html');
    assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'/);
    assert.equal(/<script>(?!<\/script>)/.test(html), false, 'no inline script');
    assert.equal(/https?:\/\//.test(html), false);
    assert.match(html, /<script src="\.\/strip\.js"><\/script>/);
  });

  test('the page builds with textContent only and asks main for nothing but the two clicks', () => {
    const js = read('src/main/strip/strip.js');
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), false);
    assert.deepEqual([...js.matchAll(/api\.([a-zA-Z]+)\(/g)].map((m) => m[1]).sort(), ['menu', 'onData', 'open']);
  });

  test('every logo the page names exists, under the renderer\'s own file names', () => {
    const css = read('src/main/strip/strip.css');
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
    assert.equal(urls.length, 6);
    for (const u of urls) {
      assert.ok(fs.existsSync(path.join(ROOT, 'src', 'main', 'strip', u)), u);
      assert.match(u, /^\.\.\/\.\.\/renderer\/assets\/logos\/[a-z]+-color\.svg$/);
    }
  });

  test('index.js: snapshots reach the strip, a theme change re-reads its colour, quit takes it out first', () => {
    const src = read('src/main/index.js');
    assert.match(src, /if \(strip\) strip\.update\(snapshot\);/);
    assert.match(src, /strip\.themeChanged\(\)/);
    const quit = src.slice(src.indexOf("app.on('before-quit'"));
    assert.ok(quit.indexOf('strip.disable()') !== -1 && quit.indexOf('strip.disable()') < quit.indexOf('tray.destroy()'));
    assert.match(src, /new TaskbarStrip\(\{ BrowserWindow, log, onChange: \(\) => pushPreferences\(\) \}\)/);
    assert.match(src, /applyTrayView\(settings\.trayView\);/);
    // Left click opens pinned (the pointer is not on the tray icon), right click is the tray's menu.
    assert.match(src, /function openFromStrip\(\)[\s\S]*?openPinned\(\);/);
    assert.match(src, /if \(tray\) tray\.popUpMenu\(\);/);
  });
});

test.describe('the tray menu, reused for a right click on the strip', () => {
  test('popUpMenu pops the tray icon\'s own context menu; a destroyed tray is a no-op', () => {
    const fake = require('./helpers/fake-electron').install();
    try {
      delete require.cache[require.resolve('../src/main/tray')];
      const { TrayController } = require('../src/main/tray');
      const tray = new TrayController({ onToggle() {}, onOpen() {} });
      tray.create({ autostart: true, autostartByWindows: false, onToggleAutostart() {}, onQuit() {} });
      const t = fake.trays[0];
      let popped = 0;
      t.popUpContextMenu = () => { popped += 1; };
      tray.popUpMenu();
      assert.equal(popped, 1);
      tray.destroy();
      tray.popUpMenu();
      assert.equal(popped, 1);
    } finally {
      fake.restore();
      delete require.cache[require.resolve('../src/main/tray')];
    }
  });
});

test('every page the main process can load declares a no-network CSP, the strip page included', () => {
  const pages = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.html')) pages.push(full);
    }
  };
  walk(path.join(ROOT, 'src', 'main'));
  pages.push(path.join(ROOT, 'src', 'renderer', 'index.html'));
  const rel = pages.map((p) => path.relative(ROOT, p).split(path.sep).join('/')).sort();
  assert.ok(rel.includes('src/main/strip/strip.html'), rel.join(','));
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
    assert.ok(csp, `${page} has no CSP`);
    for (const directive of ["default-src 'none'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
      assert.ok(csp[1].includes(directive), `${page}: ${directive}`);
    }
  }
});
