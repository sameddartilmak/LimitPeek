'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { DisplayLayer, WORKER, FRAME_MS, MAX_ATTACH_FAILURES } = require('../src/main/taskbar-display');
const { TaskbarStrip, TILE_WIDTH } = require('../src/main/taskbar-strip');
const { IPC_STRIP } = require('../src/shared/contract');

const ROOT = path.join(__dirname, '..');

/**
 * The strip's DISPLAY layer (src/main/taskbar-display.js and its worker):
 * the tiles drawn inside the taskbar, so they stay visible when the taskbar is
 * the foreground window (owner, 2026-10-20). The worker, the offscreen window
 * and the timers are fakes; nothing here touches the real taskbar.
 */

/* ----------------------------------------------------------------- fakes */

class FakePort extends EventEmitter {
  constructor() { super(); this.posted = []; }
  postMessage(msg, transfer) { this.posted.push({ msg, transfer }); }
  unref() {}
}

class FakeChannel {
  constructor() { this.port1 = new FakePort(); this.port2 = new FakePort(); FakeChannel.last = this; }
}

class FakeWorker extends EventEmitter {
  constructor(file, opts) { super(); this.file = file; this.opts = opts; FakeWorker.last = this; }
  unref() {}
}

class FakeImage {
  constructor(w, h, fill = 1) { this.w = w; this.h = h; this.fill = fill; this.cropped = null; }
  getSize() { return { width: this.w, height: this.h }; }
  crop(r) { const img = new FakeImage(r.width, r.height, this.fill); img.cropped = r; return img; }
  toBitmap() { return Buffer.alloc(this.w * this.h * 4, this.fill); }
}

class FakeOsr extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.size = [options.width, options.height];
    const wc = new EventEmitter();
    wc.sent = [];
    wc.frameRate = null;
    wc.send = (channel, payload) => wc.sent.push({ channel, payload });
    wc.setFrameRate = (r) => { wc.frameRate = r; };
    this.webContents = wc;
    this.loaded = null;
    FakeOsr.last = this;
  }
  loadFile(f) { this.loaded = f; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  getContentSize() { return [...this.size]; }
  setContentSize(w, h) { this.size = [w, h]; }
  paint(img) { this.webContents.emit('paint', {}, {}, img); }
}

function layerRig() {
  const timers = [];
  const wakes = [];
  const states = [];
  const logs = [];
  const layer = new DisplayLayer({
    BrowserWindow: FakeOsr,
    Worker: FakeWorker,
    MessageChannel: FakeChannel,
    wake: (tid) => { wakes.push(tid); return true; },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    onState: (s) => states.push(s),
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
  });
  const port = () => FakeChannel.last.port1;
  const sent = () => port().posted.map((p) => p.msg);
  const fromWorker = (msg) => port().emit('message', msg);
  const flush = () => { while (timers.length) timers.shift().fn(); };
  return { layer, timers, wakes, states, logs, port, sent, fromWorker, flush };
}

const PLACE = { x: 1061, y: 5, w: 450, h: 50, scale: 1.25, colour: '#202020' };
const TILES = { ground: 'dark', tileWidth: TILE_WIDTH, tiles: [{ id: 'claude', title: 't', rows: [] }] };

function attachedRig() {
  const r = layerRig();
  r.layer.start();
  r.fromWorker({ type: 'ready', tid: 4242 });
  r.layer.attach(100);
  r.fromWorker({ type: 'attached', hwnd: 9, mode: 'layered' });
  r.layer.place(PLACE);
  FakeOsr.last.webContents.emit('did-finish-load');
  r.layer.data(TILES);
  return r;
}

/* ----------------------------------------------------------- DisplayLayer */

test.describe('the display layer, main side', () => {
  test('start: one worker with its own port, and a hardened OFFSCREEN window on the strip page', () => {
    const r = layerRig();
    r.layer.start();
    assert.equal(FakeWorker.last.file, WORKER);
    assert.equal(FakeWorker.last.opts.workerData.port, FakeChannel.last.port2);
    assert.deepEqual(FakeWorker.last.opts.transferList, [FakeChannel.last.port2]);
    const o = FakeOsr.last.options;
    assert.equal(o.webPreferences.offscreen, true);
    assert.equal(o.transparent, true);
    assert.equal(o.show, false);
    assert.equal(o.webPreferences.sandbox, true);
    assert.equal(o.webPreferences.contextIsolation, true);
    assert.equal(o.webPreferences.nodeIntegration, false);
    assert.equal(o.webPreferences.spellcheck, false);
    assert.equal(o.webPreferences.devTools, false);
    assert.ok(FakeOsr.last.loaded.endsWith(path.join('strip', 'strip.html')));
    assert.equal(FakeOsr.last.webContents.frameRate, 30);
    assert.equal(r.layer.state(), 'starting');
    assert.equal(r.layer.usable(), false);
  });

  test('ready, then attach: the worker is told which taskbar, and woken with a thread message', () => {
    const r = layerRig();
    r.layer.start();
    r.layer.attach(100);
    assert.deepEqual(r.sent(), [], 'nothing before the worker is ready');
    r.fromWorker({ type: 'ready', tid: 4242 });
    assert.deepEqual(r.sent(), [{ type: 'attach', bar: 100 }], 'the remembered taskbar is attached on ready');
    assert.deepEqual(r.wakes, [4242]);
    r.layer.attach(100);
    assert.equal(r.sent().length, 1, 'not twice for the same taskbar');
  });

  test('attached: placed relative to the taskbar, data to the offscreen page with layer, scale and hover', () => {
    const r = attachedRig();
    assert.equal(r.layer.state(), 'attached');
    assert.deepEqual(r.sent().at(-1), { type: 'place', x: 1061, y: 5, w: 450, h: 50, colour: '#202020' });
    assert.deepEqual(FakeOsr.last.size, [450, 50], 'the page renders at the placed physical size');
    const data = FakeOsr.last.webContents.sent.at(-1);
    assert.equal(data.channel, IPC_STRIP.DATA);
    assert.equal(data.payload.layer, 'display');
    assert.equal(data.payload.scale, 1.25);
    r.layer.data(TILES);
    assert.equal(FakeOsr.last.webContents.sent.length, 1, 'identical data is not re-sent (no repaint)');
  });

  test('a paint becomes ONE frame per FRAME_MS, cut to the placed size, transferred, and only when it changed', () => {
    const r = attachedRig();
    assert.equal(r.layer.usable(), false, 'not before a frame is on screen');
    FakeOsr.last.paint(new FakeImage(453, 53, 7));
    FakeOsr.last.paint(new FakeImage(453, 53, 7));
    assert.equal(r.timers.length, 1, 'coalesced');
    assert.equal(r.timers[0].ms, FRAME_MS);
    r.flush();
    const frames = r.port().posted.filter((p) => p.msg.type === 'frame');
    assert.equal(frames.length, 1);
    assert.equal(frames[0].msg.w, 450);
    assert.equal(frames[0].msg.h, 50);
    assert.equal(frames[0].msg.data.length, 450 * 50 * 4);
    assert.deepEqual(frames[0].transfer, [frames[0].msg.data.buffer], 'moved, not copied, across the thread');
    assert.equal(r.layer.usable(), true);
    assert.ok(r.states.includes('shown'));
    FakeOsr.last.paint(new FakeImage(453, 53, 7));
    r.flush();
    assert.equal(r.port().posted.filter((p) => p.msg.type === 'frame').length, 1, 'the same pixels are not sent again');
    FakeOsr.last.paint(new FakeImage(450, 50, 9));
    r.flush();
    assert.equal(r.port().posted.filter((p) => p.msg.type === 'frame').length, 2);
  });

  test('a paint smaller than the placed size (still resizing) is skipped', () => {
    const r = attachedRig();
    FakeOsr.last.paint(new FakeImage(300, 50));
    r.flush();
    assert.equal(r.port().posted.filter((p) => p.msg.type === 'frame').length, 0);
    assert.equal(r.layer.usable(), false);
  });

  test('hide: the child is hidden and the layer is not usable until placed again', () => {
    const r = attachedRig();
    FakeOsr.last.paint(new FakeImage(450, 50));
    r.flush();
    r.layer.hide();
    assert.deepEqual(r.sent().at(-1), { type: 'hide' });
    assert.equal(r.layer.usable(), false);
    r.layer.place(PLACE);
    assert.equal(r.sent().at(-1).type, 'place');
    assert.equal(r.layer.usable(), true);
  });

  test('Explorer restarted ("gone"): not usable, and the next attach makes a new child', () => {
    const r = attachedRig();
    FakeOsr.last.paint(new FakeImage(450, 50));
    r.flush();
    r.fromWorker({ type: 'gone' });
    assert.equal(r.layer.usable(), false);
    assert.equal(r.layer.state(), 'ready');
    r.layer.attach(101);
    assert.deepEqual(r.sent().at(-1), { type: 'attach', bar: 101 });
  });

  test('the opaque fallback is recorded; the layer stays usable', () => {
    const r = attachedRig();
    FakeOsr.last.paint(new FakeImage(450, 50));
    r.flush();
    r.fromWorker({ type: 'mode', mode: 'opaque' });
    assert.equal(r.layer.mode(), 'opaque');
    assert.equal(r.layer.usable(), true);
    assert.ok(r.logs.some((m) => m.includes('opaque fallback')));
  });

  test('a child that cannot be made: retried, then the layer fails for good and stops everything', () => {
    const r = layerRig();
    r.layer.start();
    r.fromWorker({ type: 'ready', tid: 1 });
    r.layer.attach(100);
    for (let i = 1; i < MAX_ATTACH_FAILURES; i += 1) {
      r.fromWorker({ type: 'failed', code: 'CREATE_CHILD' });
      assert.equal(r.layer.failed(), false, `failure ${i} is retried`);
      r.layer.attach(100);
    }
    r.fromWorker({ type: 'failed', code: 'CREATE_CHILD' });
    assert.equal(r.layer.failed(), true);
    assert.equal(r.layer.state(), 'failed');
    assert.deepEqual(r.sent().at(-1), { type: 'stop' });
    assert.equal(FakeOsr.last.destroyed, true);
    assert.equal(r.logs.filter((m) => m.includes('display layer unavailable')).length, 1);
  });

  test('any other worker failure, a worker error or exit, or a dead offscreen page fails the layer', () => {
    for (const fire of [
      (r) => r.fromWorker({ type: 'failed', code: 'SETUP_FAILED' }),
      () => FakeWorker.last.emit('error', Object.assign(new Error('x'), { code: 'ERR' })),
      () => FakeWorker.last.emit('exit', 1),
      () => FakeOsr.last.webContents.emit('render-process-gone'),
    ]) {
      const r = layerRig();
      r.layer.start();
      fire(r);
      assert.equal(r.layer.failed(), true);
      assert.equal(r.layer.usable(), false);
    }
  });

  test('stop: the worker is told to stop and woken, the offscreen window goes, nothing is usable', () => {
    const r = attachedRig();
    r.layer.stop();
    assert.deepEqual(FakeChannel.last.port1.posted.at(-1).msg, { type: 'stop' });
    assert.equal(r.wakes.at(-1), 4242);
    assert.equal(FakeOsr.last.destroyed, true);
    assert.equal(r.layer.usable(), false);
    FakeWorker.last.emit('exit', 0);
    assert.equal(r.layer.failed(), false, 'an exit after stop is not a failure');
  });
});

/* ---------------------------------------------- the strip with a display */

const BAR = { left: 0, top: 1020, right: 1920, bottom: 1080 };
const TRAY = { left: 1481, top: 1020, right: 1920, bottom: 1080 };
const ICONS = { left: 0, top: 1020, right: 784, bottom: 1080 };

class FakeInputWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    const wc = new EventEmitter();
    wc.sent = [];
    wc.send = (channel, payload) => wc.sent.push({ channel, payload });
    this.webContents = wc;
    FakeInputWindow.last = this;
  }
  loadFile() {}
  setMenu() {}
  showInactive() {}
  hide() {}
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  getBounds() { return { x: 0, y: 0, width: 1, height: 1 }; }
}

function fakeDisplay() {
  const d = {
    calls: [],
    isUsable: false,
    isFailed: false,
    onState: null,
    wake: null,
    start() { d.calls.push(['start']); },
    stop() { d.calls.push(['stop']); },
    attach(bar) { d.calls.push(['attach', bar]); },
    place(p) { d.calls.push(['place', p]); },
    data(p) { d.calls.push(['data', p]); },
    hide() { d.calls.push(['hide']); },
    usable() { return d.isUsable; },
    failed() { return d.isFailed; },
  };
  return d;
}

function stripRig() {
  const intervals = [];
  const timeouts = [];
  const display = fakeDisplay();
  const state = { bar: 100, own: null };
  const api = {
    findTaskbar: () => state.bar,
    findTrayNotify: () => 200,
    windowRect: (h) => (h === state.bar ? { ...BAR } : h === 200 ? { ...TRAY } : state.own),
    monitorRect: () => ({ left: 0, top: 0, right: 1920, bottom: 1080 }),
    foreground: () => null,
    dpiFor: () => 120,
    attach: () => true,
    place: (h, x, y, w, hh) => { state.own = { left: x, top: y, right: x + w, bottom: y + hh }; return true; },
    isBelow: () => false,
    raise: () => true,
    sampleColour: () => '#202020',
    pidOf: () => 0,
    wakeThread: (tid) => { state.woke = tid; return true; },
    cursor: () => state.cursor || null,
    leftButtonDown: () => Boolean(state.down),
    rootAt: () => state.rootAt || 0,
  };
  const strip = new TaskbarStrip({
    BrowserWindow: FakeInputWindow,
    win32: { load: () => api, handleOf: () => 777 },
    makeIconProbe: () => ({ start() {}, stop() {}, latest: () => ICONS, remeasure() {} }),
    makeDisplay: (opts) => { display.onState = opts.onState; display.wake = opts.wake; return display; },
    log: { info() {}, warn() {} },
    setInterval: (fn, ms) => { const t = { fn, ms }; intervals.push(t); return t; },
    clearInterval: () => {},
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timeouts.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    onCoveredClick: () => { state.coveredClicks = (state.coveredClicks || 0) + 1; },
    now: () => Date.parse('2026-10-20T12:00:00Z'),
  });
  const snap = {
    providers: [{
      id: 'claude', displayName: 'Claude Code', enabled: true, connected: true, setupAction: null,
      fiveHour: { usedPercentage: 30, certainty: 'known', resetsAt: '2026-10-20T14:00:00Z' }, sevenDay: null,
    }],
  };
  const inputData = () => FakeInputWindow.last.webContents.sent.filter((m) => m.channel === IPC_STRIP.DATA).at(-1)?.payload;
  const guard = () => { for (const t of intervals) if (t.ms === 500) t.fn(); };
  const watchTick = () => {
    const live = timeouts.filter((t) => !t.cleared && !t.ran);
    for (const t of live) { t.ran = true; t.fn(); }
    return live.length;
  };
  return { strip, display, state, snap, inputData, guard, watchTick, timeouts };
}

function shown(r) {
  r.strip.enable();
  r.strip.update(r.snap);
  FakeInputWindow.last.webContents.emit('did-finish-load');
}

test.describe('the strip drives both layers', () => {
  test('enable starts the display layer and hands it a wake function over the thread message', () => {
    const r = stripRig();
    r.strip.enable();
    assert.deepEqual(r.display.calls[0], ['start']);
    assert.equal(r.display.wake(55), true);
    assert.equal(r.state.woke, 55);
  });

  test('until the display has shown a frame the input window draws the tiles itself ("full")', () => {
    const r = stripRig();
    shown(r);
    assert.equal(r.inputData().layer, 'full');
    assert.equal(r.strip.layer(), 'full');
  });

  test('the display gets the taskbar, the place RELATIVE to it, the scale and the colour, and the same tiles', () => {
    const r = stripRig();
    shown(r);
    const attach = r.display.calls.find((c) => c[0] === 'attach');
    assert.deepEqual(attach, ['attach', 100]);
    const place = r.display.calls.filter((c) => c[0] === 'place').at(-1)[1];
    const own = r.state.own;
    assert.equal(BAR.left + place.x, own.left, 'the same place as the input window');
    assert.equal(BAR.top + place.y, own.top);
    assert.equal(place.w, own.right - own.left);
    assert.equal(place.scale, 1.25);
    assert.equal(place.colour, '#202020');
    const data = r.display.calls.filter((c) => c[0] === 'data').at(-1)[1];
    assert.deepEqual(data.tiles, r.inputData().tiles);
    assert.equal(data.hover, -1);
  });

  test('once the display shows a frame the input window goes invisible ("input")', () => {
    const r = stripRig();
    shown(r);
    r.display.isUsable = true;
    r.display.onState('shown');
    assert.equal(r.inputData().layer, 'input');
  });

  test('hover from the input page is passed on to the display; garbage is "no tile"', () => {
    const r = stripRig();
    shown(r);
    r.display.isUsable = true;
    r.display.onState('shown');
    r.strip.hover(0);
    assert.equal(r.display.calls.filter((c) => c[0] === 'data').at(-1)[1].hover, 0);
    r.strip.hover('x');
    assert.equal(r.display.calls.filter((c) => c[0] === 'data').at(-1)[1].hover, -1);
    const n = r.display.calls.length;
    r.strip.hover(99);
    assert.equal(r.display.calls.length, n, 'unchanged (still -1): no sync');
  });

  test('the display failing brings the visible top-level strip back ("full")', () => {
    const r = stripRig();
    shown(r);
    r.display.isUsable = true;
    r.display.onState('shown');
    assert.equal(r.inputData().layer, 'input');
    r.display.isUsable = false;
    r.display.isFailed = true;
    r.display.onState('failed');
    assert.equal(r.inputData().layer, 'full');
    const n = r.display.calls.filter((c) => c[0] === 'place').length;
    r.strip.update(r.snap);
    assert.equal(r.display.calls.filter((c) => c[0] === 'place').length, n, 'a failed display is not driven');
  });

  test('hiding the strip hides the display; disable stops it; a new taskbar is attached', () => {
    const r = stripRig();
    shown(r);
    r.strip.update({ providers: [] });
    assert.ok(r.display.calls.some((c) => c[0] === 'hide'));
    r.strip.update(r.snap);
    r.state.bar = 101;
    r.strip.update(r.snap);
    assert.deepEqual(r.display.calls.filter((c) => c[0] === 'attach').at(-1), ['attach', 101]);
    r.strip.disable();
    assert.deepEqual(r.display.calls.at(-1), ['stop']);
  });
});

test.describe('a click the foreground taskbar took (it covers the invisible input window)', () => {
  function covered() {
    const r = stripRig();
    shown(r);
    const own = r.state.own;
    r.state.cursor = { x: own.left + 20, y: own.top + 10 };
    r.state.rootAt = 100; // the taskbar, not our window (777)
    return r;
  }

  test('no watch while the taskbar is not the foreground', () => {
    const r = covered();
    r.guard();
    assert.equal(r.watchTick(), 0);
  });

  test('taskbar in front: a press and release over the strip opens the panel, once', () => {
    const r = covered();
    r.strip._api.foreground = () => ({ hwnd: 100, cls: 'Shell_TrayWnd', rect: { ...BAR } });
    r.guard();
    r.state.down = true;
    r.watchTick();
    assert.equal(r.state.coveredClicks, undefined, 'not on the press');
    r.state.down = false;
    r.watchTick();
    assert.equal(r.state.coveredClicks, 1, 'on the release');
    r.watchTick();
    assert.equal(r.state.coveredClicks, 1);
  });

  test('where our own window is on top the page takes the click, so the watch stays out of it', () => {
    const r = covered();
    r.strip._api.foreground = () => ({ hwnd: 100, cls: 'Shell_TrayWnd', rect: { ...BAR } });
    r.state.rootAt = 777;
    r.guard();
    r.state.down = true;
    r.watchTick();
    r.state.down = false;
    r.watchTick();
    assert.equal(r.state.coveredClicks, undefined);
  });

  test('a press outside the strip, released inside, is not a click; the watch is slow outside, fast inside', () => {
    const r = covered();
    r.strip._api.foreground = () => ({ hwnd: 100, cls: 'Shell_TrayWnd', rect: { ...BAR } });
    r.guard();
    const inside = r.state.cursor;
    r.state.cursor = { x: 10, y: 1050 };
    r.state.down = true;
    r.watchTick();
    assert.equal(r.timeouts.at(-1).ms, 120);
    r.state.cursor = inside;
    r.state.down = false;
    r.watchTick();
    assert.equal(r.state.coveredClicks, undefined);
    assert.equal(r.timeouts.at(-1).ms, 30);
  });

  test('the watch stops when the taskbar is no longer in front, and when the strip hides', () => {
    const r = covered();
    r.strip._api.foreground = () => ({ hwnd: 100, cls: 'Shell_TrayWnd', rect: { ...BAR } });
    r.guard();
    r.strip._api.foreground = () => ({ hwnd: 5, cls: 'Notepad', rect: { left: 0, top: 0, right: 10, bottom: 10 } });
    r.guard();
    assert.equal(r.watchTick(), 0);
    r.strip._api.foreground = () => ({ hwnd: 100, cls: 'Shell_TrayWnd', rect: { ...BAR } });
    r.guard();
    r.strip.update({ providers: [] });
    assert.equal(r.watchTick(), 0);
  });
});

/* ------------------------------------------------------------ the worker */

test.describe('the display worker', () => {
  const src = fs.readFileSync(WORKER, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

  test('a layered, input-transparent, never-activating CHILD of the taskbar, above the island', () => {
    assert.match(code, /CreateWindowExW\(WS_EX_LAYERED \| WS_EX_TRANSPARENT \| WS_EX_NOACTIVATE, CLASS_NAME/);
    assert.match(code, /WS_CHILD \| WS_CLIPSIBLINGS, 0, 0, 1, 1, bar,/);
    assert.match(code, /if \(msg === WM_NCHITTEST\) return HTTRANSPARENT;/);
    assert.match(code, /SetWindowPos\(hwnd, HWND_TOP,/);
    assert.match(code, /const HWND_TOP = 0;/);
  });

  test('its own message loop: waits in MsgWaitForMultipleObjectsEx and reads commands synchronously', () => {
    assert.match(code, /MsgWaitForMultipleObjectsEx\(0, null, IDLE_WAIT_MS, QS_ALLINPUT, MWMO_INPUTAVAILABLE\)/);
    assert.match(code, /receiveMessageOnPort\(port\)/);
    assert.match(code, /PeekMessageW\(m, 0, 0, 0, PM_REMOVE\)/);
    // Never back into Node's event loop while it owns the window: no timers, no 'message' listener.
    assert.equal(/setInterval|setTimeout|\.on\('message'/.test(code), false);
  });

  test('pixels reach the DIB with RtlMoveMemory — never koffi.view, which Electron refuses fatally', () => {
    assert.equal(code.includes('koffi.view'), false);
    assert.match(code, /RtlMoveMemory\(bitsPtr, data, data\.length\)/);
    assert.match(code, /UpdateLayeredWindow\(hwnd, screenDc, null,/);
    assert.match(code, /ULW_ALPHA/);
  });

  test('the opaque fallback stays layered (a plain child is covered by the island) and paints with GDI', () => {
    assert.match(code, /SetLayeredWindowAttributes\(hwnd, 0, 255, LWA_ALPHA\)/);
    assert.match(code, /if \(!\(ex & WS_EX_LAYERED\)\)/);
    assert.match(code, /BitBlt\(dc, 0, 0, dibW, dibH, memDc, 0, 0, SRCCOPY\)/);
  });

  test('everything it made is released when it stops', () => {
    const teardown = code.slice(code.indexOf('function teardown()'));
    for (const call of ['destroyWindow()', 'freeDib()', 'DeleteDC(memDc)', 'ReleaseDC(0, screenDc)', 'UnregisterClassW(CLASS_NAME', 'koffi.unregister(wndProc)']) {
      assert.ok(teardown.includes(call), call);
    }
  });

  test('the opaque composite over the taskbar colour is premultiplied-correct', () => {
    // The worker's arithmetic, restated: out = src + bg * (255 - a) / 255.
    const blend = (src, a, bg) => src + ((bg * (255 - a) + 127) / 255 | 0);
    assert.equal(blend(0, 0, 32), 32, 'transparent shows the taskbar');
    assert.equal(blend(200, 255, 32), 200, 'opaque shows the tile');
    assert.equal(blend(64, 128, 32), 64 + 16);
    assert.match(code, /bits\[i\] = src\[i\] \+ \(\(b \* k \+ 127\) \/ 255 \| 0\);/);
  });
});

/* -------------------------------------------------------------- the page */

test.describe('the strip page, three layers', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'main', 'strip', 'strip.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'main', 'strip', 'strip.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'strip-preload.js'), 'utf8');

  test('the input layer is laid out but invisible (opacity, so every tile still takes the mouse)', () => {
    assert.match(css, /body\[data-layer="input"\] \.strip \{ opacity: 0; \}/);
    assert.equal(/data-layer="input"[^}]*(display: none|visibility: hidden|pointer-events: none)/.test(css), false);
  });

  test('the display layer zooms to the taskbar scale, bounded, and lights the hovered tile', () => {
    assert.match(js, /data\.scale >= 1 && data\.scale <= 4/);
    assert.match(js, /document\.documentElement\.style\.zoom = String\(scale\)/);
    assert.match(css, /\.tile--hover/);
  });

  test('the preload passes only a small integer for the hover', () => {
    assert.match(preload, /hover: \(index\) => ipcRenderer\.send\(CH\.HOVER, Number\.isInteger\(index\) && index >= -1 && index < 16 \? index : -1\)/);
  });
});
