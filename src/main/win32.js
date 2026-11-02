'use strict';
const log = require('../core/log');

/**
 * The only main-thread door to Win32, for the taskbar strip (taskbar-strip.js)
 * and for the shape and tint of the panel window (`loadDwm`, below). (The
 * taskbar's button area is measured by UI Automation in a worker,
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
 * `koffi.load` cannot be handed a planted copy from the app folder. dwmapi
 * DwmSetWindowAttribute sets four attributes of the PANEL's own window (see
 * `loadDwm` for why its name is safe too), and user32
 * SetWindowCompositionAttribute one more on that same window, its accent
 * backdrop: a clear window under the panel's glass. And gdi32 BitBlt READS
 * the screen region the panel is about to cover, and while it is open the
 * region under it, so the page can draw the glass from it (`captureScreen`,
 * `captureBehind`, below): the pixels stay in this process's memory, go to
 * the panel's own sandboxed page and nowhere else, and are dropped when the
 * panel closes. user32 SetWindowDisplayAffinity hides OUR window from that
 * one copy, for the length of the copy. Nothing
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
const WM_APP = 0x8000;
const VK_LBUTTON = 0x01;
const GA_ROOT = 2;
/** GetPixel's "could not read". */
const CLR_INVALID = 0xFFFFFFFF;
/** DwmSetWindowAttribute: the light or dark variant of the window's backdrop. */
const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
/** DwmSetWindowAttribute: the colour of the hairline Windows 11 draws round a window. */
const DWMWA_BORDER_COLOR = 34;
/** DwmSetWindowAttribute: Windows 11's rounded corners (DWMWCP_ROUND, 8px). */
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWCP_ROUND = 2;
/** Square: the glass draws its own, larger corners over a clear window. */
const DWMWCP_DONOTROUND = 1;
/** DwmSetWindowAttribute: DWM draws the window's frame effects — its shadow. */
const DWMWA_NCRENDERING_POLICY = 2;
const DWMNCRP_ENABLED = 2;
/** No frame effects: a shadow round a clear window outlines its square rect. */
const DWMNCRP_DISABLED = 1;
/** DWMWA_BORDER_COLOR: no hairline at all. */
const DWMWA_COLOR_NONE = 0xFFFFFFFE;
/** BitBlt: a plain copy. */
const SRCCOPY = 0x00CC0020;
/** BITMAPINFOHEADER is 40 bytes; one RGBQUAD after it, which 32 bpp leaves unread. */
const BITMAPINFO_SIZE = 44;
/**
 * SetWindowDisplayAffinity: the window is drawn on the monitor but left out of
 * every screen capture (Windows 10 2004 and up). 0 puts it back.
 */
const WDA_EXCLUDEFROMCAPTURE = 0x11;
const WDA_NONE = 0;
/** The biggest region `captureScreen` copies, per side, in physical pixels. */
const CAPTURE_MAX_SIDE = 4096;
/** SetWindowCompositionAttribute: WCA_ACCENT_POLICY, and its 16-byte ACCENT_POLICY. */
const WCA_ACCENT_POLICY = 19;
const ACCENT_POLICY_SIZE = 16;

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
  koffi.struct('UN_POINT', { x: 'int32', y: 'int32' });
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
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr h)'),
    IsWindow: user32.func('bool __stdcall IsWindow(intptr h)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr h)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr h, _Out_ uint32_t* pid)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr h, _Out_ uint16_t* buf, int n)'),
    MonitorFromWindow: user32.func('intptr __stdcall MonitorFromWindow(intptr h, uint flags)'),
    GetMonitorInfoW: user32.func('bool __stdcall GetMonitorInfoW(intptr m, _Inout_ UN_MONITORINFO* info)'),
    GetDpiForWindow: user32.func('uint __stdcall GetDpiForWindow(intptr h)'),
    GetDC: user32.func('intptr __stdcall GetDC(intptr h)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr h, intptr dc)'),
    GetPixel: gdi32.func('uint32 __stdcall GetPixel(intptr dc, int x, int y)'),
    GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ UN_POINT* p)'),
    GetAsyncKeyState: user32.func('int16 __stdcall GetAsyncKeyState(int vk)'),
    WindowFromPoint: user32.func('intptr __stdcall WindowFromPoint(UN_POINT p)'),
    GetAncestor: user32.func('intptr __stdcall GetAncestor(intptr h, uint flags)'),
    PostThreadMessageW: user32.func('bool __stdcall PostThreadMessageW(uint32 tid, uint msg, uintptr wp, intptr lp)'),
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
    /** The process that owns a window, or 0. */
    pidOf: guard('pidOf', (h) => {
      const pid = [0];
      if (!h) return 0;
      f.GetWindowThreadProcessId(h, pid);
      return num(pid[0]);
    }, 0),
    /** A window that still exists and is shown. */
    isLiveWindow: guard('isLiveWindow', (h) => Boolean(h && f.IsWindow(h) && f.IsWindowVisible(h)), false),
    /** Hand the foreground to a window; Windows may refuse, which is fine. */
    setForeground: guard('setForeground', (h) => Boolean(h && f.SetForegroundWindow(h)), false),
    /**
     * Wakes the strip's display worker out of its message wait (WM_APP; the
     * worker ignores the message itself and reads its command port).
     */
    wakeThread: guard('wakeThread', (tid) => Boolean(tid && f.PostThreadMessageW(tid, WM_APP, 0, 0)), false),
    /** The cursor in physical screen pixels, or null. */
    cursor: guard('cursor', () => {
      const p = {};
      return f.GetCursorPos(p) ? { x: p.x, y: p.y } : null;
    }, null),
    /** Is the primary (left) mouse button down right now? Reads, never consumes. */
    leftButtonDown: guard('leftButtonDown', () => (f.GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0, false),
    /** The top-level window under a screen point (GA_ROOT), or 0. */
    rootAt: guard('rootAt', (x, y) => {
      const h = num(f.WindowFromPoint({ x, y }));
      return h ? num(f.GetAncestor(h, GA_ROOT)) : 0;
    }, 0),
    /** The desktop window (Progman), or 0. */
    findDesktop: guard('findDesktop', () => num(f.FindWindowW('Progman', null)), 0),
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

/* ------------------------------------------------------------ panel window */

/**
 * The panel's fitted window (panel-window.js) takes its backdrop, corners and
 * shadow from Windows, and these of Windows' choices there have to be OURS:
 *
 *   - the corners and the shadow. A frameless window with Electron's default
 *     thick frame gets both, and with them Windows' INVISIBLE resize borders:
 *     measured here, 8 physical px left, right and below the visible panel
 *     that still answer WindowFromPoint for the panel, so a click just beside
 *     it was swallowed. With `thickFrame: false` the window is exactly the
 *     panel, and Electron then asks DWM for square corners and no frame;
 *     these two ask for the rounding and the shadow back.
 *   - light or dark. The window's immersive dark mode, which Electron sets
 *     from `nativeTheme.shouldUseDarkColors` — Windows' app mode, not the
 *     panel's own theme — and which DWM reads for the frame it draws. A user
 *     who chose "Açık" on a dark Windows would get a dark frame round a light
 *     panel. Electron writes its value again on every nativeTheme change, so
 *     the panel writes its own after each one (index.js), and the glass's
 *     tint with it.
 *   - the hairline. Windows draws the ACCENT colour there on an active window
 *     when the user has accent borders on; a coloured frame the moment the
 *     panel is clicked.
 *   - the glass itself (`setAccent`): user32's SetWindowCompositionAttribute
 *     with WCA_ACCENT_POLICY, frosted or clear and tinted by the "Saydamlık"
 *     level (src/core/panel-material.js, `panelAccent`, says which, and why
 *     not Electron's `backgroundMaterial`). Undocumented, but stable since
 *     Windows 10 1803; it writes OUR window's attribute only, and a refusal is
 *     answered with the opaque base (panel-window.js).
 *
 * Bound separately from `load()`: a failure here costs these refinements (a
 * square, shadowless, opaque panel), never the strip, and the strip's
 * failure never costs them. dwmapi.dll is not a KnownDLL, but Chromium has already loaded it
 * into this process (it composites through DWM), and LoadLibrary hands back a
 * module that is already loaded by name before it searches any folder — so the
 * name cannot reach a planted copy beside the exe.
 *
 * Window handles are the same numbers `handleOf()` returns.
 */

/** undefined: not tried yet; null: tried and unavailable; object: ready. */
let dwm;

function bindDwm() {
  if (process.platform !== 'win32') throw Object.assign(new Error('not windows'), { code: 'NOT_WIN32' });
  // eslint-disable-next-line global-require
  const koffi = require('koffi');
  const dwmapi = koffi.load('dwmapi.dll');
  // A KnownDLL, as for the strip (header).
  const user32 = koffi.load('user32.dll');
  // A KnownDLL too: the screen copy for the glass.
  const gdi32 = koffi.load('gdi32.dll');
  // WINDOWCOMPOSITIONATTRIBDATA; pvData is handed a Buffer holding the
  // ACCENT_POLICY: the binding the spike measured (2026-10-22).
  koffi.struct('UN_WCAD', { Attrib: 'int32', pvData: 'void *', cbData: 'size_t' });
  return {
    DwmSetWindowAttribute: dwmapi.func('int __stdcall DwmSetWindowAttribute(intptr h, uint attr, _In_ uint32_t* value, uint size)'),
    DwmFlush: dwmapi.func('int __stdcall DwmFlush()'),
    SetWindowCompositionAttribute: user32.func('bool __stdcall SetWindowCompositionAttribute(intptr h, UN_WCAD *data)'),
    SetWindowDisplayAffinity: user32.func('bool __stdcall SetWindowDisplayAffinity(intptr h, uint32 affinity)'),
    GetDC: user32.func('intptr __stdcall GetDC(intptr h)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr h, intptr dc)'),
    CreateCompatibleDC: gdi32.func('intptr __stdcall CreateCompatibleDC(intptr dc)'),
    CreateCompatibleBitmap: gdi32.func('intptr __stdcall CreateCompatibleBitmap(intptr dc, int w, int h)'),
    SelectObject: gdi32.func('intptr __stdcall SelectObject(intptr dc, intptr obj)'),
    BitBlt: gdi32.func('bool __stdcall BitBlt(intptr dst, int x, int y, int w, int h, intptr src, int sx, int sy, uint32 rop)'),
    GetDIBits: gdi32.func('int __stdcall GetDIBits(intptr dc, intptr bm, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ uint8_t *bmi, uint32 usage)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr obj)'),
    DeleteDC: gdi32.func('bool __stdcall DeleteDC(intptr dc)'),
  };
}

/**
 * ACCENT_POLICY { int32 AccentState, int32 AccentFlags, uint32 GradientColor
 * (0xAABBGGRR), int32 AnimationId }, as the 16 bytes Windows reads.
 */
function accentPolicyBuffer({ state, flags, color }) {
  const buf = Buffer.alloc(ACCENT_POLICY_SIZE);
  buf.writeInt32LE(state | 0, 0);
  buf.writeInt32LE(flags | 0, 4);
  buf.writeUInt32LE(color >>> 0, 8);
  buf.writeInt32LE(0, 12);
  return buf;
}

/** `#RRGGBB` -> COLORREF (0x00BBGGRR), or null for anything else. */
function colorrefOfHex(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return null;
  return (parseInt(m[1], 16) | (parseInt(m[2], 16) << 8) | (parseInt(m[3], 16) << 16)) >>> 0;
}

function makeDwm(f) {
  const set = (h, attr, value) => f.DwmSetWindowAttribute(h, attr, [value >>> 0], 4) === 0;
  return {
    /** Dark (true) or light frame for `hwnd`. True when Windows took it. */
    setDarkMode: guard('setDarkMode', (h, dark) => Boolean(h) && set(h, DWMWA_USE_IMMERSIVE_DARK_MODE, dark ? 1 : 0), false),
    /** Rounded corners and the frame shadow. True when Windows took both. */
    setFlyoutShape: guard('setFlyoutShape', (h) => Boolean(h)
      && set(h, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND)
      && set(h, DWMWA_NCRENDERING_POLICY, DWMNCRP_ENABLED), false),
    /**
     * The glass behind `hwnd`: an accent from panel-material.js's
     * `panelAccent` ({state, flags, color}); state 0 takes it away. True when
     * Windows took it.
     */
    setAccent: guard('setAccent', (h, accent) => Boolean(h) && Boolean(accent)
      && Boolean(f.SetWindowCompositionAttribute(h, {
        Attrib: WCA_ACCENT_POLICY, pvData: accentPolicyBuffer(accent), cbData: ACCENT_POLICY_SIZE,
      })), false),
    /** The window's hairline, `#RRGGBB`. True when Windows took it. */
    setBorderColour: guard('setBorderColour', (h, hex) => {
      const ref = colorrefOfHex(hex);
      return Boolean(h) && ref !== null && set(h, DWMWA_BORDER_COLOR, ref);
    }, false),
    /**
     * The glass's frame: square, no shadow, no hairline. The window is clear
     * and the page draws the glass with its own wider corners and its own
     * rim; Windows' 8px rounding, its shadow and its hairline would outline
     * the square window around them. `setFlyoutShape` and `setBorderColour`
     * put the opaque panel's frame back. True when Windows took all three.
     */
    setGlassShape: guard('setGlassShape', (h) => Boolean(h)
      && set(h, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND)
      && set(h, DWMWA_NCRENDERING_POLICY, DWMNCRP_DISABLED)
      && set(h, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE), false),
    /**
     * A copy of the screen's pixels in `rect` (PHYSICAL px, as
     * screen.dipToScreenRect gives them), for the panel's glass: what the
     * panel is about to cover, read before it moves on screen. A GDI copy of
     * the composed desktop, about 7 ms for the panel's region (scratch spike,
     * 2026-11-02). Rows top-down, 4 bytes a pixel in the B, G, R order Windows
     * keeps; the fourth byte is not an alpha (the page sets its own).
     *
     * @param {{x: number, y: number, width: number, height: number}} rect
     * @returns {{width: number, height: number, bgra: Buffer}|null}
     */
    captureScreen: guard('captureScreen', (rect) => {
      const box = captureBox(rect);
      return box ? copyScreen(f, box) : null;
    }, null),
    /**
     * `captureScreen` of the region UNDER `hwnd` while it is on screen: the
     * window is left out of screen captures for the length of the copy only
     * (measured, 2026-11-02: the very next BitBlt already shows what is
     * behind it, and the one after the reset shows the window again), so a
     * screenshot or a recording the user takes still has the panel in it.
     * The affinity is put back on every path.
     *
     * @returns {{width: number, height: number, bgra: Buffer}|null}
     */
    /**
     * Wait for Windows' next composed frame (DwmFlush): the LIVE glass looks
     * once per frame the screen actually shows, instead of on a timer that
     * Windows rounds to its 15.6 ms tick (measured: 37 copies a second at a
     * 16 ms interval). Blocks the calling thread, so only glass-worker.js
     * calls it. False when there is no frame to wait for.
     */
    waitForFrame: guard('waitForFrame', () => f.DwmFlush() === 0, false),
    captureBehind: guard('captureBehind', (hwnd, rect) => {
      const box = captureBox(rect);
      if (!hwnd || !box) return null;
      if (!f.SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)) return null;
      try {
        return copyScreen(f, box);
      } finally {
        f.SetWindowDisplayAffinity(hwnd, WDA_NONE);
      }
    }, null),
  };
}

/** A rect `captureScreen` may copy: whole pixels, 1 to CAPTURE_MAX_SIDE a side. */
function captureBox(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const [x, y, width, height] = [rect.x, rect.y, rect.width, rect.height].map((v) => Math.round(Number(v)));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 1 || height < 1 || width > CAPTURE_MAX_SIDE || height > CAPTURE_MAX_SIDE) return null;
  return { x, y, width, height };
}

/**
 * The BitBlt itself: the screen DC into a memory bitmap, read out as a
 * top-down 32 bpp DIB. Every handle is released on every path; GetDIBits needs
 * the bitmap out of the memory DC first.
 */
function copyScreen(f, { x, y, width, height }) {
  const screenDc = num(f.GetDC(0));
  if (!screenDc) return null;
  let memDc = 0;
  let bitmap = 0;
  try {
    memDc = num(f.CreateCompatibleDC(screenDc));
    bitmap = num(f.CreateCompatibleBitmap(screenDc, width, height));
    if (!memDc || !bitmap) return null;
    const previous = f.SelectObject(memDc, bitmap);
    const copied = f.BitBlt(memDc, 0, 0, width, height, screenDc, x, y, SRCCOPY);
    f.SelectObject(memDc, previous);
    if (!copied) return null;
    const bmi = Buffer.alloc(BITMAPINFO_SIZE);
    bmi.writeUInt32LE(40, 0);
    bmi.writeInt32LE(width, 4);
    bmi.writeInt32LE(-height, 8); // negative: top-down rows
    bmi.writeUInt16LE(1, 12);
    bmi.writeUInt16LE(32, 14);
    const bgra = Buffer.alloc(width * height * 4);
    const lines = f.GetDIBits(memDc, bitmap, 0, height, bgra, bmi, 0);
    return lines === height ? { width, height, bgra } : null;
  } finally {
    if (bitmap) f.DeleteObject(bitmap);
    if (memDc) f.DeleteDC(memDc);
    f.ReleaseDC(0, screenDc);
  }
}

/** The panel's DWM attributes, or null when they cannot be had. Tried once. */
function loadDwm() {
  if (dwm !== undefined) return dwm;
  try {
    dwm = makeDwm(bindDwm());
  } catch (err) {
    log.warn(`panel window attributes unavailable: code=${(err && err.code) || (err && err.name) || 'UNKNOWN'}`);
    dwm = null;
  }
  return dwm;
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
  dwm = undefined;
}

module.exports = {
  load, loadDwm, handleOf, hexOfColorref, colorrefOfHex, accentPolicyBuffer, makeDwm, __resetForTest,
  MOVE_FLAGS, RAISE_FLAGS,
};
