/**
 * The panel shell: header, an optional status strip, one ordered card list,
 * the toasts, and the footer.
 *
 * Cards are reconciled by provider id rather than rebuilt, so the meter keeps
 * its element across snapshots and the 400ms fill transition actually has
 * something to transition from. Rebuilding the list would make every update
 * look like a first paint.
 *
 * ONE LIST, NOT TWO
 * -----------------
 * Connected and passive cards share a single list, in the order main sends.
 * The contract says the tray icon follows the first ENABLED provider, and the
 * user's model of that is "the card at the top"; passive cards are draggable
 * too, so they share one position space; and one list has one drop target and
 * one live region. An unconnected card still reads as one: grey mark, no meter,
 * its own "bağlı değil" explanation.
 *
 * THE SHELL (UI plan 2026-09-29)
 * ------------------------------
 *   header   fixed; the freshness marker is a dot while live and a chip when not
 *   strip    "Bağlantı yok" while the background service is unreachable — the
 *            ONE place that condition is stated; the footer no longer repeats it
 *   list     the only thing that scrolls; the first-run card sits above it
 *   toasts   outcomes of the user's own actions: a success leaves after 3 s, an
 *            error stays until closed
 *   footer   "Son tarama" and "Yenile", nothing else; the pin's promise moved
 *            into the pin's own tooltip
 */

import type { LanguageChoice, ProviderSnapshot, ThemeChoice, TrayView } from '../../../shared/contract.js';
import { defaultPlacement, placePanel, type PanelPlacement } from '../anchor.js';
import { el, on, replaceChildrenWith, setAttr, setText, svg } from '../dom.js';
import { clockTime } from '../format.js';
import { language, t } from '../i18n.js';
import { createReorder, type ReorderHandle } from '../reorder.js';
import { isDrawable } from './meter.js';
import { enabledOf, type PanelState, type PanelView, type SettingsTab } from '../store.js';
import { createHeader, type HeaderHandle } from './header.js';
import { providerMark } from './logo.js';
import { createSettings, type SettingsHandle } from './settings.js';
import { createOnboarding, type OnboardingHandle } from './onboarding.js';
import {
  createRow,
  createSkeletonRow,
  REORDER_HELP_ID,
  type RowContext,
  type RowHandle,
} from './row.js';

/** Placeholder cards shown before the first snapshot lands. Enough to fill the
 *  panel without pretending to know how many tools this machine has. */
const SKELETON_ROWS = 3;

/** How long the "tool is closed" toast stays before it leaves on its own. */
const TOOL_TOAST_MS = 5000;
/** How long a success or info toast stays. An error stays until closed. */
const OUTCOME_TOAST_MS = 3000;

/**
 * `attachGrip` and `isTrayRow` are supplied by the panel itself, not the app:
 * only the panel knows which element ended up first and which reorder
 * controller owns the list.
 */
export interface PanelContext extends Omit<RowContext, 'attachGrip' | 'isTrayRow' | 'isExpanded' | 'onToggleExpand'> {
  /** Take our statusLine hook out of a tool's settings. */
  onDisconnect(providerId: string): void;
  /** From settings: back to the main list and ask this tool's setup question. */
  onConnectFromSettings(providerId: string): void;
  /** The user stated the plan they are on for this tool, or cleared it. */
  onPlanLabel(providerId: string, label: string): void;
  onPinToggle(pinned: boolean): void;
  onClose(): void;
  onRefresh(): void;
  /** Swap between the usage list and the settings view. */
  onSettingsToggle(): void;
  /** Open the settings view on a given tab. */
  onOpenSettings(tab: SettingsTab): void;
  /** The user picked a settings tab. */
  onSettingsTab(tab: SettingsTab): void;
  /** Add a provider to the main panel, or remove it. */
  onToggleProvider(providerId: string, enabled: boolean): void;
  /** The user picked a theme in settings. */
  onThemeChange(theme: ThemeChoice): void;
  /** The user picked a language in settings. The app waits for main's push. */
  onLanguageChange(language: LanguageChoice): void;
  /** The user flipped "start with Windows" in settings. Optimistic. */
  onAutostartChange(enabled: boolean): void;
  /** The user picked Görünüm: tray icon or taskbar strip. Optimistic. */
  onTrayViewChange(view: TrayView): void;
  /** The user pressed a card's "Ayrıntılar". */
  onToggleExpand(providerId: string): void;
  /** "Bağla" on the first-run card: the same consent path, drawn in the card. */
  onCoachConnect(providerId: string): void;
  /** "Atla" / "Başla" in the first-run introduction: persisted, it does not come back. */
  onCoachDismiss(): void;
  /** The introduction moved to another step (0-based). */
  onOnboardingStep(step: number): void;
  /** Settings → Genel "Tanıtımı yeniden göster". */
  onReplayOnboarding(): void;
  /**
   * Whether the first-run tray coach was dismissed. Held by the app, not the
   * panel, because a language change rebuilds the panel and a tip the user
   * already closed must not come back with it.
   */
  coachDismissed: boolean;
  onConsentConfirm(): void;
  onConsentCancel(): void;
  /** User asked for a new order. The app persists it and owns the revert. */
  onReorder(ids: readonly string[]): void;
  /** Cancels main's pending auto-hide. Called whenever the pointer is inside
   *  the panel, and again at the start of every drag. */
  onKeepAlive(): void;
  /** The pointer entered (true) or left (false) the painted panel. */
  onPointerOverPanel(over: boolean): void;
  /** The user closed the toast. Clears `state.notice`. */
  onNoticeDismiss(): void;
  /** The user closed the refresh bubble ("Antigravity açık değil"). */
  onRefreshNoticeDismiss(): void;
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
  /** After a rebuild for a new language: back onto the language radio. */
  focusLanguage(): void;
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

/** A small close cross, shared by every toast. */
function closeIcon(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', {
      d: 'M5 5l6 6M11 5l-6 6',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
    }),
  );
}

/** The refresh arrow. It turns while a refresh is in flight; the label says so too. */
function refreshIcon(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false', class: 'foot__refresh-icon' },
    svg('path', {
      d: 'M13 8a5 5 0 1 1-1.5-3.55M13.25 2.5v2.75H10.5',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
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
    onDisconnect: (id) => ctx.onDisconnect(id),
    onConnect: (id) => ctx.onConnectFromSettings(id),
    onReplayIntro: () => ctx.onReplayOnboarding(),
    onPlanLabel: (id, label) => ctx.onPlanLabel(id, label),
    onTheme: (theme) => ctx.onThemeChange(theme),
    onLanguage: (choice) => ctx.onLanguageChange(choice),
    onAutostart: (enabled) => ctx.onAutostartChange(enabled),
    onTrayView: (view) => ctx.onTrayViewChange(view),
    onBack: () => ctx.onSettingsToggle(),
    onTab: (tab) => ctx.onSettingsTab(tab),
  });

  // --- the status strip: the ONE place "no connection" is stated ----------
  const strip = el('p', { class: 'strip', role: 'status' }, t('panel.offline'));
  strip.hidden = true;

  const rowList = el('ul', {
    class: 'rows',
    role: 'list',
    'aria-label': t('panel.rowsLabel'),
  });

  const skeletonList = el('ul', {
    class: 'rows',
    role: 'list',
    'aria-label': t('panel.rowsLoading'),
    'aria-busy': 'true',
  });
  for (let i = 0; i < SKELETON_ROWS; i++) skeletonList.appendChild(createSkeletonRow());
  skeletonList.hidden = true;

  /**
   * The empty states, spelled out. "We found nothing on this machine" and "you
   * removed every card" look identical as a blank list, and each has its own
   * fix, so each gets its own words and its own one button.
   */
  const emptyTitle = el('strong', { class: 'empty__title' }, '');
  const emptyDetail = el('span', { class: 'empty__detail' }, '');
  const emptyAction = el('button', { type: 'button', class: 'btn btn--primary' }, '') as HTMLButtonElement;
  let emptyMode: 'none-found' | 'none-added' = 'none-found';
  on(emptyAction, 'click', () => {
    if (emptyMode === 'none-found') ctx.onRefresh();
    else ctx.onOpenSettings('providers');
  });
  const emptyState = el('div', { class: 'empty' }, emptyTitle, emptyDetail, emptyAction);
  emptyState.hidden = true;

  // Every grip points at this with aria-describedby, so the keyboard path is
  // announced by the control that offers it rather than hidden in a tooltip.
  const reorderHelp = el('p', { class: 'u-sr', id: REORDER_HELP_ID }, t('panel.reorderHelp'));

  // Moves are announced here, politely, with the resulting position.
  const liveRegion = el('p', {
    class: 'u-sr rows__live',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });

  // --- consent: drawn where the button was pressed ------------------------
  // Installing the statusline bridge writes into the user's Claude Code
  // settings. It is never sent to main until this is confirmed, and the
  // explanation is shown BEFORE the affirmative control. It is moved into the
  // card whose "Bağla" was pressed (or into the first-run card), so the user
  // reads the question where they acted.
  const consentTitle = el('strong', { class: 'consent__title', id: 'consent-title' }, '');
  // One paragraph per SetupAction.consent entry (the file, the promise, ...).
  const consentDetail = el('div', { class: 'consent__detail', id: 'consent-detail' });
  const consentCancel = el('button', { type: 'button', class: 'btn' }, t('panel.consentCancel')) as HTMLButtonElement;
  const consentConfirm = el('button', { type: 'button', class: 'btn btn--primary' }, t('panel.consentConfirm')) as HTMLButtonElement;
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

  // --- the first-run introduction (onboarding.ts) -------------------------
  // It replaced the single "Claude Code'u bağla" card: its third step asks the
  // same question, through the same consent path.
  const onboarding: OnboardingHandle = createOnboarding({
    onStep: (step) => ctx.onOnboardingStep(step),
    onDone: () => ctx.onCoachDismiss(),
    onToggle: (id, enabled) => ctx.onToggleProvider(id, enabled),
    onConnect: (id) => ctx.onCoachConnect(id),
  });

  const listBand = el(
    'div',
    { class: 'panel__band panel__band--list' },
    reorderHelp,
    onboarding.el,
    skeletonList,
    rowList,
    emptyState,
    settings.el,
  );
  listBand.style.setProperty('--band-delay', '40ms');

  // --- toasts -------------------------------------------------------------
  // The outcome of something the user just did. `role="status"` on the text
  // alone, so the close control is never part of the announcement and is never
  // rewritten under focus. An error stays until closed; anything else leaves
  // after OUTCOME_TOAST_MS. No Esc binding: Esc already unwinds consent ->
  // settings -> close the panel, and a toast has no claim on it.
  const noticeText = el('p', { class: 'toast__text notice__text', role: 'status' }, '');
  const noticeClose = el('button', {
    type: 'button',
    class: 'toast__close',
    'aria-label': t('panel.noticeClose'),
    title: t('panel.noticeClose'),
  }) as HTMLButtonElement;
  noticeClose.appendChild(closeIcon());
  const notice = el('div', { class: 'toast notice' }, el('div', { class: 'toast__body' }, noticeText), noticeClose);
  notice.hidden = true;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let noticeShown: string | null = null;

  /**
   * First-run coaching for the tray icon, shown only when we KNOW we are not
   * pointing at one: `anchorSource: 'cursor'` means main could not measure a
   * plausible tray rect, most often the Windows 11 hidden-icons overflow.
   */
  const coachDismiss = el(
    'button',
    { type: 'button', class: 'btn', 'aria-label': t('panel.coachDismissLabel') },
    t('panel.coachDismiss'),
  ) as HTMLButtonElement;
  const coach = el(
    'div',
    { class: 'coach', role: 'note' },
    el('span', { class: 'coach__text' }, t('panel.coach')),
    el('div', { class: 'coach__actions' }, coachDismiss),
  );
  coach.hidden = true;
  on(coachDismiss, 'click', () => {
    ctx.coachDismissed = true;
    coach.hidden = true;
  });

  // The "tool is closed" toast: the user pressed Yenile while the Antigravity
  // IDE was closed, so its store cannot be updating. Calm information, not an
  // error; it leaves on its own after TOOL_TOAST_MS. Shown ONLY on an explicit
  // refresh reply carrying the notice, never on a push.
  const refreshBubbleDismiss = el(
    'button',
    { type: 'button', class: 'toast__close', 'aria-label': t('panel.bubbleDismissLabel') },
    closeIcon(),
  ) as HTMLButtonElement;
  const refreshBubble = el(
    'div',
    { class: 'toast toast--tool', role: 'status' },
    providerMark('antigravity', true),
    el(
      'div',
      { class: 'toast__body' },
      el('p', { class: 'toast__title' }, t('provider.antigravity.notRunning.title')),
      el('p', { class: 'toast__text' }, t('provider.antigravity.notRunning')),
    ),
    refreshBubbleDismiss,
  );
  refreshBubble.hidden = true;
  on(refreshBubbleDismiss, 'click', () => ctx.onRefreshNoticeDismiss());
  let toolToastTimer: ReturnType<typeof setTimeout> | null = null;

  const toasts = el('div', { class: 'toasts' }, coach, refreshBubble, notice);

  // --- footer: last scan and refresh, nothing else -------------------------
  const scanText = el('span', { class: 'foot__scan' }, '');
  const refreshLabel = el('span', { class: 'foot__refresh-label' }, t('panel.refresh'));
  const refreshButton = el(
    'button',
    { type: 'button', class: 'btn foot__refresh', 'aria-label': t('panel.refreshLabel') },
    refreshIcon(),
    refreshLabel,
  ) as HTMLButtonElement;
  on(refreshButton, 'click', () => ctx.onRefresh());
  const foot = el(
    'div',
    { class: 'foot' },
    scanText,
    el('span', { class: 'foot__spacer' }),
    refreshButton,
  );

  const footBand = el('div', { class: 'panel__band panel__band--foot' }, toasts, liveRegion, foot);
  footBand.style.setProperty('--band-delay', '80ms');

  const root = el(
    'div',
    {
      class: 'panel',
      // The language main resolved, at build time. A change rebuilds the
      // panel (app.ts), so this is never stale.
      lang: language(),
      role: 'dialog',
      'aria-label': t('panel.dialogLabel'),
      'data-open': 'false',
      tabindex: '-1',
    },
    header.el,
    strip,
    listBand,
    footBand,
  );

  // The tail must sit outside the panel's overflow clip, so the panel and the
  // tail share a positioned wrapper and it is the wrapper that transforms.
  const tail = el('span', { class: 'panel__tail', 'aria-hidden': 'true' }, tailGlyph());
  const anchorEl = el('div', { class: 'anchor', 'data-open': 'false' }, root, tail);

  /**
   * Dismissal, and where focus goes afterwards: a focused control inside a
   * box that is about to be hidden would drop focus to <body>, outside the
   * dialog. The panel root is `tabindex="-1"` and tabbing on from it continues
   * inside the panel. Guarded on `contains`, so a mouse user is not moved.
   */
  on(noticeClose, 'click', () => {
    const hadFocus = notice.contains(document.activeElement);
    ctx.onNoticeDismiss();
    if (hadFocus) root.focus({ preventScroll: true });
  });

  let lastPlacementKey = '';
  let lastConsentKey: string | null = null;
  /** Newest state, so a drag ending can re-render without the app pushing. */
  let lastState: PanelState | null = null;
  let lastNow = Date.now();
  /** The card whose details were open at the last render, to scroll to a new one. */
  let lastExpanded: string | null = null;

  const reorder: ReorderHandle = createReorder({
    list: rowList,
    scroller: listBand,
    // The list only holds ADDED providers, so what the drag produces is a
    // subset; expandOrder() puts it back into a full order first.
    commit: (ids) => ctx.onReorder(expandOrder(ids)),
    announce: (text) => {
      // Re-announce identical text by clearing first.
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

  // The context the cards actually see. Getters, not a spread: the app mutates
  // `generatedAt` and `staleOverride` on its own object between renders.
  const rowCtx: RowContext = {
    onRetry: (id) => ctx.onRetry(id),
    onSetup: (id) => ctx.onSetup(id),
    isBusy: (id) => ctx.isBusy(id),
    isPending: (id) => ctx.isPending(id),
    attachGrip: (grip, id, name) => reorder.attach(grip, id, name),
    isTrayRow: (id) => id === trayRowId,
    isExpanded: (id) => lastState?.expandedProviderId === id,
    onToggleExpand: (id) => ctx.onToggleExpand(id),
    get generatedAt(): string | null {
      return ctx.generatedAt;
    },
    get staleOverride(): boolean {
      return ctx.staleOverride;
    },
  };

  /**
   * "The pointer is inside the panel" — a tighter second signal for main's own
   * cursor poll, never the mechanism holding the panel open. Throttled.
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

  /**
   * The window around the panel is transparent and click-through; main takes
   * the mouse back only while the pointer is over the painted panel (owner,
   * 2026-10-01: the empty space beside and above it swallowed clicks meant for
   * the apps behind). Main forwards mouse MOVES even while click-through, so
   * enter and leave still arrive here. A drag that crosses the edge keeps the
   * mouse until the button is released.
   */
  let pointerOver = false;
  function reportOver(over: boolean): void {
    if (over === pointerOver) return;
    pointerOver = over;
    ctx.onPointerOverPanel(over);
  }
  on(anchorEl, 'pointerenter', () => reportOver(true));
  on(anchorEl, 'pointermove', () => reportOver(true));
  on(anchorEl, 'pointerleave', (event: PointerEvent) => {
    if (event.buttons === 0) reportOver(false);
  });
  const onUp = (event: PointerEvent): void => {
    if (!anchorEl.contains(event.target as Node)) reportOver(false);
  };
  document.addEventListener('pointerup', onUp);

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
    // The OS window cannot grow, so the list — not the panel — absorbs any
    // excess. Header and footer stay put; only the list scrolls.
    const canvasHeight = state.anchor
      ? state.anchor.window.height
      : document.documentElement.clientHeight;
    const chrome = header.el.offsetHeight + footBand.offsetHeight + (strip.hidden ? 0 : strip.offsetHeight);
    const budget = canvasHeight - chrome - 2 * 12 - 8 - 2;
    listBand.style.setProperty('--list-max', `${Math.max(120, budget)}px`);

    const size = { width: root.offsetWidth || 400, height: root.offsetHeight || 0 };
    const placement = state.anchor
      ? placePanel(state.anchor, size)
      : defaultPlacement({
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        });

    // Re-applied on every render because the height changes with content, but
    // keyed so identical styles are not rewritten every second.
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
    // for an instant, and Chromium drops focus to <body> when it does — fatal
    // for the keyboard reorder path. Verified in Electron.
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
      // Position is stated, not implied by DOM order alone.
      setAttr(handle.el, 'aria-posinset', String(i + 1));
      setAttr(handle.el, 'aria-setsize', String(providers.length));
      if (handle.el === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        list.insertBefore(handle.el, cursor);
      }
    }
    while (cursor) {
      const next = cursor.nextElementSibling;
      list.removeChild(cursor);
      cursor = next;
    }

    if (refocus && document.activeElement !== refocus && list.contains(refocus)) {
      refocus.focus({ preventScroll: true });
      refocus.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Turn the visible (added-only) order a drag produced back into a full one:
   * un-added providers keep their absolute positions and the added ones fill
   * the slots they already occupied, in their new relative order.
   */
  function expandOrder(visible: readonly string[]): readonly string[] {
    const all = (lastState ? ordered(lastState) : []).map((p) => p.id as string);
    const moving = new Set(visible);
    const slots = all.filter((id) => moving.has(id));
    if (all.length === 0 || slots.length !== visible.length) return all;
    let k = 0;
    return all.map((id) => (moving.has(id) ? (visible[k++] as string) : id));
  }

  /** What the main panel draws: user order, added cards only. */
  function visibleOf(state: PanelState): readonly ProviderSnapshot[] {
    return ordered(state).filter((provider) => enabledOf(state, provider));
  }

  /**
   * `Snapshot.providers` is already in user order and is NEVER re-sorted here,
   * except for `state.order`: the user's own pending move, applied only when it
   * names exactly the same set of providers.
   */
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

  function reducedMotion(): boolean {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /** The toast for `state.notice`, and its timer. */
  function renderNotice(state: PanelState): void {
    if (!state.notice) {
      notice.hidden = true;
      setText(noticeText, '');
      noticeShown = null;
      if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
      }
      return;
    }
    notice.hidden = false;
    setAttr(notice, 'data-tone', state.noticeTone);
    // An error is announced assertively and stays; anything else is polite.
    setAttr(noticeText, 'role', state.noticeTone === 'error' ? 'alert' : 'status');
    const key = `${state.noticeTone}|${state.notice}`;
    if (key === noticeShown) return;
    noticeShown = key;
    setText(noticeText, state.notice);
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    if (state.noticeTone !== 'error') {
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        if (lastState?.notice === state.notice) ctx.onNoticeDismiss();
      }, OUTCOME_TOAST_MS);
    }
  }

  /** Where the consent question is drawn: the card, or the first-run card. */
  function placeConsent(state: PanelState): void {
    const consent = state.consent;
    if (!consent) {
      consentBox.hidden = true;
      lastConsentKey = null;
      return;
    }
    const host = consent.origin === 'coach' && !onboarding.el.hidden
      ? onboarding.consentHost
      : rows.get(consent.providerId)?.el ?? onboarding.consentHost;
    if (consentBox.parentElement !== host) host.appendChild(consentBox);
    consentBox.hidden = false;
    // A question, asked once, in the app's own words: the native dialog that
    // used to follow this box is gone (owner, 2026-09-30).
    setText(consentTitle, t('panel.consentTitle', { provider: consent.providerName }));
    const paragraphs = consent.paragraphs && consent.paragraphs.length > 0 ? consent.paragraphs : [consent.detail];
    replaceChildrenWith(
      consentDetail,
      paragraphs.map((line) => el('p', { class: 'consent__para' }, line)),
    );
    setText(consentConfirm, consent.label);
    setAttr(
      consentConfirm,
      'aria-label',
      t('panel.consentConfirmLabel', { provider: consent.providerName, label: consent.label }),
    );
    // Moving focus onto the affirmative control would be a trap for anyone
    // pressing Enter twice; focus the cancel side and let them choose.
    const key = `${consent.origin}|${consent.providerId}`;
    if (lastConsentKey !== key) {
      lastConsentKey = key;
      consentCancel.focus({ preventScroll: true });
      consentBox.scrollIntoView({ block: 'nearest' });
    }
  }

  function render(state: PanelState, now: number): void {
    lastState = state;
    lastNow = now;

    const inSettings = state.view === 'settings';
    const all = ordered(state);
    // The main list shows only what the user ADDED. Settings sees every tool.
    const providers = visibleOf(state);
    // The tray icon follows the first ENABLED provider.
    trayRowId = providers.length > 0 ? providers[0].id : null;

    header.update(state, now);

    // A drag owns the list's MEMBERSHIP as well as its geometry: nothing may be
    // added, removed or re-ordered until the gesture ends (see reorder.ts).
    if (reorder.isDragging()) {
      for (const provider of providers) rows.get(provider.id)?.update(provider, rowCtx, now);
    } else {
      const alive = new Set<string>(providers.map((p) => p.id));
      for (const [id, handle] of rows) {
        if (!alive.has(id)) {
          handle.el.remove();
          rows.delete(id);
        }
      }
      syncList(rowList, providers, now);
    }

    // --- the first-run introduction: it owns the list area while it runs ---
    onboarding.update(state);
    const introducing = !onboarding.el.hidden;

    // Before the first snapshot lands the panel shows the final geometry, so
    // nothing moves when data arrives.
    skeletonList.hidden = state.hasData || inSettings || introducing;
    rowList.hidden = !state.hasData || inSettings || introducing || providers.length === 0;
    emptyState.hidden = !state.hasData || inSettings || introducing || providers.length > 0;
    reorderHelp.hidden = inSettings || introducing;
    settings.el.hidden = !inSettings;
    setAttr(root, 'data-view', state.view);
    if (inSettings) settings.render(state, all);

    if (!emptyState.hidden) {
      const nothingKnown = all.length === 0;
      emptyMode = nothingKnown ? 'none-found' : 'none-added';
      setText(emptyTitle, nothingKnown ? t('panel.empty.noneFoundTitle') : t('panel.empty.noneAdded'));
      setText(
        emptyDetail,
        nothingKnown
          ? t('panel.empty.noneDetail')
          : t('panel.empty.noneAddedDetail', { count: all.length }),
      );
      setText(emptyAction, nothingKnown ? t('panel.empty.rescan') : t('panel.empty.chooseTools'));
      emptyAction.disabled = nothingKnown && (state.refreshing || !state.bridgeAvailable);
    }

    // --- the status strip, the one home of "no connection" ---
    strip.hidden = state.bridgeAvailable;

    renderNotice(state);
    placeConsent(state);

    // --- footer ---
    // While the first scan runs, the button says so and waits; while the
    // service is unreachable it cannot do anything and its tooltip says why.
    // Hidden where the empty state already offers "Yeniden tara".
    const scanning = !state.hasData && state.bridgeAvailable;
    // Hidden in both empty states: each offers its own one action.
    refreshButton.hidden = !emptyState.hidden;
    refreshButton.disabled = state.refreshing || !state.bridgeAvailable || scanning;
    setAttr(refreshButton, 'data-busy', state.refreshing || scanning ? 'true' : null);
    setText(
      refreshLabel,
      scanning ? t('panel.scanning') : state.refreshing ? t('panel.refreshing') : t('panel.refresh'),
    );
    setAttr(refreshButton, 'title', !state.bridgeAvailable ? t('panel.refreshOffline') : t('panel.refreshLabel'));

    const generatedAt = state.snapshot?.generatedAt ?? null;
    setText(
      scanText,
      generatedAt ? t('panel.lastScan', { time: clockTime(generatedAt) }) : t('panel.noScan'),
    );

    // Only when we know we are NOT pointing at a measured tray icon.
    coach.hidden = ctx.coachDismissed || state.anchor?.anchorSource !== 'cursor';

    // Driven purely by the store flag, which app.ts sets only from a refresh
    // reply and clears at the next refresh or on dismissal — never from a push.
    const showToolToast = state.refreshNotice === 'ANTIGRAVITY_NOT_RUNNING';
    if (showToolToast && refreshBubble.hidden) {
      if (toolToastTimer !== null) clearTimeout(toolToastTimer);
      toolToastTimer = setTimeout(() => {
        toolToastTimer = null;
        ctx.onRefreshNoticeDismiss();
      }, TOOL_TOAST_MS);
    } else if (!showToolToast && toolToastTimer !== null) {
      clearTimeout(toolToastTimer);
      toolToastTimer = null;
    }
    refreshBubble.hidden = !showToolToast;

    // A card whose details just opened is brought into view, gently.
    const expanded = inSettings ? null : state.expandedProviderId;
    if (expanded && expanded !== lastExpanded) {
      const handle = rows.get(expanded);
      if (handle) {
        requestAnimationFrame(() => {
          handle.el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
        });
      }
    }
    lastExpanded = expanded;

    // Content just changed, so the panel's height did too. Re-place last —
    // except mid-drag, where moving the panel under a captured pointer would
    // shift every card the user is aiming at.
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
      // Main resets its side to click-through when it hides the panel; forget
      // ours too, so the next enter is reported rather than deduplicated away.
      if (!open) pointerOver = false;
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
     * thing in the settings view and also the way out. Coming back, the
     * control that got the user there.
     */
    focusView(view: PanelView): void {
      if (view === 'settings') settings.focusFirst();
      else header.settingsButton.focus({ preventScroll: true });
    },
    focusLanguage(): void {
      settings.focusLanguage();
    },
    destroy(): void {
      document.removeEventListener('pointerup', onUp);
      if (noticeTimer !== null) clearTimeout(noticeTimer);
      if (toolToastTimer !== null) clearTimeout(toolToastTimer);
      reorder.destroy();
      anchorEl.remove();
    },
  };
}
