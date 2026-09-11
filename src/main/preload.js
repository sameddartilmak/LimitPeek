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
  INITIAL_SNAPSHOT: 'usage:initial-snapshot',
  INITIAL_PREFERENCES: 'prefs:initial',
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

  close: () => ipcRenderer.send(CH.PANEL_CLOSE),
  pin: () => ipcRenderer.send(CH.PANEL_PIN),
});
