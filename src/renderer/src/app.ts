/**
 * Application wiring: bridge -> store -> panel, plus the open/close
 * choreography, the consent gate and the 1Hz clock.
 *
 * Exported as `mountApp` so the dev harness can mount the exact same panel
 * against a mock bridge. There is no second rendering path.
 */

import type {
  ProviderSnapshot,
  SetupAction,
  Snapshot,
  ThemeChoice,
} from '../../shared/contract.js';
import type { Bridge } from './bridge.js';
import { bindVisibility, everySecond } from './clock.js';
import { captureExpired } from './components/row.js';
import { createPanel, type PanelContext } from './components/panel.js';
import { trimMessage } from './format.js';
import { freshnessOf, shouldDegrade, Store } from './store.js';
import { createTheme, DEFAULT_THEME } from './theme.js';

export interface AppHandle {
  /** Push a snapshot in, as if main had sent it. Used by the harness. */
  applySnapshot(snapshot: Snapshot): void;
  requestClose(): void;
  destroy(): void;
}

const CLOSE_MS = 140;

/**
 * Anything that writes outside the app's own userData needs an explicit,
 * informed gesture. Installing the statusline bridge edits the user's Claude
 * Code settings, so it is gated; the others are main's business.
 */
function needsConsent(action: SetupAction): boolean {
  return action.kind === 'install-bridge';
}

function findProvider(snapshot: Snapshot | null, id: string): ProviderSnapshot | null {
  return snapshot?.providers.find((p) => p.id === id) ?? null;
}

export function mountApp(container: HTMLElement, bridge: Bridge): AppHandle {
  const store = new Store();
  const disposers: Array<() => void> = [];

  // FIRST, before anything is built or painted.
  //
  // `initialPreferences()` is synchronous for the same reason
  // `initialSnapshot()` is: the panel gets one first frame, and a theme applied
  // after it is a visible flash of the other palette. Nothing above this line
  // may touch the DOM.
  const theme = createTheme(bridge.initialPreferences()?.theme ?? DEFAULT_THEME);
  store.set({ theme: theme.choice() });
  disposers.push(() => theme.destroy());
  let closing = false;
  /** Provider whose consent prompt is currently open, if any. */
  let awaitingConsent: string | null = null;

  const ctx: PanelContext = {
    generatedAt: null,
    staleOverride: false,
    isBusy: (id) => store.get().busy.includes(id),
    onRetry: (providerId) => void runRefresh(providerId),
    onSetup: (providerId) => beginSetup(providerId),
    onRefresh: () => void runRefresh(null),
    onPinToggle: () => {
      // Main owns pinned mode and answers by pushing a new anchor — mode:'pin'
      // when it pinned, mode:'hover' when this press UNPINNED it, panel still
      // open either way. The renderer only asks; it never assumes it
      // succeeded, and it never flips its own button ahead of the answer.
      bridge.pin();
    },
    onClose: () => requestClose(),
    onSettingsToggle: () => toggleSettings(),
    onToggleProvider: (id, enabled) => void applyEnabled(id, enabled),
    onThemeChange: (choice) => void applyTheme(choice),
    onReorder: (ids) => void applyOrder(ids),
    onKeepAlive: () => bridge.panelOpened(),
    // The user read it and is done with it. Only ever reaches a notice the
    // STORE owns: the offline banner is a live condition, not an outcome, and
    // the panel does not offer a control that would clear it (panel.ts).
    onNoticeDismiss: () => store.set({ notice: null }),
    // The refresh bubble ("Antigravity açık değil") is an outcome, not a live
    // condition, so unlike the offline banner it is dismissible.
    onRefreshNoticeDismiss: () => store.set({ refreshNotice: null }),
    onConsentConfirm: () => {
      const id = awaitingConsent;
      awaitingConsent = null;
      store.set({ consent: null });
      if (id) void runSetup(id, true);
    },
    onConsentCancel: () => {
      awaitingConsent = null;
      store.set({ consent: null, notice: 'Kurulum iptal edildi. Hiçbir dosya değiştirilmedi.' });
    },
  };

  const panel = createPanel(ctx);
  container.appendChild(panel.el);

  function render(): void {
    const state = store.get();
    const now = Date.now();
    ctx.generatedAt = state.snapshot?.generatedAt ?? null;
    // Derived here, not trusted from the row: a main process that has stopped
    // pushing keeps reporting `ok`, and an old number shown at full confidence
    // is exactly the failure this product exists to avoid.
    ctx.staleOverride = shouldDegrade(
      freshnessOf(ctx.generatedAt, state.bridgeAvailable, now).level,
    );
    panel.render(state, now);
  }

  disposers.push(store.subscribe(render));

  /** The single door every snapshot comes through, whatever pushed it. */
  function acceptSnapshot(snapshot: Snapshot): void {
    reconcileOrder(snapshot);
    reconcileEnabled(snapshot);
    store.setSnapshot(snapshot);
  }

  // --- actions -----------------------------------------------------------

  async function runRefresh(providerId: string | null): Promise<void> {
    if (store.get().refreshing) return;
    // Clear the previous refresh's notice up front: this attempt owns the
    // answer now, and a stale bubble outliving the press it described would be
    // the standing claim the contract keeps refreshNotices off pushes to avoid.
    store.set({ refreshing: true, notice: null, refreshNotice: null });
    if (providerId) store.markBusy(providerId, true);
    try {
      const snapshot = await bridge.requestRefresh();
      if (snapshot) {
        acceptSnapshot(snapshot);
        // `refreshNotices` rides only on a refresh reply (contract), so this is
        // the one place it can be read — and reading it from the RETURNED
        // snapshot rather than the stored one keeps it from riding later
        // pushes. One notice today; a set leaves the door open without a
        // rewrite.
        if (snapshot.refreshNotices?.includes('ANTIGRAVITY_NOT_RUNNING')) {
          store.set({ refreshNotice: 'ANTIGRAVITY_NOT_RUNNING' });
        }
      } else if (bridge.available) {
        store.set({ notice: 'Yenilenemedi. Birazdan yeniden denenecek.' });
      }
    } finally {
      if (providerId) store.markBusy(providerId, false);
      store.set({ refreshing: false });
    }
  }

  /**
   * Step one of a setup: decide whether this action may run unattended.
   * `runSetup(id, true)` is only ever reached from the confirm control, so the
   * `confirmed` flag can never be set without the user having read the detail.
   */
  function beginSetup(providerId: string): void {
    const provider = findProvider(store.get().snapshot, providerId);
    const action = provider?.setupAction ?? null;
    if (!action) return;

    if (needsConsent(action)) {
      awaitingConsent = providerId;
      store.set({
        notice: null,
        consent: {
          providerId,
          providerName: provider?.displayName ?? '',
          label: action.label,
          detail: action.detail,
        },
      });
      return;
    }
    void runSetup(providerId, false);
  }

  // --- provider order ----------------------------------------------------

  /**
   * The order we asked main for, and the instant we asked. `at` is what
   * separates main's answer from a snapshot that was already in flight when
   * the user dropped the row.
   */
  let orderRequest: { ids: readonly string[]; at: number } | null = null;

  function sameSequence(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((id, i) => id === b[i]);
  }

  /**
   * Optimistic, then reconciled. The row moves on the gesture; main is asked;
   * a failure puts the row back where it was AND says so, because a silent
   * revert reads as the app dropping the interaction.
   */
  async function applyOrder(ids: readonly string[]): Promise<void> {
    const next = ids.slice();
    orderRequest = { ids: next, at: Date.now() };
    store.set({ order: next, notice: null });

    const ok = await bridge.setOrder(next);
    if (ok) return;

    // Only revert if this is still the newest request; a later drag has
    // already replaced what is on screen and must not be undone by an old
    // failure.
    if (orderRequest && sameSequence(orderRequest.ids, next)) {
      orderRequest = null;
      store.set({
        order: null,
        notice: 'Sıralama kaydedilemedi. Önceki sıra geri alındı.',
      });
    }
  }

  /**
   * Decide what to do with an incoming snapshot while a move is pending.
   *
   * `Snapshot.providers` is authoritative and is never re-sorted. The override
   * exists only to cover the gap between the gesture and main's re-emit, so it
   * is dropped as soon as main has had its say:
   *   - the provider SET changed  -> main's order wins outright
   *   - main agrees               -> reconciled, drop the override
   *   - main was generated after we asked and still disagrees -> it did not
   *     persist; adopt main's order and say so rather than hold a lie on
   *     screen forever
   */
  function reconcileOrder(snapshot: Snapshot): void {
    const pending = store.get().order;
    if (!pending) return;
    const incoming = snapshot.providers.map((p) => p.id as string);

    const sameSet =
      incoming.length === pending.length && pending.every((id) => incoming.includes(id));
    if (!sameSet) {
      orderRequest = null;
      store.set({ order: null });
      return;
    }
    if (sameSequence(incoming, pending)) {
      orderRequest = null;
      store.set({ order: null });
      return;
    }
    const generatedAt = Date.parse(snapshot.generatedAt);
    if (
      orderRequest !== null &&
      Number.isFinite(generatedAt) &&
      generatedAt >= orderRequest.at
    ) {
      orderRequest = null;
      store.set({ order: null, notice: 'Sıralama kaydedilmedi. Önceki sıra geri alındı.' });
    }
  }

  // --- settings view -----------------------------------------------------

  function toggleSettings(): void {
    const next = store.get().view === 'settings' ? 'main' : 'settings';
    // The notice belongs to the view that produced it; carrying a reorder
    // failure into settings would attach it to controls that did not cause it.
    store.set({ view: next, notice: null, revertedId: null });
    panel.focusView(next);
  }

  // --- add / remove a provider -------------------------------------------

  /**
   * The newest add/remove asked of main, per provider, and when we asked.
   * `at` is what separates main's answer from a snapshot that was already in
   * flight when the switch was flipped — the same problem `orderRequest`
   * solves for the drag.
   */
  const enabledRequests = new Map<string, { enabled: boolean; at: number }>();

  function withoutId(ids: readonly string[], id: string): readonly string[] {
    return ids.filter((entry) => entry !== id);
  }

  function nameOf(id: string): string {
    return findProvider(store.get().snapshot, id)?.displayName ?? id;
  }

  /**
   * Optimistic, then reconciled — the switch moves on the gesture and main is
   * asked afterwards. `{ok:false}` is defined by the contract as "nothing
   * changed anywhere", so a failure drops the override (which puts the switch
   * back on main's value), flags the row so the revert is visible, and says so
   * in words. A silent snap-back reads as the app dropping the interaction.
   */
  async function applyEnabled(providerId: string, enabled: boolean): Promise<void> {
    const at = Date.now();
    enabledRequests.set(providerId, { enabled, at });
    const state = store.get();
    store.set({
      enabledOverride: { ...state.enabledOverride, [providerId]: enabled },
      enabledPending: state.enabledPending.includes(providerId)
        ? state.enabledPending
        : [...state.enabledPending, providerId],
      notice: null,
      revertedId: null,
    });

    const ok = await bridge.setEnabled(providerId, enabled);

    // A newer flip of the SAME switch owns the override and the pending flag
    // from here on; this call must not undo it.
    const pending = enabledRequests.get(providerId);
    if (pending && pending.at !== at) return;
    enabledRequests.delete(providerId);
    store.set({ enabledPending: withoutId(store.get().enabledPending, providerId) });
    if (ok) return;

    const override = { ...store.get().enabledOverride };
    delete override[providerId];
    store.set({
      enabledOverride: override,
      revertedId: providerId,
      notice: `${nameOf(providerId)}: ayar kaydedilemedi. Değişiklik geri alındı.`,
    });
    // The flag only has to outlive the flash; the notice keeps the message.
    window.setTimeout(() => {
      if (store.get().revertedId === providerId) store.set({ revertedId: null });
    }, 1_600);
  }

  /**
   * Same contract as reconcileOrder(), for `enabled`.
   *
   * `Snapshot.providers[].enabled` is main's truth. The override exists only
   * to cover the gap between the gesture and main's re-emit, so it is dropped
   * as soon as main has had its say: when it agrees, when nothing is in
   * flight, or when a snapshot generated AFTER we asked still disagrees —
   * which means the write did not land and holding the switch would be a lie.
   */
  function reconcileEnabled(snapshot: Snapshot): void {
    const override = store.get().enabledOverride;
    const ids = Object.keys(override);
    if (ids.length === 0) return;

    const generatedAt = Date.parse(snapshot.generatedAt);
    const next: Record<string, boolean> = {};
    let stranded = false;
    for (const id of ids) {
      const provider = snapshot.providers.find((p) => p.id === id);
      if (!provider || provider.enabled === override[id]) continue;
      const request = enabledRequests.get(id);
      if (!request) continue;
      if (Number.isFinite(generatedAt) && generatedAt >= request.at) {
        enabledRequests.delete(id);
        stranded = true;
        continue;
      }
      next[id] = override[id];
    }
    if (Object.keys(next).length === ids.length && !stranded) return;
    store.set({
      enabledOverride: next,
      notice: stranded
        ? 'Araç ayarı kaydedilmedi. Önceki durum geri alındı.'
        : store.get().notice ?? null,
    });
  }

  // --- theme --------------------------------------------------------------

  /**
   * The newest theme asked of main, and when. Same shape as `orderRequest`:
   * it is what separates main's answer from a preference push that was already
   * in flight when the radio was pressed.
   */
  let themeRequest: { theme: ThemeChoice; at: number } | null = null;

  /**
   * Optimistic, then reconciled — the palette flips on the gesture and main is
   * asked afterwards. `{ok:false}` is defined by the contract as "nothing
   * changed anywhere", so a failure puts the OLD theme back on the document as
   * well as in the radio group: leaving the new palette on screen would show a
   * setting that will not survive a restart.
   */
  async function applyTheme(next: ThemeChoice): Promise<void> {
    const previous = store.get().theme;
    if (next === previous) return;

    const at = Date.now();
    themeRequest = { theme: next, at };
    theme.apply(next);
    store.set({ theme: next, themePending: true, themeReverted: false, notice: null });

    const ok = await bridge.setTheme(next);

    // A newer pick owns the choice from here on; this call must not undo it.
    if (!themeRequest || themeRequest.at !== at) return;
    themeRequest = null;
    store.set({ themePending: false });
    if (ok) return;

    theme.apply(previous);
    store.set({
      theme: previous,
      themeReverted: true,
      notice: 'Görünüm kaydedilemedi. Önceki tema geri alındı.',
    });
    // The flag only has to outlive the flash; the notice keeps the message.
    window.setTimeout(() => {
      if (store.get().themeReverted) store.set({ themeReverted: false });
    }, 1_600);
  }

  /**
   * Main's truth, pushed. Adopted unless the user has just picked something
   * else and we are still waiting for the answer — the same gap the enabled
   * override covers, for the same reason: a push that crossed the request in
   * flight would snap the palette back under the user's hand.
   */
  function acceptPreferences(choice: ThemeChoice): void {
    if (themeRequest !== null) return;
    if (choice === store.get().theme) return;
    theme.apply(choice);
    store.set({ theme: choice });
  }

  async function runSetup(providerId: string, confirmed: boolean): Promise<void> {
    if (store.get().busy.includes(providerId)) return;
    store.markBusy(providerId, true);
    store.set({ notice: null });
    try {
      const result = await bridge.runSetup(providerId, confirmed);
      const message = trimMessage(result.message);
      store.set({
        notice: message || (result.ok ? 'Bağlantı kuruldu.' : 'Kurulum tamamlanamadı.'),
      });
      if (result.ok) {
        const snapshot = await bridge.requestRefresh();
        if (snapshot) acceptSnapshot(snapshot);
      }
    } finally {
      store.markBusy(providerId, false);
    }
  }

  function requestClose(): void {
    if (closing) return;
    closing = true;
    panel.setOpen(false);
    window.setTimeout(() => {
      bridge.close();
      closing = false;
    }, CLOSE_MS);
  }

  // --- keyboard ----------------------------------------------------------

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    // Esc unwinds one level at a time: an open consent prompt first, so a
    // mis-click cannot be turned into a dismissal that loses the explanation.
    if (awaitingConsent !== null) {
      ctx.onConsentCancel();
      return;
    }
    // Then the settings view: Esc in a sub-view backs out of the sub-view. A
    // user who opened settings and pressed Esc meant "leave settings", and
    // closing the whole panel instead loses the place they were in.
    if (store.get().view === 'settings') {
      store.set({ view: 'main', revertedId: null });
      panel.focusView('main');
      return;
    }
    requestClose();
  }
  document.addEventListener('keydown', onKeyDown);
  disposers.push(() => document.removeEventListener('keydown', onKeyDown));

  // --- first paint -------------------------------------------------------

  store.set({ bridgeAvailable: bridge.available });

  // Synchronous. The panel paints the last-known snapshot in frame one and
  // never awaits a scan.
  const initial = bridge.initialSnapshot();
  if (initial) acceptSnapshot(initial);
  render();

  // Two frames: the first commits the closed state and the un-animated meter
  // fills, the second flips the open flag and arms the fill transition. That
  // is what keeps the meters from sweeping in on first paint.
  requestAnimationFrame(() => {
    panel.setOpen(true);
    store.set({ open: true });
    // Focus the dialog root on open. NOT for the keyboard path: the panel is
    // the only thing in the document (index.html mounts #app and nothing
    // else), so Tab from <body> already reaches the first control. It is so
    // assistive technology lands on the named dialog when the window IS
    // activated.
    //
    // When main opens the window inactive (showInactive), this only sets
    // document.activeElement; nothing depends on it, and the user's first
    // click moves focus to whatever they clicked. Nothing here may assume the
    // window has OS focus.
    //
    // It must never DRAW anything. A tray click happens outside this document,
    // so Chromium treats this programmatic focus as keyboard-origin and
    // :focus-visible matches — which painted a 2px white frame around the
    // whole window on every open. `.panel:focus-visible` in panel.css turns
    // that off for the root alone; real controls keep their ring.
    panel.focus();
    requestAnimationFrame(() => panel.enableAnimation());
  });

  bridge.panelOpened();

  disposers.push(bridge.onSnapshot((snapshot) => acceptSnapshot(snapshot)));
  disposers.push(bridge.onPreferences((prefs) => acceptPreferences(prefs.theme)));
  // 'system' is a LIVE binding: when Windows flips at sunset the document has
  // already changed underneath us, and the settings copy that names what
  // 'system' currently resolves to has to follow it.
  disposers.push(theme.onChange(() => render()));
  disposers.push(
    bridge.onAnchor((anchor) => {
      // Main owns the mode in BOTH directions: pin() is a toggle, and unpinning
      // arrives here as mode:'hover' with the panel still open. The renderer
      // only ever asks (see onPinToggle) and reads the answer off the anchor,
      // which is what keeps the button from claiming a state main does not
      // hold.
      store.setAnchor(anchor);
      // Re-assert focus if something outside the panel took it while we were
      // being pinned; the keyboard path has to survive the mode change.
      if (anchor.mode === 'pin' && !document.querySelector('.panel:focus-within')) {
        panel.focus();
      }
    }),
  );

  // --- 1Hz local clock ---------------------------------------------------

  /**
   * What the tick must be able to change on its own, with no push from main:
   *  - a fresh snapshot ageing past CADENCE.STALE_AFTER_MS
   *  - a stale capture whose window rolls over (ADR-001 amendment 2)
   * Both are structural, so they need a full render, not a text update.
   */
  function structuralSignature(now: number): string {
    const state = store.get();
    const degrade = shouldDegrade(
      freshnessOf(state.snapshot?.generatedAt ?? null, state.bridgeAvailable, now).level,
    );
    let expired = 0;
    for (const provider of state.snapshot?.providers ?? []) {
      if (captureExpired(provider.fiveHour, now)) expired++;
      if (captureExpired(provider.sevenDay, now)) expired++;
    }
    return `${degrade}|${expired}`;
  }

  let lastSignature = structuralSignature(Date.now());

  disposers.push(bindVisibility());
  disposers.push(
    everySecond((now) => {
      const signature = structuralSignature(now);
      if (signature !== lastSignature) {
        lastSignature = signature;
        render();
      } else {
        panel.tick(store.get(), now);
      }
    }),
  );

  return {
    applySnapshot(snapshot: Snapshot): void {
      acceptSnapshot(snapshot);
    },
    requestClose,
    destroy(): void {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      panel.destroy();
    },
  };
}
