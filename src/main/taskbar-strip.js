'use strict';
const path = require('node:path');
const { IPC_STRIP } = require('../shared/contract');
const { stripTiles, groundFor } = require('../core/strip-tiles');
const defaultWin32 = require('./win32');
const { IconProbe } = require('./taskbar-icons');

/**
 * The taskbar strip (Settings → Genel → Görünüm → "Görev çubuğu şeridi").
 *
 * A small window ON the Windows 11 taskbar, just left of the notification
 * area: one tile per visible tool, its logo and a mini bar for the five-hour
 * and the seven-day window. Off by default. While it is shown the tray icon is
 * removed and the strip carries the click and the menu; the icon returns
 * whenever the strip is not shown (index.js syncTrayPresence).
 *
 * HOW IT GETS ONTO THE TASKBAR (measured on this machine, 2026-10-20)
 * ------------------------------------------------------------------
 *   1. A transparent, frameless, unfocusable BrowserWindow is created hidden.
 *   2. win32.js makes it a topmost tool window that never activates — ONCE.
 *      It is neither a child of the taskbar (a child gets no mouse input on
 *      Windows 11) nor owned by it (a cross-thread owner couples the two input
 *      queues, so a busy app would freeze the taskbar); win32.js has both
 *      measurements.
 *   3. SetWindowPos places it in PHYSICAL screen pixels over the empty part of
 *      the taskbar left of the tray, with SWP_NOZORDER: a move never re-asserts
 *      the z-order.
 *   4. A guard every GUARD_MS re-raises it only when the taskbar is actually
 *      above it (the taskbar rises when it is clicked), and hides it while a
 *      full-screen window covers the taskbar's monitor, which a topmost window
 *      would otherwise sit on top of.
 *
 * WHERE IT MAY GO
 * ---------------
 * Between the taskbar's buttons and the tray, never over a button. The
 * buttons' right edge is measured with UI Automation in a worker
 * (taskbar-icons.js), centred or left-aligned, Widgets included, and the strip
 * keeps ICON_GAP from it. Tiles are dropped from the end of the panel order
 * until the rest fit. Until the buttons have been measured, or when not even
 * one tile fits, the strip is hidden and its status is 'no-room', which the
 * settings screen explains.
 *
 * The taskbar colour is read with GDI at a point in the gap between the strip
 * and the tray (the strip never covers it), on the poll and on a Windows theme
 * change only — never per snapshot — and only to choose dark or light ink and
 * the matching ramp: the window is transparent, so the taskbar's own material
 * shows between the tiles.
 *
 * WHAT CAN GO WRONG, AND WHAT HAPPENS THEN
 * ----------------------------------------
 *   - koffi cannot load (no binary for this CPU, not Windows): `enable()`
 *     answers false, the status is 'unavailable', and nothing else changes.
 *   - Explorer restarts: the taskbar disappears ('waiting', strip hidden) and
 *     comes back with a new handle; the strip is placed on the new one and the
 *     buttons are measured again.
 *   - The taskbar auto-hides: its rectangle slides mostly off the monitor and
 *     the strip hides with it ('covered').
 *   - The window keeps dying (a renderer that will not load): it is rebuilt at
 *     most MAX_REBUILDS times, then the strip stops for the session as
 *     'unavailable'.
 *   - Something else moved or resized the window: the poll compares the real
 *     rectangle with the target and places it again.
 *
 * Nothing here requires `electron`: the BrowserWindow class, Win32 and the
 * button probe are passed in, so `test/taskbar-strip.test.js` drives this
 * exact class.
 *
 * TWO LAYERS (owner, 2026-10-20: any click on the taskbar made the strip vanish)
 * -------------------------------------------------------------------------
 * Any click on the taskbar — the ^ arrow, the clock, Wi-Fi, Start — makes it
 * the foreground window, and a foreground taskbar sits in a z-band no ordinary
 * topmost window can enter. So the tiles the user SEES are drawn by a DISPLAY
 * layer inside the taskbar (taskbar-display.js: the page rendered offscreen,
 * shown by a native child of the taskbar owned by a worker thread), and the
 * window placed here becomes the INPUT layer: laid out but invisible, it takes
 * the clicks, shows the native tooltip and reports the hovered tile, which the
 * display layer lights. While the taskbar is the foreground the input layer is
 * under it, and a click on a tile lands on the taskbar instead (measured:
 * mousedown never reached the page). So while the taskbar is the foreground
 * and covers the input window, a light watch (CLICK_WATCH_*: cursor position
 * and the left button's state, read, never consumed) turns a press and
 * release over the strip into the same left click. Right-click is left to the
 * taskbar there (it opens its own menu). Until the display layer
 * has shown a frame, and whenever it is unavailable, this window draws the
 * tiles itself (layer 'full'), exactly as before.
 *
 * PHASE 2 (not done here): secondary monitors' taskbars
 * (`Shell_SecondaryTrayWnd`); a vertical taskbar; anchoring the panel to the
 * strip instead of the tray icon; a native-looking hover card; the "time
 * elapsed in window" line under each bar; event-driven re-measurement (UI
 * Automation structure events) instead of the worker's one-second poll.
 */

/**
 * One tile's width in DIP. The page lays tiles out at exactly this. Room for
 * the logo and, per row, the label, a bar, the figure and the time left
 * ("5sa ▬▬ %22 1sa 37dk"; the owner asked for the last two, 2026-10-20).
 */
const TILE_WIDTH = 180;
/** The strip's height in DIP; the Windows 11 taskbar is 48. */
const STRIP_HEIGHT = 40;
/** Between the strip's right edge and the notification area, in DIP. */
const TRAY_GAP = 8;
/** Between the taskbar's last button and the strip's left edge, in DIP. */
const ICON_GAP = 12;
/** Where in the tray gap the taskbar colour is read, from the tray's left edge. */
const SAMPLE_INSET = 3;
/** Re-read rectangles, the taskbar handle and its colour this often. */
const POLL_MS = 2000;
/** Z-order and full-screen check, this often, while the strip is wanted. */
const GUARD_MS = 500;
/** The covered-click watch: fast while the cursor is over the strip, slow elsewhere. */
const CLICK_WATCH_INSIDE_MS = 30;
const CLICK_WATCH_OUTSIDE_MS = 120;
/** A window the shell keeps killing is not rebuilt for ever. */
const MAX_REBUILDS = 20;
const FALLBACK_COLOUR = '#202020';
/**
 * Foreground classes that cover the monitor without being a full-screen app:
 * the desktop, the taskbar, and the shell's own surfaces (Start, Search), which
 * are CoreWindows the size of the monitor with the taskbar still showing.
 */
const NOT_FULLSCREEN = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow',
]);

const PAGE = path.join(__dirname, 'strip', 'strip.html');
const PRELOAD = path.join(__dirname, 'strip-preload.js');

/**
 * Where the strip goes, in PHYSICAL pixels relative to the taskbar's top-left
 * corner (the caller adds the taskbar's screen position), or null when it must
 * not be shown: no tiles, no measured button area, not even one tile fits, or
 * a vertical or collapsed taskbar.
 *
 * @param {{bar:object, tray:object, icons:object|null, dpi:number, tileCount:number}} input
 *   `bar`, `tray` and `icons` are screen rectangles ({left,top,right,bottom}).
 *   `icons` is the union of the taskbar's buttons (taskbar-icons.js); without
 *   it there is no safe place.
 */
function placement({ bar, tray, icons, dpi, tileCount }) {
  if (!bar || !tray || !icons || !(tileCount > 0)) return null;
  const barW = bar.right - bar.left;
  const barH = bar.bottom - bar.top;
  if (!(barW > 0) || !(barH > 0) || barH > barW) return null;
  const scale = dpi > 0 ? dpi / 96 : 1;
  const tileW = Math.round(TILE_WIDTH * scale);
  const right = tray.left - bar.left - Math.round(TRAY_GAP * scale);
  const leftLimit = icons.right - bar.left + Math.round(ICON_GAP * scale);
  const fit = Math.floor((right - leftLimit) / tileW);
  const count = Math.min(tileCount, Math.max(0, fit));
  if (count <= 0) return null;
  const width = count * tileW;
  const height = Math.min(Math.round(STRIP_HEIGHT * scale), barH);
  return { x: right - width, y: Math.round((barH - height) / 2), width, height, count, scale };
}

/** The screen point whose colour the ink is chosen for: in the gap, mid-height. */
function samplePoint({ bar, tray, dpi }) {
  if (!bar || !tray) return null;
  const scale = dpi > 0 ? dpi / 96 : 1;
  return {
    x: tray.left - Math.max(1, Math.round(SAMPLE_INSET * scale)),
    y: bar.top + Math.round((bar.bottom - bar.top) / 2),
  };
}

/** Less than half of the taskbar is on its monitor: auto-hidden, sliding away. */
function barMostlyOffscreen(bar, monitor) {
  if (!bar || !monitor) return false;
  const h = bar.bottom - bar.top;
  const w = bar.right - bar.left;
  if (!(h > 0) || !(w > 0)) return true;
  const visH = Math.min(bar.bottom, monitor.bottom) - Math.max(bar.top, monitor.top);
  const visW = Math.min(bar.right, monitor.right) - Math.max(bar.left, monitor.left);
  return visH < h / 2 || visW < w / 2;
}

/** The foreground window covers the whole monitor and is not the desktop or the shell. */
function isFullscreen(fg, monitor, ownHwnd) {
  if (!fg || !fg.rect || !monitor) return false;
  if (fg.hwnd && fg.hwnd === ownHwnd) return false;
  if (NOT_FULLSCREEN.has(fg.cls)) return false;
  const r = fg.rect;
  return r.left <= monitor.left && r.top <= monitor.top && r.right >= monitor.right && r.bottom >= monitor.bottom;
}

function sameRect(a, x, y, w, h) {
  return Boolean(a) && a.left === x && a.top === y && a.right - a.left === w && a.bottom - a.top === h;
}

class TaskbarStrip {
  /**
   * @param {object} deps
   * @param {Function} deps.BrowserWindow
   * @param {{load: Function, handleOf: Function}} [deps.win32]
   * @param {(opts: {log: object, onChange: Function}) => {start: Function, stop: Function,
   *          latest: Function, remeasure: Function}} [deps.makeIconProbe]
   * @param {{info: Function, warn: Function}} deps.log
   * @param {() => void} [deps.onChange]  the status moved (index.js pushes PREFERENCES)
   * @param {Function} [deps.setInterval]
   * @param {Function} [deps.clearInterval]
   * @param {() => number} [deps.now]
   */
  constructor(deps) {
    this.BrowserWindow = deps.BrowserWindow;
    this.win32 = deps.win32 || defaultWin32;
    this.makeIconProbe = deps.makeIconProbe || ((opts) => new IconProbe(opts));
    /** Optional: the display layer inside the taskbar (index.js passes it). */
    this.makeDisplay = deps.makeDisplay || null;
    this._display = null;
    this._hover = -1;
    this.log = deps.log;
    this.onChange = deps.onChange || (() => {});
    this._setInterval = deps.setInterval || setInterval;
    this._clearInterval = deps.clearInterval || clearInterval;
    this._setTimeout = deps.setTimeout || setTimeout;
    this._clearTimeout = deps.clearTimeout || clearTimeout;
    /** A left click that the taskbar took (see TWO LAYERS); index.js opens the panel. */
    this.onCoveredClick = deps.onCoveredClick || null;
    this._watch = null;
    this._pressed = false;
    this._target = null;
    this._now = deps.now || Date.now;

    this._api = null;
    this._icons = null;
    this._wanted = false;
    this._dead = false;
    this._status = 'off';
    /** The last window the user worked in (see handBackFocus). */
    this._lastApp = 0;
    this._pid = process.pid;
    this._timers = [];
    this._snapshot = null;

    this.win = null;
    this._hwnd = 0;
    this._bar = 0;
    this._monitor = null;
    this._loading = false;
    this._attached = false;
    this._shown = false;
    this._geomKey = null;
    this._sentKey = null;
    this._rebuilds = 0;

    this._colour = null;
    this._candidate = null;
  }

  /** 'off' | 'unavailable' | 'waiting' | 'hidden' | 'no-room' | 'covered' | 'shown' */
  status() {
    return this._status;
  }

  /** False only once the strip was asked for and could not be had here. */
  available() {
    return this._status !== 'unavailable';
  }

  /** Did this IPC message come from the strip's own page? */
  isSender(sender) {
    return Boolean(this.win && !this.win.isDestroyed() && sender === this.win.webContents);
  }

  /** @returns {boolean} whether the strip can be shown on this machine */
  enable() {
    if (this._wanted) return this.available();
    this._wanted = true;
    if (this._dead) {
      this._setStatus('unavailable');
      return false;
    }
    this._api = this.win32.load();
    if (!this._api) {
      this._setStatus('unavailable');
      return false;
    }
    this._icons = this.makeIconProbe({ log: this.log, onChange: () => this._sync('icons') });
    this._icons.start();
    if (this.makeDisplay) {
      this._display = this.makeDisplay({
        log: this.log,
        wake: (tid) => Boolean(this._api && this._api.wakeThread(tid)),
        onState: () => { if (this._wanted && !this._dead) this._sync('display'); },
      });
      this._display.start();
    }
    this._startTimers();
    this._sync('poll');
    return true;
  }

  disable() {
    this._wanted = false;
    this._stopTimers();
    this._stopClickWatch();
    if (this._icons) this._icons.stop();
    this._icons = null;
    this._stopDisplay();
    this._drop();
    this._bar = 0;
    this._setStatus(this._dead ? 'unavailable' : 'off');
  }

  /** Every snapshot main emits. Cheap when nothing visible changed; no screen read. */
  update(snapshot) {
    this._snapshot = snapshot || null;
    if (this._wanted && this._api) this._sync('update');
  }

  /** Windows switched light/dark: read the colour afresh, no debounce. */
  themeChanged() {
    this._colour = null;
    this._candidate = null;
    if (this._wanted && this._api) this._sync('theme');
  }

  /** The input page's hovered tile (-1: none), passed on to the display layer. */
  hover(index) {
    const i = Number.isInteger(index) && index >= 0 && index < 16 ? index : -1;
    if (i === this._hover) return;
    this._hover = i;
    if (this._display && this._display.usable()) this._sync('hover');
  }

  /** 'input' while the display layer shows the tiles, 'full' otherwise. */
  layer() {
    return this._display && this._display.usable() ? 'input' : 'full';
  }

  /* --------------------------------------------------------------- internals */

  /** Runs while the taskbar is the foreground (it then covers the input window). */
  _startClickWatch() {
    if (this._watch || !this.onCoveredClick) return;
    this._pressed = false;
    this._watch = this._setTimeout(() => this._clickTick(), CLICK_WATCH_OUTSIDE_MS);
  }

  _stopClickWatch() {
    if (this._watch) this._clearTimeout(this._watch);
    this._watch = null;
    this._pressed = false;
  }

  _clickTick() {
    this._watch = null;
    const api = this._api;
    const t = this._target;
    if (this._dead || !this._wanted || !this._shown || !api || !t) return;
    const p = api.cursor();
    const inside = Boolean(p && p.x >= t.left && p.x < t.right && p.y >= t.top && p.y < t.bottom);
    // Only where the taskbar really covers us: otherwise the page gets the click.
    if (inside && api.rootAt(p.x, p.y) !== this._hwnd) {
      if (api.leftButtonDown()) {
        this._pressed = true;
      } else if (this._pressed) {
        this._pressed = false;
        try { this.onCoveredClick(); } catch { /* the panel's problem */ }
      }
    } else {
      this._pressed = false;
    }
    this._watch = this._setTimeout(() => this._clickTick(), inside ? CLICK_WATCH_INSIDE_MS : CLICK_WATCH_OUTSIDE_MS);
  }

  _stopDisplay() {
    const d = this._display;
    this._display = null;
    if (d) {
      try { d.stop(); } catch { /* going */ }
    }
  }

  _startTimers() {
    for (const [fn, ms] of [[() => this._sync('poll'), POLL_MS], [() => this._guard(), GUARD_MS]]) {
      const t = this._setInterval(fn, ms);
      if (t && typeof t.unref === 'function') t.unref();
      this._timers.push(t);
    }
  }

  _stopTimers() {
    for (const t of this._timers) this._clearInterval(t);
    this._timers = [];
  }

  _setStatus(next) {
    if (next === this._status) return;
    this._status = next;
    try { this.onChange(next); } catch { /* a listener must not break the strip */ }
  }

  /** Destroys the window, if any. The next sync builds a new one. */
  _drop() {
    const win = this.win;
    this.win = null;
    this._hwnd = 0;
    this._loading = false;
    this._attached = false;
    this._shown = false;
    this._geomKey = null;
    this._sentKey = null;
    if (win && !win.isDestroyed()) {
      try { win.destroy(); } catch { /* already going */ }
    }
  }

  /** Off screen, kept alive, until a sync can place it again. */
  _hide(status) {
    if (this.win && !this.win.isDestroyed() && this._shown) {
      try { this.win.hide(); } catch { /* best effort */ }
    }
    if (this._display) this._display.hide();
    this._stopClickWatch();
    this._shown = false;
    this._geomKey = null;
    if (status) this._setStatus(status);
  }

  /** Stops for the session: the window keeps dying (F5). */
  _giveUp() {
    if (this._dead) return;
    this._dead = true;
    this._stopTimers();
    this._stopClickWatch();
    if (this._icons) this._icons.stop();
    this._icons = null;
    this._stopDisplay();
    this._drop();
    this.log.warn('taskbar strip: rebuilt too often; giving up for this session');
    this._setStatus('unavailable');
  }

  /**
   * The taskbar colour the ink is chosen for. A first reading is taken as it
   * is; after that a new colour has to be read twice in a row, so a flyout
   * passing over the sample point for one poll does not repaint the strip.
   */
  _readColour(point) {
    const read = point ? this._api.sampleColour(point.x, point.y) : null;
    if (!read) return this._colour || FALLBACK_COLOUR;
    if (!this._colour) {
      this._colour = read;
    } else if (read !== this._colour) {
      if (this._candidate === read) {
        this._colour = read;
        this._candidate = null;
      } else {
        this._candidate = read;
      }
    } else {
      this._candidate = null;
    }
    return this._colour;
  }

  /**
   * Z-order and full screen, between polls. Re-raises ONLY when the taskbar is
   * above the strip, and hides it under a full-screen window; when that window
   * goes, it asks for a sync so the strip comes back without waiting a poll.
   */
  _guard() {
    if (this._dead || !this._wanted || !this._api) return;
    const api = this._api;
    const fg = api.foreground();
    this._noteForeground(fg);
    const fullscreen = isFullscreen(fg, this._monitor, this._hwnd);
    if (this._status === 'covered' && !fullscreen) {
      this._sync('poll');
      return;
    }
    if (!this._shown || !this._hwnd || !this._bar) return;
    if (fullscreen) {
      this._hide('covered');
      return;
    }
    const taskbarFront = Boolean(fg && (fg.cls === 'Shell_TrayWnd' || fg.cls === 'Shell_SecondaryTrayWnd'));
    if (taskbarFront) this._startClickWatch();
    else this._stopClickWatch();
    if (api.isBelow(this._hwnd, this._bar)) api.raise(this._hwnd);
  }

  /**
   * The last window the user was working in: not the shell, not the desktop,
   * not one of ours. handBackFocus() returns the foreground to it.
   */
  _noteForeground(fg) {
    if (!fg || !fg.hwnd || NOT_FULLSCREEN.has(fg.cls)) return;
    if (this._api.pidOf(fg.hwnd) === this._pid) return;
    this._lastApp = fg.hwnd;
  }

  /**
   * The panel is about to close. Without this, Windows gives the foreground to
   * the taskbar (the tray was the last thing clicked), and a foreground taskbar
   * sits in a z-band above every ordinary window: the strip vanished under it
   * and came back on the next click, a blink on every open and close (owner,
   * 2026-10-20; measured: the foreground was Shell_TrayWnd right after the
   * panel went). Hand it back to the window the user was in, or to the
   * desktop, as Windows' own flyouts do. Only when the foreground is still
   * ours or the taskbar: a panel closed by clicking another app has already
   * given the foreground to that app.
   *
   * @returns {boolean} whether the foreground was handed on
   */
  /**
   * Where the panel anchors while the tray icon is gone: the strip's own
   * rectangle, in DIP like Tray.getBounds(). Null when the strip is not shown.
   */
  anchorRect() {
    if (!this._shown || !this.win || this.win.isDestroyed()) return null;
    try {
      const b = this.win.getBounds();
      return b && b.width > 0 && b.height > 0 ? b : null;
    } catch {
      return null;
    }
  }

  handBackFocus() {
    if (this._dead || !this._wanted || !this._shown || !this._api) return false;
    const api = this._api;
    const fg = api.foreground();
    const ours = Boolean(fg && fg.hwnd && api.pidOf(fg.hwnd) === this._pid);
    const shell = Boolean(fg && (fg.cls === 'Shell_TrayWnd' || fg.cls === 'Shell_SecondaryTrayWnd'));
    if (!ours && !shell) return false;
    const target = this._lastApp && api.isLiveWindow(this._lastApp) ? this._lastApp : api.findDesktop();
    return target ? api.setForeground(target) : false;
  }

  _sync(reason) {
    if (this._dead || !this._wanted || !this._api) return;
    const api = this._api;

    if (this.win && this.win.isDestroyed()) this._drop();

    const bar = api.findTaskbar();
    if (!bar) {
      // Explorer is restarting, or there is no shell at all.
      this._bar = 0;
      this._hide('waiting');
      return;
    }
    if (bar !== this._bar) {
      if (this._bar) this.log.info('taskbar strip: taskbar changed, placing again');
      this._bar = bar;
      this._geomKey = null;
      if (this._icons && reason !== 'icons') this._icons.remeasure();
    }

    const tray = api.findTrayNotify(bar);
    const barRect = api.windowRect(bar);
    const trayRect = tray ? api.windowRect(tray) : null;
    if (!barRect || !trayRect) {
      this._hide('waiting');
      return;
    }
    this._monitor = api.monitorRect(bar);
    if (barMostlyOffscreen(barRect, this._monitor)) {
      this._hide('covered');
      return;
    }
    const dpi = api.dpiFor(bar);
    // The screen is read on the poll and on a theme change, never per snapshot.
    const colour = (reason === 'poll' || reason === 'theme' || !this._colour)
      ? this._readColour(samplePoint({ bar: barRect, tray: trayRect, dpi }))
      : this._colour;
    const ground = groundFor(colour);
    const tiles = stripTiles(this._snapshot, this._now(), ground);
    if (tiles.length === 0) {
      this._hide('hidden');
      return;
    }
    const icons = this._icons ? this._icons.latest() : null;
    const place = placement({ bar: barRect, tray: trayRect, icons, dpi, tileCount: tiles.length });
    if (!place) {
      this._hide('no-room');
      return;
    }
    if (isFullscreen(api.foreground(), this._monitor, this._hwnd)) {
      this._hide('covered');
      return;
    }

    if (!this.win) {
      if (this._rebuilds >= MAX_REBUILDS) {
        this._giveUp();
        return;
      }
      this._rebuilds += 1;
      this._create(place);
      return; // did-finish-load comes back here
    }
    if (this._loading) return;

    if (!this._attached) {
      this._hwnd = this.win32.handleOf(this.win);
      if (!this._hwnd || !api.attach(this._hwnd)) {
        this.log.warn('taskbar strip: could not prepare its window');
        this._drop();
        this._setStatus('waiting');
        return;
      }
      this._attached = true;
      this._geomKey = null;
    }

    const x = barRect.left + place.x;
    const y = barRect.top + place.y;
    const key = `${x},${y},${place.width},${place.height}`;
    const moved = this._shown && !sameRect(api.windowRect(this._hwnd), x, y, place.width, place.height);
    if (key !== this._geomKey || !this._shown || moved) {
      if (!api.place(this._hwnd, x, y, place.width, place.height)) {
        // Nothing is claimed about a window that was not placed: not shown,
        // no key, and the next poll tries again.
        this._geomKey = null;
        if (this._shown) this._hide();
        this._setStatus('waiting');
        return;
      }
      if (!this._shown) {
        try { this.win.showInactive(); } catch { /* SWP_SHOWWINDOW already showed it */ }
      }
      this._shown = true;
      this._geomKey = key;
      this._target = { left: x, top: y, right: x + place.width, bottom: y + place.height };
    }

    const base = { ground, tileWidth: TILE_WIDTH, tiles: tiles.slice(0, place.count) };
    const display = this._display;
    if (display && !display.failed()) {
      // The same tiles, drawn inside the taskbar at the same place.
      display.attach(bar);
      display.place({ x: place.x, y: place.y, w: place.width, h: place.height, scale: place.scale, colour });
      display.data({ ...base, hover: this._hover });
    }
    const payload = { ...base, layer: this.layer() };
    const sentKey = JSON.stringify(payload);
    if (sentKey !== this._sentKey) {
      try {
        this.win.webContents.send(IPC_STRIP.DATA, payload);
        this._sentKey = sentKey;
      } catch { /* retried on the next sync */ }
    }
    this._setStatus('shown');
  }

  _create(place) {
    const win = new this.BrowserWindow({
      width: Math.max(1, Math.round(place.width / place.scale)),
      height: Math.max(1, Math.round(place.height / place.scale)),
      show: false,
      frame: false,
      // The taskbar's own material shows between the tiles.
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Clicking a tile must not take the keyboard from the user's window.
      focusable: false,
      hasShadow: false,
      // No WS_THICKFRAME: no resize border, no shadow, no window animation.
      thickFrame: false,
      title: 'Usage Notch',
      webPreferences: {
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
    this.win = win;
    this._loading = true;
    if (typeof win.setMenu === 'function') win.setMenu(null);
    win.on('closed', () => {
      if (this.win !== win) return;
      // Destroyed under us, or the app is quitting: the next sync rebuilds.
      this.win = null;
      this._hwnd = 0;
      this._attached = false;
      this._shown = false;
      this._loading = false;
      this._geomKey = null;
      this._sentKey = null;
    });
    const wc = win.webContents;
    wc.on('did-finish-load', () => {
      if (this.win !== win) return;
      this._loading = false;
      this._sentKey = null;
      this._sync('poll');
    });
    // A page or preload that did not load is a dead window: dropped, so the
    // rebuild counts toward MAX_REBUILDS instead of leaving a blank strip.
    wc.on('did-fail-load', (_e, code, _d, _u, isMainFrame) => {
      if (!isMainFrame || this.win !== win) return;
      this.log.warn(`taskbar strip failed to load: code=${code}`);
      this._drop();
    });
    wc.on('preload-error', () => {
      if (this.win !== win) return;
      this.log.warn('taskbar strip preload failed');
      this._drop();
    });
    wc.on('render-process-gone', () => {
      if (this.win !== win) return;
      this.log.warn('taskbar strip renderer gone; rebuilding');
      this._drop();
    });
    win.loadFile(PAGE);
  }
}

module.exports = {
  TaskbarStrip,
  placement,
  samplePoint,
  barMostlyOffscreen,
  isFullscreen,
  TILE_WIDTH,
  STRIP_HEIGHT,
  TRAY_GAP,
  ICON_GAP,
  POLL_MS,
  GUARD_MS,
  MAX_REBUILDS,
  PAGE,
  PRELOAD,
};
