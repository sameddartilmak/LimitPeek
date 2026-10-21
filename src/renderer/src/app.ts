/**
 * Application wiring: bridge -> store -> panel, plus the open/close
 * choreography, the consent gate and the 1Hz clock.
 *
 * Exported as `mountApp` so the dev harness can mount the exact same panel
 * against a mock bridge. There is no second rendering path.
 */

import type {
  Gauge,
  LanguageChoice,
  Preferences,
  ProviderSnapshot,
  SetupAction,
  Snapshot,
  ThemeChoice,
  TrayView,
} from '../../shared/contract.js';
import type { Bridge } from './bridge.js';
import { bindVisibility, everySecond } from './clock.js';
import { captureExpired } from './components/row.js';
import { createPanel, type PanelContext } from './components/panel.js';
import { trimMessage } from './format.js';
import { formatLocale, language, setLocale, t } from './i18n.js';
import { defaultFormatLocale, fallbackLanguage, pendingUsageOf } from './sanitize.js';
import { freshnessOf, shouldDegrade, Store, type NoticeTone, type SettingsTab } from './store.js';
import { createTheme, DEFAULT_THEME } from './theme.js';
import { installTooltips } from './tooltip.js';

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

/**
 * Put main's resolved language and format locale into effect for everything
 * built after this call, and on the document.
 *
 * Main is the only resolver (contract.ts `Preferences`): it also writes the
 * tray tooltip, the menu and the setup text, and a second resolver here could
 * disagree with it. The one exception is `prefs === null` — no preload at all —
 * where there is no main to ask, and ADR-004's own rule is applied to the
 * browser's language instead.
 */
function applyLocale(prefs: Preferences | null): void {
  const resolved = prefs?.resolvedLanguage ?? fallbackLanguage(globalThis.navigator?.language);
  setLocale(resolved, prefs?.formatLocale ?? defaultFormatLocale(resolved));
  // Screen readers choose a voice from `lang`: an English panel under
  // lang="tr" is read with Turkish pronunciation.
  document.documentElement.setAttribute('lang', language());
  // The product name in every language: it is what the taskbar and a screen
  // reader's window list call this panel, and the header prints the same.
  document.title = 'LimitPeek';
}

/**
 * Görünüm → Gösterge on the document: row.css draws the activity rings under
 * `html[data-gauge="ring"]` and the bars otherwise. Written in frame one, like
 * the theme, or a ring user sees bars turn into rings on every launch.
 */
function paintGauge(gauge: Gauge): void {
  document.documentElement.dataset.gauge = gauge;
}

/**
 * Görünüm → "Saydamlığı azalt" on the document: tokens.css turns every glass
 * surface opaque under `html[data-reduce-transparency]`. Set when the user
 * asked OR Windows did (reduced transparency, high contrast; the CSS media
 * features say the same live, this covers what main measured). Frame one,
 * like the gauge, or the glass flashes before it goes opaque.
 */
function paintGlass(reduce: boolean, system: boolean): void {
  if (reduce || system) document.documentElement.dataset.reduceTransparency = 'true';
  else delete document.documentElement.dataset.reduceTransparency;
}

export function mountApp(container: HTMLElement, bridge: Bridge): AppHandle {
  const store = new Store();
  const disposers: Array<() => void> = [];

  // FIRST, before anything is built or painted.
  //
  // `initialPreferences()` is synchronous for the same reason
  // `initialSnapshot()` is: the panel gets one first frame, and a theme applied
  // after it is a visible flash of the other palette. The language has the
  // same deadline for the same reason — frame one in the wrong language is a
  // flash of the other one. Nothing above this line may touch the DOM.
  const initialPrefs = bridge.initialPreferences();
  applyLocale(initialPrefs);
  const theme = createTheme(initialPrefs?.theme ?? DEFAULT_THEME);
  paintGauge(initialPrefs?.gauge ?? 'bar');
  paintGlass(initialPrefs?.reduceTransparency === true, initialPrefs?.systemReducedTransparency === true);
  store.set({
    theme: theme.choice(),
    language: initialPrefs?.language ?? 'system',
    autostart: initialPrefs?.autostart ?? true,
    autostartByWindows: initialPrefs?.autostartByWindows ?? false,
    // No preload means no main to have said "fresh install": the card stays shut.
    setupCoachDismissed: initialPrefs?.setupCoachDismissed ?? true,
    trayView: initialPrefs?.trayView ?? 'tray',
    stripAvailable: initialPrefs?.stripAvailable ?? true,
    stripNoRoom: initialPrefs?.stripNoRoom ?? false,
    gauge: initialPrefs?.gauge ?? 'bar',
    reduceTransparency: initialPrefs?.reduceTransparency === true,
    systemReducedTransparency: initialPrefs?.systemReducedTransparency === true,
  });
  disposers.push(() => theme.destroy());
  // 400 ms on hover, at once on keyboard focus (tooltip.ts).
  disposers.push(installTooltips());
  let closing = false;
  /** Provider whose consent prompt is currently open, if any. */
  let awaitingConsent: string | null = null;
  /** Where that prompt was opened: the first-run card, or the provider's card. */
  let consentOrigin: 'coach' | 'row' = 'row';

  /**
   * One door for every toast (UI plan 2026-09-29). An `error` stays until the
   * user closes it; `success` and `info` leave on their own after 3 s.
   */
  function say(message: string | null, tone: NoticeTone = 'info'): void {
    store.set({ notice: message, noticeTone: tone });
  }

  const ctx: PanelContext = {
    generatedAt: null,
    staleOverride: false,
    isBusy: (id) => store.get().busy.includes(id),
    isPending: (id) => pendingUsageOf(store.get().snapshot).includes(id),
    onRetry: (providerId) => void runRefresh(providerId),
    onSetup: (providerId) => beginSetup(providerId),
    onPlanLabel: (providerId, label) => void applyPlanLabel(providerId, label),
    onDisconnect: (providerId) => void disconnectProvider(providerId),
    // The setup question is drawn in the tool's card, so show the list first.
    onConnectFromSettings: (providerId) => {
      store.set({ view: 'main', notice: null, revertedId: null });
      panel.focusView('main');
      beginSetup(providerId);
    },
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
    onOpenSettings: (tab) => openSettings(tab),
    onSettingsTab: (tab) => store.set({ settingsTab: tab }),
    // One card's details at a time: opening another closes the first, and
    // pressing the open one closes it.
    onToggleExpand: (id) => {
      const open = store.get().expandedProviderId;
      store.set({ expandedProviderId: open === id ? null : id });
    },
    onCoachConnect: (id) => beginSetup(id, 'coach'),
    onCoachDismiss: () => void dismissCoach(),
    onOnboardingStep: (step) => store.set({ onboardingStep: step, coachMessage: null }),
    onReplayOnboarding: () => void replayOnboarding(),
    onToggleProvider: (id, enabled) => void applyEnabled(id, enabled),
    onThemeChange: (choice) => void applyTheme(choice),
    onLanguageChange: (choice) => void applyLanguage(choice),
    onAutostartChange: (enabled) => void applyAutostart(enabled),
    onTrayViewChange: (view) => void applyTrayView(view),
    onGaugeChange: (gauge) => void applyGauge(gauge),
    onReduceTransparencyChange: (reduce) => void applyReduceTransparency(reduce),
    coachDismissed: false,
    onReorder: (ids) => void applyOrder(ids),
    onKeepAlive: () => bridge.panelOpened(),
    onPointerOverPanel: (over) => bridge.setPointerOverPanel(over),
    // The user read it and is done with it. Only ever reaches a notice the
    // STORE owns: the offline banner is a live condition, not an outcome, and
    // the panel does not offer a control that would clear it (panel.ts).
    onNoticeDismiss: () => store.set({ notice: null }),
    // The refresh bubble ("Antigravity açık değil") is an outcome, not a live
    // condition, so unlike the offline banner it is dismissible.
    onRefreshNoticeDismiss: () => store.set({ refreshNotice: null }),
    onConsentConfirm: () => {
      const id = awaitingConsent;
      const origin = consentOrigin;
      awaitingConsent = null;
      store.set({ consent: null });
      if (id) void runSetup(id, true, origin);
    },
    onConsentCancel: () => {
      awaitingConsent = null;
      store.set({ consent: null });
      // Said where the user acted: inside the first-run card, or as a toast.
      if (consentOrigin === 'coach') store.set({ coachMessage: t('coach.cancelled') });
      else say(t('app.setupCancelled'), 'info');
    },
  };

  // `let`, not `const`: a language change replaces the panel wholesale (see
  // rebuildPanel). Every closure below reads this binding, never a copy.
  let panel = createPanel(ctx);
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
        say(t('app.refreshFailed'), 'error');
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
  function beginSetup(providerId: string, origin: 'coach' | 'row' = 'row'): void {
    const provider = findProvider(store.get().snapshot, providerId);
    const action = provider?.setupAction ?? null;
    if (!action) return;

    if (needsConsent(action)) {
      awaitingConsent = providerId;
      consentOrigin = origin;
      store.set({
        notice: null,
        coachMessage: null,
        consent: {
          providerId,
          providerName: provider?.displayName ?? '',
          label: action.label,
          detail: action.detail,
          paragraphs: action.consent,
          origin,
        },
      });
      return;
    }
    void runSetup(providerId, false, origin);
  }

  /**
   * "Şimdi değil" on the first-run card. Optimistic — the card closes on the
   * press — and persisted, so it does not come back after a restart. A failed
   * write is said, but the card stays closed for this session: re-showing a
   * suggestion the user just declined would be the worse outcome.
   */
  /**
   * Settings → Genel "Tanıtımı yeniden göster": the stored answer is taken
   * back, so the introduction starts again from the welcome on the main list.
   */
  async function replayOnboarding(): Promise<void> {
    store.set({ setupCoachDismissed: false, onboardingStep: 0, coachMessage: null, view: 'main', notice: null });
    panel.focusView('main');
    const ok = await bridge.setSetupCoachDismissed(false);
    if (!ok && bridge.available) say(t('app.coachNotSaved'), 'error');
  }

  async function dismissCoach(): Promise<void> {
    store.set({ setupCoachDismissed: true, coachMessage: null });
    const ok = await bridge.setSetupCoachDismissed(true);
    if (!ok && bridge.available) say(t('app.coachNotSaved'), 'error');
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
      store.set({ order: null });
      say(t('app.orderNotSaved'), 'error');
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
      store.set({ order: null });
      say(t('app.orderNotPersisted'), 'error');
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

  /** Straight into settings on a given tab (the empty state's "Araçları seç"). */
  function openSettings(tab: SettingsTab): void {
    store.set({ view: 'settings', settingsTab: tab, notice: null, revertedId: null });
    panel.focusView('settings');
  }

  // --- add / remove a provider -------------------------------------------

  /**
   * The newest add/remove asked of main, per provider, and when we asked.
   * `at` is what separates main's answer from a snapshot that was already in
   * flight when the switch was flipped — the same problem `orderRequest`
   * solves for the drag.
   */
  const enabledRequests = new Map<string, { enabled: boolean; at: number }>();
  /** The newest plan-label write per tool, so an older reply cannot revert it. */
  const planRequests = new Map<string, number>();

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
  /**
   * The plan the user says they are on. PERSIST THEN APPLY, and put the control
   * back if main wrote nothing.
   *
   * Mirrors applyEnabled: a per-provider request stamp so a second edit of the
   * SAME field owns the outcome from then on, a pending flag while the write is
   * in flight, and on refusal a revert flag held briefly so the change is SEEN
   * plus a notice that says what happened. The difference from applyEnabled is
   * that there is no optimistic override to undo — the field holds what the user
   * typed, and `settings.ts` re-reads it from the next snapshot, so a refusal
   * puts the stored value back rather than a value this function remembers.
   */
  async function applyPlanLabel(providerId: string, label: string): Promise<void> {
    const at = Date.now();
    planRequests.set(providerId, at);
    const state = store.get();
    store.set({
      planPending: state.planPending.includes(providerId)
        ? state.planPending
        : [...state.planPending, providerId],
      notice: null,
      planReverted: null,
    });

    const ok = await bridge.setPlanLabel(providerId, label);

    if (planRequests.get(providerId) !== at) return;
    planRequests.delete(providerId);
    store.set({ planPending: withoutId(store.get().planPending, providerId) });
    if (ok) return;

    store.set({ planReverted: providerId });
    say(t('app.planNotSaved', { name: nameOf(providerId) }), 'error');
    window.setTimeout(() => {
      if (store.get().planReverted === providerId) store.set({ planReverted: null });
    }, 1_600);
  }

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
    store.set({ enabledOverride: override, revertedId: providerId });
    say(t('app.enabledNotSaved', { name: nameOf(providerId) }), 'error');
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
    store.set({ enabledOverride: next });
    if (stranded) say(t('app.enabledNotPersisted'), 'error');
  }

  // --- theme --------------------------------------------------------------

  /**
   * The newest theme asked of main, and when. Same shape as `orderRequest`:
   * it is what separates main's answer from a preference push that was already
   * in flight when the radio was pressed.
   */
  let themeRequest: { theme: ThemeChoice; at: number } | null = null;
  /**
   * The theme main is KNOWN to hold: the frame-one value, then only an ok reply
   * or a PREFERENCES push. A failure reverts to this, never to whatever the
   * store showed at click time — after two quick picks that value is the first
   * pick, which main may never have persisted.
   */
  let confirmedTheme: ThemeChoice = theme.choice();

  /**
   * Optimistic, then reconciled — the palette flips on the gesture and main is
   * asked afterwards. `{ok:false}` is defined by the contract as "nothing
   * changed anywhere", so a failure puts the OLD theme back on the document as
   * well as in the radio group: leaving the new palette on screen would show a
   * setting that will not survive a restart.
   */
  async function applyTheme(next: ThemeChoice): Promise<void> {
    if (next === store.get().theme) return;

    // Identity, not the timestamp, says which request is newest: two picks in
    // the same millisecond must still be told apart.
    const request = { theme: next, at: Date.now() };
    themeRequest = request;
    theme.apply(next);
    store.set({ theme: next, themePending: true, themeReverted: false, notice: null });

    const ok = await bridge.setTheme(next);
    // An ok reply confirms THIS value was persisted, even when a newer pick has
    // since replaced it on screen: if that newer pick then fails, this is what
    // main holds and what the revert must show.
    if (ok) confirmedTheme = next;

    // A newer pick owns the choice from here on; this call must not undo it.
    if (themeRequest !== request) return;
    themeRequest = null;
    store.set({ themePending: false });
    if (ok) return;

    const previous = confirmedTheme;
    theme.apply(previous);
    store.set({ theme: previous, themeReverted: true });
    say(t('app.themeNotSaved'), 'error');
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
  function acceptPreferences(prefs: Preferences): void {
    acceptLanguage(prefs);
    acceptAutostart(prefs);
    acceptTrayView(prefs);
    acceptGauge(prefs);
    acceptReduceTransparency(prefs);
    // Main's persisted answer. Only ever moves the card SHUT from here: a push
    // that crossed a "Şimdi değil" in flight must not re-open it under the user.
    if (prefs.setupCoachDismissed && !store.get().setupCoachDismissed) {
      store.set({ setupCoachDismissed: true });
    }
    const choice = prefs.theme;
    // A push is main's persisted state, so it confirms even while a pick is in
    // flight and is not yet drawn.
    confirmedTheme = choice;
    if (themeRequest !== null) return;
    if (choice === store.get().theme) return;
    theme.apply(choice);
    store.set({ theme: choice });
  }

  // --- start with Windows ---------------------------------------------------

  /** The newest autostart value asked of main. Same shape as themeRequest. */
  let autostartRequest: { enabled: boolean; at: number } | null = null;
  /** Same role as `confirmedTheme`: what main is known to hold. */
  let confirmedAutostart: boolean = store.get().autostart;

  /**
   * Optimistic, then reconciled, exactly like applyTheme: the switch moves on
   * the gesture and main is asked afterwards. `{ok:false}` means nothing
   * changed anywhere, so the switch goes back to what main holds, flashes, and
   * the notice says so. Main also rebuilds the tray menu, so its checkbox and
   * this switch cannot disagree.
   */
  async function applyAutostart(next: boolean): Promise<void> {
    if (next === store.get().autostart) return;

    const request = { enabled: next, at: Date.now() };
    autostartRequest = request;
    store.set({ autostart: next, autostartPending: true, autostartReverted: false, notice: null });

    const ok = await bridge.setAutostart(next);
    if (ok) confirmedAutostart = next;

    // A newer press owns the switch from here on; this call must not undo it.
    if (autostartRequest !== request) return;
    autostartRequest = null;
    store.set({ autostartPending: false });
    if (ok) return;

    store.set({ autostart: confirmedAutostart, autostartReverted: true });
    say(t('app.autostartNotSaved'), 'error');
    window.setTimeout(() => {
      if (store.get().autostartReverted) store.set({ autostartReverted: false });
    }, 1_600);
  }

  /**
   * Main's value, pushed — after this panel's own change, or after the tray
   * menu's checkbox moved it. Adopted unless a press is still in flight, for
   * the reason acceptPreferences gives for the theme.
   */
  function acceptAutostart(prefs: Preferences): void {
    if (prefs.autostartByWindows !== store.get().autostartByWindows) {
      store.set({ autostartByWindows: prefs.autostartByWindows });
    }
    confirmedAutostart = prefs.autostart;
    if (autostartRequest !== null) return;
    if (prefs.autostart !== store.get().autostart) store.set({ autostart: prefs.autostart });
  }

  // --- Görünüm: tray icon or taskbar strip ---------------------------------

  /** The newest tray view asked of main. Same shape as autostartRequest. */
  let trayViewRequest: { view: TrayView; at: number } | null = null;
  /** Same role as `confirmedAutostart`: what main is known to hold. */
  let confirmedTrayView: TrayView = store.get().trayView;

  /**
   * Optimistic, then reconciled, exactly like applyAutostart. Main shows or
   * removes the strip and pushes PREFERENCES; a strip that cannot be shown
   * here is not a refusal — it comes back as `stripAvailable: false` and the
   * option says so.
   */
  async function applyTrayView(next: TrayView): Promise<void> {
    if (next === store.get().trayView) return;

    const request = { view: next, at: Date.now() };
    trayViewRequest = request;
    store.set({ trayView: next, trayViewPending: true, trayViewReverted: false, notice: null });

    const ok = await bridge.setTrayView(next);
    if (ok) confirmedTrayView = next;

    if (trayViewRequest !== request) return;
    trayViewRequest = null;
    store.set({ trayViewPending: false });
    if (ok) return;

    store.set({ trayView: confirmedTrayView, trayViewReverted: true });
    say(t('app.trayViewNotSaved'), 'error');
    window.setTimeout(() => {
      if (store.get().trayViewReverted) store.set({ trayViewReverted: false });
    }, 1_600);
  }

  /** Main's value, pushed. Adopted unless a pick is still in flight. */
  function acceptTrayView(prefs: Preferences): void {
    if (prefs.stripAvailable !== store.get().stripAvailable) {
      store.set({ stripAvailable: prefs.stripAvailable });
    }
    if (prefs.stripNoRoom !== store.get().stripNoRoom) {
      store.set({ stripNoRoom: prefs.stripNoRoom });
    }
    confirmedTrayView = prefs.trayView;
    if (trayViewRequest !== null) return;
    if (prefs.trayView !== store.get().trayView) store.set({ trayView: prefs.trayView });
  }

  // --- Görünüm: bars or activity rings -------------------------------------

  /** The newest gauge asked of main. Same shape as trayViewRequest. */
  let gaugeRequest: { gauge: Gauge; at: number } | null = null;
  /** Same role as `confirmedTheme`: what main is known to hold. */
  let confirmedGauge: Gauge = store.get().gauge;

  /**
   * Optimistic, then reconciled, exactly like applyTheme: the meters change on
   * the gesture and main is asked afterwards. `{ok:false}` means nothing
   * changed anywhere, so the OLD gauge goes back on the document as well as in
   * the radio group: leaving rings on screen would show a setting that will
   * not survive a restart.
   */
  async function applyGauge(next: Gauge): Promise<void> {
    if (next === store.get().gauge) return;

    const request = { gauge: next, at: Date.now() };
    gaugeRequest = request;
    paintGauge(next);
    store.set({ gauge: next, gaugePending: true, gaugeReverted: false, notice: null });

    const ok = await bridge.setGauge(next);
    if (ok) confirmedGauge = next;

    if (gaugeRequest !== request) return;
    gaugeRequest = null;
    store.set({ gaugePending: false });
    if (ok) return;

    paintGauge(confirmedGauge);
    store.set({ gauge: confirmedGauge, gaugeReverted: true });
    say(t('app.gaugeNotSaved'), 'error');
    window.setTimeout(() => {
      if (store.get().gaugeReverted) store.set({ gaugeReverted: false });
    }, 1_600);
  }

  /** Main's value, pushed. Adopted unless a pick is still in flight. */
  function acceptGauge(prefs: Preferences): void {
    confirmedGauge = prefs.gauge;
    if (gaugeRequest !== null) return;
    if (prefs.gauge === store.get().gauge) return;
    paintGauge(prefs.gauge);
    store.set({ gauge: prefs.gauge });
  }

  // --- Görünüm: "Saydamlığı azalt" -----------------------------------------

  /** The newest value asked of main. Same shape as gaugeRequest. */
  let glassRequest: { reduce: boolean; at: number } | null = null;
  /** Same role as `confirmedGauge`: what main is known to hold. */
  let confirmedReduce: boolean = store.get().reduceTransparency;

  /**
   * Optimistic, then reconciled, exactly like applyGauge: the glass goes
   * opaque (or comes back) on the gesture and main is asked afterwards.
   * `{ok:false}` puts the old value back on the document as well as on the
   * switch, so the screen never shows a choice that will not survive a
   * restart.
   */
  async function applyReduceTransparency(next: boolean): Promise<void> {
    if (next === store.get().reduceTransparency) return;

    const request = { reduce: next, at: Date.now() };
    glassRequest = request;
    paintGlass(next, store.get().systemReducedTransparency);
    store.set({ reduceTransparency: next, reduceTransparencyPending: true, reduceTransparencyReverted: false, notice: null });

    const ok = await bridge.setReduceTransparency(next);
    if (ok) confirmedReduce = next;

    if (glassRequest !== request) return;
    glassRequest = null;
    store.set({ reduceTransparencyPending: false });
    if (ok) return;

    paintGlass(confirmedReduce, store.get().systemReducedTransparency);
    store.set({ reduceTransparency: confirmedReduce, reduceTransparencyReverted: true });
    say(t('app.reduceTransparencyNotSaved'), 'error');
    window.setTimeout(() => {
      if (store.get().reduceTransparencyReverted) store.set({ reduceTransparencyReverted: false });
    }, 1_600);
  }

  /**
   * Main's values, pushed. Windows' half is adopted at once (it is not the
   * user's to revert); the user's half unless a flip is still in flight.
   */
  function acceptReduceTransparency(prefs: Preferences): void {
    confirmedReduce = prefs.reduceTransparency;
    const system = prefs.systemReducedTransparency;
    const reduce = glassRequest !== null ? store.get().reduceTransparency : prefs.reduceTransparency;
    const current = store.get();
    if (reduce === current.reduceTransparency && system === current.systemReducedTransparency) return;
    paintGlass(reduce, system);
    store.set({ reduceTransparency: reduce, systemReducedTransparency: system });
  }

  // --- language -----------------------------------------------------------

  /** The newest language asked of main, and when. Same shape as themeRequest. */
  let languageRequest: { language: LanguageChoice; at: number } | null = null;
  /** Same role as `confirmedTheme`: what main is known to hold. */
  let confirmedLanguage: LanguageChoice = store.get().language;

  /**
   * Ask main to persist a language choice.
   *
   * Only the RADIO is optimistic. The words on screen do not change here: main
   * re-resolves 'system', rebuilds the tray tooltip and menu, re-publishes the
   * snapshot with translated setup text, and pushes PREFERENCES — and that push
   * (acceptLanguage) is what switches the panel. Switching ahead of it could
   * put an English panel beside a Turkish tooltip, which is the one outcome
   * ADR-004 names.
   *
   * `{ok:false}` means nothing changed anywhere, so the radio goes back and the
   * user is told, in the language still on screen.
   */
  async function applyLanguage(next: LanguageChoice): Promise<void> {
    if (next === store.get().language && languageRequest === null) return;

    const request = { language: next, at: Date.now() };
    languageRequest = request;
    store.set({ language: next, languagePending: true, languageReverted: false, notice: null });

    const ok = await bridge.setLanguage(next);
    if (ok) confirmedLanguage = next;

    // A newer pick owns the choice from here on; this call must not undo it.
    if (languageRequest !== request) return;
    languageRequest = null;
    store.set({ languagePending: false });
    if (ok) return;

    store.set({ language: confirmedLanguage, languageReverted: true });
    say(t('app.languageNotSaved'), 'error');
    window.setTimeout(() => {
      if (store.get().languageReverted) store.set({ languageReverted: false });
    }, 1_600);
  }

  /**
   * Main's language, pushed. The choice follows the push unless the user has a
   * different pick in flight; the RESOLVED language and format locale always
   * follow it, because main is the only resolver and the tooltip it just
   * rewrote is already in that language.
   */
  function acceptLanguage(prefs: Preferences): void {
    confirmedLanguage = prefs.language;
    if (languageRequest === null || languageRequest.language === prefs.language) {
      if (prefs.language !== store.get().language) store.set({ language: prefs.language });
    }
    if (prefs.resolvedLanguage === language() && prefs.formatLocale === formatLocale()) return;

    // Where focus was decides where it goes back. The radio the user just
    // pressed is destroyed with the old panel; leaving focus to fall to <body>
    // would drop a keyboard user out of the dialog on every language change.
    const active = document.activeElement;
    const inLanguage = active instanceof Element && active.closest('.theme--language') !== null;
    const inPanel = active instanceof Element && panel.el.contains(active);

    applyLocale(prefs);
    dropConsentForLanguageChange();
    rebuildPanel();

    if (inLanguage) panel.focusLanguage();
    else if (inPanel) panel.focus();
  }

  /**
   * An open consent prompt does not survive a language change: it is CLEARED,
   * not rebuilt.
   *
   * Rebuilding it from the snapshot looks kinder and is not safe. The prompt's
   * words are main's `setupAction` text, and on a language change main
   * re-publishes the snapshot on its own schedule — the PREFERENCES push can
   * land before it, so "rebuild now" would re-show the OLD language, and
   * "rebuild when the snapshot lands" would show whatever action main carries
   * by then, which may not be the action the user pressed, or none. Either way
   * the user could be asked to consent to something they did not ask about.
   * Clearing cannot do that: nothing ran (setup only runs from Confirm), the
   * notice says so in the new language, and the setup button is still there.
   */
  function dropConsentForLanguageChange(): void {
    if (awaitingConsent === null) return;
    awaitingConsent = null;
    store.set({ consent: null });
    say(t('app.setupCancelled'), 'info');
  }

  /**
   * Replace the panel with one built in the current language.
   *
   * A rebuild rather than a re-render because most words are written once, at
   * construction (labels, help text, aria names), and chasing every one of
   * them into an update path is a second copy of the build that would drift.
   * State lives in the store and in `ctx`, so nothing the user did is lost:
   * view, pin, order and switch overrides, pending flags, the dismissed coach.
   * What is NOT carried is purely local disclosure state (an expanded cost or
   * quota block, the open settings section — which focusLanguage reopens).
   *
   * Opened BEFORE it is attached, so the entrance transition does not replay:
   * the element's first computed style is already the open one.
   */
  function rebuildPanel(): void {
    const open = store.get().open;
    panel.destroy();
    panel = createPanel(ctx);
    panel.setOpen(open);
    container.appendChild(panel.el);
    render();
    requestAnimationFrame(() => panel.enableAnimation());
  }

  async function runSetup(providerId: string, confirmed: boolean, origin: 'coach' | 'row' = 'row'): Promise<void> {
    if (store.get().busy.includes(providerId)) return;
    store.markBusy(providerId, true);
    store.set({ notice: null, coachMessage: null });
    try {
      const result = await bridge.runSetup(providerId, confirmed);
      const message = trimMessage(result.message);
      if (result.ok) {
        say(message || t('app.setupConnected'), 'success');
        // Connected from the first-run card: it has done its job and must not
        // come back if the user later disconnects.
        if (origin === 'coach') void dismissCoachQuietly();
        const snapshot = await bridge.requestRefresh();
        if (snapshot) acceptSnapshot(snapshot);
      } else if (origin === 'coach') {
        // The failure is read where the user acted, and the card stays.
        store.set({ coachMessage: t('coach.failed', { message: message || t('app.setupFailed') }) });
      } else {
        say(message || t('app.setupFailed'), 'error');
      }
    } finally {
      store.markBusy(providerId, false);
    }
  }

  /** The first-run card after a successful connect: shut, and remembered. */
  async function dismissCoachQuietly(): Promise<void> {
    store.set({ setupCoachDismissed: true });
    await bridge.setSetupCoachDismissed(true);
  }

  /**
   * Same busy guard and notice as runSetup. Reached only from the settings
   * item's own confirmation box, after its confirm button.
   */
  async function disconnectProvider(providerId: string): Promise<void> {
    if (store.get().busy.includes(providerId)) return;
    store.markBusy(providerId, true);
    store.set({ notice: null });
    try {
      const result = await bridge.disconnectProvider(providerId, true);
      const message = trimMessage(result.message);
      if (message) say(message, result.ok ? 'success' : 'error');
      const snapshot = await bridge.requestRefresh();
      if (snapshot) acceptSnapshot(snapshot);
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
  disposers.push(bridge.onPreferences((prefs) => acceptPreferences(prefs)));
  // Replays the entrance on EVERY open, not just at app start.
  //
  // The window lives always-composited and is revealed by moving on-screen and
  // concealed by moving off-screen (main's `_reveal`/`_conceal`), so `data-open`
  // no longer flips on its own between opens — without this the panel would just
  // pop into place. Main sends `false` while the window is OFF-SCREEN, so the
  // closed visual state is set invisibly; the following `true` then has a clean
  // false->true transition to grow in on screen. `prefers-reduced-motion`
  // collapses that transition to ~1ms automatically, because it is the same
  // token-driven `data-open` path the first-paint entrance uses.
  //
  // The first-paint entrance above stays the app-start entrance; the first
  // reveal after launch finds `data-open` already true and is a no-op, so
  // startup plays exactly one entrance and this never double-fires it.
  disposers.push(bridge.onPanelVisibility((open) => panel.setOpen(open)));
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
