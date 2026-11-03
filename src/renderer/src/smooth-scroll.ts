/**
 * Mouse-wheel scrolling that glides, like scrolling on a Mac.
 *
 * Chromium on Windows turns each wheel notch into one short, fixed jump. With
 * Windows set to 6 lines per notch that is about 200 px, more than a third of
 * the panel's list, so the list lurches from row to row. Here a notch moves a
 * target instead, and the box eases toward it every frame (an exponential
 * approach, so quick notches add up to a longer, faster glide and the motion
 * always settles softly).
 *
 * Only a notched mouse wheel is taken over. A precision touchpad already
 * scrolls 1:1 with the fingers and coasts on its own (Windows sends the
 * momentum), and smoothing it again would only add lag. Ctrl+wheel (zoom),
 * sideways scrolling and `prefers-reduced-motion` are left to the browser.
 *
 * The box is found the way the browser would: the nearest ancestor that
 * scrolls and still has room in that direction. `overscroll-behavior:
 * contain` stops the search there, as it stops scroll chaining natively.
 */

/** How quickly the glide closes on its target: 63% of the way every TAU. */
export const SCROLL_TAU_S = 0.085;
/** Share of the browser's per-notch distance one notch moves. */
export const WHEEL_GAIN = 0.7;
/** Closer than this (CSS px) and the glide simply lands. */
const LAND_PX = 0.5;
/** Someone else moved the box (scrollbar drag, scrollIntoView, code). */
const FOREIGN_PX = 1.5;
/** A dropped frame never turns into a jump. */
const MAX_DT_S = 0.05;

export interface WheelLike {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  /** Legacy, but Chromium still fills it: whole notches are multiples of 120. */
  wheelDeltaY?: number;
}

/**
 * A notched mouse wheel, as opposed to a touchpad or a free-spinning wheel.
 * Chromium reports whole notches as multiples of 120 in `wheelDeltaY`; a
 * touchpad's small fractional steps practically never are.
 */
export function isNotchedWheel(e: WheelLike): boolean {
  if (e.ctrlKey || e.shiftKey) return false;
  if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return false;
  if (e.deltaMode !== 0) return true;
  const w = e.wheelDeltaY;
  return typeof w === 'number' && w !== 0 && w % 120 === 0;
}

/** The wheel event's vertical distance in CSS px, scaled by WHEEL_GAIN. */
export function wheelDistance(e: WheelLike, pageHeight: number): number {
  const unit = e.deltaMode === 1 ? 100 / 3 : e.deltaMode === 2 ? pageHeight : 1;
  return e.deltaY * unit * WHEEL_GAIN;
}

/** One frame of the glide: `current` eased toward `target` over `dt` seconds. */
export function approach(current: number, target: number, dt: number, tau: number = SCROLL_TAU_S): number {
  if (!(dt > 0)) return current;
  const next = target + (current - target) * Math.exp(-Math.min(dt, MAX_DT_S) / tau);
  return Math.abs(target - next) < LAND_PX ? target : next;
}

/**
 * Where a new notch sends the glide. Same direction: the notch adds to what is
 * still to go. Reversed: it starts from where the box is now, so turning the
 * wheel back answers at once instead of first finishing the old glide.
 */
export function nextTarget(current: number, target: number, delta: number, max: number): number {
  const reversed = (target - current) * delta < 0;
  const base = reversed ? current : target;
  return Math.min(max, Math.max(0, base + delta));
}

interface Glide {
  current: number;
  target: number;
  /** scrollTop as the browser stored it after our last write. */
  written: number;
  last: number;
  raf: number;
}

function scrollsY(el: Element, view: Window): boolean {
  const oy = view.getComputedStyle(el).overflowY;
  return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1;
}

/**
 * The box this wheel turn should move, or null to leave it to the browser.
 * `glides` lets a box that is mid-glide keep the wheel even though its
 * scrollTop has not caught up with the room that is left.
 */
function boxFor(start: EventTarget | null, dy: number, view: Window, glides: WeakMap<Element, Glide>): Element | null {
  for (let el = start instanceof Element ? start : null; el; el = el.parentElement) {
    if (!scrollsY(el, view)) continue;
    const g = glides.get(el);
    const at = g && g.raf ? g.target : el.scrollTop;
    const max = el.scrollHeight - el.clientHeight;
    if (dy < 0 ? at > 0 : at < max - 1) return el;
    if (view.getComputedStyle(el).overscrollBehaviorY !== 'auto') return null;
  }
  return null;
}

/** Takes over notched mouse-wheel scrolling in `view`. Returns the undo. */
export function installSmoothScroll(view: Window = window): () => void {
  const glides = new WeakMap<Element, Glide>();
  const reduce = view.matchMedia ? view.matchMedia('(prefers-reduced-motion: reduce)') : null;

  const frame = (el: Element, g: Glide) => (now: number): void => {
    g.raf = 0;
    if (Math.abs(el.scrollTop - g.written) > FOREIGN_PX) return; // someone else scrolled
    const max = el.scrollHeight - el.clientHeight;
    g.target = Math.min(max, Math.max(0, g.target));
    g.current = approach(g.current, g.target, (now - g.last) / 1000);
    g.last = now;
    el.scrollTop = g.current;
    g.written = el.scrollTop;
    if (g.current !== g.target) g.raf = view.requestAnimationFrame(frame(el, g));
  };

  const onWheel = (event: WheelEvent): void => {
    if (event.defaultPrevented || (reduce && reduce.matches)) return;
    if (!isNotchedWheel(event)) return;
    const el = boxFor(event.target, event.deltaY, view, glides);
    if (!el) return;
    event.preventDefault();
    let g = glides.get(el);
    const idle = !g || !g.raf || Math.abs(el.scrollTop - g.written) > FOREIGN_PX;
    if (!g || idle) {
      if (g && g.raf) view.cancelAnimationFrame(g.raf);
      g = { current: el.scrollTop, target: el.scrollTop, written: el.scrollTop, last: view.performance.now(), raf: 0 };
      glides.set(el, g);
    }
    const max = el.scrollHeight - el.clientHeight;
    g.target = nextTarget(g.current, g.target, wheelDistance(event, view.innerHeight), max);
    if (!g.raf) {
      g.last = view.performance.now();
      g.raf = view.requestAnimationFrame(frame(el, g));
    }
  };

  view.addEventListener('wheel', onWheel, { passive: false });
  return () => view.removeEventListener('wheel', onWheel);
}
