'use strict';
/**
 * Where the taskbar's own buttons end, measured with UI Automation, off the
 * main thread (taskbar-icons.js starts this worker; the strip reads its answer).
 *
 * WHY UI AUTOMATION
 * -----------------
 * The Windows 11 task buttons are XAML inside the taskbar's island: no HWND of
 * theirs says where they are. The legacy `MSTaskSwWClass` window still exists
 * but its rectangle is stale (measured 2026-10-20: 69..509 while the buttons
 * ran 0..784). UI Automation does know: under `Shell_TrayWnd` sits an element
 * of class `Taskbar.TaskbarFrameAutomationPeer`, and its children are the
 * groups of buttons — Start, Search, Task View, Widgets and the task list.
 * The union of those children's bounding rectangles is the area the strip must
 * never cover, whether the icons are centred or left-aligned (TaskbarAl=0),
 * and wherever Widgets sits. The notification area is a sibling of the frame,
 * not a child, so it is not in the union.
 *
 * WHY A WORKER
 * ------------
 * Every UI Automation call is a cross-process round trip into Explorer, and a
 * hung Explorer holds a call for seconds. On the main thread that would freeze
 * the panel; here it delays one measurement. UI Automation also wants an MTA
 * client thread, which a worker is (CoInitializeEx(COINIT_MULTITHREADED)).
 *
 * What it does: one IUIAutomation for the worker's life; per measurement
 * ElementFromHandle(Shell_TrayWnd) and a raw-view walk at most three levels
 * deep. Every element is Released as soon as it has been read, and the
 * walker and the automation object when the worker stops. Reads only: it
 * never invokes, focuses or changes anything. Posts `{ rect }` (physical
 * screen pixels; main is per-monitor DPI aware) or `{ rect: null, code }`,
 * and only when the answer changed.
 */
const { parentPort, workerData } = require('node:worker_threads');

const INTERVAL_MS = (workerData && workerData.intervalMs) || 1000;
const FRAME_CLASS = 'Taskbar.TaskbarFrame';
const MAX_DEPTH = 3;
const HR_OK = (hr) => hr >= 0;

let koffi = null;
let f = null;
let uia = null;
let walker = null;
let lastKey = null;
let timer = null;

function guid(s) {
  const h = s.replace(/[{}-]/g, '');
  const d4 = [];
  for (let i = 16; i < 32; i += 2) d4.push(parseInt(h.slice(i, i + 2), 16));
  return { d1: parseInt(h.slice(0, 8), 16), d2: parseInt(h.slice(8, 12), 16), d3: parseInt(h.slice(12, 16), 16), d4 };
}

function setup() {
  // eslint-disable-next-line global-require
  koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const ole32 = koffi.load('ole32.dll');
  const oleaut32 = koffi.load('oleaut32.dll');
  koffi.struct('UN_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: koffi.array('uint8', 8) });
  koffi.struct('UN_URECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  f = {
    FindWindowW: user32.func('intptr __stdcall FindWindowW(str16 cls, str16 name)'),
    CoInitializeEx: ole32.func('long __stdcall CoInitializeEx(void* reserved, uint32 model)'),
    CoUninitialize: ole32.func('void __stdcall CoUninitialize()'),
    CoCreateInstance: ole32.func('long __stdcall CoCreateInstance(UN_GUID* clsid, void* outer, uint32 ctx, UN_GUID* iid, _Out_ void** out)'),
    SysFreeString: oleaut32.func('void __stdcall SysFreeString(void* s)'),
    // IUnknown::Release, IUIAutomation::ElementFromHandle / get_RawViewWalker,
    // IUIAutomationTreeWalker::GetFirstChildElement / GetNextSiblingElement,
    // IUIAutomationElement::get_CurrentClassName / get_CurrentBoundingRectangle.
    Release: koffi.proto('uint32 __stdcall UN_Release(void* self)'),
    FromHandle: koffi.proto('long __stdcall UN_FromHandle(void* self, intptr hwnd, _Out_ void** out)'),
    GetObject: koffi.proto('long __stdcall UN_GetObject(void* self, _Out_ void** out)'),
    Step: koffi.proto('long __stdcall UN_Step(void* self, void* el, _Out_ void** out)'),
    GetRect: koffi.proto('long __stdcall UN_GetRect(void* self, _Out_ UN_URECT* out)'),
  };
  // 0 = COINIT_MULTITHREADED. A fresh worker thread: S_OK.
  if (!HR_OK(f.CoInitializeEx(null, 0))) throw Object.assign(new Error('com'), { code: 'COINIT' });
  const out = [null];
  // CLSID_CUIAutomation, IID_IUIAutomation, CLSCTX_INPROC_SERVER.
  const hr = f.CoCreateInstance(guid('{FF48DBA4-60EF-4201-AA87-54103EEF594E}'), null, 1,
    guid('{30CBE57D-D9D0-452A-AB13-7AC5AC4825EE}'), out);
  if (!HR_OK(hr) || !out[0]) throw Object.assign(new Error('uia'), { code: 'UIA_CREATE' });
  uia = out[0];
  const w = [null];
  if (!HR_OK(call(uia, 16, f.GetObject, w)) || !w[0]) throw Object.assign(new Error('walker'), { code: 'UIA_WALKER' });
  walker = w[0];
}

/** Calls vtable slot `index` of COM object `obj`. */
function call(obj, index, proto, ...args) {
  const vtbl = koffi.decode(obj, 'void*');
  const fn = koffi.decode(vtbl, index * 8, 'void*');
  return koffi.call(fn, proto, obj, ...args);
}

function release(obj) {
  if (obj) call(obj, 2, f.Release);
}

function className(el) {
  const out = [null];
  if (!HR_OK(call(el, 30, f.GetObject, out)) || !out[0]) return '';
  try {
    return koffi.decode(out[0], 'char16_t', -1);
  } finally {
    f.SysFreeString(out[0]);
  }
}

function rectOf(el) {
  const r = {};
  if (!HR_OK(call(el, 43, f.GetRect, r))) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function firstChild(el) {
  const out = [null];
  return HR_OK(call(walker, 4, f.Step, el, out)) ? out[0] : null;
}

function nextSibling(el) {
  const out = [null];
  return HR_OK(call(walker, 6, f.Step, el, out)) ? out[0] : null;
}

/** The frame element under `el`, or null. Everything it does not return is released. */
function findFrame(el, depth) {
  if (depth > MAX_DEPTH) return null;
  let child = firstChild(el);
  while (child) {
    if (className(child).startsWith(FRAME_CLASS)) return child;
    const found = findFrame(child, depth + 1);
    if (found) {
      release(child);
      return found;
    }
    const next = nextSibling(child);
    release(child);
    child = next;
  }
  return null;
}

/** The union of the frame's children's rectangles, or null. */
function measure() {
  const bar = Number(f.FindWindowW('Shell_TrayWnd', null)) || 0;
  if (!bar) return { rect: null, code: 'NO_TASKBAR' };
  const out = [null];
  if (!HR_OK(call(uia, 6, f.FromHandle, bar, out)) || !out[0]) return { rect: null, code: 'NO_ELEMENT' };
  const root = out[0];
  let frame = null;
  try {
    frame = findFrame(root, 1);
    if (!frame) return { rect: null, code: 'NO_FRAME' };
    const rects = [];
    let child = firstChild(frame);
    while (child) {
      const r = rectOf(child);
      if (r) rects.push(r);
      const next = nextSibling(child);
      release(child);
      child = next;
    }
    // eslint-disable-next-line global-require
    const { unionOfRects } = require('./taskbar-icons');
    const rect = unionOfRects(rects);
    return rect ? { rect } : { rect: null, code: 'NO_BUTTONS' };
  } finally {
    release(frame);
    release(root);
  }
}

function tick() {
  let result;
  try {
    result = measure();
  } catch (err) {
    result = { rect: null, code: (err && err.code) || 'UIA_FAILED' };
  }
  const key = JSON.stringify(result);
  if (key === lastKey) return;
  lastKey = key;
  parentPort.postMessage(result);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  try { release(walker); } catch { /* going away */ }
  try { release(uia); } catch { /* going away */ }
  walker = null;
  uia = null;
  try { if (f) f.CoUninitialize(); } catch { /* going away */ }
  process.exit(0);
}

try {
  setup();
} catch (err) {
  parentPort.postMessage({ rect: null, code: (err && err.code) || 'SETUP_FAILED', fatal: true });
  process.exit(0);
}
parentPort.on('message', (msg) => {
  if (msg === 'stop') stop();
  else if (msg === 'measure') { lastKey = null; tick(); }
});
tick();
timer = setInterval(tick, INTERVAL_MS);
