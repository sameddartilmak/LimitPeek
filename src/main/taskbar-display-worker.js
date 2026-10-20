'use strict';
/**
 * The strip's DISPLAY layer: a native window drawn INSIDE the taskbar, owned
 * by this worker thread (taskbar-display.js starts it and feeds it pixels).
 *
 * WHY INSIDE, AND WHY A THREAD OF ITS OWN
 * ---------------------------------------
 * Any click on the taskbar — the ^ arrow, the clock, Wi-Fi, Start — makes it
 * the foreground window, and a foreground taskbar sits in a z-band above every
 * ordinary topmost window: a strip drawn by a top-level window vanished until
 * something else was clicked (owner, 2026-10-20). A CHILD of `Shell_TrayWnd`
 * is part of the taskbar and stays visible whatever has the foreground
 * (measured: a layered child stayed on screen with the clock flyout and the
 * overflow open).
 *
 * A child of another process's window attaches its creating thread's input
 * queue to Explorer's. Created on the Electron main thread, every busy moment
 * of the app would freeze the taskbar (measured for an owned window: Start
 * opened only after a 6 s block ended). So the child belongs to THIS thread,
 * which does nothing but pump its messages and copy pixels: only this queue
 * is coupled, and it is never busy. It never returns to Node's event loop:
 * the loop below waits in MsgWaitForMultipleObjectsEx and reads commands with
 * `receiveMessageOnPort`; main wakes it with a thread message after posting.
 *
 * The child takes no input (the taskbar's XAML island receives every pointer
 * event over its area anyway, and the child answers WM_NCHITTEST with
 * HTTRANSPARENT). Clicks go to the strip's separate, invisible input window.
 *
 * HOW IT DRAWS
 * ------------
 * Layered (WS_EX_LAYERED) with UpdateLayeredWindow from a 32-bit premultiplied
 * top-down DIB section, so the taskbar's own material shows between the tiles.
 * The pixels are the strip page rendered offscreen in main (premultiplied
 * BGRA, measured). If UpdateLayeredWindow fails, the window drops
 * WS_EX_LAYERED and the frame is composited over the sampled taskbar colour
 * and blitted opaque instead ('opaque' mode, reported to main).
 *
 * COMMANDS (from main, on `workerData.port`)
 *   { type: 'attach', bar }           a child of this taskbar (re-attach: the old one goes)
 *   { type: 'place', x, y, w, h, colour }  relative to the taskbar; shown
 *   { type: 'frame', w, h, data }     premultiplied BGRA, w*h*4 bytes
 *   { type: 'hide' }  { type: 'stop' }
 * REPORTS (to main): ready {tid} | attached {hwnd, mode} | mode {mode} | gone | failed {code}
 */
const { workerData, receiveMessageOnPort } = require('node:worker_threads');

const port = workerData && workerData.port;
const CLASS_NAME = `UsageNotchStripDisplay${process.pid}`;
/** Wake-up at least this often (z-order check, parent still alive). */
const IDLE_WAIT_MS = 1000;

const WS_CHILD = 0x40000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_NOACTIVATE = 0x08000000;
const GWL_EXSTYLE = -20;
const GW_CHILD = 5;
const HWND_TOP = 0;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const SWP_HIDEWINDOW = 0x0080;
const SWP_NOZORDER = 0x0004;
const WM_DESTROY = 0x0002;
const WM_PAINT = 0x000F;
const WM_NCHITTEST = 0x0084;
const HTTRANSPARENT = -1;
const QS_ALLINPUT = 0x04FF;
const MWMO_INPUTAVAILABLE = 0x0004;
const PM_REMOVE = 0x0001;
const ULW_ALPHA = 0x00000002;
const AC_SRC_ALPHA = 0x01;
const SRCCOPY = 0x00CC0020;
const LWA_ALPHA = 0x00000002;
const RDW_INVALIDATE = 0x0001;
const RDW_UPDATENOW = 0x0100;

let koffi = null;
let f = null;
let wndProc = null;
let instance = 0;

let hwnd = 0;
let bar = 0;
let mode = 'layered';
let gone = false;
let screenDc = 0;
let memDc = 0;
let dib = 0;
let oldBitmap = 0;
/** The DIB section's pixels (native memory) and a JS-side staging copy. */
let bitsPtr = null;
let bits = null;
let dibW = 0;
let dibH = 0;
let lastFrame = null;
let colour = [32, 32, 32];
let lastZCheck = 0;
let running = true;

function post(msg) {
  try { port.postMessage(msg); } catch { /* main is gone */ }
}

function setup() {
  // eslint-disable-next-line global-require
  koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const WNDPROC = koffi.proto('intptr __stdcall UN_DisplayWndProc(intptr hwnd, uint msg, uintptr wp, intptr lp)');
  koffi.struct('UN_DWNDCLASSEXW', {
    cbSize: 'uint', style: 'uint', lpfnWndProc: koffi.pointer(WNDPROC), cbClsExtra: 'int', cbWndExtra: 'int',
    hInstance: 'intptr', hIcon: 'intptr', hCursor: 'intptr', hbrBackground: 'intptr', lpszMenuName: 'str16',
    lpszClassName: 'str16', hIconSm: 'intptr',
  });
  koffi.struct('UN_DPOINT', { x: 'int32', y: 'int32' });
  koffi.struct('UN_DSIZE', { cx: 'int32', cy: 'int32' });
  koffi.struct('UN_DBLEND', { op: 'uint8', flags: 'uint8', alpha: 'uint8', format: 'uint8' });
  koffi.struct('UN_DBIH', {
    biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
    biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
    biClrUsed: 'uint32', biClrImportant: 'uint32',
  });
  koffi.struct('UN_DMSG', {
    hwnd: 'intptr', message: 'uint32', wParam: 'uintptr', lParam: 'intptr', time: 'uint32', pt: 'UN_DPOINT', priv: 'uint32',
  });
  f = {
    GetModuleHandleW: kernel32.func('intptr __stdcall GetModuleHandleW(str16 name)'),
    GetCurrentThreadId: kernel32.func('uint32 __stdcall GetCurrentThreadId()'),
    // Into the DIB section. NOT koffi.view: an external ArrayBuffer over native
    // memory is refused by Electron's V8 sandbox, and the refusal is fatal.
    RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(void* dst, const void* src, uintptr len)'),
    RegisterClassExW: user32.func('uint16 __stdcall RegisterClassExW(UN_DWNDCLASSEXW* wc)'),
    UnregisterClassW: user32.func('bool __stdcall UnregisterClassW(str16 cls, intptr inst)'),
    CreateWindowExW: user32.func('intptr __stdcall CreateWindowExW(uint ex, str16 cls, str16 name, uint style, int x, int y, int w, int h, intptr parent, intptr menu, intptr inst, intptr param)'),
    DestroyWindow: user32.func('bool __stdcall DestroyWindow(intptr h)'),
    DefWindowProcW: user32.func('intptr __stdcall DefWindowProcW(intptr h, uint m, uintptr w, intptr l)'),
    IsWindow: user32.func('bool __stdcall IsWindow(intptr h)'),
    GetWindow: user32.func('intptr __stdcall GetWindow(intptr h, uint cmd)'),
    GetWindowLongPtrW: user32.func('intptr __stdcall GetWindowLongPtrW(intptr h, int idx)'),
    SetWindowLongPtrW: user32.func('intptr __stdcall SetWindowLongPtrW(intptr h, int idx, intptr v)'),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr h, intptr after, int x, int y, int cx, int cy, uint flags)'),
    ValidateRect: user32.func('bool __stdcall ValidateRect(intptr h, void* r)'),
    GetDC: user32.func('intptr __stdcall GetDC(intptr h)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr h, intptr dc)'),
    SetLayeredWindowAttributes: user32.func('bool __stdcall SetLayeredWindowAttributes(intptr h, uint key, uint8 alpha, uint flags)'),
    RedrawWindow: user32.func('bool __stdcall RedrawWindow(intptr h, void* r, intptr rgn, uint flags)'),
    UpdateLayeredWindow: user32.func('bool __stdcall UpdateLayeredWindow(intptr h, intptr dst, UN_DPOINT* ptDst, UN_DSIZE* size, intptr src, UN_DPOINT* ptSrc, uint key, UN_DBLEND* blend, uint flags)'),
    PeekMessageW: user32.func('bool __stdcall PeekMessageW(_Out_ UN_DMSG* m, intptr h, uint a, uint b, uint r)'),
    TranslateMessage: user32.func('bool __stdcall TranslateMessage(UN_DMSG* m)'),
    DispatchMessageW: user32.func('intptr __stdcall DispatchMessageW(UN_DMSG* m)'),
    MsgWaitForMultipleObjectsEx: user32.func('uint32 __stdcall MsgWaitForMultipleObjectsEx(uint32 n, void* handles, uint32 ms, uint32 mask, uint32 flags)'),
    CreateCompatibleDC: gdi32.func('intptr __stdcall CreateCompatibleDC(intptr dc)'),
    DeleteDC: gdi32.func('bool __stdcall DeleteDC(intptr dc)'),
    CreateDIBSection: gdi32.func('intptr __stdcall CreateDIBSection(intptr dc, UN_DBIH* bmi, uint usage, _Out_ void** bits, intptr section, uint offset)'),
    SelectObject: gdi32.func('intptr __stdcall SelectObject(intptr dc, intptr obj)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr obj)'),
    BitBlt: gdi32.func('bool __stdcall BitBlt(intptr dst, int x, int y, int w, int h, intptr src, int sx, int sy, uint rop)'),
  };
  wndProc = koffi.register((h, msg, wp, lp) => {
    if (msg === WM_NCHITTEST) return HTTRANSPARENT;
    if (msg === WM_PAINT && mode === 'opaque') {
      blitOpaque(h);
      f.ValidateRect(h, null);
      return 0;
    }
    if (msg === WM_DESTROY && h === hwnd) {
      // The taskbar went (Explorer restarted) and took its child with it.
      hwnd = 0;
      gone = true;
    }
    return f.DefWindowProcW(h, msg, wp, lp);
  }, koffi.pointer(WNDPROC));
  instance = Number(f.GetModuleHandleW(null)) || 0;
  const atom = f.RegisterClassExW({
    cbSize: koffi.sizeof('UN_DWNDCLASSEXW'), style: 0, lpfnWndProc: wndProc, cbClsExtra: 0, cbWndExtra: 0,
    hInstance: instance, hIcon: 0, hCursor: 0, hbrBackground: 0, lpszMenuName: null, lpszClassName: CLASS_NAME, hIconSm: 0,
  });
  if (!atom) throw Object.assign(new Error('class'), { code: 'REGISTER_CLASS' });
  screenDc = Number(f.GetDC(0)) || 0;
  memDc = Number(f.CreateCompatibleDC(screenDc)) || 0;
  if (!memDc) throw Object.assign(new Error('dc'), { code: 'MEMORY_DC' });
}

function freeDib() {
  if (dib) {
    f.SelectObject(memDc, oldBitmap);
    f.DeleteObject(dib);
  }
  dib = 0;
  bitsPtr = null;
  bits = null;
  dibW = 0;
  dibH = 0;
}

function ensureDib(w, h) {
  if (dib && dibW === w && dibH === h) return true;
  freeDib();
  const out = [null];
  const made = Number(f.CreateDIBSection(memDc, {
    biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0,
    biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
  }, 0, out, 0, 0)) || 0;
  if (!made || !out[0]) return false;
  dib = made;
  oldBitmap = Number(f.SelectObject(memDc, dib)) || 0;
  bitsPtr = out[0];
  bits = new Uint8Array(w * h * 4);
  dibW = w;
  dibH = h;
  return true;
}

function destroyWindow() {
  if (hwnd && f.IsWindow(hwnd)) f.DestroyWindow(hwnd);
  hwnd = 0;
}

function attach(nextBar) {
  destroyWindow();
  bar = nextBar;
  gone = false;
  mode = 'layered';
  hwnd = Number(f.CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE, CLASS_NAME, 'Usage Notch',
    WS_CHILD | WS_CLIPSIBLINGS, 0, 0, 1, 1, bar, 0, instance, 0)) || 0;
  if (!hwnd) {
    post({ type: 'failed', code: 'CREATE_CHILD' });
    return;
  }
  post({ type: 'attached', hwnd, mode });
}

/** Layered: hand the frame to the compositor with per-pixel alpha. */
function showLayered() {
  return Boolean(f.UpdateLayeredWindow(hwnd, screenDc, null, { cx: dibW, cy: dibH }, memDc, { x: 0, y: 0 }, 0,
    { op: 0, flags: 0, alpha: 255, format: AC_SRC_ALPHA }, ULW_ALPHA));
}

/** Opaque fallback: the frame over the taskbar colour, then a plain blit. */
function composeOpaque() {
  if (!lastFrame || !bits) return;
  const src = lastFrame;
  const [r, g, b] = colour;
  for (let i = 0; i < bits.length; i += 4) {
    const k = 255 - src[i + 3];
    bits[i] = src[i] + ((b * k + 127) / 255 | 0);
    bits[i + 1] = src[i + 1] + ((g * k + 127) / 255 | 0);
    bits[i + 2] = src[i + 2] + ((r * k + 127) / 255 | 0);
    bits[i + 3] = 255;
  }
  f.RtlMoveMemory(bitsPtr, bits, bits.length);
}

function blitOpaque(h) {
  if (!dib) return;
  const dc = Number(f.GetDC(h)) || 0;
  if (!dc) return;
  try {
    f.BitBlt(dc, 0, 0, dibW, dibH, memDc, 0, 0, SRCCOPY);
  } finally {
    f.ReleaseDC(h, dc);
  }
}

/**
 * Opaque fallback. STILL layered, but with a constant alpha
 * (SetLayeredWindowAttributes) and painted with GDI: a plain, non-layered
 * child is drawn into the taskbar's redirection surface, which the XAML
 * island's own visual covers — measured: it showed nothing at all.
 */
function toOpaque() {
  mode = 'opaque';
  const ex = Number(f.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) >>> 0;
  if (!(ex & WS_EX_LAYERED)) f.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_LAYERED) >>> 0);
  if (!f.SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA)) {
    post({ type: 'failed', code: 'OPAQUE' });
    return false;
  }
  f.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOZORDER);
  post({ type: 'mode', mode });
  return true;
}

function frame(msg) {
  if (!hwnd) return;
  const w = msg.w | 0;
  const h = msg.h | 0;
  const data = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data || []);
  if (w <= 0 || h <= 0 || data.length !== w * h * 4) return;
  if (!ensureDib(w, h)) {
    post({ type: 'failed', code: 'DIB' });
    return;
  }
  lastFrame = data;
  if (mode === 'layered') {
    f.RtlMoveMemory(bitsPtr, data, data.length);
    if (showLayered()) return;
    if (!toOpaque()) return;
  }
  composeOpaque();
  // Invalidate rather than draw here: WM_PAINT blits, and the window's
  // redirection surface keeps the picture.
  f.RedrawWindow(hwnd, null, 0, RDW_INVALIDATE | RDW_UPDATENOW);
}

function parseColour(hex) {
  const m = typeof hex === 'string' && /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return colour;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
}

function place(msg) {
  if (!hwnd) return;
  const next = parseColour(msg.colour);
  const recolour = next.join() !== colour.join();
  colour = next;
  // HWND_TOP: above the taskbar's XAML island, which is its sibling.
  f.SetWindowPos(hwnd, HWND_TOP, msg.x | 0, msg.y | 0, msg.w | 0, msg.h | 0, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  if (mode === 'opaque' && recolour) {
    composeOpaque();
    f.RedrawWindow(hwnd, null, 0, RDW_INVALIDATE | RDW_UPDATENOW);
  }
}

function hide() {
  if (hwnd) f.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER | SWP_HIDEWINDOW);
}

/** Once a second: still alive, still above the island. */
function housekeeping(now) {
  if (now - lastZCheck < IDLE_WAIT_MS) return;
  lastZCheck = now;
  if (hwnd && !f.IsWindow(hwnd)) {
    hwnd = 0;
    gone = true;
  }
  if (hwnd && bar && Number(f.GetWindow(bar, GW_CHILD)) !== hwnd) {
    f.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
}

function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'attach': attach(Number(msg.bar) || 0); break;
    case 'place': place(msg); break;
    case 'frame': frame(msg); break;
    case 'hide': hide(); break;
    case 'stop': running = false; break;
    default: break;
  }
}

function loop() {
  const m = {};
  while (running) {
    f.MsgWaitForMultipleObjectsEx(0, null, IDLE_WAIT_MS, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    while (f.PeekMessageW(m, 0, 0, 0, PM_REMOVE)) {
      f.TranslateMessage(m);
      f.DispatchMessageW(m);
    }
    let next;
    while (running && (next = receiveMessageOnPort(port))) handle(next.message);
    housekeeping(Date.now());
    if (gone) {
      gone = false;
      post({ type: 'gone' });
    }
  }
}

function teardown() {
  try { destroyWindow(); } catch { /* going */ }
  try { freeDib(); } catch { /* going */ }
  try { if (memDc) f.DeleteDC(memDc); } catch { /* going */ }
  try { if (screenDc) f.ReleaseDC(0, screenDc); } catch { /* going */ }
  try { f.UnregisterClassW(CLASS_NAME, instance); } catch { /* going */ }
  try { if (wndProc) koffi.unregister(wndProc); } catch { /* going */ }
}

try {
  setup();
} catch (err) {
  post({ type: 'failed', code: (err && err.code) || 'SETUP_FAILED' });
  process.exit(0);
}
post({ type: 'ready', tid: Number(f.GetCurrentThreadId()) });
try {
  loop();
} catch (err) {
  post({ type: 'failed', code: (err && err.code) || 'LOOP_FAILED' });
}
teardown();
process.exit(0);
