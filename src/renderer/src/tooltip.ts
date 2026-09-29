/**
 * The panel's tooltips (UI plan 2026-09-29): 400 ms after the pointer settles
 * on something, immediately when the keyboard lands on it, and gone on leave,
 * blur or Esc.
 *
 * WHY NOT THE NATIVE `title`
 * --------------------------
 * The native tooltip's delay is the OS's, not ours, it never appears for a
 * keyboard user, and on this transparent always-on-top window it can paint
 * behind the panel. So every `title` the components write stays the SOURCE of
 * the text — they keep calling setAttr(el, 'title', …) exactly as before — and
 * this module lifts it into its own bubble at show time. The attribute is
 * moved to `data-tip` so the native one does not appear on top of ours, and
 * the text is kept in the accessibility tree as `aria-description` unless the
 * element already has a described-by, which outranks it anyway.
 *
 * Text only: the bubble's content is set with textContent, never markup.
 */

const HOVER_DELAY_MS = 400;
const GAP = 6;
const EDGE = 8;

/** Move a `title` into `data-tip` (and the accessibility tree), returning the text. */
function takeTitle(target: Element): string | null {
  const title = target.getAttribute('title');
  if (title !== null) {
    target.removeAttribute('title');
    if (title.trim() === '') {
      target.removeAttribute('data-tip');
      return null;
    }
    target.setAttribute('data-tip', title);
    if (!target.hasAttribute('aria-describedby') && !target.hasAttribute('aria-label')) {
      target.setAttribute('aria-description', title);
    }
    return title;
  }
  return target.getAttribute('data-tip');
}

function tipTarget(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) return null;
  return node.closest('[title], [data-tip]');
}

export function installTooltips(doc: Document = document): () => void {
  const bubble = doc.createElement('div');
  bubble.className = 'tip';
  bubble.setAttribute('role', 'tooltip');
  bubble.setAttribute('aria-hidden', 'true');
  bubble.hidden = true;
  doc.body.appendChild(bubble);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let shownFor: Element | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function hide(): void {
    clearTimer();
    bubble.hidden = true;
    shownFor = null;
  }

  function show(target: Element): void {
    const text = takeTitle(target);
    if (!text || !target.isConnected) {
      hide();
      return;
    }
    bubble.textContent = text;
    bubble.hidden = false;
    shownFor = target;
    const r = target.getBoundingClientRect();
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    let left = Math.round(r.left + r.width / 2 - w / 2);
    left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
    // Below when it fits, above otherwise: the panel usually sits on the
    // taskbar, so the space is above.
    let top = r.bottom + GAP;
    if (top + h > vh - EDGE) top = r.top - GAP - h;
    top = Math.max(EDGE, top);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  }

  function onOver(event: Event): void {
    const target = tipTarget(event.target);
    if (!target || target === shownFor) return;
    // Lift the title now, so the native tooltip never starts its own timer.
    takeTitle(target);
    hide();
    timer = setTimeout(() => {
      timer = null;
      show(target);
    }, HOVER_DELAY_MS);
  }

  function onOut(event: Event): void {
    const target = tipTarget(event.target);
    const to = (event as MouseEvent).relatedTarget;
    if (target && to instanceof Node && target.contains(to)) return;
    hide();
  }

  function onFocusIn(event: Event): void {
    const target = tipTarget(event.target);
    if (!target) return;
    // The keyboard gets it at once; a click that focuses a control does not.
    let keyboard = false;
    try {
      keyboard = (event.target as Element).matches(':focus-visible');
    } catch {
      keyboard = false;
    }
    if (keyboard) show(target);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !bubble.hidden) hide();
  }

  doc.addEventListener('pointerover', onOver, true);
  doc.addEventListener('pointerout', onOut, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', hide, true);
  doc.addEventListener('pointerdown', hide, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('scroll', hide, true);

  return () => {
    hide();
    doc.removeEventListener('pointerover', onOver, true);
    doc.removeEventListener('pointerout', onOut, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', hide, true);
    doc.removeEventListener('pointerdown', hide, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('scroll', hide, true);
    bubble.remove();
  };
}
