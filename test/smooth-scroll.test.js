'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mirrorRenderer } = require('./helpers/fake-dom');

let mirror;
let mod;
test.before(async () => {
  mirror = mirrorRenderer();
  mod = await mirror.load('smooth-scroll.js');
});
test.after(() => { if (mirror) mirror.cleanup(); });

const notch = (deltaY, extra = {}) => ({
  deltaMode: 0, deltaX: 0, deltaY, ctrlKey: false, shiftKey: false,
  wheelDeltaY: -Math.sign(deltaY) * 120, ...extra,
});

test('a notched mouse wheel is taken over; touchpad, zoom and sideways are not', () => {
  assert.equal(mod.isNotchedWheel(notch(200)), true);
  assert.equal(mod.isNotchedWheel(notch(-200)), true);
  assert.equal(mod.isNotchedWheel(notch(3, { deltaMode: 1, wheelDeltaY: undefined })), true, 'line mode is a wheel');
  assert.equal(mod.isNotchedWheel(notch(7.25, { wheelDeltaY: -9 })), false, 'touchpad step');
  assert.equal(mod.isNotchedWheel(notch(200, { ctrlKey: true })), false, 'ctrl+wheel zooms');
  assert.equal(mod.isNotchedWheel(notch(200, { shiftKey: true })), false);
  assert.equal(mod.isNotchedWheel(notch(10, { deltaX: 50 })), false, 'sideways');
  assert.equal(mod.isNotchedWheel(notch(0)), false);
});

test('one notch moves less than the browser jump, scaled by WHEEL_GAIN', () => {
  assert.equal(mod.wheelDistance(notch(200), 600), 200 * mod.WHEEL_GAIN);
  assert.ok(mod.wheelDistance(notch(200), 600) < 200);
  assert.equal(mod.wheelDistance(notch(-3, { deltaMode: 1 }), 600), -100 * mod.WHEEL_GAIN);
});

test('the glide eases in, never overshoots, and lands', () => {
  let x = 0;
  const steps = [];
  for (let i = 0; i < 200 && x !== 140; i++) { x = mod.approach(x, 140, 1 / 147); steps.push(x); }
  assert.equal(x, 140, 'lands exactly on the target');
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] >= steps[i - 1] && steps[i] <= 140);
  const firstMove = steps[0];
  const lastMove = steps[steps.length - 1] - steps[steps.length - 2];
  assert.ok(firstMove > lastMove * 10, 'fast at first, soft at the end');
  const ms = steps.length * (1000 / 147);
  assert.ok(ms > 500 && ms < 1200, `a notch coasts, slippery but not sluggish (${ms.toFixed(0)} ms)`);
  const half = steps.findIndex((v) => v >= 70) * (1000 / 147);
  assert.ok(half < 150, `half the way within ${half.toFixed(0)} ms: it answers at once`);
});

test('a dropped frame does not become a jump', () => {
  assert.equal(mod.approach(0, 100, 5), mod.approach(0, 100, 0.05));
  assert.equal(mod.approach(30, 100, 0), 30);
});

test('notches add up; a reversed notch answers from where the box is', () => {
  assert.equal(mod.nextTarget(0, 0, 140, 1000), 140);
  assert.equal(mod.nextTarget(50, 140, 140, 1000), 280, 'same direction adds to what is left');
  assert.equal(mod.nextTarget(50, 140, -140, 1000), 0, 'reverse starts from current (50-140, clamped)');
  assert.equal(mod.nextTarget(900, 950, 140, 1000), 1000, 'clamped at the bottom');
});

function fakeView() {
  const frames = [];
  let now = 0;
  const listeners = {};
  const style = { overflowY: 'auto', overscrollBehaviorY: 'contain' };
  class El {
    constructor(parent) { this.parentElement = parent; this._top = 0; this.scrollHeight = 2000; this.clientHeight = 400; }
    get scrollTop() { return this._top; }
    set scrollTop(v) { this._top = Math.round(Math.min(this.scrollHeight - this.clientHeight, Math.max(0, v)) * 1.25) / 1.25; }
  }
  globalThis.Element = El;
  const view = {
    innerHeight: 600,
    performance: { now: () => now },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: (el) => (el.plain ? { overflowY: 'visible', overscrollBehaviorY: 'auto' } : style),
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
    addEventListener: (t, fn) => { listeners[t] = fn; },
    removeEventListener: (t) => { delete listeners[t]; },
  };
  const run = (ms) => {
    const end = now + ms;
    while (now < end && frames.length) { now += 1000 / 147; const f = frames.shift(); f(now); }
  };
  const wheel = (target, deltaY) => {
    const e = { ...notch(deltaY), target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    listeners.wheel(e);
    return e;
  };
  return { view, El, run, wheel, listeners };
}

test('installed: a notch glides the scrolling box and settles on target', () => {
  const f = fakeView();
  const box = new f.El(null);
  const row = new f.El(box); row.plain = true;
  const undo = mod.installSmoothScroll(f.view);
  const e = f.wheel(row, 200);
  assert.equal(e.defaultPrevented, true);
  f.run(16);
  const one = 200 * mod.WHEEL_GAIN;
  assert.ok(box.scrollTop > 0 && box.scrollTop < one / 2, `moving, not jumped (${box.scrollTop})`);
  f.run(2000);
  assert.ok(Math.abs(box.scrollTop - one) < 1, `settled near ${one} (${box.scrollTop})`);
  undo();
  assert.equal(f.listeners.wheel, undefined);
});

test('installed: at the edge of a contained box the wheel is left alone', () => {
  const f = fakeView();
  const box = new f.El(null);
  mod.installSmoothScroll(f.view);
  const e = f.wheel(box, -200);
  assert.equal(e.defaultPrevented, false);
});

test('installed: someone else scrolling (scrollbar, scrollIntoView) stops the glide', () => {
  const f = fakeView();
  const box = new f.El(null);
  mod.installSmoothScroll(f.view);
  f.wheel(box, 200);
  f.run(30);
  box.scrollTop = 900;
  f.run(1000);
  assert.equal(box.scrollTop, 900);
});

test('a fast spin throws further; a slow one does not', () => {
  assert.equal(mod.streakBoost(0), 1);
  assert.ok(mod.streakBoost(2) > 1.5);
  assert.equal(mod.streakBoost(50), mod.STREAK_MAX);
  const spin = (gapMs) => {
    const f = fakeView();
    const box = new f.El(null);
    box.scrollHeight = 20000;
    mod.installSmoothScroll(f.view);
    for (let i = 0; i < 4; i++) { f.wheel(box, 200); f.run(gapMs); }
    f.run(3000);
    return box.scrollTop;
  };
  const slow = spin(400);
  const fast = spin(40);
  assert.ok(Math.abs(slow - 4 * 200 * mod.WHEEL_GAIN) < 2, `slow notches add up plainly (${slow})`);
  assert.ok(fast > slow * 1.4, `fast notches throw further (${fast} vs ${slow})`);
});

test('the panel installs it', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer', 'src', 'main.ts'), 'utf8');
  assert.match(src, /installSmoothScroll\(window\)/);
});
