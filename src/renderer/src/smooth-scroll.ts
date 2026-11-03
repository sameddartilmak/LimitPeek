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

/**
 * How quickly the glide closes on its target: 63% of the way every TAU. Long
 * enough that the list keeps coasting after the wheel stops (the owner asked
 * for "daha kaygan", more slippery, after 0.085 s felt too firm).
 */
export const SCROLL_TAU_S = 0.16;
/**
 * How far one wheel notch moves the list, in CSS px, whatever Windows' "lines
 * per notch" says. The browser's own step (about 200 px at 6 lines) and then
 * 0.7 of it (140 px) both slid too far for one small turn ("az kaydırmayla
 * bile fazla kayıyor"); a Mac moves a lone notch only a little and lets speed
 * carry a fast spin further.
 */
export const NOTCH_PX = 70;
/** Used only when the event says nothing about notches (no wheelDeltaY). */
export const WHEEL_GAIN = 0.4;
/**
 * Spinning the wheel fast throws the list further, as on a Mac. A notch that
 * follows the last within STREAK_MS in the same direction extends the streak;
 * the first STREAK_FREE notches of a streak move plainly (an ordinary short
 * roll stays short), each one after that moves STREAK_STEP more, up to
 * STREAK_MAX times a lone notch.
 */
export const STREAK_MS = 110;
export const STREAK_FREE = 2;
export const STREAK_STEP = 0.25;
export const STREAK_MAX = 2.2;
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

/**
 * The wheel event's vertical distance in CSS px: NOTCH_PX per notch when the
 * event counts notches, otherwise the browser's distance times WHEEL_GAIN.
 */
export function wheelDistance(e: WheelLike, pageHeight: number): number {
  const w = e.wheelDeltaY;
  if (typeof w === 'number' && w !== 0 && w % 120 === 0) return (-w / 120) * NOTCH_PX;
  if (e.deltaMode === 1) return (e.deltaY / 3) * NOTCH_PX;
  const unit = e.deltaMode === 2 ? pageHeight : 1;
  return e.deltaY * unit * WHEEL_GAIN;
}

/**
 * The throw multiplier for this notch. `streak` is how many notches in a row
 * came within STREAK_MS in the same direction before this one.
 */
export function streakBoost(streak: number): number {
  return Math.min(STREAK_MAX, 1 + Math.max(0, streak - STREAK_FREE) * STREAK_STEP);
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
  /** Notches in a row, and when and which way the last one went. */
  streak: number;
  notchAt: number;
  notchSign: number;
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
      const keep = g && g.raf === 0 ? g : null;
      g = {
        current: el.scrollTop, target: el.scrollTop, written: el.scrollTop, last: view.performance.now(), raf: 0,
        streak: keep ? keep.streak : 0, notchAt: keep ? keep.notchAt : -Infinity, notchSign: keep ? keep.notchSign : 0,
      };
      glides.set(el, g);
    }
    const now = view.performance.now();
    const sign = Math.sign(event.deltaY);
    g.streak = sign === g.notchSign && now - g.notchAt < STREAK_MS ? g.streak + 1 : 0;
    g.notchAt = now;
    g.notchSign = sign;
    const max = el.scrollHeight - el.clientHeight;
    const delta = wheelDistance(event, view.innerHeight) * streakBoost(g.streak);
    g.target = nextTarget(g.current, g.target, delta, max);
    if (!g.raf) {
      g.last = view.performance.now();
      g.raf = view.requestAnimationFrame(frame(el, g));
    }
  };

  view.addEventListener('wheel', onWheel, { passive: false });
  return () => view.removeEventListener('wheel', onWheel);
}
