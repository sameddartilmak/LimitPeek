'use strict';
/**
 * Runtime mirror of the IPC channel names declared in `contract.ts`.
 *
 * `contract.ts` is orchestrator-owned and type-only at runtime except for its
 * `IPC` and `CADENCE` consts. Nothing here may drift from it:
 * `test/contract-mirror.test.js` parses `contract.ts` and fails if a single
 * character differs.
 */
/**
 * Runtime mirror of `contract.ts`'s STATE_THRESHOLDS.
 *
 * Two independent renderers draw from this — the panel meter and the tray
 * donut — and they once shipped with different values (60/85 vs 70/90), which
 * put a green icon beside an amber row at 62%. A value two lanes must agree on
 * belongs to neither lane, so it lives in the contract and is mirrored here
 * under the same drift test as the channel names.
 *
 * Always compared against the ROUNDED percentage.
 */
const STATE_THRESHOLDS = { watch: 60, ember: 85, spent: 100 };

const IPC = {
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
  DISCONNECT_PROVIDER: 'provider:disconnect',
  SET_SETUP_COACH_DISMISSED: 'prefs:set-setup-coach-dismissed',
  PANEL_HIT: 'panel:hit',
  SET_TRAY_VIEW: 'prefs:set-tray-view',
  SET_GAUGE: 'prefs:set-gauge',
  SET_REDUCE_TRANSPARENCY: 'prefs:set-reduce-transparency',
  PANEL_SIZE: 'panel:size',
};

/**
 * The taskbar strip's own channels, mirrored from `contract.ts` IPC_STRIP
 * under the same drift test. Only `strip-preload.js` speaks them.
 */
const IPC_STRIP = {
  DATA: 'strip:data',
  OPEN: 'strip:open',
  MENU: 'strip:menu',
  HOVER: 'strip:hover',
};

/**
 * Transport-only channels that carry no data shape of their own, so the
 * contract names the API method rather than the wire name. Kept separate so it
 * stays obvious which strings the orchestrator owns.
 */
const IPC_EXT = {
  /**
   * Synchronous. Backs `UsageNotchApi.initialSnapshot()`, which has to return
   * a value in frame one — an async round trip cannot, and a skeleton row is
   * exactly the "no data" state the panel is supposed to avoid on a warm
   * start. Payload is one small object; the renderer blocks for microseconds.
   */
  INITIAL_SNAPSHOT: 'usage:initial-snapshot',
  /**
   * Synchronous, and for a sharper reason than its sibling. Backs
   * `UsageNotchApi.initialPreferences()`: a theme applied after first paint is
   * a visible flash of the wrong one, which is exactly what a promise-based
   * getter guarantees.
   */
  INITIAL_PREFERENCES: 'prefs:initial',
};

module.exports = { IPC, IPC_EXT, IPC_STRIP, STATE_THRESHOLDS };
