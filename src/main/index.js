'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, dialog, nativeTheme, BrowserWindow } = require('electron');

const { IPC, IPC_EXT, IPC_STRIP } = require('../shared/contract');
const { Collector } = require('../core/collector');
const { isProviderId, getProvider } = require('../core/providers');
const { sanitizeOrder } = require('../core/order');
const { withEnabled } = require('../core/enabled');
const { isTheme } = require('../core/theme');
const { createSetPlanLabelHandler } = require('./plan-label-ipc');
const i18n = require('../core/i18n');
const { traySpecFromSnapshot, trayIconKey } = require('../core/tray-spec');
const { buildTooltip } = require('../core/tray-tooltip');
const paths = require('../core/paths');
const { isAntigravityRunning } = require('../core/antigravity/process');
const log = require('../core/log');
const security = require('./security');
const settingsStore = require('./settings');
const { PanelWindow } = require('./panel-window');
const { TrayController } = require('./tray');
const {
  osLocale,
  createSetLanguageHandler,
  createLocaleResolver,
  createApplyLanguage,
  createPreferences,
} = require('./language-ipc');
const { createSetAutostartHandler, createSetSetupCoachDismissedHandler } = require('./autostart-ipc');
const { createRefreshHandler } = require('./refresh-ipc');
const { buildTrayImage } = require('./tray-icon');
const {
  runClaudeSetup,
  runAntigravitySetup,
  materialiseBridge,
  bridgeInstallPath,
  runDisconnect,
  hookInstalled,
  cleanupIntegrations,
  BRIDGE_SCRIPTS,
} = require('./bridge-install');
const { isStoreBuild, pinUserData } = require('./packaging');
const { migrateLegacyLoginItem, disabledByWindows, loginItemSettings } = require('./login-item');
const { runUninstallPrompt, promptLook } = require('./uninstall-prompt');
const { TaskbarStrip } = require('./taskbar-strip');
const { DisplayLayer } = require('./taskbar-display');
const { createSetTrayViewHandler } = require('./tray-view-ipc');
const { sanitizeTrayView } = require('../core/tray-view');
const { createSetGaugeHandler } = require('./gauge-ipc');
const { createSetReduceTransparencyHandler } = require('./reduce-transparency-ipc');

// userData is %APPDATA%\usage-notch by name, whatever the product is called
// (packaging.js). First, before the early exits below and the single-instance
// lock, which all read it. No module required above reads it at load time.
pinUserData(app);

// Must run before `ready`: some of it is command-line switches.
security.applyAll();

// Uninstall (build/installer.nsh): take our hooks out of Claude Code's and
// agy's settings, putting the user's own status line back, then exit. Before
// the single-instance lock: the uninstaller has already closed the app.
if (process.argv.includes('--cleanup-integrations')) {
  cleanupIntegrations();
  app.exit(0);
  return;
}

// Windows "Kaldır" runs the uninstaller silently with --ask; its customUnInit
// starts this and waits (build/installer.nsh). Ask in the app's own look and
// answer through the exit code (uninstall-prompt.js). Before the single-
// instance lock; the uninstaller has already closed the tray app.
if (process.argv.includes('--uninstall-ask')) {
  app.whenReady().then(async () => {
    const { lang, theme } = promptLook(settingsStore.load(userDataDir()), osLocale(app), nativeTheme.shouldUseDarkColors);
    const code = await runUninstallPrompt({ BrowserWindow, t: i18n.t, lang, theme, log });
    app.exit(code);
  }).catch((err) => {
    // No question could be shown: remove the app but keep the data, the
    // answer that loses nothing.
    log.warn(`uninstall prompt failed: code=${(err && err.code) || 'UNKNOWN'}`);
    app.exit(1);
  });
  return;
}

// A second instance would fight over the tray icon and the store file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let panel = null;
let tray = null;
/** The taskbar strip; built at bootstrap, shown only when trayView is 'strip'. */
let strip = null;
let collector = null;
let settings = null;
let isQuitting = false;
/** Last icon actually drawn, and last tooltip actually set. See updateTray(). */
let trayIconDrawnKey = null;
let trayTooltipShown = null;
/** The resolved language and format locale. See refreshLocale(). */
let locale = null;

/**
 * Upper bound on a SET_ORDER payload. The registry has five providers; anything
 * an order of magnitude past that is a malformed or hostile message, not a
 * user dragging rows, and there is no reason to sanitise a list of any length.
 */
const MAX_ORDER_LENGTH = 64;

function userDataDir() {
  return app.getPath('userData');
}

/* ------------------------------------------------------------------ panel */

function anchorSender(anchor) {
  if (panel) panel.sendAnchor(anchor);
}

/**
 * Tray-click open: activated, but NOT pinned.
 *
 * Unpinned means the panel lives as long as the pointer is over it; the
 * pointer bookkeeping is `PanelWindow`'s, because it is the only object that
 * knows the window rect.
 */
/**
 * What the panel opens against: the tray icon, or the strip while the icon is
 * gone for it (syncTrayPresence). Null lets the panel use its own fallback.
 */
function anchorRect() {
  return (tray && tray.bounds()) || (strip && strip.anchorRect()) || null;
}

function openPanel(anchor = anchorRect()) {
  if (!panel) return;
  panel.open(anchor, anchorSender);
  collector.setPanelOpen(true);
  if (collector.snapshot) panel.send(IPC.SNAPSHOT, collector.snapshot);
}

/** Pinned open: stays until an explicit close or unpin, whatever has focus. */
function openPinned() {
  if (!panel) return;
  panel.pin(anchorRect(), anchorSender);
  collector.setPanelOpen(true);
  if (collector.snapshot) panel.send(IPC.SNAPSHOT, collector.snapshot);
}

/* --------------------------------------------------------- refresh notices */

/**
 * How long the refresh reply may wait for the process probe once the scan is
 * already done. Generous, because it is only ever reached on the path where
 * the answer is worth having.
 */
const PROBE_WAIT_MS = 1200;

/**
 * The probe's answer within PROBE_WAIT_MS, or 'unknown' past it.
 *
 * Only the waiting lives here. WHETHER to probe, whether to wait, and whether
 * the answer becomes a notice are all decided in refresh-ipc.js, against the
 * row in the snapshot the reply actually carries — so a row re-published as
 * live during this wait can never ship beside "Antigravity is not running".
 */
async function awaitAntigravityProbe(probe) {
  let timer = null;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve('unknown'), PROBE_WAIT_MS);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([probe, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ preferences */

// The Preferences object the renderer is entitled to see: the theme
// re-sanitised off disk, the language fields from the current `locale`.
// Built in language-ipc.js, where it is tested.
const preferences = createPreferences({
  getSettings: () => settings,
  currentLocale: () => locale,
  // osLocale(): which Electron APIs report the OS language, and which one is
  // deliberately not used, is documented where it is measured (language-ipc.js).
  readOs: () => osLocale(app),
  storeBuild: () => isStoreBuild(),
  stripAvailable: () => !strip || strip.available(),
  stripNoRoom: () => Boolean(strip && strip.status() === 'no-room'),
  // Windows' "Saydamlık efektleri" off, or high contrast on: the panel's glass
  // goes opaque (Görünüm → "Saydamlığı azalt" says why). Re-read on every
  // build; nativeTheme 'updated' below pushes when either moves.
  systemReducedTransparency: () => systemReducedTransparency(),
});

/** Both nativeTheme reads, guarded: a property this Electron lacks reads as false. */
function systemReducedTransparency() {
  try {
    return nativeTheme.prefersReducedTransparency === true || nativeTheme.inForcedColorsMode === true;
  } catch {
    return false;
  }
}

// Re-resolves the language and hands it to main's t(), so the tray, the dialogs
// and the snapshot's setup text cannot disagree.
const resolveLocale = createLocaleResolver({
  getSettings: () => settings,
  readOs: () => osLocale(app),
  setLocale: i18n.setLocale,
  log,
});

/**
 * Re-reads the OS and the stored choice into `locale`. Called at bootstrap and
 * after a successful SET_LANGUAGE write. Not on every read: the tray tooltip,
 * the menu and the snapshot are built from `locale`, and they must all be built
 * from the same answer the renderer was pushed.
 */
function refreshLocale() {
  locale = resolveLocale();
  return locale;
}

function pushPreferences() {
  if (panel) panel.send(IPC.PREFERENCES, preferences());
}

/* ------------------------------------------------------------ taskbar strip */

/**
 * Settings → Genel → Görünüm. 'strip' adds the taskbar strip, and the tray
 * icon steps aside while it is shown (syncTrayPresence). When the strip cannot
 * be shown here, `enable()` says so,
 * the app simply carries on as 'tray', and the next PREFERENCES push carries
 * `stripAvailable: false` for the settings screen to explain.
 */
function applyTrayView(view) {
  if (!strip) return;
  if (sanitizeTrayView(view) === 'strip') {
    strip.enable();
    if (collector && collector.snapshot) strip.update(collector.snapshot);
  } else {
    strip.disable();
  }
  syncTrayPresence();
}

/**
 * The tray icon is gone while the strip is SHOWN, and back the moment it is
 * not (no room, nothing to show, unavailable, covered, or 'tray' chosen), so
 * there is always one place to click. Removal waits until the strip has been
 * up for TRAY_AWAY_MS, so a strip that blinks on its way up never takes the
 * icon with it; the return is immediate.
 */
const TRAY_AWAY_MS = 1500;
let trayAwayTimer = null;
function syncTrayPresence() {
  // Quitting: the strip's disable() reports a status change on the way out, and
  // the icon is about to be destroyed anyway.
  if (!tray || isQuitting) return;
  const stripUp = () => Boolean(strip && sanitizeTrayView(settings.trayView) === 'strip' && strip.status() === 'shown');
  if (!stripUp()) {
    if (trayAwayTimer) { clearTimeout(trayAwayTimer); trayAwayTimer = null; }
    if (tray.setPresent(true) === 'created') {
      // A new icon starts as the static PNG with the default tooltip.
      trayIconDrawnKey = null;
      trayTooltipShown = null;
      if (collector && collector.snapshot) updateTray(collector.snapshot);
    }
    return;
  }
  if (!tray.present() || trayAwayTimer) return;
  trayAwayTimer = setTimeout(() => {
    trayAwayTimer = null;
    if (stripUp()) tray.setPresent(false);
  }, TRAY_AWAY_MS);
  if (trayAwayTimer.unref) trayAwayTimer.unref();
}

/**
 * A left click on the strip: the tray click's toggle, anchored to the strip
 * itself, so the panel opens above it and its corridor runs from the strip.
 */
/** A strip release and a covered-click report for the same press are one click. */
const STRIP_CLICK_COALESCE_MS = 400;
let lastStripClickAt = -Infinity;

function openFromStrip() {
  if (!panel) return;
  const now = Date.now();
  if (now - lastStripClickAt < STRIP_CLICK_COALESCE_MS) {
    log.trace('strip.click', { act: 'coalesced', sinceMs: now - lastStripClickAt });
    return;
  }
  lastStripClickAt = now;
  const visible = panel.isVisible();
  const pending = panel.hidePending();
  const act = !visible || pending ? 'open' : 'hide';
  log.trace('strip.click', { visible, hidePending: pending, act });
  if (act === 'hide') panel.hide('strip-toggle');
  // Not pinned, like a tray click: the panel now anchors to the strip
  // (anchorRect), so the strip-to-panel corridor keeps it open while the
  // pointer travels up (owner, 2026-10-20: it opened with the pin on).
  else openPanel((strip && strip.anchorRect()) || anchorRect());
}

/* -------------------------------------------------------------------- ipc */

/** The strip's two clicks are taken from the strip's own page only. */
function fromStrip(event) {
  return Boolean(strip && strip.isSender(event.sender));
}

/** Every handler drops messages that did not come from our own panel. */
function fromPanel(event) {
  return Boolean(
    panel && panel.win && !panel.win.isDestroyed() && event.sender === panel.win.webContents,
  );
}

function registerIpc() {
  // Synchronous, and answered from memory: the renderer calls this during its
  // first paint, so it must never touch the disk or wait on a scan.
  ipcMain.on(IPC_EXT.INITIAL_SNAPSHOT, (event) => {
    // `returnValue` must be set on every path, including rejection — leaving
    // it unset blocks the calling renderer.
    event.returnValue = fromPanel(event) && collector ? (collector.snapshot || null) : null;
  });

  // Synchronous for the same reason INITIAL_SNAPSHOT is, and with more at
  // stake: a theme applied after first paint is a visible flash of the wrong
  // one. `returnValue` is assigned on every path, rejection included — an
  // ipcMain listener that returns without setting it blocks the renderer
  // forever, which on this channel would be a panel that never paints at all.
  // A brand-new install with no settings.json yet returns a CONCRETE
  // `{theme:'system'}`, never null: `settings` is loaded in bootstrap() before
  // this window exists, and `load()` answers a missing file with defaults. The
  // renderer would survive null — it falls back — but then two independent
  // fallbacks would have to stay in step for ever, and the render fixture
  // returns an object. null here means one thing only: this sender is not our
  // panel.
  ipcMain.on(IPC_EXT.INITIAL_PREFERENCES, (event) => {
    event.returnValue = fromPanel(event) ? preferences() : null;
  });

  ipcMain.on(IPC.PANEL_OPENED, (event) => {
    if (!fromPanel(event)) return;
    log.trace('ipc.panelOpened', { visible: panel.isVisible() });
    // A HINT ABOUT THE POINTER, not a statement about it. The renderer sends
    // this on mount as well as on its own pointer events, and a renderer
    // cannot see the OS cursor — so main verifies it against the cursor before
    // it counts for anything. Believing it verbatim latched "the pointer has
    // been inside" while the pointer was still on the tray icon, and the next
    // poll then dismissed the panel the user had just opened. See
    // `PanelWindow.notePointerInside`.
    panel.notePointerInside();

    // The contract calls this a HINT, and it has to be treated as one. The
    // renderer sends it while mounting, which happens on did-finish-load —
    // with the window still hidden, because it is created show:false and
    // loaded at startup. Believing it there pins panelOpen true for the whole
    // session: the 15s cadence never drops back to 60s and the watcher gating
    // below never engages. Main owns the answer to "is the panel on screen",
    // so main decides.
    if (panel.isVisible()) collector.setPanelOpen(true);
  });

  ipcMain.on(IPC.PANEL_CLOSE, (event) => {
    if (!fromPanel(event)) return;
    panel.hide('ipc-close');
    collector.setPanelOpen(false);
  });

  // The transparent space around the panel lets clicks through to other
  // apps; the window takes the mouse only while the pointer is over the
  // painted panel (panel-window.js setPointerOverPanel).
  ipcMain.on(IPC.PANEL_HIT, (event, over) => {
    if (!fromPanel(event)) return;
    panel.setPointerOverPanel(over === true);
  });

  /**
   * A TOGGLE, because the control in the panel is one.
   *
   * The renderer calls this `onPinToggle` and takes its answer from the next
   * ANCHOR push (`mode: 'pin' | 'hover'`); it never assumes it succeeded. Main
   * previously only ever pinned, so the button was a one-way door: once
   * pressed, nothing short of closing the panel could undo it, and pinning is
   * now the state that survives everything.
   */
  ipcMain.on(IPC.PANEL_PIN, (event) => {
    if (!fromPanel(event)) return;
    if (panel.pinned) panel.unpin(anchorRect(), anchorSender);
    else openPinned();
  });

  /**
   * Persist-then-apply, and deliberately synchronous end to end.
   *
   * Order matters on the failure path: if the settings write fails, NOTHING
   * has changed — not the file, not the collector, not the tray — and the
   * renderer is told so, instead of the panel showing an order that silently
   * reverts on the next launch. `settings` is restored before returning.
   *
   * Being synchronous is what makes two rapid drags safe: main's event loop
   * runs this handler to completion before the next one starts, so there is no
   * window in which two read-modify-write cycles interleave over the same
   * settings object and file.
   */
  ipcMain.handle(IPC.SET_ORDER, (event, ids) => {
    if (!fromPanel(event)) return { ok: false };
    if (!Array.isArray(ids) || ids.length > MAX_ORDER_LENGTH) return { ok: false };

    const applied = sanitizeOrder(ids);
    const previous = settings.providerOrder;
    settings.providerOrder = applied;
    if (!settingsStore.save(userDataDir(), settings)) {
      settings.providerOrder = previous;
      log.warn('provider order could not be persisted; order unchanged');
      return { ok: false };
    }
    // Emits an ordered snapshot, which pushes to the panel and re-renders the
    // tray through the same listener every other update goes through.
    //
    // Wrapped because the contract promises that {ok:false} means the order
    // changed NOWHERE. setOrder() rebuilds and emits synchronously, so a throw
    // anywhere in a snapshot listener would reject this handler AFTER the file
    // was written — the renderer would revert the rows while the settings file
    // held the new order, and the two would disagree until the next launch.
    // No input is known to make it throw; the point is that the guarantee
    // should be structural rather than incidental.
    try {
      collector.setOrder(applied);
    } catch (err) {
      settings.providerOrder = previous;
      // The rollback write can fail too, and then `{ok:false}` is only half
      // true: memory and the panel are back to `previous`, but the FILE still
      // holds the order we just tried to apply, so the next launch would come
      // up with an order the user was told did not take. Not attacker
      // reachable, but it must not pass in silence.
      if (!settingsStore.save(userDataDir(), settings)) {
        log.warn('provider order rollback could not be persisted; settings.json still holds the rejected order');
      }
      try { collector.setOrder(previous); } catch { /* already reported below */ }
      log.warn(`provider order could not be applied: code=${(err && err.code) || 'UNKNOWN'}`);
      return { ok: false };
    }
    return { ok: true };
  });

  /**
   * Adds a provider to the main panel, or removes it.
   *
   * Same persist-then-apply discipline as SET_ORDER, and synchronous for the
   * same reason: main runs this handler to completion before the next one
   * starts, so two rapid toggles cannot interleave two read-modify-write
   * cycles over one settings object and one file.
   *
   * The id is validated against the real registry rather than trusted, and the
   * flag is required to be an actual boolean — a truthy string arriving here
   * would otherwise be persisted as `true` and then dropped by
   * `sanitizeEnabled()` on the next launch, so the row would silently revert.
   */
  ipcMain.handle(IPC.SET_ENABLED, (event, id, enabled) => {
    if (!fromPanel(event)) return { ok: false };
    if (!isProviderId(id)) return { ok: false };
    if (typeof enabled !== 'boolean') return { ok: false };

    const previous = settings.enabledProviders;
    const applied = withEnabled(previous, id, enabled);
    settings.enabledProviders = applied;
    if (!settingsStore.save(userDataDir(), settings)) {
      settings.enabledProviders = previous;
      log.warn('provider enablement could not be persisted; nothing changed');
      return { ok: false };
    }
    // Wrapped for the same reason SET_ORDER is: setEnabled() rebuilds and
    // emits synchronously, so a throw in a snapshot listener would reject this
    // handler AFTER the file was written. The renderer would revert its toggle
    // while the settings file held the new value, and the two would disagree
    // until the next launch. {ok:false} has to mean "nothing changed anywhere".
    try {
      collector.setEnabled(applied);
    } catch (err) {
      settings.enabledProviders = previous;
      // Same half-truth as the SET_ORDER rollback above: a failed rollback
      // write leaves settings.json holding a value the renderer has been told
      // was rejected.
      if (!settingsStore.save(userDataDir(), settings)) {
        log.warn('provider enablement rollback could not be persisted; settings.json still holds the rejected value');
      }
      try { collector.setEnabled(previous); } catch { /* already reported below */ }
      log.warn(`provider enablement could not be applied: code=${(err && err.code) || 'UNKNOWN'}`);
      return { ok: false };
    }
    return { ok: true };
  });

  /**
   * Persist-then-apply, exactly as SET_ORDER and SET_ENABLED do, and
   * synchronous for the same reason: main runs this handler to completion
   * before the next one starts, so two rapid taps on the switch cannot
   * interleave two read-modify-write cycles over one settings object and one
   * file.
   *
   * The value is checked against the three literals rather than coerced. A
   * string that is not one of them is a bug or a hostile message, and
   * persisting it would put the next launch's `load()` in charge of repairing
   * it — which it would, silently, back to 'system', so the user's choice
   * would appear to take and then revert.
   *
   * `{ok:false}` means the theme changed NOWHERE and the renderer must revert.
   */
  ipcMain.handle(IPC.SET_THEME, (event, theme) => {
    if (!fromPanel(event)) return { ok: false };
    if (!isTheme(theme)) return { ok: false };

    const previous = settings.theme;
    settings.theme = theme;
    if (!settingsStore.save(userDataDir(), settings)) {
      settings.theme = previous;
      log.warn('theme could not be persisted; nothing changed');
      return { ok: false };
    }
    // Best effort, and deliberately NOT a rollback trigger. Unlike SET_ORDER
    // this applies nothing in main — there is no icon to redraw and no
    // snapshot to rebuild — so a push that fails costs the renderer an echo of
    // a value it already has, not a disagreement with the file.
    pushPreferences();
    return { ok: true };
  });

  // Persist, then apply; rollback on a failed write. The handler lives in
  // plan-label-ipc.js so the unit tests and the Electron smoke run this exact
  // function rather than a copy of it — it is the validation boundary for free
  // text a person types, so a tested copy would prove nothing.
  ipcMain.handle(IPC.SET_PLAN_LABEL, createSetPlanLabelHandler({
    fromPanel,
    getSettings: () => settings,
    save: (s) => settingsStore.save(userDataDir(), s),
    apply: (providerId, label) => { if (collector) collector.setPlanLabel(providerId, label); },
    log,
  }));

  // Persist, apply, then push; rollback and no push on failure. The handler
  // lives in language-ipc.js so the unit tests and the Electron smoke run this
  // exact function rather than a copy of it.
  ipcMain.handle(IPC.SET_LANGUAGE, createSetLanguageHandler({
    fromPanel,
    getSettings: () => settings,
    save: (s) => settingsStore.save(userDataDir(), s),
    apply: applyLanguage,
    push: pushPreferences,
    log,
  }));

  // Persist, apply, rebuild the tray menu, then push; rollback on a failed
  // write. The handler lives in autostart-ipc.js so the unit tests run this
  // exact function rather than a copy of it. The tray's own checkbox writes the
  // same `settings.autostart` (trayMenuOptions), so both controls show one value.
  ipcMain.handle(IPC.SET_AUTOSTART, createSetAutostartHandler({
    fromPanel,
    getSettings: () => settings,
    save: (s) => settingsStore.save(userDataDir(), s),
    apply: applyAutostart,
    rebuildTrayMenu: () => { if (tray) tray.setMenu(trayMenuOptions()); },
    push: pushPreferences,
    log,
  }));

  // Görünüm: tray icon or taskbar strip. Persist, apply, push; rollback on a
  // failed write. Tested in tray-view-ipc.js's own suite.
  ipcMain.handle(IPC.SET_TRAY_VIEW, createSetTrayViewHandler({
    fromPanel,
    getSettings: () => settings,
    save: (s) => settingsStore.save(userDataDir(), s),
    apply: applyTrayView,
    push: pushPreferences,
    log,
  }));

  // Görünüm: bars or activity rings. Persist, hand it to the taskbar strip
  // (mini rings in its tiles), push; rollback on a failed write. Tested in
  // gauge-ipc.js's suite.
  ipcMain.handle(IPC.SET_GAUGE, createSetGaugeHandler({
    fromPanel,
    getSettings: () => settings,
    save: (s) => settingsStore.save(userDataDir(), s),
    apply: (gauge) => { if (strip) strip.setGauge(gauge); },
    push: pushPreferences,
    log,
  }));

  // Görünüm: "Saydamlığı azalt". Persist, then push; rollback on a failed
  // write. Panel only. Tested in reduce-transparency-ipc.js's suite.
  ipcMain.handle(IPC.SET_REDUCE_TRANSPARENCY, createSetReduceTransparencyHandler({
    fromPanel,
    getSettings: () => settings,
    save: (s) => settingsStore.save(userDataDir(), s),
    push: pushPreferences,
    log,
  }));

  // The strip page's clicks: left opens the panel, right shows the tray menu.
  ipcMain.on(IPC_STRIP.OPEN, (event) => {
    if (!fromStrip(event)) return;
    openFromStrip();
  });
  ipcMain.on(IPC_STRIP.MENU, (event) => {
    if (!fromStrip(event)) return;
    if (tray) tray.popUpMenu();
  });
  // The tile under the pointer, lit by the display layer inside the taskbar.
  ipcMain.on(IPC_STRIP.HOVER, (event, index) => {
    if (!fromStrip(event)) return;
    strip.hover(index);
  });

  // "Şimdi değil" on the first-run card. Persist, then push; nothing to apply.
  ipcMain.handle(IPC.SET_SETUP_COACH_DISMISSED, createSetSetupCoachDismissedHandler({
    fromPanel,
    getSettings: () => settings,
    save: (s) => settingsStore.save(userDataDir(), s),
    push: pushPreferences,
    log,
  }));

  // The probe is started BEFORE the scan so the two overlap: `tasklist` costs
  // about half a second on this machine, and the refresh must not visibly wait
  // for it. The reply is read from the collector AFTER the probe wait, and the
  // notice is judged against that same snapshot, so neither a language
  // re-publish nor a row turning live in that gap is contradicted
  // (refresh-ipc.js).
  ipcMain.handle(IPC.REQUEST_REFRESH, createRefreshHandler({
    fromPanel,
    startProbe: () => isAntigravityRunning(),
    refresh: () => collector.refreshNow(),
    awaitProbe: awaitAntigravityProbe,
    latestSnapshot: () => collector.snapshot,
    log,
  }));

  ipcMain.handle(IPC.RUN_SETUP, async (event, providerId, confirmed) => {
    if (!fromPanel(event)) return { ok: false, message: i18n.t('ipc.invalidRequest') };
    if (!isProviderId(providerId)) {
      return { ok: false, message: i18n.t('ipc.unknownProvider') };
    }
    const provider = getProvider(providerId);

    // A tool that is not on this machine: nothing to set up, and it IS
    // supported, so the answer says so instead of "not supported". Never
    // throws, never writes anything.
    if (provider.setupAction.kind === 'not-installed') {
      return { ok: false, message: i18n.t('provider.notInstalledHint', { provider: provider.displayName }) };
    }

    if (provider.id === 'claude') {
      try {
        // No native modal any more (the panel asked in its own box), so
        // nothing to pin the panel for.
        const result = await runClaudeSetup({ confirmed });
        if (result.ok) collector.rebuild();
        return result;
      } catch (err) {
        log.warn(`setup failed: code=${(err && err.code) || 'UNKNOWN'}`);
        return { ok: false, message: i18n.t('setup.failed') };
      }
    }

    if (provider.id === 'antigravity') {
      try {
        // Pinned ONLY on the path that raises a modal — now just the agy
        // download dialog — via a hook the setup calls right before it: an
        // unpinned panel closes once the pointer leaves it, and the pointer
        // has to leave it to answer the dialog. A setup that turns out to be a
        // no-op does not leave the panel in a state the user never chose. It
        // stays pinned afterwards so the result can be read.
        const result = await runAntigravitySetup({
          confirmed,
          parentWindow: panel.win,
          beforePrompt: () => openPinned(),
        });
        if (result.ok) collector.rebuild();
        return result;
      } catch (err) {
        log.warn(`antigravity setup failed: code=${(err && err.code) || 'UNKNOWN'}`);
        return { ok: false, message: i18n.t('setup.failed') };
      }
    }

    return { ok: false, message: i18n.t('ipc.actionUnsupported') };
  });

  // The way back from RUN_SETUP for the two hook-writing rows. The panel asks
  // in its own confirmation box; `confirmed` is true only from its button.
  ipcMain.handle(IPC.DISCONNECT_PROVIDER, async (event, providerId, confirmed) => {
    if (!fromPanel(event)) return { ok: false, message: i18n.t('ipc.invalidRequest') };
    if (providerId !== 'claude' && providerId !== 'antigravity') {
      return { ok: false, message: i18n.t('ipc.actionUnsupported') };
    }
    try {
      const result = await runDisconnect({ providerId, confirmed: confirmed === true });
      collector.rebuild();
      return result;
    } catch (err) {
      log.warn(`disconnect failed: code=${(err && err.code) || 'UNKNOWN'}`);
      return { ok: false, message: i18n.t('setup.failed') };
    }
  });
}

/* ------------------------------------------------------------------ boot */

function applyAutostart(enabled, { atBoot = false } = {}) {
  // In a dev run the executable is node_modules/electron/dist/electron.exe, so
  // registering it under HKCU\...\Run would leave the user with a login item
  // that starts a bare Electron shell. Only a packaged build may touch it.
  if (!app.isPackaged) {
    log.info(`autostart ${enabled ? 'requested' : 'disabled'}; skipped in a dev run`);
    return;
  }
  // A Store package's Run entry would be redirected into the package and never
  // read; its StartupTask is Windows' to switch (packaging.js).
  if (isStoreBuild()) return;
  // At launch only: move a pre-0.6.27 "Usage Notch" value to the new name, and
  // keep a value the user switched off in Task Manager off (login-item.js).
  // The app's own switch passes neither: flipping it is an explicit choice.
  let keepOff = false;
  if (atBoot) {
    try {
      const legacy = migrateLegacyLoginItem({ app, log });
      keepOff = legacy.disabled || disabledByWindows({ app });
    } catch (err) {
      log.warn(`login item migration failed: code=${(err && err.code) || 'UNKNOWN'}`);
    }
  }
  try {
    // Started by Windows with --hidden: the tray only, never a window.
    app.setLoginItemSettings(loginItemSettings(enabled, { keepOff }));
  } catch (err) {
    log.warn(`autostart update failed: code=${(err && err.code) || 'UNKNOWN'}`);
  }
}

/**
 * The tray menu's inputs, in one place, so bootstrap and a language change
 * build the menu from the same handlers. Built fresh on every call because
 * `autostart` is read at build time and the checkbox must show the current
 * value, not the one from launch.
 */
function trayMenuOptions() {
  return {
    autostart: settings.autostart,
    autostartByWindows: isStoreBuild(),
    onToggleAutostart: (checked) => {
      settings.autostart = Boolean(checked);
      settingsStore.save(userDataDir(), settings);
      applyAutostart(settings.autostart);
      // An open settings screen shows the same value on its own switch; without
      // the push it would keep the old one until the panel was reloaded.
      pushPreferences();
    },
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  };
}

// Re-resolves the language and re-renders every surface MAIN writes text on:
// the tray menu, the tray tooltip (cache cleared, then repainted by the
// 'snapshot' listener's updateTray), and the snapshot. Throws are left to the
// SET_LANGUAGE handler, which owns the rollback. Order is tested in
// language-ipc.js's factory.
const applyLanguage = createApplyLanguage({
  refreshLocale,
  getTray: () => tray,
  trayMenuOptions,
  resetTooltip: () => { trayTooltipShown = null; },
  getCollector: () => collector,
});

function bootstrap() {
  // Anchors every later `+NNNNms` offset to something nameable in the log.
  log.trace('app.bootstrap');
  settings = settingsStore.load(userDataDir());
  // Before the collector, the tray and the window: all three build text from
  // it, and the renderer's synchronous initialPreferences() reads it.
  refreshLocale();
  applyAutostart(settings.autostart, { atBoot: true });

  // Refresh the copy of the bridge that Claude Code executes, on every launch.
  // It was previously written only during install, which meant the one file
  // this app causes another program to run could never be patched on a machine
  // where it was already wired — and a tampered copy would keep running
  // forever. The write is content-compared, so this is a no-op in the normal
  // case, and it repairs the file if it was modified or truncated.
  //
  // Both bridges, unconditionally. Refreshing the Antigravity copy costs one
  // content-compared write even on a machine with no `agy` installed, and
  // skipping it would leave a wired user's script frozen at whatever version
  // was current the day they pressed the button. It writes only inside this
  // app's own userData, so it wires nothing and creates nothing in ~/.gemini.
  //
  // A Store build keeps the bridge under the home directory, which is not this
  // app's own folder: there it is refreshed only once a setup has created it.
  const bridgeWired = !isStoreBuild() || fs.existsSync(path.dirname(bridgeInstallPath()));
  for (const script of bridgeWired ? Object.values(BRIDGE_SCRIPTS) : []) {
    if (!materialiseBridge(script)) log.warn(`bridge could not be refreshed on this launch: ${script}`);
  }

  // Order matters. The collector is built and started FIRST, because
  // `start()` loads the persisted store synchronously and sets
  // `collector.snapshot`. The renderer calls `initialSnapshot()` during its
  // first paint, and that has to find a value already sitting there — a warm
  // start must never flash skeleton rows.
  collector = new Collector({
    userDataDir: userDataDir(),
    projectsRoot: paths.claudeProjectsDir(),
    // The Claude desktop app's plan-usage samples and Cowork transcripts,
    // found on this machine (core/claude-desktop.js).
    claudeDesktopDirs: null,
    planLabels: settings.planLabels,
    order: settings.providerOrder,
    enabled: settings.enabledProviders,
    workerPath: path.join(__dirname, '..', 'core', 'scan', 'worker.js'),
    // The long-lived Codex usage scan worker (ADR-002 A3.11): rollouts are
    // never read for usage on this thread.
    codexWorkerPath: path.join(__dirname, '..', 'core', 'codex', 'scan-worker.js'),
    // The same arrangement for Kimi Code, Qwen Code and Grok Build (ADR-003
    // A6); a worker is only started when that tool is on this machine.
    kimiWorkerPath: path.join(__dirname, '..', 'core', 'kimi', 'scan-worker.js'),
    qwenWorkerPath: path.join(__dirname, '..', 'core', 'qwen', 'scan-worker.js'),
    grokWorkerPath: path.join(__dirname, '..', 'core', 'grok', 'scan-worker.js'),
    hooksInput: () => ({ claude: hookInstalled('claude'), antigravity: hookInstalled('antigravity') }),
  });

  collector.on('snapshot', (snapshot) => {
    if (panel) panel.send(IPC.SNAPSHOT, snapshot);
    updateTray(snapshot);
    if (strip) strip.update(snapshot);
  });
  collector.on('stats', (stats) => {
    log.info(`scan: ${stats.filesParsed}/${stats.filesSeen} files, ${stats.records} events, ${stats.ms} ms`);
  });

  collector.start();

  // Handlers are registered before the window exists, so the renderer cannot
  // race a sendSync against a channel with no listener (which would hang it).
  registerIpc();

  panel = new PanelWindow({
    onVisibilityChange: (visible) => {
      if (!visible) collector.setPanelOpen(false);
    },
    // With the strip on, the foreground goes back to the user's window rather
    // than to the taskbar, which would cover the strip (TaskbarStrip.handBackFocus).
    onBeforeConceal: () => { if (strip) strip.handBackFocus(); },
  });
  panel.create();

  // Hover opens NOTHING. The tray icon reacts to a click, and to a click only;
  // its hover surface is the native tooltip, set in updateTray().
  tray = new TrayController({
    /**
     * Single click toggles — but a panel with a PENDING DISMISSAL is not open
     * for the purpose of deciding what a click means.
     *
     * This is the reported bug, and the trace named it. The measured sequence
     * from one real click:
     *
     *   +576128  panel.scheduleHide reason=pointer-left ms=550
     *   +576660  tray.click
     *   +576660  tray.toggle visible=true pinned=false hidePending=true act=hide
     *   +576663  panel.hide reason=tray-toggle
     *   +577365  tray.click            <- the user clicking again
     *   +577373  panel.show
     *
     * The user moved the pointer off the panel TOWARDS the tray icon, which
     * armed the 550 ms leave grace, and clicked 530 ms later — inside it.
     * `isVisible()` was still true because the timer had not fired, so the
     * toggle read a live panel and closed it. From the user's side that is one
     * intent producing close-then-open.
     *
     * Reaching for the tray icon while the panel is fading is asking to KEEP
     * it, not to dismiss it. So `visible && hidePending` takes the open path:
     * `open()` cancels the hide, re-measures the anchor and re-arms the
     * pointer watch, leaving the panel on screen. Deliberately not a no-op —
     * that would swallow the click and leave the timer running, so the panel
     * would vanish anyway a moment later and the click would have done
     * nothing at all.
     */
    onToggle: () => {
      const visible = panel.isVisible();
      const pending = panel.hidePending();
      // 'keep' rather than 'open' when it was already on screen: the two are
      // the same code path but very different events to read in a log.
      const act = !visible ? 'open' : (pending ? 'keep' : 'hide');
      log.trace('tray.toggle', { visible, pinned: panel.pinned, hidePending: pending, act });
      if (act === 'hide') panel.hide('tray-toggle');
      else openPanel();
    },
    /**
     * Double click can only open. Windows delivers `click` then `double-click`
     * for one gesture, so a second toggle would close what the first opened.
     *
     * It has to answer the pending-hide case too, and for a sharper reason
     * than the toggle: "idempotent open" means the panel is on screen AND
     * STAYING when this returns. Skipping on `isVisible()` alone would leave a
     * panel that is visible and still counting down to its own dismissal,
     * which is the one outcome this handler exists to rule out.
     */
    onOpen: () => {
      const visible = panel.isVisible();
      const pending = panel.hidePending();
      const act = !visible ? 'open' : (pending ? 'keep' : 'noop');
      log.trace('tray.open', { visible, hidePending: pending, act });
      if (act !== 'noop') openPanel();
    },
  });
  tray.create(trayMenuOptions());

  // After the tray, which it leans on for its right-click menu. Built always,
  // shown only for 'strip'; koffi is not even loaded for 'tray'. A status
  // change (shown, unavailable) is pushed so the settings screen can say it.
  // The tiles themselves are drawn inside the taskbar by the display layer
  // (taskbar-display.js), so they stay visible when the taskbar is clicked.
  strip = new TaskbarStrip({
    BrowserWindow,
    log,
    makeDisplay: (opts) => new DisplayLayer({ BrowserWindow, ...opts }),
    // A click the foreground taskbar took from the invisible input window.
    onCoveredClick: () => openFromStrip(),
    onChange: () => { pushPreferences(); syncTrayPresence(); },
  });
  // Before it is enabled, so its first frame already has the user's gauge.
  strip.setGauge(settings.gauge);
  applyTrayView(settings.trayView);

  // The user flipping Windows between light and dark changes no snapshot
  // field, so nothing else in this process would ever ask for a repaint. The
  // ground is in the icon key, so this call finds a changed key and redraws;
  // if the OS theme did not actually move, the key matches and it is free.
  let systemGlassOff = systemReducedTransparency();
  nativeTheme.on('updated', () => {
    log.trace('os.theme', { ground: trayGround() });
    if (collector && collector.snapshot) updateTray(collector.snapshot);
    // High contrast or "Saydamlık efektleri" moved: the settings screen says
    // why the glass is off. Pushed only on a change, not on every theme event.
    const glassOff = systemReducedTransparency();
    if (glassOff !== systemGlassOff) {
      systemGlassOff = glassOff;
      pushPreferences();
    }
    // The taskbar repaints a moment after the event; read its colour then.
    if (strip) {
      const timer = setTimeout(() => { if (strip) strip.themeChanged(); }, 700);
      if (timer.unref) timer.unref();
    }
  });

  // The collector emitted its first snapshot inside start(), before the tray
  // existed, and that emit was dropped by the `if (!tray)` guard. Without this
  // the icon would stay the static PNG until the next sweep — up to a minute
  // of a warm start showing no usage at all.
  if (collector.snapshot) updateTray(collector.snapshot);

  // Belt and braces alongside `initialSnapshot()`: push once the renderer can
  // receive, so a panel that only subscribes still paints without waiting for
  // the next sweep.
  panel.win.webContents.on('did-finish-load', () => {
    if (collector.snapshot) panel.send(IPC.SNAPSHOT, collector.snapshot);
    // Belt and braces alongside `initialPreferences()`, and the restoration
    // half as well: this event also fires after `render-process-gone`, and a
    // revived renderer that never called the sync getter would come back in
    // the default theme while settings.json holds the user's choice.
    pushPreferences();
    // The anchor is the other half of that restoration, not an extra. This
    // event also fires when the renderer is revived after `render-process-gone`
    // (panel-window.js), and the revived page derives `pinned` from
    // `anchor.mode` — so without this it comes back saying "not pinned" while
    // main is pinned, and the pin control reports a state that is not the
    // panel's. Sends nothing when the panel is not on screen.
    panel.sendCurrentAnchor(anchorRect(), anchorSender);
  });
}

/**
 * Which taskbar the icon will sit on.
 *
 * `nativeTheme.shouldUseDarkColors`, NOT `settings.theme`. The icon lives in
 * the Windows taskbar, which follows the OS setting regardless of what the
 * user chose for the panel, so it matches what it sits on: a user on a light
 * taskbar who prefers a dark panel still needs a legible icon. Painting the
 * dark ramp onto a light taskbar left `spent` at 1.51:1 against the surface —
 * the one state that most needs to be seen, effectively invisible.
 *
 * Falls back to 'dark' on a throw rather than propagating: an unreadable OS
 * setting must cost the icon its optimal contrast, not its existence.
 */
function trayGround() {
  try {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

/**
 * Repaints the tray, and only when something visible actually changed.
 *
 * Snapshots arrive every 15 s while the panel is open and on every transcript
 * change. Everything the icon shows is in `trayIconKey()` — the provider, the
 * rounded percentage, the state, the no-data flag — so anything the key does
 * not mention (burn rate, token counts, generatedAt) cannot change a pixel and
 * must not cost four rasterisations plus three PNG encodes in a process that
 * runs all day.
 */
function updateTray(snapshot) {
  if (!tray || !snapshot) return;

  // ONE instant for all three surfaces below. They share a reset horizon
  // (tray-spec.js, READING_HORIZON_MS), so reading the clock separately could
  // put the tooltip on one side of it and the icon on the other — the tooltip
  // saying the window is resetting beside a donut still drawing its sweep.
  const now = Date.now();

  // Built from the same leadProvider() the donut uses, so the two describe one
  // row. It carries a live countdown, so it changes between snapshots that do
  // not repaint a pixel — which is why it is compared and set separately from
  // the icon key rather than folded into it.
  const tooltip = buildTooltip(snapshot, now);
  if (tooltip !== trayTooltipShown) {
    tray.setTooltip(tooltip);
    trayTooltipShown = tooltip;
  }

  // The ground is part of the key, or an OS theme flip would change nothing
  // the key can see — it changes no snapshot field — and the early return
  // below would leave the dark ramp on a light taskbar until the percentage
  // happened to move.
  const ground = trayGround();
  const key = trayIconKey(snapshot, now, ground);
  if (key === trayIconDrawnKey) return;

  const image = buildTrayImage(traySpecFromSnapshot(snapshot, now), ground);
  // A failed build leaves whatever is on screen — the static PNG on a cold
  // start — and leaves the key unset, so the next snapshot retries.
  if (!image || !tray.setIcon(image)) return;
  trayIconDrawnKey = key;
}

// Launching the app again (desktop or Start shortcut) opens the panel PINNED.
// It used to get the tray click's answer, unpinned, but the pointer is then
// on the shortcut, nowhere near the tray->panel corridor, so the corridor rule
// closed the panel about 550 ms after it appeared (seen in the clean-machine
// sandbox, 2026-10-05). Pinned stays until the user closes or unpins it.
app.on('second-instance', () => {
  if (panel) openPinned();
});

// Tray app: an empty listener is what keeps Electron from quitting when the
// panel window is hidden or closed.
app.on('window-all-closed', () => { /* stay resident in the tray */ });

app.on('before-quit', () => {
  isQuitting = true;
  if (collector) collector.stop();
  // Off the taskbar before the tray goes: the strip's window, its timers and
  // its UI Automation worker stop here, not at process teardown.
  if (strip) strip.disable();
  if (tray) tray.destroy();
  trayIconDrawnKey = null;
  trayTooltipShown = null;
});

app.whenReady().then(bootstrap).catch((err) => {
  log.error(`startup failed: code=${(err && err.code) || (err && err.name) || 'UNKNOWN'}`);
  // The failure may have happened before bootstrap() resolved the language, so
  // resolve it here: `settings` if it loaded, the OS otherwise. Every read in
  // osLocale() is guarded, and this path must not throw on its way to saying
  // that the app could not start.
  try {
    refreshLocale();
  } catch { /* the dialog still shows, in the default language */ }
  dialog.showErrorBox('LimitPeek', i18n.t('app.startupFailed'));
  app.quit();
});

module.exports = { isQuitting: () => isQuitting };
