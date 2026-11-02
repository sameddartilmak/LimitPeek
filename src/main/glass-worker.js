'use strict';
/**
 * The Liquid Glass's LIVE copy on a thread of its own (panel-window.js,
 * LIVE). Main's event loop also routes every IPC message, paints the tray
 * and runs the scans; a copy timed from it lands late whenever any of those
 * is busy, and the glass moved in steps ("biraz daha akıcı olabilir", owner,
 * 2026-11-02). Here nothing else runs: the loop copies, compares and posts.
 *
 * The same rule as main's own `_liveTick`, which stays as the fallback when
 * this thread cannot start: a thin ring just outside the panel is copied
 * with the panel IN it; only when the ring changed (or the screen was moving
 * a tick ago) is the region under the window copied with the window left out
 * of that one copy (win32 captureBehind), and it is posted only when it
 * differs from the last one posted. A still screen never hides the panel
 * from a screenshot.
 *
 * COMMANDS (from main, on parentPort)
 *   { type: 'follow', seq, hwnd, rect, ring }  start, or follow a new place:
 *                                              rect = the window, ring = the
 *                                              window grown by the ring, both
 *                                              PHYSICAL px; `seq` names it
 *   { type: 'pause' }                          stop copying (panel closed)
 * REPORTS (to main)
 *   { type: 'frame', seq, width, height, bgra }  `bgra` an ArrayBuffer, transferred
 *   { type: 'failed', code }                     no DWM helper: main falls back
 *
 * Nothing is kept past a `pause`: the last copy is dropped with it.
 */
const { parentPort } = require('node:worker_threads');
const win32 = require('./win32');

/**
 * The pace. A copy of the screen takes about one composed frame (the BitBlt
 * waits for DWM: 7 ms on the 147 Hz display measured here), so while the
 * screen moves the copies run back to back and follow EVERY frame the
 * display shows (the owner, 2026-11-02, after 48 and then 70 a second: "biraz
 * daha akıcı", twice). MOVING_GAP_MS only stops a copy that did not wait for
 * DWM from spinning faster than any display. A still screen is looked at
 * (the ring alone) about 30 times a second, waiting on Windows' composed
 * frames in between (win32 waitForFrame, DwmFlush), so motion that starts
 * is caught within a frame or two. Without frames to wait for, a plain timer
 * at the same gaps.
 */
const MOVING_GAP_MS = 5;
const STILL_GAP_MS = 33;
/**
 * How long the screen counts as moving after the last change. A drag, a
 * scroll or a video has frames where nothing moved; dropping to the still
 * pace (and the ring) on each of them made the glass catch up in steps.
 */
const MOVING_HOLD_MS = 250;

const dwm = win32.loadDwm();
if (!dwm || typeof dwm.captureBehind !== 'function' || typeof dwm.captureScreen !== 'function') {
  parentPort.postMessage({ type: 'failed', code: 'NO_DWM' });
}

let place = null;
let timer = null;
let lastLook = 0;
let ring = null;
let last = null;
let moving = false;
/** When the last copy that differed was posted. */
let lastChange = 0;

/**
 * Two equal-sized BGRA copies compared on their outer `edge` pixels only: the
 * top and bottom bands whole, and the sides between them.
 */
function sameRing(a, b, width, height, edge) {
  const stride = width * 4;
  const band = Math.min(edge, height) * stride;
  if (a.compare(b, 0, band, 0, band) !== 0) return false;
  const bottom = Math.max(0, height - edge) * stride;
  if (a.compare(b, bottom, a.length, bottom, b.length) !== 0) return false;
  const side = Math.min(edge, width) * 4;
  for (let y = edge; y < height - edge; y++) {
    const row = y * stride;
    if (a.compare(b, row, row + side, row, row + side) !== 0) return false;
    if (a.compare(b, row + stride - side, row + stride, row + stride - side, row + stride) !== 0) return false;
  }
  return true;
}

/** Did the ring outside the panel change since the last look? */
function ringMoved() {
  const probe = dwm.captureScreen(place.ring);
  if (!probe) return false;
  const before = ring;
  ring = probe;
  if (!before || before.width !== probe.width || before.height !== probe.height) return true;
  const edge = Math.max(1, Math.round((place.ring.width - place.rect.width) / 2));
  return !sameRing(before.bgra, probe.bgra, probe.width, probe.height, edge);
}

function tick() {
  timer = null;
  if (!place) return;
  const gap = moving ? MOVING_GAP_MS : STILL_GAP_MS;
  const since = performance.now() - lastLook;
  if (since < gap) {
    // Too soon: the next composed frame, letting messages in between; with
    // no frames to wait for, a timer for the rest of the gap.
    timer = dwm.waitForFrame() ? setImmediate(tick) : setTimeout(tick, Math.max(1, Math.ceil(gap - since)));
    return;
  }
  lastLook = performance.now();
  try {
    if (moving || ringMoved()) {
      const shot = dwm.captureBehind(place.hwnd, place.rect);
      if (shot) {
        if (last && last.width === shot.width && last.height === shot.height && last.bgra.equals(shot.bgra)) {
          // Still, unless it changed a moment ago (MOVING_HOLD_MS).
          if (Date.now() - lastChange >= MOVING_HOLD_MS) moving = false;
        } else {
          moving = true;
          lastChange = Date.now();
          last = shot;
          // A copy goes; the original stays here to compare the next one with.
          const out = new Uint8Array(shot.bgra);
          parentPort.postMessage({ type: 'frame', seq: place.seq, width: shot.width, height: shot.height, bgra: out.buffer }, [out.buffer]);
        }
      }
    }
  } catch {
    // A copy that throws is a tick without a picture; win32 already guards.
  }
  timer = setImmediate(tick);
}

function cancel() {
  if (!timer) return;
  clearImmediate(timer);
  clearTimeout(timer);
  timer = null;
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'follow') {
    place = { seq: msg.seq, hwnd: msg.hwnd, rect: msg.rect, ring: msg.ring };
    // Another place: compare nothing with the old one.
    ring = null;
    last = null;
    moving = false;
    if (!timer) timer = setImmediate(tick);
  } else if (msg.type === 'pause') {
    place = null;
    ring = null;
    last = null;
    moving = false;
    cancel();
  }
});
