'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeOrder } = require('../core/order');
const { sanitizeEnabled } = require('../core/enabled');
const { sanitizeTheme, DEFAULT_THEME } = require('../core/theme');
const { sanitizeLanguage, DEFAULT_LANGUAGE } = require('../core/language');
const { migratePlanLabels } = require('../core/plan-labels');
const { sanitizeTrayView, DEFAULT_TRAY_VIEW } = require('../core/tray-view');
const { sanitizeReduceTransparency, DEFAULT_REDUCE_TRANSPARENCY } = require('../core/reduce-transparency');
const { sanitizeLayout, DEFAULT_LAYOUT } = require('../core/layout');
const { sanitizeStripStyle, DEFAULT_STRIP_STYLE } = require('../core/strip-style');

/**
 * App settings, stored in the app's own userData. Small and hand-editable.
 *
 * `planLabels` lives here on purpose: it is the ONLY source for that field.
 * ADR-001 security F1 forbids opening `~/.claude/.credentials.json`, so the
 * plan is either something the user told us or the row says nothing. It is never
 * inferred from usage volume, which would be a guess presented as a fact, and
 * nothing computes from it — see `src/core/plan-labels.js`. It became a map when
 * the plan moved onto every row: one string could only ever be right about one
 * tool, and a person on Claude Max 20x may also be on a Codex plan.
 *
 * `providerOrder` and `enabledProviders` live here rather than in the
 * transcript store on purpose: the store is derived data that is rewritten,
 * pruned and thrown away whenever its schema moves, and losing a user's drag
 * order — or, worse, which providers they added — to a cache eviction would be
 * a bug with no visible cause. This file is user state.
 */
const FILE = 'settings.json';

const DEFAULTS = Object.freeze({
  autostart: true,
  /**
   * Partial map id -> plan name the user typed, e.g. `{ claude: 'Max 20x' }`.
   * Empty means no row shows a plan, which is the honest rendering of a fact
   * nobody stated. Partial rather than a full map for the same reason
   * `enabledProviders` is: a tool absent from it shows nothing, and that is
   * different from an empty string.
   */
  planLabels: {},
  /** Empty means "registry order"; see src/core/order.js. */
  providerOrder: [],
  /**
   * Partial map id -> boolean. Empty means "every provider takes its shipped
   * default" (claude on, the other five off); see src/core/enabled.js. It is
   * deliberately partial rather than a full map, so a provider added in a
   * later version arrives with ITS default rather than inheriting a `false`
   * that a settings file written before it existed could never have meant.
   */
  enabledProviders: {},
  /**
   * 'dark' | 'light' | 'system'. See `src/core/theme.js` for why an
   * unrecognised value falls back to the default rather than being passed
   * through: a theme the renderer does not know is a panel with no palette.
   */
  theme: DEFAULT_THEME,
  /**
   * 'tr' | 'en' | 'system'. The WORD the user chose, never the resolved
   * language; see `src/core/language.js`. An unrecognised value falls back to
   * 'system' for the same reason the theme does.
   */
  language: DEFAULT_LANGUAGE,
  /**
   * Whether the user closed the first-run "show Claude Code's usage" card with
   * "Şimdi değil". A NEW settings file starts with it false, so a fresh install
   * sees the card once; a file written before the card existed has no such key
   * and reads as true in `load()`, so an update never springs onboarding on
   * someone who has used the app for weeks (UI plan 2026-09-29).
   */
  setupCoachDismissed: false,
  /**
   * 'tray' | 'strip': where the usage is shown outside the panel (Settings →
   * Genel → Görünüm). 'tray' is the tray icon alone, the look every earlier
   * version had; 'strip' adds the taskbar strip (src/main/taskbar-strip.js).
   * An unknown value is 'tray', see `src/core/tray-view.js`.
   */
  trayView: DEFAULT_TRAY_VIEW,
  // No `gauge` any more ("Gösterge: Çubuk / Halka", removed with the old
  // layouts, 2026-10-22: the short list draws no bars, the ring tiles always
  // rings). A file that still carries one keeps it on disk until the next
  // save; `load` below simply never reads it.
  /**
   * Settings → Genel → Görünüm → "Saydamlığı azalt": the panel's glass
   * (header, settings tab band) drawn opaque. Off by default; only a real
   * `true` is on, see `src/core/reduce-transparency.js`. Windows' own reduced
   * transparency and high contrast do the same without touching this.
   */
  reduceTransparency: DEFAULT_REDUCE_TRANSPARENCY,
  /**
   * 'sade' | 'halka': how the panel lays out the tools (Settings → Genel →
   * Görünüm → Düzen). 'sade' is one short line per tool, 'halka' a grid of
   * small ring tiles. Panel only. The three layouts of 0.6.38 and earlier
   * ('list', 'focus', 'tiles') are read as their successors; anything else is
   * 'sade', see `src/core/layout.js`.
   */
  layout: DEFAULT_LAYOUT,
  /**
   * 'plain' | 'rings' | 'fill': how the taskbar strip draws a tile (Settings →
   * Genel → Görünüm → Şerit stili). 'plain' is the bars the strip always had.
   * An unknown value is 'plain', see `src/core/strip-style.js`.
   */
  stripStyle: DEFAULT_STRIP_STYLE,
});

function file(userDataDir) {
  return path.join(userDataDir, FILE);
}

function defaults() {
  // DEFAULTS is frozen and holds an array and two objects, so a spread would
  // hand the caller a shared, frozen `providerOrder` / `enabledProviders` /
  // `planLabels`.
  return { ...DEFAULTS, providerOrder: [], enabledProviders: {}, planLabels: {} };
}

function load(userDataDir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file(userDataDir), 'utf8'));
  } catch {
    // Missing, unreadable or corrupt. Never a throw and never a partial read:
    // a truncated settings file must cost the user their preferences, not
    // their panel.
    return defaults();
  }
  if (!raw || typeof raw !== 'object') return defaults();
  return {
    autostart: typeof raw.autostart === 'boolean' ? raw.autostart : DEFAULTS.autostart,
    // Untrusted user text from a hand-editable file: trimmed, length-capped and
    // reduced to the known ids at this boundary, so nothing downstream re-checks
    // it. Carries the legacy single `planLabel` onto the `claude` key rather than
    // dropping a setting the user typed — see `migratePlanLabels`.
    planLabels: migratePlanLabels(raw.planLabels, raw.planLabel),
    // Validated at the boundary: whatever survives here is known ids only, so
    // nothing downstream has to re-check it.
    providerOrder: sanitizeOrder(raw.providerOrder),
    // Same discipline, and the same fallback: an unknown id is dropped, a
    // non-boolean value is ignored so that id keeps its default, and a value
    // that is not an object at all degrades to defaults. Never to "nothing is
    // enabled", which would be an empty panel with no visible cause.
    enabledProviders: sanitizeEnabled(raw.enabledProviders),
    // Same discipline again, and the same reason: a typo, a value from a
    // future version or a non-string all become the shipped default here, so
    // nothing downstream has to decide what to do with a theme it cannot draw.
    theme: sanitizeTheme(raw.theme),
    // And again for the language: a typo or a future value becomes 'system',
    // never a language no catalog exists for.
    language: sanitizeLanguage(raw.language),
    // Absent means "written before the first-run card existed": an existing
    // user, who is not shown onboarding by an update.
    setupCoachDismissed: typeof raw.setupCoachDismissed === 'boolean' ? raw.setupCoachDismissed : true,
    // Absent (every file written before the strip existed), a typo or a
    // future value: the tray icon, the look the user already has.
    trayView: sanitizeTrayView(raw.trayView),
    // Absent (every file written before the glass existed) or not a real
    // boolean: the glass, the look the trial ships with.
    reduceTransparency: sanitizeReduceTransparency(raw.reduceTransparency),
    // An old layout ('list', 'focus', 'tiles') reads as its successor, so an
    // update keeps the user's list or grid; absent, a typo or a future value:
    // the short list, the default.
    layout: sanitizeLayout(raw.layout),
    // Absent (every file written before the strip styles existed), a typo or
    // a future value: the plain bars, the look the strip already has.
    stripStyle: sanitizeStripStyle(raw.stripStyle),
  };
}

/**
 * tmp + fsync + rename, the same sequence `store.js` and `claude-bridge.js`
 * use. Without the fsync the rename can land before the data does, so a crash
 * seconds later leaves a truncated settings.json — `load()` catches it and
 * returns defaults, which means the user silently loses their autostart choice,
 * their drag order and the providers they added.
 */
function save(userDataDir, settings) {
  const target = file(userDataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return false;
  }
}

module.exports = { load, save, DEFAULTS };
