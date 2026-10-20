'use strict';
const log = require('../core/log');

/**
 * The only main-thread door to Win32, for the taskbar strip (taskbar-strip.js).
 * (The taskbar's button area is measured by UI Automation in a worker,
 * taskbar-icons-worker.js, which is the one other file that loads koffi.)
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Windows 11 offers no API for putting content on the taskbar: the deskbands
 * of Windows 10 are gone and the XAML taskbar takes no extensions. Electron
 * cannot find the taskbar or read its geometry, so this file calls user32
 * through koffi, the app's one runtime dependency (test/contract-mirror.test.js
 * says why it is allowed).
 *
 * AN UNOWNED TOPMOST TOOL WINDOW (measured on this machine, Windows 11 26200,
 * 2026-10-20). Two other techniques were tried and both are wrong:
 *
 *   - A CHILD of `Shell_TrayWnd` (SetParent) draws, but gets NO MOUSE INPUT:
 *     the Windows 11 taskbar routes every pointer event over its area to its
 *     XAML island's InputSite, so no WM_NCHITTEST or WM_MOUSEMOVE reaches a
 *     child — measured for the Electron window and a plain Win32 STATIC alike.
 *   - A popup OWNED by the taskbar (GWLP_HWNDPARENT) takes the mouse, but a
 *     cross-thread owner attaches the two threads' input queues: with the
 *     app's main thread blocked for 6 s, a click on Start opened the Start
 *     menu only when the block ended (+6023 ms), against +1035 ms with no
 *     strip. The app could freeze the user's taskbar.
 *
 * So the strip is a plain top-level window with WS_EX_TOOLWINDOW (no Alt+Tab)
 * and WS_EX_NOACTIVATE (a click never takes the keyboard), made topmost ONCE
 * when attached. Moves and resizes never touch the z-order (SWP_NOZORDER).
 * When the taskbar is activated it rises above the strip, so the strip's guard
 * checks the z-order and re-raises only when the taskbar is actually above it.
 * A topmost window would also sit over a full-screen app, so the guard hides
 * it while the foreground window covers the taskbar's monitor.
 *
 * WHAT IT CALLS, AND WHAT IT NEVER DOES
 * -------------------------------------
 * user32 (find the taskbar, read rectangles, DPI, monitors, the z-order and
 * the foreground window; style and place OUR window) and gdi32 GetPixel (the
 * taskbar's colour, to choose dark or light ink). Both are KnownDLLs, so
 * `koffi.load` cannot be handed a planted copy from the app folder. Nothing
 * here writes to another process's window, opens a file, a socket or a
 * process; koffi's runtime JavaScript has no network module either (scanned by
 * test/contract-mirror.test.js).
 *
 * LAZY AND DEFENSIVE
 * ------------------
 * koffi is required on the first `load()`, never at startup, so a user who
 * keeps the tray icon never loads a native module at all. Any failure — no
 * binary for this CPU, a damaged install, not Windows — makes `load()` answer
 * null, once, and the strip reports itself unavailable; the app goes on
 * exactly as it does without the strip. Every wrapper below catches, so a
 * throwing call costs one placement, never the main process.
 *
 * Window handles are plain numbers (`intptr`), so they compare with `===` and
 * a test can fake them. Coordinates are PHYSICAL screen pixels throughout:
 * Electron's main process is per-monitor DPI aware.
 */

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const HWND_TOPMOST = -1;
const GW_HWNDPREV = 3;
const MONITOR_DEFAULTTONEAREST = 2;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_NOOWNERZORDER = 0x0200;
/** Flags for a move or resize: never the z-order, never activation. */
const MOVE_FLAGS = SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW;
/** Flags for the z-order assertion: nothing but the z-order. */
const RAISE_FLAGS = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
/** How far up the z-order the "is the taskbar above us" walk looks. */
const ZORDER_WALK = 64;
/** GetPixel's "could not read". */
const CLR_INVALID = 0xFFFFFFFF;

/** undefined: not tried yet; null: tried and unavailable; object: ready. */
let api;

/** koffi hands back a BigInt for a 64-bit value now and then; handles fit a Number. */
function num(v) {
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function bind() {
  if (process.platform !== 'win32') throw Object.assign(new Error('not windows'), { code: 'NOT_WIN32' });
  // Lazily, and only here: see the header.
  // eslint-disable-next-line global-require
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  koffi.struct('UN_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  koffi.struct('UN_MONITORINFO', { cbSize: 'uint32', rcMonitor: 'UN_RECT', rcWork: 'UN_RECT', dwFlags: 'uint32' });
  return {
    FindWindowW: user32.func('intptr __stdcall FindWindowW(str16 cls, str16 name)'),
    FindWindowExW: user32.func('intptr __stdcall FindWindowExW(intptr parent, intptr after, str16 cls, str16 name)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr h, _Out_ UN_RECT* r)'),
    GetWindowLongPtrW: user32.func('intptr __stdcall GetWindowLongPtrW(intptr h, int idx)'),
    SetWindowLongPtrW: user32.func('intptr __stdcall SetWindowLongPtrW(intptr h, int idx, intptr v)'),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr h, intptr after, int x, int y, int cx, int cy, uint flags)'),
    GetWindow: user32.func('intptr __stdcall GetWindow(intptr h, uint cmd)'),
    GetForegroundWindow: user32.func('intptr __stdcall GetForegroundWindow()'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr h, _Out_ uint16_t* buf, int n)'),
    MonitorFromWindow: user32.func('intptr __stdcall MonitorFromWindow(intptr h, uint flags)'),
    GetMonitorInfoW: user32.func('bool __stdcall GetMonitorInfoW(intptr m, _Inout_ UN_MONITORINFO* info)'),
    GetDpiForWindow: user32.func('uint __stdcall GetDpiForWindow(intptr h)'),
    GetDC: user32.func('intptr __stdcall GetDC(intptr h)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr h, intptr dc)'),
    GetPixel: gdi32.func('uint32 __stdcall GetPixel(intptr dc, int x, int y)'),
    MONITORINFO_SIZE: koffi.sizeof('UN_MONITORINFO'),
  };
}

/** The bound functions, or null when they cannot be had. Tried once. */
function load() {
  if (api !== undefined) return api;
  try {
    api = makeApi(bind());
  } catch (err) {
    // A fixed code, never the message: it can carry a path.
    log.warn(`taskbar strip unavailable: code=${(err && err.code) || (err && err.name) || 'UNKNOWN'}`);
    api = null;
  }
  return api;
}

function guard(name, fn, fallback) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      log.warn(`win32 ${name} failed: code=${(err && err.code) || 'UNKNOWN'}`);
      return fallback;
    }
  };
}

/** `#RRGGBB` from a COLORREF (0x00BBGGRR), or null for CLR_INVALID. */
function hexOfColorref(px) {
  const v = px >>> 0;
  if (v === CLR_INVALID) return null;
  const r = v & 0xFF;
  const g = (v >> 8) & 0xFF;
  const b = (v >> 16) & 0xFF;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function makeApi(f) {
  const rectOf = (h) => {
    const r = {};
    if (!h || !f.GetWindowRect(h, r)) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  const classOf = (h) => {
    const buf = new Uint16Array(128);
    const n = f.GetClassNameW(h, buf, 128);
    return n > 0 ? String.fromCharCode(...buf.slice(0, n)) : '';
  };
  return {
    /** The primary taskbar, or 0. */
    findTaskbar: guard('findTaskbar', () => num(f.FindWindowW('Shell_TrayWnd', null)), 0),
    /** The notification area inside it (the tray icons and the clock), or 0. */
    findTrayNotify: guard('findTrayNotify', (bar) => num(f.FindWindowExW(bar, 0, 'TrayNotifyWnd', null)), 0),
    /** Screen rectangle in PHYSICAL pixels, or null. */
    windowRect: guard('windowRect', rectOf, null),
    /** 96 at 100 %, 120 at 125 %. 96 when Windows will not say. */
    dpiFor: guard('dpiFor', (h) => num(f.GetDpiForWindow(h)) || 96, 96),
    /** The whole rectangle of the monitor a window is on, or null. */
    monitorRect: guard('monitorRect', (h) => {
      const m = num(f.MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST));
      if (!m) return null;
      const zero = { left: 0, top: 0, right: 0, bottom: 0 };
      const info = { cbSize: f.MONITORINFO_SIZE, rcMonitor: { ...zero }, rcWork: { ...zero }, dwFlags: 0 };
      if (!f.GetMonitorInfoW(m, info)) return null;
      const r = info.rcMonitor;
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }, null),
    /** The foreground window: handle, class and rectangle, or null. */
    foreground: guard('foreground', () => {
      const h = num(f.GetForegroundWindow());
      if (!h) return null;
      return { hwnd: h, cls: classOf(h), rect: rectOf(h) };
    }, null),
    /**
     * Our window: out of Alt+Tab, never activated by a click, and topmost.
     * The ONE place the z-order is set without being asked for (see raise).
     */
    attach: guard('attach', (hwnd) => {
      const ex = num(f.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
      f.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) >>> 0);
      return Boolean(f.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, RAISE_FLAGS));
    }, false),
    /** Move and size in physical screen pixels, shown; z-order untouched. */
    place: guard('place', (hwnd, x, y, w, h) => Boolean(
      f.SetWindowPos(hwnd, 0, Math.round(x), Math.round(y), Math.round(w), Math.round(h), MOVE_FLAGS),
    ), false),
    /** True when `other` (the taskbar) is above `hwnd` in the z-order. */
    isBelow: guard('isBelow', (hwnd, other) => {
      let h = num(f.GetWindow(hwnd, GW_HWNDPREV));
      for (let i = 0; h && i < ZORDER_WALK; i += 1) {
        if (h === other) return true;
        h = num(f.GetWindow(h, GW_HWNDPREV));
      }
      return false;
    }, false),
    /** Back to the top of the topmost band, without moving or activating. */
    raise: guard('raise', (hwnd) => Boolean(f.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, RAISE_FLAGS)), false),
    /** The colour on screen at a PHYSICAL point, as `#RRGGBB`, or null. */
    sampleColour: guard('sampleColour', (x, y) => {
      const dc = num(f.GetDC(0));
      if (!dc) return null;
      try {
        return hexOfColorref(f.GetPixel(dc, Math.round(x), Math.round(y)));
      } finally {
        f.ReleaseDC(0, dc);
      }
    }, null),
  };
}

/** Our BrowserWindow's HWND as a number, or 0. No koffi needed. */
function handleOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf || buf.length < 4) return 0;
    return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
  } catch {
    return 0;
  }
}

/** Tests only: forget the cached answer. */
function __resetForTest() {
  api = undefined;
}

module.exports = {
  load, handleOf, hexOfColorref, __resetForTest, MOVE_FLAGS, RAISE_FLAGS,
};
