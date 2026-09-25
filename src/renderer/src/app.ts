/**
 * Application wiring: bridge -> store -> panel, plus the open/close
 * choreography, the consent gate and the 1Hz clock.
 *
 * Exported as `mountApp` so the dev harness can mount the exact same panel
 * against a mock bridge. There is no second rendering path.
 */

import type {
  LanguageChoice,
  Preferences,
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
import { formatLocale, language, setLocale, t } from './i18n.js';
import { defaultFormatLocale, fallbackLanguage, pendingUsageOf } from './sanitize.js';
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
  document.title = 'Usage Notch';
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
  store.set({
    theme: theme.choice(),
    language: initialPrefs?.language ?? 'system',
    autostart: initialPrefs?.autostart ?? true,
    autostartByWindows: initialPrefs?.autostartByWindows ?? false,
  });
  disposers.push(() => theme.destroy());
  let closing = false;
  /** Provider whose consent prompt is currently open, if any. */
  let awaitingConsent: string | null = null;

  const ctx: PanelContext = {
    generatedAt: null,
    staleOverride: false,
    isBusy: (id) => store.get().busy.includes(id),
    isPending: (id) => pendingUsageOf(store.get().snapshot).includes(id),
    onRetry: (providerId) => void runRefresh(providerId),
    onSetup: (providerId) => beginSetup(providerId),
    // ADR-003 A8 (Phase B). All three are write-only asks: main owns the
    // window, the local store and the URL. The renderer never holds a key and
    // never builds a URL, so there is nothing to get wrong here.
    onAddKey: (providerId) => void bridge.requestKeyEntry(providerId),
    // The ONE of the three whose answer matters, so it is the one that is read.
    // The confirm step promises "only the local copy is deleted", and until now
    // the boolean saying whether that happened was dropped on the floor: a
    // failed delete left a DPAPI credential on disk behind a dialog the user had
    // just been shown, with nothing said. `callKeyChannel` never rejects — it
    // returns false for a refusal and for a main that cannot do it — so one
    // branch covers both. Revocation is named because it is the only remedy that
    // works whether or not the file went, which is the same reason the
    // uninstaller's message carries it.
    onPlanLabel: (providerId, label) => void applyPlanLabel(providerId, label),
    onRemoveKey: (providerId) => {
      void bridge.removeKey(providerId).then((ok) => {
        if (!ok) store.set({ notice: t('app.keyRemoveFailed') });
      });
    },
    onOpenTokenPage: (providerId) => void bridge.openTokenPage(providerId),
    onRefreshKey: (providerId) => bridge.refreshKey(providerId),
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
    onLanguageChange: (choice) => void applyLanguage(choice),
    onAutostartChange: (enabled) => void applyAutostart(enabled),
    coachDismissed: false,
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
      store.set({ consent: null, notice: t('app.setupCancelled') });
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
        store.set({ notice: t('app.refreshFailed') });
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

    // A key-sourced row's "Add" is the key flow itself. That flow asks for
    // consent in its own window, so no second confirmation is shown here.
    if (action.kind === 'add-api-key') {
      void bridge.requestKeyEntry(providerId);
      return;
    }

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
        notice: t('app.orderNotSaved'),
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
      store.set({ order: null, notice: t('app.orderNotPersisted') });
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

    store.set({
      planReverted: providerId,
      notice: t('app.planNotSaved', { name: nameOf(providerId) }),
    });
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
    store.set({
      enabledOverride: override,
      revertedId: providerId,
      notice: t('app.enabledNotSaved', { name: nameOf(providerId) }),
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
        ? t('app.enabledNotPersisted')
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
    store.set({
      theme: previous,
      themeReverted: true,
      notice: t('app.themeNotSaved'),
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
  function acceptPreferences(prefs: Preferences): void {
    acceptLanguage(prefs);
    acceptAutostart(prefs);
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

    store.set({
      autostart: confirmedAutostart,
      autostartReverted: true,
      notice: t('app.autostartNotSaved'),
    });
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

    store.set({
      language: confirmedLanguage,
      languageReverted: true,
      notice: t('app.languageNotSaved'),
    });
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
    store.set({ consent: null, notice: t('app.setupCancelled') });
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

  async function runSetup(providerId: string, confirmed: boolean): Promise<void> {
    if (store.get().busy.includes(providerId)) return;
    store.markBusy(providerId, true);
    store.set({ notice: null });
    try {
      const result = await bridge.runSetup(providerId, confirmed);
      const message = trimMessage(result.message);
      store.set({
        notice: message || (result.ok ? t('app.setupConnected') : t('app.setupFailed')),
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
