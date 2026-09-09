/**
 * The panel shell: header band, one ordered row list, footer.
 *
 * Rows are reconciled by provider id rather than rebuilt, so the meter keeps
 * its element across snapshots and the 400ms fill transition actually has
 * something to transition from. Rebuilding the list would make every update
 * look like a first paint.
 *
 * ONE LIST, NOT TWO
 * -----------------
 * Connected and passive rows used to live in separate sections under a
 * "Henüz bağlı değil" label. They now share a single list, in the order main
 * sends. Three reasons, all forced by reordering:
 *   1. The contract says `providers[0]` drives the tray icon and the user's
 *      model of that is "the row at the top of the panel". With two sections
 *      those are different objects, and a disconnected provider sitting at
 *      index 0 would show at the BOTTOM while owning the tray.
 *   2. Passive rows are draggable too, so they have to share one position
 *      space; "3 of 4" has to mean one thing.
 *   3. Two lists means two drop targets with different semantics and two live
 *      regions. One list has one set of positions and one announcement.
 * The grouping information is not lost: an unconnected row has a monochrome
 * mark, no tile, no meter, and its own "bağlı değil" explanation.
 */

import type { ProviderSnapshot, ThemeChoice } from '../../../shared/contract.js';
import { defaultPlacement, placePanel, type PanelPlacement } from '../anchor.js';
import { el, on, setAttr, setText, svg } from '../dom.js';
import { clockTime, integer } from '../format.js';
import { createReorder, type ReorderHandle } from '../reorder.js';
import { enabledOf, type PanelState, type PanelView } from '../store.js';
import { createHeader, type HeaderHandle } from './header.js';
import { createSettings, type SettingsHandle } from './settings.js';
import {
  createRow,
  createSkeletonRow,
  REORDER_HELP_ID,
  type RowContext,
  type RowHandle,
} from './row.js';

/** Placeholder rows shown before the first snapshot lands. Enough to fill the
 *  panel without pretending to know how many tools this machine has. */
const SKELETON_ROWS = 3;

/**
 * `attachGrip` and `isTrayRow` are supplied by the panel itself, not the app:
 * only the panel knows which element ended up first and which reorder
 * controller owns the list.
 */
export interface PanelContext extends Omit<RowContext, 'attachGrip' | 'isTrayRow'> {
  onPinToggle(pinned: boolean): void;
  onClose(): void;
  onRefresh(): void;
  /** Swap between the usage list and the settings view. */
  onSettingsToggle(): void;
  /** Add a provider to the main panel, or remove it. */
  onToggleProvider(providerId: string, enabled: boolean): void;
  /** The user picked a theme in settings. */
  onThemeChange(theme: ThemeChoice): void;
  onConsentConfirm(): void;
  onConsentCancel(): void;
  /** User asked for a new order. The app persists it and owns the revert. */
  onReorder(ids: readonly string[]): void;
  /** Cancels main's pending auto-hide. Called whenever the pointer is inside
   *  the panel, and again at the start of every drag. */
  onKeepAlive(): void;
  /** The user closed the notice. Clears `state.notice`; see the notice block
   *  below for why the offline banner never reaches this. */
  onNoticeDismiss(): void;
}

export interface PanelHandle {
  /** The positioned wrapper. This is what gets appended and what animates. */
  el: HTMLElement;
  render(state: PanelState, now: number): void;
  tick(state: PanelState, now: number): void;
  setOpen(open: boolean): void;
  enableAnimation(): void;
  focus(): void;
  /** Put focus somewhere sensible for the view that just became current. */
  focusView(view: PanelView): void;
  /** Re-place the panel against the newest tray geometry. */
  applyAnchor(state: PanelState): void;
  /** Measured panel size in CSS px, for the canvas-fit check. */
  measure(): { width: number; height: number };
  /** Tears down the reorder listeners and removes the element. */
  destroy(): void;
}

/** The tail glyph. Drawn open at the top so the stroke never crosses the
 *  panel border it joins. */
function tailGlyph(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 8', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', {
      d: 'M0 0.5 L8 7.4 L16 0.5',
      fill: 'var(--ink-900)',
      stroke: 'var(--ink-700)',
      'stroke-width': '1',
      'stroke-linejoin': 'round',
    }),
  );
}

/**
 * The notice's close cross. Same geometry and stroke as the header's close
 * (components/header.ts) so the two read as one control at two sizes, drawn
 * at 12/16 of the viewBox because this one sits inside a text box rather than
 * a control strip.
 */
function noticeCloseIcon(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', {
      d: 'M5 5l6 6M11 5l-6 6',
      stroke: 'currentColor',
      'stroke-width': '1.4',
      'stroke-linecap': 'round',
    }),
  );
}

export function createPanel(ctx: PanelContext): PanelHandle {
  const rows = new Map<string, RowHandle>();

  const header: HeaderHandle = createHeader({
    onPinToggle: ctx.onPinToggle,
    onClose: ctx.onClose,
    onSettingsToggle: () => ctx.onSettingsToggle(),
  });

  const settings: SettingsHandle = createSettings({
    onToggle: (id, enabled) => ctx.onToggleProvider(id, enabled),
    onTheme: (theme) => ctx.onThemeChange(theme),
    onBack: () => ctx.onSettingsToggle(),
  });

  const rowList = el('ul', {
    class: 'rows',
    role: 'list',
    'aria-label': 'Araçlar, tepsi sırasına göre',
  });

  const skeletonList = el('ul', {
    class: 'rows',
    role: 'list',
    'aria-label': 'Araçlar taranıyor',
    'aria-busy': 'true',
  });
  for (let i = 0; i < SKELETON_ROWS; i++) skeletonList.appendChild(createSkeletonRow());
  skeletonList.hidden = true;

  /**
   * The empty state, spelled out.
   *
   * A blank list is the no-data-versus-zero collision: "we found nothing on
   * this machine" and "you removed every row" look identical, and one of them
   * has an obvious fix. So the box always says WHICH it is, and when the fix
   * is in settings it offers the way there rather than describing it.
   */
  const emptyTitle = el('strong', { class: 'empty__title' }, '');
  const emptyDetail = el('span', { class: 'empty__detail' }, '');
  const emptyAction = el(
    'button',
    { type: 'button', class: 'btn btn--primary' },
    'Ayarları aç',
  ) as HTMLButtonElement;
  on(emptyAction, 'click', () => ctx.onSettingsToggle());
  const emptyState = el('div', { class: 'empty' }, emptyTitle, emptyDetail, emptyAction);
  emptyState.hidden = true;

  // Every grip points at this with aria-describedby, so the keyboard path is
  // announced by the control that offers it rather than hidden in a tooltip.
  const reorderHelp = el(
    'p',
    { class: 'u-sr', id: REORDER_HELP_ID },
    'Sırayı değiştirmek için sürükleyin ya da Alt tuşuyla yukarı ve aşağı ok ' +
      'tuşlarını kullanın. Alt ve Home en üste taşır. En üstteki aracın beş ' +
      'saatlik penceresi tepsi simgesine çizilir.',
  );

  // Moves are announced here, politely, with the resulting position. A drag
  // announces once, on drop; the keyboard path announces on every move.
  // Classed, not anonymous: the header now carries a second polite status
  // region (the freshness marker), and a bare [role=status] selector — in a
  // test or in a future component — would find whichever comes first in the
  // document. Two regions is the right ARIA here, one per concern; what is
  // wrong is two regions that cannot be told apart.
  const liveRegion = el('p', {
    class: 'u-sr rows__live',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });

  const listBand = el(
    'div',
    { class: 'panel__band panel__band--list' },
    el('hr', { class: 'rule' }),
    reorderHelp,
    skeletonList,
    rowList,
    emptyState,
    settings.el,
  );
  listBand.style.setProperty('--band-delay', '40ms');

  /**
   * The notice, and its close control.
   *
   * WHY THE BUTTON IS OUTSIDE THE LIVE REGION
   * -----------------------------------------
   * `role="status"` is a live region: assistive technology re-reads its
   * contents whenever they change. The whole box used to BE that region, so
   * putting the button inside it would have made every message — a reorder
   * failure, a theme failure, a setup result — announce itself with
   * "Bu bildirimi kapat, düğme" tacked on the end. Worse, the region's content
   * is replaced on every render, and a focused control inside a node whose
   * text is being rewritten is the classic way to drop focus to <body>.
   *
   * So the region shrank to the paragraph. The wrapper is a plain <div> with
   * no role, the text is the only thing announced, and the button is a sibling
   * that is never part of the announcement and is never rewritten.
   *
   * WHY THE OFFLINE BANNER HAS NO BUTTON
   * ------------------------------------
   * Two different things share this box. `state.notice` is an OUTCOME — a
   * thing that happened once and is over — and clearing it loses nothing. The
   * bridge-unavailable line is a live CONDITION: it is true for as long as it
   * is on screen, and the panel is showing values it cannot refresh the whole
   * time. There is no store field to clear, and inventing a dismissed-flag for
   * it would let the user hide a fact that is still true. So the control is
   * present exactly when pressing it would do something, which is also the
   * only honest reading of a close button.
   *
   * NO Esc BINDING. Esc already unwinds consent -> settings -> close the panel
   * (app.ts onKeyDown). A notice appears after almost every action, so binding
   * Esc here would mean "Esc closes the panel" silently stops working at
   * exactly the moment the user is most likely to press it. The notice is not
   * modal, takes no focus and blocks nothing, so it has no claim on the key.
   */
  const noticeText = el('p', { class: 'notice__text', role: 'status' }, '');
  const noticeClose = el('button', {
    type: 'button',
    // Same 24px icon button as the header controls, one step quieter: the
    // message is the point and the control must not compete with it.
    class: 'iconbtn notice__close',
    // The glyph is drawn and aria-hidden, so the button would otherwise have
    // no accessible name at all.
    'aria-label': 'Bu bildirimi kapat',
    title: 'Bu bildirimi kapat',
  }) as HTMLButtonElement;
  noticeClose.appendChild(noticeCloseIcon());
  const notice = el('div', { class: 'notice' }, noticeText, noticeClose);
  notice.hidden = true;

  // --- consent prompt ----------------------------------------------------
  // Installing the statusline bridge writes into the user's Claude Code
  // settings. It is never sent to main until this is confirmed, and the
  // explanation is shown BEFORE the affirmative control, not after it.
  const consentTitle = el('strong', { class: 'consent__title', id: 'consent-title' }, '');
  const consentDetail = el('span', { class: 'consent__detail', id: 'consent-detail' }, '');
  const consentCancel = el(
    'button',
    { type: 'button', class: 'btn' },
    'Vazgeç',
  ) as HTMLButtonElement;
  const consentConfirm = el(
    'button',
    { type: 'button', class: 'btn btn--primary' },
    'Onayla',
  ) as HTMLButtonElement;
  on(consentCancel, 'click', () => ctx.onConsentCancel());
  on(consentConfirm, 'click', () => ctx.onConsentConfirm());

  const consentBox = el(
    'div',
    {
      class: 'consent',
      role: 'group',
      'aria-labelledby': 'consent-title',
      'aria-describedby': 'consent-detail',
    },
    consentTitle,
    consentDetail,
    el('div', { class: 'consent__actions' }, consentCancel, consentConfirm),
  );
  consentBox.hidden = true;

  const scanText = el('span', {}, '');
  /**
   * The pin promise, in words, in the one place the user is already reading
   * small print. The icon carries it too, but "this window disappears when my
   * mouse leaves" is a surprising rule to infer from a 14px glyph, and it is
   * now the DEFAULT state after a tray click.
   */
  const modeText = el('span', { class: 'foot__mode' }, '');
  const refreshButton = el(
    'button',
    { type: 'button', class: 'btn', 'aria-label': 'Şimdi yenile' },
    'Yenile',
  ) as HTMLButtonElement;
  on(refreshButton, 'click', () => ctx.onRefresh());

  /**
   * First-run coaching for the tray icon, shown only when we KNOW we are not
   * pointing at one: `anchorSource: 'cursor'` means main could not measure a
   * plausible tray rect, and on Windows 11 that is most often the hidden-icons
   * overflow flyout. It matters more now that hover no longer opens anything —
   * a click target the user cannot find is worse than a hover target they
   * stumble onto.
   */
  const coachDismiss = el(
    'button',
    { type: 'button', class: 'btn', 'aria-label': 'Bu ipucunu kapat' },
    'Anladım',
  ) as HTMLButtonElement;
  const coach = el(
    'div',
    { class: 'coach', role: 'note' },
    el(
      'span',
      { class: 'coach__text' },
      'Tepsi simgesi gizli simgeler alanında olabilir: görev çubuğundaki ' +
        'ok işaretini açıp simgeyi dışarı sürükleyin. ' +
        'Panel artık üzerine gelince değil, tıklayınca açılır.',
    ),
    el('div', { class: 'coach__actions' }, coachDismiss),
  );
  coach.hidden = true;
  let coachDismissed = false;
  on(coachDismiss, 'click', () => {
    coachDismissed = true;
    coach.hidden = true;
  });

  const footBand = el(
    'div',
    { class: 'panel__band' },
    coach,
    consentBox,
    notice,
    liveRegion,
    el(
      'div',
      { class: 'foot' },
      scanText,
      el('span', { class: 'foot__spacer' }),
      modeText,
      refreshButton,
    ),
  );
  footBand.style.setProperty('--band-delay', '80ms');

  const root = el(
    'div',
    {
      class: 'panel',
      lang: 'tr',
      role: 'dialog',
      'aria-label': 'Kullanım paneli',
      'data-open': 'false',
      tabindex: '-1',
    },
    header.el,
    listBand,
    footBand,
  );

  // The tail must sit outside the panel's overflow clip, so the panel and the
  // tail share a positioned wrapper and it is the wrapper that transforms.
  const tail = el('span', { class: 'panel__tail', 'aria-hidden': 'true' }, tailGlyph());
  const anchorEl = el('div', { class: 'anchor', 'data-open': 'false' }, root, tail);

  /**
   * Dismissal, and where focus goes afterwards.
   *
   * The control removes itself: `ctx.onNoticeDismiss()` clears the store,
   * which re-renders synchronously (store.ts `set` calls its listeners inline)
   * and hides this whole box. A focused element inside a `hidden` subtree is
   * blurred by the browser, and focus lands on <body> — outside the dialog,
   * with no visible ring and no tab position, so the next Tab restarts from
   * the top of the document. The panel already treats focus survival as
   * load-bearing (the render suite pins focus surviving a row move), so this
   * puts focus on the panel itself: it is `tabindex="-1"`, it is the dialog,
   * and tabbing on from it continues inside the panel.
   *
   * Guarded on `contains`, because a mouse user never had focus in here and
   * yanking it to the dialog root would be a change they did not ask for.
   */
  on(noticeClose, 'click', () => {
    const hadFocus = notice.contains(document.activeElement);
    ctx.onNoticeDismiss();
    if (hadFocus) root.focus({ preventScroll: true });
  });

  let lastPlacementKey = '';
  let lastConsentId: string | null = null;
  /** Newest state, so a drag ending can re-render without the app pushing. */
  let lastState: PanelState | null = null;
  let lastNow = Date.now();

  const reorder: ReorderHandle = createReorder({
    list: rowList,
    scroller: listBand,
    // The list only holds ADDED providers now, so what the drag produces is a
    // subset. Persisting that subset would tell main the un-added providers no
    // longer exist. expandOrder() puts it back into a full order first.
    commit: (ids) => ctx.onReorder(expandOrder(ids)),
    announce: (text) => {
      // Re-announce identical text by clearing first; a screen reader ignores
      // a live region whose content did not change, and two moves in a row can
      // legitimately produce the same sentence.
      setText(liveRegion, '');
      setText(liveRegion, text);
    },
    keepAlive: () => keepAlive(true),
    onDragEnd: () => {
      if (lastState) render(lastState, lastNow);
    },
    enabled: () => (lastState ? lastState.bridgeAvailable : false),
  });

  /** Provider id currently at index 0, i.e. the one main draws the tray from. */
  let trayRowId: string | null = null;

  // The context the rows actually see. Getters, not a spread: the app mutates
  // `generatedAt` and `staleOverride` on its own object between renders, and a
  // copy would freeze the values a row reads for its "as of" line.
  const rowCtx: RowContext = {
    onRetry: (id) => ctx.onRetry(id),
    onSetup: (id) => ctx.onSetup(id),
    isBusy: (id) => ctx.isBusy(id),
    attachGrip: (grip, id, name) => reorder.attach(grip, id, name),
    isTrayRow: (id) => id === trayRowId,
    get generatedAt(): string | null {
      return ctx.generatedAt;
    },
    get staleOverride(): boolean {
      return ctx.staleOverride;
    },
  };

  /**
   * "The pointer is inside the panel."
   *
   * NOT the leave detector. Main polls the OS for the cursor position every
   * 250ms and measures it against the window rect, because these events fire
   * on movement only: a hand resting still inside the panel emits nothing, and
   * a design that timed out on this signal would have closed the panel under
   * it — the over-eager dismissal this whole change exists to remove.
   *
   * It is kept as a tighter second signal (it lands the instant the pointer
   * arrives, ahead of the next poll) and as the "the panel is being used" hint
   * that raises main's refresh cadence. Nothing here may assume it is the
   * mechanism holding the panel open. Throttled, because it is an IPC send.
   */
  let lastKeepAlive = 0;
  function keepAlive(force: boolean): void {
    const now = Date.now();
    if (!force && now - lastKeepAlive < 400) return;
    lastKeepAlive = now;
    ctx.onKeepAlive();
  }
  on(anchorEl, 'pointerenter', () => keepAlive(true));
  on(anchorEl, 'pointermove', () => keepAlive(false));
  on(anchorEl, 'pointerdown', () => keepAlive(true));

  function applyPlacement(placement: PanelPlacement): void {
    anchorEl.style.left = `${placement.left}px`;
    anchorEl.style.top = placement.top === null ? '' : `${placement.top}px`;
    anchorEl.style.bottom = placement.bottom === null ? '' : `${placement.bottom}px`;
    anchorEl.style.transformOrigin = placement.origin;
    anchorEl.style.setProperty('--tail-offset', `${placement.tailOffset}px`);
    setAttr(anchorEl, 'data-tail', placement.tailSide);
    setAttr(anchorEl, 'data-axis', placement.axis);
    setAttr(anchorEl, 'data-mode', placement.mode);
    setAttr(anchorEl, 'data-tail-clamped', placement.tailClamped ? 'true' : null);
    setAttr(anchorEl, 'data-anchor-source', placement.anchorSource);
  }

  function applyAnchor(state: PanelState): void {
    // The OS window cannot grow, so the row list — not the panel — absorbs any
    // excess. Without this a machine with many providers silently clips its
    // last row, which is the one failure the user would never notice.
    const canvasHeight = state.anchor
      ? state.anchor.window.height
      : document.documentElement.clientHeight;
    const chrome = header.el.offsetHeight + footBand.offsetHeight;
    const budget = canvasHeight - chrome - 2 * 12 - 8 - 2;
    listBand.style.setProperty('--list-max', `${Math.max(120, budget)}px`);

    const size = { width: root.offsetWidth || 360, height: root.offsetHeight || 0 };
    const placement = state.anchor
      ? placePanel(state.anchor, size)
      : defaultPlacement({
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        });

    // Placement is re-applied on every render because the panel's height
    // changes with its content, but writing identical styles every second
    // would defeat the compositor. Key on the values that actually move.
    const key = [
      placement.left,
      placement.top,
      placement.bottom,
      placement.tailOffset,
      placement.tailSide,
      placement.axis,
      placement.mode,
      placement.tailClamped,
      placement.anchorSource,
    ].join('|');
    if (key === lastPlacementKey) return;
    lastPlacementKey = key;
    applyPlacement(placement);
  }

  function syncList(list: HTMLElement, providers: readonly ProviderSnapshot[], now: number): void {
    // `insertBefore` on an element that contains the focused node detaches it
    // for an instant, and Chromium drops focus to <body> when it does. That is
    // fatal for the keyboard path: after one Alt+ArrowUp the grip is gone from
    // under the user and the second press goes nowhere. Verified in Electron —
    // this is not defensive coding, it is a bug that was there.
    const active = document.activeElement;
    const refocus = active instanceof HTMLElement && list.contains(active) ? active : null;

    let cursor = list.firstElementChild;
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      let handle = rows.get(provider.id);
      if (handle) {
        handle.update(provider, rowCtx, now);
      } else {
        handle = createRow(provider, rowCtx, now);
        rows.set(provider.id, handle);
      }
      // Position is stated, not implied by DOM order alone: a reorderable list
      // is exactly where a screen reader needs "3 of 6" spoken.
      setAttr(handle.el, 'aria-posinset', String(i + 1));
      setAttr(handle.el, 'aria-setsize', String(providers.length));
      if (handle.el === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        list.insertBefore(handle.el, cursor);
      }
    }
    // Anything left after the cursor is gone from the snapshot.
    while (cursor) {
      const next = cursor.nextElementSibling;
      list.removeChild(cursor);
      cursor = next;
    }

    if (refocus && document.activeElement !== refocus && list.contains(refocus)) {
      refocus.focus({ preventScroll: true });
      // The row may have moved out of the scrolled viewport; bring it back
      // without yanking the whole panel around.
      refocus.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * The order the panel actually draws.
   *
   * `Snapshot.providers` is already in user order and is NEVER re-sorted here.
   * The one exception is `state.order`: the user's own pending move, held by
   * the app between the gesture and main's next snapshot. It is applied only
   * when it names exactly the same set of providers, so a stale override can
   * never drop or duplicate a row.
   */
  /**
   * Turn the visible (added-only) order a drag produced back into a full one.
   *
   * Un-added providers keep their absolute positions and the added ones fill
   * the slots they already occupied, in their new relative order. That is the
   * only expansion that leaves `Snapshot.providers` a permutation of itself —
   * anything else would either drop rows the user cannot see or move rows the
   * user did not touch.
   */
  function expandOrder(visible: readonly string[]): readonly string[] {
    const all = (lastState ? ordered(lastState) : []).map((p) => p.id as string);
    const moving = new Set(visible);
    const slots = all.filter((id) => moving.has(id));
    // A mismatch means the list and the snapshot have drifted apart; send the
    // order we are actually drawing rather than a guess built from both.
    if (all.length === 0 || slots.length !== visible.length) return all;
    let k = 0;
    return all.map((id) => (moving.has(id) ? (visible[k++] as string) : id));
  }

  /**
   * What the main panel actually draws: user order, added rows only.
   *
   * The ONE place the enabled filter is applied. Everything that needs the
   * lead row — the list and the tray marker — reads it from here rather than
   * re-deriving it, so the surfaces cannot disagree about which provider they
   * are describing.
   */
  function visibleOf(state: PanelState): readonly ProviderSnapshot[] {
    return ordered(state).filter((provider) => enabledOf(state, provider));
  }

  function ordered(state: PanelState): readonly ProviderSnapshot[] {
    const providers = state.snapshot?.providers ?? [];
    const order = state.order;
    if (!order || order.length !== providers.length) return providers;
    const byId = new Map(providers.map((p) => [p.id as string, p]));
    const out: ProviderSnapshot[] = [];
    for (const id of order) {
      const provider = byId.get(id);
      if (!provider) return providers;
      out.push(provider);
    }
    return out;
  }

  function render(state: PanelState, now: number): void {
    lastState = state;
    lastNow = now;

    const inSettings = state.view === 'settings';
    const all = ordered(state);
    // The main list shows only what the user ADDED. Settings still sees every
    // provider, which is why the snapshot carries them all.
    const providers = visibleOf(state);
    // The contract puts the tray icon on the first ENABLED provider, not on
    // providers[0]: an un-added provider must never drive an icon whose row
    // the user cannot see.
    trayRowId = providers.length > 0 ? providers[0].id : null;

    // The header no longer describes the lead row — the readout that did was
    // redundant with the window blocks below it and was removed. What is left
    // is the freshness marker and the controls, neither of which depends on
    // which provider is first.
    header.update(state, now);

    // A drag owns the list's MEMBERSHIP as well as its geometry.
    //
    // Every row carries a transform keyed to positions measured at
    // pointerdown, so nothing may be added, removed or re-ordered until the
    // gesture ends. The prune below used to run unconditionally, which was
    // harmless while the set only changed when main dropped a provider
    // outright — but the enabled filter made a row disappear on a settings
    // toggle, and pruning then tore the dragged element out from under the
    // pointer: the element loses pointer capture, so `pointerup` never reaches
    // it, the session never ends, the surviving rows stay stuck under stale
    // transforms, and the drag's capture-phase Escape handler stays installed
    // and swallows every later Esc. Row CONTENT still updates; only the set is
    // frozen, and the drop's own re-render applies the removal a moment later.
    if (reorder.isDragging()) {
      for (const provider of providers) rows.get(provider.id)?.update(provider, rowCtx, now);
    } else {
      // Drop handles for providers that are no longer drawn, so the map cannot
      // grow. `enabled` is a reason to stop drawing a row, exactly like a
      // provider vanishing from the snapshot.
      const alive = new Set<string>(providers.map((p) => p.id));
      for (const [id, handle] of rows) {
        if (!alive.has(id)) {
          handle.el.remove();
          rows.delete(id);
        }
      }
      syncList(rowList, providers, now);
    }

    // Before the first snapshot lands the panel is not blank and it does not
    // wait: it shows the final geometry so nothing moves when data arrives.
    skeletonList.hidden = state.hasData || inSettings;
    rowList.hidden = !state.hasData || inSettings || providers.length === 0;
    emptyState.hidden = !state.hasData || inSettings || providers.length > 0;
    reorderHelp.hidden = inSettings;
    settings.el.hidden = !inSettings;
    setAttr(root, 'data-view', state.view);
    if (inSettings) settings.render(state, all);

    if (!emptyState.hidden) {
      // Two different absences, never one blank panel. Only the second has a
      // fix, and it is one control away.
      const nothingKnown = all.length === 0;
      setText(
        emptyTitle,
        nothingKnown
          ? 'Bu makinede tanınan bir yapay zekâ aracı bulunamadı.'
          : 'Ana panelde hiç araç yok.',
      );
      setText(
        emptyDetail,
        nothingKnown
          ? 'Desteklenen bir araç kurduğunuzda burada görünür.'
          : `Tanınan ${integer(all.length)} aracın hiçbiri eklenmemiş. ` +
              'Ayarlardan istediklerinizi ekleyebilirsiniz.',
      );
      emptyAction.hidden = nothingKnown;
    }

    // `dismissible` is the whole difference between the two messages that
    // share this box: an outcome the store owns, versus a live condition it
    // does not. See the notice block above.
    if (!state.bridgeAvailable) {
      notice.hidden = false;
      noticeClose.hidden = true;
      setText(
        noticeText,
        'Arka plan servisine bağlanılamadı. Ekrandaki değerler güncellenmiyor.',
      );
    } else if (state.notice) {
      notice.hidden = false;
      noticeClose.hidden = false;
      setText(noticeText, state.notice);
    } else {
      notice.hidden = true;
      noticeClose.hidden = true;
      setText(noticeText, '');
    }

    // --- consent prompt ---
    const consent = state.consent;
    consentBox.hidden = consent === null;
    if (consent) {
      setText(consentTitle, `${consent.providerName}: ${consent.label}`);
      setText(consentDetail, consent.detail);
      setText(consentConfirm, consent.label);
      setAttr(consentConfirm, 'aria-label', `${consent.providerName}: ${consent.label} — onayla`);
    }

    refreshButton.disabled = state.refreshing || !state.bridgeAvailable;
    setText(refreshButton, state.refreshing ? 'Yenileniyor' : 'Yenile');

    const generatedAt = state.snapshot?.generatedAt ?? null;
    setText(scanText, generatedAt ? `Son tarama ${clockTime(generatedAt)}` : 'Henüz tarama yok');

    // The same promise the pin button makes, written out.
    setText(
      modeText,
      state.pinned ? 'ekranda kalıyor' : 'imleç ayrılınca kapanır',
    );
    setAttr(
      modeText,
      'title',
      state.pinned
        ? 'Panel sabitlendi: başka bir uygulamaya geçseniz de açık kalır.'
        : 'Panel sabit değil: imleç panelden ayrılınca kapanır. ' +
            'Başlıktaki raptiye düğmesi ekranda tutar.',
    );

    // Only when we know we are NOT pointing at a measured tray icon.
    coach.hidden = coachDismissed || state.anchor?.anchorSource !== 'cursor';

    // Moving focus onto the affirmative control would be a trap for anyone
    // pressing Enter twice; focus the cancel side and let them choose.
    if (state.consent && lastConsentId !== state.consent.providerId) {
      lastConsentId = state.consent.providerId;
      consentCancel.focus({ preventScroll: true });
    } else if (!state.consent) {
      lastConsentId = null;
    }

    // Content just changed, so the panel's height did too. Re-place last —
    // except mid-drag, where moving the whole panel under a captured pointer
    // would shift every row the user is aiming at.
    if (!reorder.isDragging()) applyAnchor(state);
  }

  function tick(state: PanelState, now: number): void {
    header.tick(state, now);
    for (const handle of rows.values()) handle.tick(now);
  }

  return {
    el: anchorEl,
    render,
    tick,
    applyAnchor,
    measure: () => ({ width: root.offsetWidth, height: root.offsetHeight }),
    setOpen(open: boolean): void {
      // data-open lives on both: the wrapper drives the transform, the panel
      // drives the band stagger and the fill-transition gate.
      setAttr(root, 'data-open', open ? 'true' : 'false');
      setAttr(anchorEl, 'data-open', open ? 'true' : 'false');
      setAttr(root, 'aria-hidden', open ? null : 'true');
    },
    enableAnimation(): void {
      root.classList.add('is-animatable');
    },
    focus(): void {
      root.focus({ preventScroll: true });
    },
    /**
     * Focus after a view switch. Going in, the back control: it is the first
     * thing in the settings view, so tab runs forwards from it into the
     * switches, and it is also the way out. Coming back, the control that got
     * the user there, which is where they expect to land.
     */
    focusView(view: PanelView): void {
      if (view === 'settings') settings.focusFirst();
      else header.settingsButton.focus({ preventScroll: true });
    },
    destroy(): void {
      reorder.destroy();
      anchorEl.remove();
    },
  };
}
