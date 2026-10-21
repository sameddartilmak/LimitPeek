/**
 * Row reordering: pointer drag and an equal keyboard path.
 *
 * WHY POINTER EVENTS AND NOT HTML5 DRAG-AND-DROP
 * ----------------------------------------------
 * The panel is a transparent, always-on-top, frameless window that main can
 * open WITHOUT activating (`showInactive`). Native drag-and-drop hands the
 * gesture to an OS drag loop that paints its own ghost outside our window and
 * behaves differently depending on whether the window took focus. Pointer
 * events keep the whole gesture inside this document, work identically in the
 * dev harness and in Electron, and cost nothing in dependencies.
 *
 * WHY THE MOVE LISTENERS ARE ON `document`, NOT ON THE GRIP
 * --------------------------------------------------------
 * `setPointerCapture` is requested and is the intended mechanism, but it is not
 * relied on: in Electron the grip is observed to receive `lostpointercapture`
 * immediately after `pointerdown`, while still connected to the document. With
 * the listeners on the grip, every later `pointermove` then went to whatever
 * element was under the cursor and never reached the handler — so the gesture
 * silently froze at the last position where the cursor happened to be over the
 * 32px tile.
 *
 * That masked itself for a long time because the dragged row translates with
 * the pointer 1:1, which keeps the grip under the cursor: the bug only appears
 * once the paint falls even 16px behind, which taller rows made routine. A
 * drag must not depend on the pointer staying inside a 32px box; that is the
 * one thing a drag is FOR. Session-scoped document listeners cost two adds and
 * two removes per gesture and cannot be lost this way.
 *
 * SURVIVING THE AUTO-HIDE
 * -----------------------
 * An unpinned panel closes once the pointer leaves it, and main decides that
 * by polling the OS cursor against the window rect — not by listening to us.
 *
 * This block used to claim a drag was safe because `setPointerCapture` keeps
 * the pointer inside the window. That is false and it was load-bearing: capture
 * retargets EVENTS, it does not move the physical cursor, and main's poll reads
 * `screen.getCursorScreenPoint()`. A drag whose pointer drifts past the window
 * margin — trivial at a bottom-right taskbar corner — and then STOPS emits no
 * `pointermove`, so nothing was holding the panel open and it closed under the
 * gesture. Main cannot tell that apart from the user walking away.
 *
 * So the drag keeps itself alive: the rAF loop that already runs for the whole
 * gesture calls `keepAlive()` on the same ~400ms cadence the panel throttles
 * pointer traffic at. A stationary pointer outside the rect is now indefinitely
 * safe FOR AS LONG AS THE GESTURE LASTS, and not one moment longer.
 *
 * Nothing here re-sorts a snapshot. It computes an id order from the DOM the
 * renderer was told to draw and hands it back to the app, which is the only
 * place allowed to hold an optimistic override.
 */

import { t } from './i18n.js';

/** How far the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Auto-scroll band at each end of the scroller, and step per frame. */
const EDGE = 26;
const EDGE_STEP = 8;

/** The part of the scroller's top covered by something drawn over it, in px. */
function scrollInsetTop(scroller: HTMLElement): number {
  try {
    const value = parseFloat(getComputedStyle(scroller).scrollPaddingTop);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
/**
 * How often a live drag re-asserts "the pointer is still here". Matches the
 * panel's own pointer-traffic throttle: this is an IPC send, and the rAF loop
 * it hangs off runs at 60Hz.
 */
const KEEPALIVE_MS = 400;

export interface ReorderHost {
  /** The list whose `li[data-provider]` children are reorderable. */
  list: HTMLElement;
  /** The element that actually scrolls the list. */
  scroller: HTMLElement;
  /** Persist a new order. The app owns the optimistic state and the revert. */
  commit(ids: readonly string[]): void;
  /** Polite, single-sentence announcement for the live region. */
  announce(text: string): void;
  /** Cancel main's pending auto-hide. */
  keepAlive(): void;
  /** Structural rendering is suspended during a drag; this resumes it. */
  onDragEnd(): void;
  /** False when nothing could be persisted (no bridge). */
  enabled(): boolean;
}

export interface ReorderHandle {
  /** Wire a row's grip. Safe to call again for the same element. */
  attach(grip: HTMLElement, providerId: string, displayName: string): void;
  /** True while a pointer drag is in flight; the panel must not re-sync. */
  isDragging(): boolean;
  destroy(): void;
}

/**
 * How much of a decision has to be undone before it is undone.
 *
 * A fraction of the SMALLER of the two rows involved, so the deadband is
 * always a real distance on screen and never wider than the smaller row can
 * afford. At 0.25 it is ~10px between two passive rows and ~35px between two
 * connected ones: comfortably more than a hand tremor, comfortably less than a
 * deliberate move.
 */
export const STICK = 0.25;

/**
 * Where a dragged row lands, given how far it has moved. Pure, and exported so
 * it can be swept without a window (`test/reorder-target.test.js`).
 *
 * WHAT THIS REPLACED, AND WHY IT WAS WRONG
 * ----------------------------------------
 * The previous version compared the dragged row's centre — measured in the
 * ORIGINAL layout — against thresholds built from a COMPACTED accumulator that
 * summed only the non-dragged heights, i.e. the layout as if the row had
 * already been lifted out. Two coordinate systems, one comparison. They agree
 * only when every row is the same height, and this panel's rows are not: a
 * connected row is 64px and a passive one 44px.
 *
 * The consequence was not subtle. On the real six-row shape
 * [64, 64, 44, 44, 44, 44], picking up row 1 computed a target of 2 before the
 * pointer had moved a single pixel — the row dropped a slot on pick-up and then
 * fought every attempt to drag it back up. That is exactly the reported
 * "I can drag it down but not up". Every row also switched slots after 1px of
 * downward travel while needing a full row height upward.
 *
 * The rule became one system and one sentence: another row is above me if my
 * centre has passed its midpoint, both measured in the layout as drawn. It
 * follows that at `dy === 0` every other row sorts to the side it started on,
 * so the result is `from` — the invariant that actually broke, and one that
 * holds for ANY set of heights rather than by accident for equal ones.
 *
 * TWO THINGS THE MIDPOINT RULE STILL GOT WRONG
 * --------------------------------------------
 * 1. A row should give way when it has been COVERED, not when it has been
 *    halved.
 *
 *    For two rows of EQUAL height the midpoint crossing is already the moment
 *    the dragged row's leading edge reaches the other row's leading edge — it
 *    has been carried all the way over — so for the case the user actually hit
 *    (two connected rows, same height) the commit point was already right.
 *    But when the dragged row is SHORTER than its neighbour, half is not yet
 *    all: a 42px row passing a 139px one swapped after 91px having covered
 *    less than a third of it.
 *
 *    The commit point is now leading-edge alignment: upward when my top edge
 *    reaches the neighbour's top edge, downward when my bottom edge reaches
 *    its bottom edge. Either way the travel is exactly the neighbour's height.
 *    It reduces to the midpoint when the heights match and comes later when
 *    the dragged row is shorter.
 *
 *    It comes EARLIER when the dragged row is taller, and that is the second
 *    correction (2026-09-24). This used to keep the midpoint there, claiming
 *    that arriving early beat overshooting. The claim was wrong. A tall row
 *    dragged up into slot 0 is clamped by `paint()` at the list's top edge,
 *    and the neighbour's midpoint lies BEYOND that edge. The owner saw the
 *    row stop at the top while the neighbour stayed behind it, as if the drag
 *    had failed. The neighbour must give way the moment it is covered, and
 *    for a taller row that moment is edge alignment.
 *
 * 2. Undoing a swap must cost more than making it.
 *
 *    Sitting exactly on a boundary, one pixel of tremor flipped the target
 *    back and forth, and `paint()` slides a full row height with a transition
 *    on every flip. Measured: a ±2px tremble produced two distinct targets
 *    under the plain midpoint rule and produces one now.
 *
 *    The stickiness is applied ONLY to a row that has ALREADY given way. A row
 *    still sitting where the gesture found it transitions at the plain commit
 *    point, so the first swap costs exactly rule 1 and not a pixel more. That
 *    asymmetry is the whole difference between "this move was deliberate" and
 *    "every move is sluggish" — a symmetric deadband would have pushed the
 *    first commit past the natural landing point, which is the overshoot
 *    rule 1 exists to avoid.
 *
 * `current` is the target index from the previous frame, and it is what makes
 * rule 2 expressible. It is a PARAMETER rather than hidden state so this stays
 * a pure function that can be swept exhaustively; the drag session owns the
 * feedback loop and hands `s.to` back in. It defaults to `from`, which is the
 * state at pick-up.
 *
 * The returned index is into the list WITH THE DRAGGED ROW REMOVED, which is
 * the space `moveId()` splices into.
 *
 * `dy` MUST NOT BE CLAMPED. See the note in `paint()`.
 */
export function targetIndexFor(
  tops: readonly number[],
  heights: readonly number[],
  from: number,
  dy: number,
  current: number = from,
): number {
  const myHeight = heights[from] as number;
  const centre = (tops[from] as number) + myHeight / 2 + dy;
  let to = 0;

  for (let i = 0; i < heights.length; i++) {
    if (i === from) continue;
    const top = tops[i] as number;
    const height = heights[i] as number;
    const stick = STICK * Math.min(myHeight, height);

    // `up`: my top edge has reached row i's top edge. `down`: my bottom edge
    // has reached row i's bottom edge. Both are "row i is now fully covered,
    // or I have fully taken its slot", and each is monotone in `top`, so the
    // thresholds stay ordered row by row and the counted set stays a PREFIX —
    // which is what makes counting a valid index rather than a tally of
    // unrelated tests. The sweeps in test/reorder-target.test.js hold that.
    const up = top + myHeight / 2;
    const down = top + height - myHeight / 2;

    const rank = i < from ? i : i - 1;
    const isAbove = rank < current; // where this row sits right now
    const wasAbove = i < from; // where it sat before the gesture began

    let above: boolean;
    if (isAbove && wasAbove) above = centre >= up;
    else if (!isAbove && !wasAbove) above = centre > down;
    // A row that has already given way comes back only past the FURTHER of
    // the two edges plus `stick`. For a tall row passing a short one `down`
    // lies above `up`, so reusing the opposite edge alone would undo the swap
    // on the very next frame.
    else if (isAbove) above = centre >= Math.min(up, down) - stick;
    else above = centre > Math.max(up, down) + stick;
    if (above) to++;
  }
  return to;
}

/** Pure: `ids` with `id` moved to index `to`, clamped. */
export function moveId(ids: readonly string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids.slice();
  const next = ids.slice();
  next.splice(from, 1);
  const target = to < 0 ? 0 : to > next.length ? next.length : to;
  next.splice(target, 0, id);
  return next;
}

function rowsOf(list: HTMLElement): HTMLElement[] {
  return Array.from(list.children).filter(
    (node): node is HTMLElement =>
      node instanceof HTMLElement && node.hasAttribute('data-provider'),
  );
}

function idsOf(list: HTMLElement): string[] {
  return rowsOf(list).map((row) => row.getAttribute('data-provider') ?? '');
}

/**
 * "Claude 1. sıraya taşındı, 6 araç içinde." The top position is called out
 * separately because it is the one with a consequence outside the panel.
 */
function movedText(name: string, index: number, total: number): string {
  const base = t('reorder.moved', { name, position: index + 1, total });
  return index === 0 ? `${base} ${t('reorder.nowTray')}` : base;
}

interface Session {
  pointerId: number;
  grip: HTMLElement;
  row: HTMLElement;
  id: string;
  name: string;
  from: number;
  to: number;
  rows: HTMLElement[];
  tops: number[];
  heights: number[];
  startY: number;
  started: boolean;
  lastClientY: number;
  raf: number | null;
}

export function createReorder(host: ReorderHost): ReorderHandle {
  const detach: Array<() => void> = [];
  const wired = new WeakSet<HTMLElement>();

  let session: Session | null = null;
  /** Last time the live drag asserted the pointer is still inside. */
  let lastKeepAlive = 0;

  function isDragging(): boolean {
    return session !== null && session.started;
  }

  function contentY(clientY: number): number {
    return clientY - host.list.getBoundingClientRect().top;
  }

  function clearTransforms(s: Session): void {
    for (const row of s.rows) {
      row.style.transform = '';
      row.classList.remove('is-shifting');
    }
    s.row.classList.remove('is-dragging');
    host.list.removeAttribute('data-dragging');
  }

  function paint(s: Session, dy: number): void {
    const last = s.rows.length - 1;
    const span = s.tops[last] + s.heights[last] - s.tops[0];
    const min = s.tops[0] - s.tops[s.from];
    const max = s.tops[0] + span - s.heights[s.from] - s.tops[s.from];
    const clamped = dy < min ? min : dy > max ? max : dy;

    /**
     * THE INDEX COMES FROM THE RAW OFFSET; ONLY THE PIXELS ARE CLAMPED.
     *
     * The clamp exists so the dragged row never paints outside the list. It is
     * a rendering bound and it must not be a decision bound, because the two
     * ask different questions: "where do I draw this" and "which slot does the
     * user mean". Feeding the clamped value to the index conflates them, and
     * the arithmetic then makes the end slots unreachable.
     *
     * Concretely, on the fixture's own [64, 64]: `max` is 64, so the top row's
     * centre can reach 96 at most — exactly the second row's midpoint, and the
     * test is strict — so `to` could never leave 0 and row 0 could not be
     * dragged down at all. The same clamp cost the six-row shape its last slot
     * for five of six rows. Both were swept before this line was written.
     *
     * With the raw offset the count is monotone in `dy` and saturates at 0 and
     * at `rows.length - 1` on its own, because there are exactly that many
     * other midpoints to pass. No clamp is needed on the index, and adding one
     * would only reintroduce the same class of bug.
     */
    // `s.to` goes in as well as out: it is the previous frame's decision, and
    // it is what lets the threshold ask for more travel to UNDO a swap than it
    // asked for to make one. Without the feedback there is no hysteresis and a
    // pointer resting on a boundary flips a whole row height back and forth.
    const to = targetIndexFor(s.tops, s.heights, s.from, dy, s.to);
    s.to = to;

    for (let i = 0; i < s.rows.length; i++) {
      if (i === s.from) {
        s.rows[i].style.transform = `translateY(${clamped.toFixed(1)}px)`;
        continue;
      }
      // Everything between the origin and the target slides one row-height out
      // of the way. Heights differ (live 64px, passive 44px), so the shift is
      // always the DRAGGED row's height, never a constant.
      let shift = 0;
      if (to > s.from && i > s.from && i <= to) shift = -s.heights[s.from];
      else if (to < s.from && i >= to && i < s.from) shift = s.heights[s.from];
      s.rows[i].style.transform = shift === 0 ? '' : `translateY(${shift}px)`;
      s.rows[i].classList.toggle('is-shifting', shift !== 0);
    }
  }

  function autoScroll(): void {
    const s = session;
    if (!s || !s.started) return;

    // The gesture's heartbeat. It lives here rather than in `onPointerMove`
    // because a pointer that has stopped moving emits nothing, and a stopped
    // pointer one pixel outside the window is exactly the case that closed the
    // panel mid-drag.
    const now = Date.now();
    if (now - lastKeepAlive >= KEEPALIVE_MS) {
      lastKeepAlive = now;
      host.keepAlive();
    }

    const scroller = host.scroller;
    const rect = scroller.getBoundingClientRect();
    const overflow = scroller.scrollHeight - scroller.clientHeight;
    // The list runs on under the glass header (panel.css), so its visible top
    // is its box's top plus that inset, which it states as scroll-padding.
    const top = rect.top + scrollInsetTop(scroller);
    let step = 0;
    if (overflow > 1) {
      if (s.lastClientY < top + EDGE && scroller.scrollTop > 0) step = -EDGE_STEP;
      else if (s.lastClientY > rect.bottom - EDGE && scroller.scrollTop < overflow) {
        step = EDGE_STEP;
      }
    }
    if (step !== 0) {
      scroller.scrollTop += step;
      paint(s, contentY(s.lastClientY) - s.startY);
    }
    s.raf = requestAnimationFrame(autoScroll);
  }

  /**
   * Move/up/cancel are bound for the LIFE OF THE GESTURE and nowhere else, so
   * the document carries no listeners while the panel is idle.
   */
  function bindSession(bind: boolean): void {
    const fn = bind ? document.addEventListener : document.removeEventListener;
    fn.call(document, 'pointermove', onDocPointerMove, true);
    fn.call(document, 'pointerup', onDocPointerUp, true);
    fn.call(document, 'pointercancel', onDocPointerCancel, true);
  }

  function finish(commit: boolean): void {
    const s = session;
    if (!s) return;
    if (s.raf !== null) cancelAnimationFrame(s.raf);
    try {
      s.grip.releasePointerCapture(s.pointerId);
    } catch {
      /* the capture may already be gone */
    }
    bindSession(false);
    document.removeEventListener('keydown', onDragKey, true);

    const wasDragging = s.started;
    clearTransforms(s);
    session = null;

    if (!wasDragging) return;

    if (commit && s.to !== s.from) {
      const next = moveId(idsOf(host.list), s.id, s.to);
      host.commit(next);
      host.announce(movedText(s.name, s.to, next.length));
    } else if (!commit) {
      host.announce(t('reorder.cancelled', { name: s.name, position: s.from + 1 }));
    }
    host.onDragEnd();
  }

  function onDragKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // Swallow it: Esc during a drag aborts the drag, it does not close the
    // panel. The panel-level handler would otherwise dismiss the whole thing.
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  }

  function onPointerMove(event: PointerEvent): void {
    const s = session;
    if (!s || event.pointerId !== s.pointerId) return;
    s.lastClientY = event.clientY;
    const dy = contentY(event.clientY) - s.startY;

    if (!s.started) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return;
      s.started = true;
      s.row.classList.add('is-dragging');
      host.list.setAttribute('data-dragging', 'true');
      lastKeepAlive = Date.now();
      host.keepAlive();
      document.addEventListener('keydown', onDragKey, true);
      s.raf = requestAnimationFrame(autoScroll);
    }
    event.preventDefault();
    paint(s, dy);
  }

  function onPointerUp(event: PointerEvent): void {
    if (!session || event.pointerId !== session.pointerId) return;
    finish(true);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (!session || event.pointerId !== session.pointerId) return;
    finish(false);
  }

  const onDocPointerMove = (event: Event): void => onPointerMove(event as PointerEvent);
  const onDocPointerUp = (event: Event): void => onPointerUp(event as PointerEvent);
  const onDocPointerCancel = (event: Event): void => onPointerCancel(event as PointerEvent);

  function onPointerDown(event: PointerEvent, grip: HTMLElement, id: string, name: string): void {
    if (session) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!host.enabled()) return;

    const row = grip.closest('li');
    if (!(row instanceof HTMLElement)) return;
    const rows = rowsOf(host.list);
    const from = rows.indexOf(row);
    if (from < 0 || rows.length < 2) return;

    // A press inside the panel means the pointer is inside the panel. Say so
    // before anything else, so a hide scheduled while the pointer was still
    // travelling from the tray cannot land in the middle of the gesture.
    host.keepAlive();

    const listTop = host.list.getBoundingClientRect().top;
    const tops: number[] = [];
    const heights: number[] = [];
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      tops.push(rect.top - listTop);
      heights.push(rect.height);
    }

    const next: Session = {
      pointerId: event.pointerId,
      grip,
      row,
      id,
      name,
      from,
      to: from,
      rows,
      tops,
      heights,
      startY: contentY(event.clientY),
      started: false,
      lastClientY: event.clientY,
      raf: null,
    };

    // Requested, not depended on. It is what keeps the cursor from turning
    // into a text caret over other elements mid-drag; the document listeners
    // below are what actually delivers the gesture.
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      /* not fatal: the document listeners do not need it */
    }
    session = next;
    bindSession(true);
  }

  // --- keyboard ----------------------------------------------------------

  function onGripKeyDown(event: KeyboardEvent, id: string, name: string): void {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const ids = idsOf(host.list);
    const from = ids.indexOf(id);
    if (from < 0) return;

    let to: number;
    if (event.key === 'ArrowUp') to = from - 1;
    else if (event.key === 'ArrowDown') to = from + 1;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = ids.length - 1;
    else return;

    event.preventDefault();
    event.stopPropagation();

    if (!host.enabled()) {
      host.announce(t('reorder.unavailable'));
      return;
    }
    if (to < 0) {
      host.announce(t('reorder.atTop', { name }));
      return;
    }
    if (to > ids.length - 1) {
      host.announce(t('reorder.atBottom', { name }));
      return;
    }
    if (to === from) return;

    host.keepAlive();
    host.commit(moveId(ids, id, to));
    host.announce(movedText(name, to, ids.length));
  }

  function attach(grip: HTMLElement, providerId: string, displayName: string): void {
    // Display names change between snapshots; keep the closures reading the
    // newest one rather than the one captured at first render.
    grip.dataset.reorderName = displayName;
    if (wired.has(grip)) return;
    wired.add(grip);

    const name = (): string => grip.dataset.reorderName ?? displayName;

    const down = (event: Event): void =>
      onPointerDown(event as PointerEvent, grip, providerId, name());
    const key = (event: Event): void => onGripKeyDown(event as KeyboardEvent, providerId, name());
    // A drag that ends over the grip would otherwise fire a click as well.
    const click = (event: Event): void => {
      if (session) event.preventDefault();
    };

    // Only the gesture's START is the grip's business. Everything after it is
    // bound on the document for the life of the session (see bindSession).
    grip.addEventListener('pointerdown', down);
    grip.addEventListener('keydown', key);
    grip.addEventListener('click', click);

    detach.push(() => {
      grip.removeEventListener('pointerdown', down);
      grip.removeEventListener('keydown', key);
      grip.removeEventListener('click', click);
    });
  }

  return {
    attach,
    isDragging,
    destroy(): void {
      finish(false);
      for (const off of detach) off();
      detach.length = 0;
    },
  };
}
