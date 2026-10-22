'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * The whole renderer-visible surface. Deliberately NOT a generic
 * `invoke(channel, args)` passthrough: that would hand any script running in
 * the renderer the full main-process IPC surface, which defeats the point of
 * contextIsolation (ADR-001, security F8).
 *
 * Channel names are inlined rather than required from `src/shared/contract.js`
 * because a sandboxed preload has a restricted module system.
 * `test/contract-mirror.test.js` fails the build if any string here drifts
 * from `contract.ts`.
 */
const CH = {
  SNAPSHOT: 'usage:snapshot',
  PANEL_OPENED: 'usage:panel-opened',
  REQUEST_REFRESH: 'usage:request-refresh',
  RUN_SETUP: 'provider:run-setup',
  PANEL_CLOSE: 'panel:close',
  PANEL_PIN: 'panel:pin',
  ANCHOR: 'panel:anchor',
  PANEL_VISIBILITY: 'panel:visibility',
  SET_ORDER: 'providers:set-order',
  SET_ENABLED: 'providers:set-enabled',
  PREFERENCES: 'prefs:changed',
  SET_THEME: 'prefs:set-theme',
  SET_LANGUAGE: 'prefs:set-language',
  SET_AUTOSTART: 'prefs:set-autostart',
  SET_PLAN_LABEL: 'prefs:set-plan-label',
  INITIAL_SNAPSHOT: 'usage:initial-snapshot',
  INITIAL_PREFERENCES: 'prefs:initial',
  DISCONNECT_PROVIDER: 'provider:disconnect',
  SET_SETUP_COACH_DISMISSED: 'prefs:set-setup-coach-dismissed',
  PANEL_HIT: 'panel:hit',
  SET_TRAY_VIEW: 'prefs:set-tray-view',
  SET_REDUCE_TRANSPARENCY: 'prefs:set-reduce-transparency',
  PANEL_SIZE: 'panel:size',
  SET_LAYOUT: 'prefs:set-layout',
  SET_STRIP_STYLE: 'prefs:set-strip-style',
};

/** Strips the IpcRendererEvent so the renderer never sees a sender handle. */
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch {
      /* a throwing renderer callback must not kill the IPC listener */
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('usageNotch', {
  /**
   * The snapshot main already holds, returned SYNCHRONOUSLY so the panel can
   * paint real data in its first frame. An async round trip cannot do that —
   * the panel would show skeleton rows for a frame on every warm open, which
   * is the "no data" state the design exists to avoid.
   *
   * Null only before the very first scan of a brand-new install. `sendSync`
   * blocks the renderer for the length of one small structured clone.
   */
  initialSnapshot: () => {
    try {
      return ipcRenderer.sendSync(CH.INITIAL_SNAPSHOT) || null;
    } catch {
      // A missing handler must degrade to the skeleton, never to a throw
      // inside the renderer's first paint.
      return null;
    }
  },

  /** main -> renderer: full Snapshot (never a delta). Returns an unsubscribe. */
  onSnapshot: (cb) => subscribe(CH.SNAPSHOT, cb),

  /**
   * main -> renderer: geometry for the panel's own anchoring math.
   * See `AnchorPayload` in contract.ts:
   * { tray, display:{id,scaleFactor,bounds,workArea}, window,
   *   edge:'bottom'|'top'|'left'|'right', mode:'hover'|'pin' }
   * All rectangles are in Electron's DIP screen coordinates. `scaleFactor` is
   * that of the display containing the tray icon, not the primary display.
   */
  onAnchor: (cb) => subscribe(CH.ANCHOR, cb),

  /**
   * main -> renderer: the panel was revealed (true) or concealed (false). The
   * renderer replays its content open animation off this. See
   * IPC.PANEL_VISIBILITY in contract.ts. Returns an unsubscribe.
   */
  onPanelVisibility: (cb) => subscribe(CH.PANEL_VISIBILITY, cb),

  /** Panel is visible / the pointer is inside it. Also cancels an auto-hide. */
  panelOpened: () => ipcRenderer.send(CH.PANEL_OPENED),

  /** @returns {Promise<Snapshot>} */
  requestRefresh: () => ipcRenderer.invoke(CH.REQUEST_REFRESH),

  /**
   * Runs a provider's SetupAction.
   * @param {string} providerId
   * @param {boolean} confirmed must be true; main also asks the user natively
   *   before writing anything outside the app's own userData.
   * @returns {Promise<{ok:boolean,message:string}>}
   */
  runSetup: (providerId, confirmed) =>
    ipcRenderer.invoke(CH.RUN_SETUP, String(providerId), confirmed === true),

  /**
   * Persists the user's provider order after a drag.
   *
   * The array is normalised to strings here so a stray DOM node or number from
   * the drag handler cannot reach the main process as a structured-clone
   * failure, and main validates it again against the real registry — the
   * renderer is not trusted to say what a provider id is.
   *
   * @param {string[]} ids
   * @returns {Promise<{ok:boolean}>}
   */
  setOrder: (ids) =>
    ipcRenderer.invoke(CH.SET_ORDER, Array.isArray(ids) ? ids.map((id) => String(id)) : []),

  /**
   * Adds a provider to the main panel, or removes it.
   *
   * Normalised to a string and a real boolean here so a checkbox's `"on"` or a
   * DOM node cannot reach main as something it has to guess about. Main
   * validates both again — the id against the real registry, the flag against
   * `typeof 'boolean'` — because the renderer is not trusted to say what a
   * provider id is, nor what counts as enabled.
   *
   * `{ok:false}` means nothing changed anywhere and the renderer must revert
   * its toggle.
   *
   * @param {string} id
   * @param {boolean} enabled
   * @returns {Promise<{ok:boolean}>}
   */
  setEnabled: (id, enabled) =>
    ipcRenderer.invoke(CH.SET_ENABLED, String(id), enabled === true),

  /**
   * The preferences main already holds, returned SYNCHRONOUSLY.
   *
   * Same `sendSync` shape as `initialSnapshot()` and for a sharper reason: a
   * theme applied after the first paint is a visible flash of the wrong one,
   * and an async round trip cannot beat the first frame. Null only when main
   * rejected the call, and the renderer must treat that as "use the default",
   * never as "paint nothing".
   */
  initialPreferences: () => {
    try {
      return ipcRenderer.sendSync(CH.INITIAL_PREFERENCES) || null;
    } catch {
      return null;
    }
  },

  /** main -> renderer: Preferences. Returns an unsubscribe. */
  onPreferences: (cb) => subscribe(CH.PREFERENCES, cb),

  /**
   * Persists the theme choice.
   *
   * Coerced to a string here so a DOM node or a `null` from a radio group
   * cannot reach main as a structured-clone failure; main then checks it
   * against the three literals of `ThemeChoice` rather than trusting it, so
   * this coercion is convenience, not validation.
   *
   * `{ok:false}` means nothing was persisted and the renderer must revert.
   *
   * @param {'dark'|'light'|'system'} theme
   * @returns {Promise<{ok:boolean}>}
   */
  setTheme: (theme) => ipcRenderer.invoke(CH.SET_THEME, String(theme)),

  /**
   * Persists the language choice.
   *
   * Same coercion-for-convenience as `setTheme`; main validates against the
   * three literals of `LanguageChoice`. NOT optimistic: the renderer applies
   * the new language only when the PREFERENCES push arrives, because main has
   * to re-resolve it and re-translate the tray and the snapshot first.
   *
   * `{ok:false}` means nothing changed anywhere.
   *
   * @param {'tr'|'en'|'system'} language
   * @returns {Promise<{ok:boolean}>}
   */
  setLanguage: (language) => ipcRenderer.invoke(CH.SET_LANGUAGE, String(language)),

  /**
   * Persists "start with Windows".
   *
   * Passed as `enabled === true`, the way `setEnabled` passes its flag, so a
   * stray value cannot reach main as something it has to guess about; main
   * checks `typeof 'boolean'` again rather than trusting it.
   *
   * `{ok:false}` means nothing changed anywhere and the renderer must revert
   * its switch.
   *
   * @param {boolean} enabled
   * @returns {Promise<{ok:boolean}>}
   */
  setAutostart: (enabled) => ipcRenderer.invoke(CH.SET_AUTOSTART, enabled === true),

  /**
   * Persists "Şimdi değil" on the first-run card. Same shape as setAutostart;
   * `{ok:false}` means nothing changed.
   *
   * @param {boolean} dismissed
   * @returns {Promise<{ok:boolean}>}
   */
  setSetupCoachDismissed: (dismissed) => ipcRenderer.invoke(CH.SET_SETUP_COACH_DISMISSED, dismissed === true),

  /**
   * Persists where the usage is shown outside the panel: 'tray' or 'strip'.
   * Coerced to a string for convenience only; main checks it against the two
   * literals. `{ok:false}` means nothing changed anywhere.
   *
   * @param {'tray'|'strip'} view
   * @returns {Promise<{ok:boolean}>}
   */
  setTrayView: (view) => ipcRenderer.invoke(CH.SET_TRAY_VIEW, String(view)),

  /**
   * Persists "Saydamlığı azalt": the panel's glass drawn opaque. Passed as
   * the boolean it is (`=== true`, never truthiness); main checks it is a real
   * boolean. `{ok:false}` means nothing changed anywhere.
   *
   * @param {boolean} reduce
   * @returns {Promise<{ok:boolean}>}
   */
  setReduceTransparency: (reduce) => ipcRenderer.invoke(CH.SET_REDUCE_TRANSPARENCY, reduce === true),

  /**
   * Persists how the panel lays out the tools: 'list', 'focus' or 'tiles'.
   * Coerced to a string for convenience only; main checks it against the
   * two literals. `{ok:false}` means nothing changed anywhere.
   *
   * @param {'sade'|'halka'} layout
   * @returns {Promise<{ok:boolean}>}
   */
  setLayout: (layout) => ipcRenderer.invoke(CH.SET_LAYOUT, String(layout)),

  /**
   * Persists how the taskbar strip draws its tiles: 'plain', 'rings' or
   * 'fill'. Coerced to a string for convenience only; main checks it against
   * the three literals. `{ok:false}` means nothing changed anywhere.
   *
   * @param {'plain'|'rings'|'fill'} style
   * @returns {Promise<{ok:boolean}>}
   */
  setStripStyle: (style) => ipcRenderer.invoke(CH.SET_STRIP_STYLE, String(style)),

  /**
   * Persists the plan the user says they are on for ONE tool, or clears it.
   *
   * The control is an `<input list>` with a per-tool `datalist`, so this carries
   * ARBITRARY user text. Coerced to a string here for convenience only — main
   * does the real validation (known id, plain string, trimmed, 24-character cap)
   * because nothing arriving over IPC may be trusted to have been checked on the
   * renderer side. An empty or blank label CLEARS the setting.
   *
   * NOT optimistic: `{ok:false}` means main wrote nothing and the renderer must
   * put the control back to the value it had. On success the new label arrives
   * on the next snapshot, which is what the row reads.
   *
   * @param {string} providerId
   * @param {string} label  free text; '' clears
   * @returns {Promise<{ok:boolean}>}
   */
  setPlanLabel: (providerId, label) =>
    ipcRenderer.invoke(CH.SET_PLAN_LABEL, String(providerId), String(label == null ? '' : label)),

  /** Takes our statusLine hook out of a tool's settings; main confirms natively. */
  disconnectProvider: (providerId, confirmed) =>
    ipcRenderer.invoke(CH.DISCONNECT_PROVIDER, String(providerId), confirmed === true),

  close: () => ipcRenderer.send(CH.PANEL_CLOSE),
  pin: () => ipcRenderer.send(CH.PANEL_PIN),
  // Only a literal true takes the mouse back; anything else leaves the
  // transparent window click-through, the safe state for other apps.
  setPointerOverPanel: (over) => ipcRenderer.send(CH.PANEL_HIT, over === true),
  // A finite number or nothing: main checks it is a plausible height before a
  // fitted window takes it (PanelWindow.setContentHeight).
  setPanelHeight: (height) => {
    if (typeof height === 'number' && Number.isFinite(height)) ipcRenderer.send(CH.PANEL_SIZE, height);
  },
});
