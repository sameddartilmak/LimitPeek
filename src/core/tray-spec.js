'use strict';

/**
 * Derives the `TrayIconSpec` (contract.ts) from a snapshot, and the cache key
 * that decides whether the icon has to be redrawn at all.
 *
 * No `electron` import: this is the honesty logic, and it has to be testable
 * under plain `node --test`. Pixels live in `src/core/donut.js`; the
 * `nativeImage` assembly lives in `src/main/tray-icon.js`.
 */

/**
 * The state ramp, taken from the contract — NOT redeclared here.
 *
 * The tray and the panel meter are two renderers of one number, and they
 * shipped with two different ramps (70/90 here, 60/85 there), which put a
 * green icon beside an amber row at 62%. The fix is not to copy the panel's
 * values into this file; it is to stop having two copies. `contract-mirror`
 * fails the build if this drifts from `contract.ts`.
 *
 * Compared against the ROUNDED percentage, never the raw one: the icon must
 * step colour at the same instant the printed number changes, or it
 * contradicts the number sitting beside it.
 */
const { STATE_THRESHOLDS } = require('../shared/contract');

/**
 * How long a tray reading has to stay true after it is produced.
 *
 * The tray icon and the tray tooltip are both ARTEFACTS: a bitmap and a string,
 * written when a snapshot arrives and then looked at whenever the user happens
 * to glance or hover. Neither has a clock. With the panel closed the next
 * snapshot is up to `Collector.SWEEP_IDLE_MS` away, so whatever is written must
 * still be true that much later — and a percentage whose window resets inside
 * that horizon will not be.
 *
 * This is not blanking the reading "a minute early". It is refusing to write a
 * claim we cannot vouch for over the artefact's whole lifetime, and it lands at
 * the worst possible moment otherwise: a near-100% figure sitting on the tray
 * for up to a minute after the limit actually came back, which is exactly when
 * someone hovers to ask whether it did.
 *
 * The panel does not need this — it has a 1 Hz clock and re-derives locally.
 * A test pins the value to SWEEP_IDLE_MS; it is not imported, because this
 * module must stay free of `collector.js` and its fs/worker_threads imports.
 */
const READING_HORIZON_MS = 60_000;

/** @returns {'calm'|'watch'|'ember'|'spent'|'none'} */
function stateForPercentage(usedPercentage) {
  if (typeof usedPercentage !== 'number' || !Number.isFinite(usedPercentage)) return 'none';
  const shown = Math.round(usedPercentage);
  if (shown >= STATE_THRESHOLDS.spent) return 'spent';
  if (shown >= STATE_THRESHOLDS.ember) return 'ember';
  if (shown >= STATE_THRESHOLDS.watch) return 'watch';
  return 'calm';
}

/**
 * Neutral ink (`--ink-400`) for the identity dot when there is no brand colour
 * to show: an unparsable accent, no provider at all, or — deliberately — a
 * provider that is not connected. The panel renders a disconnected row
 * monochrome, and the tray must not brand-colour a provider the panel has
 * decided to grey out; the dot would be the only place in the product claiming
 * that row is live.
 */
const FALLBACK_ACCENT = '#6B7A77';
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function accentOf(provider) {
  if (!provider || provider.connected === false) return FALLBACK_ACCENT;
  const accent = provider.accent;
  return typeof accent === 'string' && HEX.test(accent) ? accent : FALLBACK_ACCENT;
}

/**
 * The percentage the tray is allowed to draw, or null.
 *
 * ADR-001's honesty rule, restated for a 16px circle (contract.ts,
 * `TrayIconSpec`): no window, `certainty: 'unknown'`, or a null percentage all
 * mean the same thing — we cannot defend a number, so the icon draws the ring
 * and no sweep. A 'stale' row is NOT no-data: its percentage was true of a
 * window that has not reset yet, which is exactly what the panel shows with an
 * "as of" label, and `windowFrom()` in snapshot.js has already downgraded it
 * to 'unknown' if the window rolled over.
 */
/**
 * True when this window resets so soon that a reading of it cannot be relied on
 * for the life of a tray artefact — including a reset that has already passed.
 *
 * `snapshot.js` (`windowFrom`) already demotes an expired window to
 * `certainty: 'unknown'` AT BUILD TIME. This is the other half: the gap between
 * two builds, which is where a written-and-forgotten string or bitmap lives.
 *
 * A window with no parseable `resetsAt` is NOT resetting. That combination only
 * reaches us from a fresh capture (snapshot.js), where the reading is true and
 * there is simply no reset instant to reason about; blanking it would delete a
 * good number over a missing field.
 */
function windowResetting(win, now, horizonMs = READING_HORIZON_MS) {
  if (!win || typeof win.resetsAt !== 'string') return false;
  const at = Date.parse(win.resetsAt);
  if (!Number.isFinite(at)) return false;
  return at - now < horizonMs;
}

/**
 * The drawable percentage of ONE window object, applying every guard the tray
 * shares with the panel. Split out from `windowPercentage` so the same rules
 * govern a synthetic window (the tray's most-consumed group, below) as govern
 * `provider.fiveHour`.
 */
function percentageOfWindow(provider, win, now) {
  if (!provider) return null;
  // One predicate governs both halves of the disconnected case. `accentOf()`
  // already neutralises the dot for a disconnected provider; leaving the sweep
  // to a separate condition meant a disconnected row could in principle draw a
  // grey dot inside a fully ramped coloured arc. Unreachable today — the
  // collector only sets connected:false alongside fiveHour:null — but "the
  // comment says it cannot happen" is not enforcement.
  if (provider.connected === false) return null;
  if (!win) return null;
  if (win.certainty === 'unknown') return null;
  const pct = win.usedPercentage;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  // REJECT, do not clamp — the same rule, and the same wording, as
  // `percentage()` in `src/renderer/src/sanitize.ts`. Clamping 250 to 100
  // would draw a confident full ring out of a value that proves the producer
  // is wrong; returning null makes the tray show its no-data ring, which is
  // what the panel does with the identical input. Two surfaces reading one
  // number must not disagree about when that number is unusable.
  if (pct < 0 || pct > 100) return null;
  // Last: a number that was true when the snapshot was built but will not
  // survive this artefact's lifetime is no more drawable than a missing one.
  if (windowResetting(win, now)) return null;
  return pct;
}

function windowPercentage(provider, key, now = Date.now()) {
  if (!provider) return null;
  return percentageOfWindow(provider, provider[key], now);
}

/**
 * The five-hour window the TRAY draws — the MOST-CONSUMED model group, not the
 * selected one the panel headline shows (snapshot.js, `headlineWindow`).
 *
 * The split is deliberate and the coordinator ruled it: the panel headline can
 * name the model it belongs to, so it follows the user's selection; a 16px
 * donut cannot, so a figure that silently changed meaning when the user
 * switched model would be unreadable. The tray therefore always shows the
 * binding constraint — the worst group — which is `modelQuotas.groups[0]`
 * (the reader sorts most-consumed first).
 *
 * Providers with no per-model breakdown (Claude) fall straight through to
 * their own `fiveHour`, unchanged.
 */
function trayFiveHourWindow(provider) {
  const mq = provider && provider.modelQuotas;
  const groups = mq && Array.isArray(mq.groups) ? mq.groups : null;
  if (groups && groups.length > 0) {
    const worst = groups[0];
    return {
      usedPercentage: worst.usedPercentage,
      certainty: 'known',
      resetsAt: worst.resetsAt,
    };
  }
  return provider ? provider.fiveHour : null;
}

/**
 * The percentage the tray icon is allowed to draw, or null.
 *
 * Five-hour first, weekly second. The fallback is NOT the retargeting the
 * comment below forbids — that is about swapping to a different PROVIDER, and
 * this stays on the row the user put first. It is the rule `row.ts` and
 * `meter.ts` already apply inside the panel: draw the window you can defend.
 *
 * It was added for a provider whose only server-computed window is a weekly
 * one. Without it the tray drew its no-data ring while the tooltip, built from
 * the SAME snapshot, said `Haftalık limit: %98` — a blank glanceable surface
 * beside a real 98%, which errs optimistic, and two surfaces disagreeing about
 * one number, which is what this file argues against everywhere else.
 *
 * Nothing changes for Claude, whose `fiveHour` is populated whenever anything
 * is: the fallback is only reached when the first window has no defensible
 * figure at all.
 */
function drawablePercentage(provider, now = Date.now()) {
  // The five-hour slot is the most-consumed group for a provider that has
  // one, and `provider.fiveHour` for one that does not. See
  // `trayFiveHourWindow` for why the tray does not follow the panel headline.
  const five = percentageOfWindow(provider, trayFiveHourWindow(provider), now);
  if (five !== null) return five;
  return windowPercentage(provider, 'sevenDay', now);
}

/**
 * The first ENABLED row — the top row the user actually put in the panel.
 *
 * DELIBERATELY not "the first provider with drawable data". When the lead
 * provider disconnects, the tray shows ITS no-data ring; it does not quietly
 * retarget to whichever row still has a number. Retargeting would mean the
 * icon silently describes a provider the user did not choose, with nothing on
 * screen saying so — a worse lie than an honest no-data ring, and one the user
 * cannot detect. The broken ring is legible as "no reading", so the honest
 * state is also the readable one.
 *
 * Enablement is the one exception, and it is the same argument rather than a
 * contradiction of it: the snapshot carries ALL providers because the settings
 * view needs the full list (contract.ts, `Snapshot.providers`), but an un-added
 * provider has NO ROW in the panel. Letting it drive the icon would describe a
 * provider the user cannot see anywhere on screen — undetectable in exactly the
 * way retargeting is. When nothing is enabled there is no row to describe, so
 * the tray shows the no-data ring.
 *
 * `enabled !== false` rather than `enabled === true`: every snapshot this
 * codebase builds sets the field, so the two agree in practice, and the loose
 * test means a hand-built or older payload degrades to "shown" instead of
 * silently blanking the icon.
 */
function leadProvider(snapshot) {
  const providers = snapshot && Array.isArray(snapshot.providers) ? snapshot.providers : [];
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue;
    if (provider.enabled === false) continue;
    return provider;
  }
  return null;
}

/** @returns {{usedPercentage:number|null, accent:string, state:string}} */
function traySpecFromSnapshot(snapshot, now = Date.now()) {
  const provider = leadProvider(snapshot);
  const usedPercentage = drawablePercentage(provider, now);
  return {
    usedPercentage,
    accent: accentOf(provider),
    state: usedPercentage === null ? 'none' : stateForPercentage(usedPercentage),
  };
}

/**
 * Everything the drawn icon depends on, and nothing else.
 *
 * Snapshots are pushed every 15 s while the panel is open and on every
 * transcript change; rebuilding four bitmaps for a burn-rate that moved by two
 * tokens is pure waste in a process that runs all day. The key deliberately
 * contains the ROUNDED percentage, so 61.2 -> 61.4 is not a redraw, and the
 * id of the LEADING provider, so a reorder that leaves the number unchanged
 * still is one.
 *
 * That id comes from `leadProvider()`, which now skips un-added rows, and that
 * is what makes a settings toggle repaint: turning the top provider off moves
 * the lead to the next enabled row (or to nothing), and the id in the key
 * changes with it. Keying on `providers[0]` instead would leave the old donut
 * on screen describing a row the panel no longer shows.
 *
 * `ground` is in the key for exactly the same reason. The icon is painted from
 * one of two ramps depending on the taskbar's own light/dark setting, and a
 * user flipping Windows to light mode changes NOTHING about the snapshot — so
 * without it the key would match, the early return would fire, and the dark
 * ramp would stay on a light taskbar until the percentage happened to move.
 *
 * @param {'dark'|'light'} [ground]
 */
function trayIconKey(snapshot, now = Date.now(), ground = 'dark') {
  const provider = leadProvider(snapshot);
  // `spec.accent` already folds in `connected`, so a provider going offline
  // changes the key through its dot colour as well as its no-data flag. The
  // spec also folds in the reset horizon, so a reading ageing out of validity
  // flips the key and forces the repaint that blanks the ring.
  const spec = traySpecFromSnapshot(snapshot, now);
  const shown = spec.usedPercentage === null ? 'none' : String(Math.round(spec.usedPercentage));
  const id = provider && typeof provider.id === 'string' ? provider.id : 'none';
  return `${id}|${shown}|${spec.state}|${spec.accent}|${ground === 'light' ? 'light' : 'dark'}`;
}

module.exports = {
  STATE_THRESHOLDS,
  FALLBACK_ACCENT,
  READING_HORIZON_MS,
  windowResetting,
  stateForPercentage,
  windowPercentage,
  drawablePercentage,
  leadProvider,
  traySpecFromSnapshot,
  trayIconKey,
};
