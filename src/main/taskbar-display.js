'use strict';
const path = require('node:path');
const { IPC_STRIP } = require('../shared/contract');

/**
 * The strip's DISPLAY layer, main-thread side (taskbar-strip.js drives it).
 *
 * Two halves:
 *   - an OFFSCREEN BrowserWindow that renders the same strip page, so the
 *     tiles look exactly as they always did, and hands its pixels over on
 *     'paint' — only when something changed (data, hover, size): an idle
 *     strip renders nothing (measured: 0 paints in 5 s idle);
 *   - a worker (taskbar-display-worker.js) that owns a native child window
 *     INSIDE the taskbar and shows those pixels. The worker header says why it
 *     is a child (it stays visible when the taskbar is the foreground) and why
 *     it has a thread of its own (only that thread's input queue is coupled
 *     to Explorer's, so a busy main thread never freezes the taskbar).
 *
 * Main wakes the worker after every command with a thread message
 * (PostThreadMessageW), so the worker can sleep in its message wait instead
 * of polling.
 *
 * `usable()` is true only once a frame has actually been shown in the
 * taskbar; until then, and whenever the worker fails or the taskbar takes the
 * child with it (Explorer restart), the strip keeps drawing with its visible
 * top-level window instead (taskbar-strip.js, layer 'full').
 */

const WORKER = path.join(__dirname, 'taskbar-display-worker.js');
const PAGE = path.join(__dirname, 'strip', 'strip.html');
const PRELOAD = path.join(__dirname, 'strip-preload.js');
/** Paint events are coalesced to at most one frame per this. */
const FRAME_MS = 33;
/** The offscreen page never needs more; it only paints on change anyway. */
const FRAME_RATE = 30;
/** Child creation failing this often in a row is not a restarting Explorer. */
const MAX_ATTACH_FAILURES = 3;

class DisplayLayer {
  /**
   * @param {object} deps
   * @param {Function} deps.BrowserWindow
   * @param {Function} [deps.Worker]
   * @param {Function} [deps.MessageChannel]
   * @param {(tid: number) => boolean} deps.wake   PostThreadMessageW to the worker
   * @param {{info: Function, warn: Function}} deps.log
   * @param {(state: string) => void} [deps.onState]
   * @param {Function} [deps.setTimeout]
   */
  constructor(deps) {
    // eslint-disable-next-line global-require
    const threads = require('node:worker_threads');
    this.BrowserWindow = deps.BrowserWindow;
    this.Worker = deps.Worker || threads.Worker;
    this.MessageChannel = deps.MessageChannel || threads.MessageChannel;
    this.wake = deps.wake || (() => false);
    this.log = deps.log;
    this.onState = deps.onState || (() => {});
    this._setTimeout = deps.setTimeout || setTimeout;

    this.worker = null;
    this.port = null;
    this.tid = 0;
    this.osr = null;
    this._osrReady = false;
    this._state = 'off';
    this._failed = false;
    this._attachFailures = 0;
    this._bar = 0;
    this._requested = 0;
    this._attachedBar = 0;
    this._mode = null;
    this._shownFrames = 0;
    this._place = null;
    this._placeKey = null;
    this._dataKey = null;
    this._pendingData = null;
    this._paint = null;
    this._flushTimer = null;
    this._lastFrame = null;
    this._hidden = true;
  }

  /** 'off' | 'starting' | 'ready' | 'attached' | 'failed' */
  state() {
    return this._state;
  }

  /** 'layered' | 'opaque' | null */
  mode() {
    return this._mode;
  }

  failed() {
    return this._failed;
  }

  /** A frame is on screen inside the taskbar. */
  usable() {
    return !this._failed && this._state === 'attached' && this._shownFrames > 0 && !this._hidden;
  }

  start() {
    if (this.worker || this._failed) return;
    this._setState('starting');
    try {
      const { port1, port2 } = new this.MessageChannel();
      this.port = port1;
      this.worker = new this.Worker(WORKER, { workerData: { port: port2 }, transferList: [port2] });
    } catch (err) {
      this._fail(`worker:${(err && err.code) || 'START'}`);
      return;
    }
    this.port.on('message', (msg) => this._onWorker(msg));
    if (typeof this.port.unref === 'function') this.port.unref();
    this.worker.on('error', (err) => this._fail(`worker:${(err && err.code) || 'ERROR'}`));
    this.worker.on('exit', () => {
      if (this._state !== 'off') this._fail('worker:EXIT');
    });
    if (typeof this.worker.unref === 'function') this.worker.unref();
    this._createOsr();
  }

  stop() {
    const was = this._state;
    this._state = 'off';
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    if (this.port) {
      try { this.port.postMessage({ type: 'stop' }); } catch { /* gone */ }
      if (this.tid) this.wake(this.tid);
    }
    this.port = null;
    this.worker = null;
    this.tid = 0;
    const osr = this.osr;
    this.osr = null;
    if (osr && !osr.isDestroyed()) {
      try { osr.destroy(); } catch { /* going */ }
    }
    this._attachedBar = 0;
    this._shownFrames = 0;
    if (was !== 'off') this.onState('off');
  }

  /** Make the child live inside this taskbar (again, after Explorer restarted). */
  attach(bar) {
    this._bar = bar;
    if (!bar || this._failed || !this.tid) return;
    if (this._attachedBar === bar && this._state === 'attached') return;
    if (this._requested === bar) return;
    this._requested = bar;
    this._shownFrames = 0;
    this._lastFrame = null;
    this._placeKey = null;
    this._send({ type: 'attach', bar });
  }

  /** Relative to the taskbar, physical px; `scale` sizes the page; `colour` for the opaque fallback. */
  place({ x, y, w, h, scale, colour }) {
    this._place = { x, y, w, h, scale, colour };
    this._hidden = false;
    if (this.osr && !this.osr.isDestroyed()) {
      try {
        const [cw, ch] = this.osr.getContentSize();
        if (cw !== w || ch !== h) this.osr.setContentSize(w, h);
      } catch { /* the next place retries */ }
    }
    const key = `${x},${y},${w},${h},${colour}`;
    if (key === this._placeKey || this._state !== 'attached') return;
    this._placeKey = key;
    this._send({ type: 'place', x, y, w, h, colour });
  }

  /** The tiles for the offscreen page (the input layer gets the same tiles). */
  data(payload) {
    const scale = this._place ? this._place.scale : 1;
    const full = { ...payload, layer: 'display', scale };
    const key = JSON.stringify(full);
    if (key === this._dataKey) return;
    this._pendingData = full;
    this._pushData();
  }

  hide() {
    if (this._hidden) return;
    this._hidden = true;
    this._placeKey = null;
    if (this._state === 'attached') this._send({ type: 'hide' });
  }

  /* --------------------------------------------------------------- internals */

  _setState(next) {
    if (next === this._state) return;
    this._state = next;
    try { this.onState(next); } catch { /* the strip's problem */ }
  }

  _fail(code) {
    if (this._failed) return;
    this._failed = true;
    this.log.warn(`taskbar strip display layer unavailable: code=${String(code).slice(0, 32)}`);
    const port = this.port;
    if (port) {
      try { port.postMessage({ type: 'stop' }); } catch { /* gone */ }
      if (this.tid) this.wake(this.tid);
    }
    this.port = null;
    this.worker = null;
    const osr = this.osr;
    this.osr = null;
    if (osr && !osr.isDestroyed()) {
      try { osr.destroy(); } catch { /* going */ }
    }
    this._setState('failed');
  }

  _send(msg, transfer) {
    if (!this.port) return;
    try {
      this.port.postMessage(msg, transfer || []);
    } catch {
      return;
    }
    if (this.tid) this.wake(this.tid);
  }

  _onWorker(msg) {
    if (!msg || typeof msg !== 'object' || this._state === 'off') return;
    switch (msg.type) {
      case 'ready':
        this.tid = Number(msg.tid) || 0;
        this._setState('ready');
        if (this._bar) this.attach(this._bar);
        break;
      case 'attached':
        this._attachedBar = this._requested || 0;
        this._requested = 0;
        this._attachFailures = 0;
        this._mode = msg.mode === 'opaque' ? 'opaque' : 'layered';
        this._setState('attached');
        if (this._place && !this._hidden) this.place(this._place);
        if (this._lastPaint()) this._schedule();
        break;
      case 'mode':
        this._mode = msg.mode === 'opaque' ? 'opaque' : 'layered';
        this.log.info(`taskbar strip display: ${this._mode} fallback`);
        break;
      case 'gone':
        // Explorer restarted: the next attach (from the strip's poll) makes a new child.
        this._attachedBar = 0;
        this._requested = 0;
        this._shownFrames = 0;
        this._setState('ready');
        break;
      case 'failed':
        this._requested = 0;
        if (msg.code === 'CREATE_CHILD' && (this._attachFailures += 1) < MAX_ATTACH_FAILURES) {
          this._setState('ready');
          break;
        }
        this._fail(msg.code || 'WORKER');
        break;
      default:
        break;
    }
  }

  _lastPaint() {
    return this._paint;
  }

  _createOsr() {
    let win;
    try {
      win = new this.BrowserWindow({
        width: 1,
        height: 1,
        useContentSize: true,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        skipTaskbar: true,
        focusable: false,
        thickFrame: false,
        title: 'LimitPeek',
        webPreferences: {
          offscreen: true,
          preload: PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          experimentalFeatures: false,
          webviewTag: false,
          // A network control, not typography (security F11).
          spellcheck: false,
          enableWebSQL: false,
          devTools: false,
          backgroundThrottling: false,
        },
      });
    } catch (err) {
      this._fail(`osr:${(err && err.code) || 'CREATE'}`);
      return;
    }
    this.osr = win;
    const wc = win.webContents;
    try { wc.setFrameRate(FRAME_RATE); } catch { /* default rate */ }
    wc.on('paint', (_event, _dirty, image) => {
      if (this.osr !== win) return;
      this._paint = image;
      this._schedule();
    });
    wc.on('did-finish-load', () => {
      if (this.osr !== win) return;
      this._osrReady = true;
      this._dataKey = null;
      this._pushData();
    });
    wc.on('render-process-gone', () => {
      if (this.osr === win) this._fail('osr:GONE');
    });
    wc.on('did-fail-load', (_e, _code, _d, _u, isMainFrame) => {
      if (isMainFrame && this.osr === win) this._fail('osr:LOAD');
    });
    win.loadFile(PAGE);
  }

  _pushData() {
    if (!this._pendingData || !this._osrReady || !this.osr || this.osr.isDestroyed()) return;
    try {
      this.osr.webContents.send(IPC_STRIP.DATA, this._pendingData);
      this._dataKey = JSON.stringify(this._pendingData);
      this._pendingData = null;
    } catch { /* the next data() retries */ }
  }

  _schedule() {
    if (this._flushTimer || this._state === 'off') return;
    this._flushTimer = this._setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, FRAME_MS);
    if (this._flushTimer && typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
  }

  /** The latest paint, cut to the placed size, to the worker — if it changed. */
  _flush() {
    const image = this._paint;
    const p = this._place;
    if (!image || !p || this._state !== 'attached' || this._hidden) return;
    let frame = image;
    try {
      const size = image.getSize();
      if (size.width < p.w || size.height < p.h) return; // still resizing; the next paint follows
      if (size.width !== p.w || size.height !== p.h) frame = image.crop({ x: 0, y: 0, width: p.w, height: p.h });
    } catch {
      return;
    }
    const bitmap = frame.toBitmap();
    if (bitmap.length !== p.w * p.h * 4) return;
    if (this._lastFrame && this._lastFrame.equals(bitmap)) {
      this._shownFrames = Math.max(this._shownFrames, 1);
      return;
    }
    this._lastFrame = bitmap;
    const copy = new Uint8Array(bitmap);
    this._send({ type: 'frame', w: p.w, h: p.h, data: copy }, [copy.buffer]);
    const first = this._shownFrames === 0;
    this._shownFrames += 1;
    if (first) {
      try { this.onState('shown'); } catch { /* the strip's problem */ }
    }
  }
}

module.exports = { DisplayLayer, WORKER, FRAME_MS, MAX_ATTACH_FAILURES };
