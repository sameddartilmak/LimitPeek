'use strict';
const {
  percentageOfWindow, trayFiveHourWindow, stateForPercentage,
} = require('./tray-spec');
const { rampFor } = require('./donut');
const { formatPercent, remainingDuration } = require('./tray-tooltip');
const { t } = require('./i18n');

/**
 * What the taskbar strip shows, derived from a snapshot (src/main/taskbar-strip.js
 * draws it). No `electron` import: plain `node --test` runs it.
 *
 * ONE TILE PER VISIBLE TOOL, in the panel's order (the snapshot is already
 * ordered). A tile has a row per window we can defend — the five-hour one and
 * the seven-day one — and a tool with only one of them shows only that row
 * (Codex today: weekly only). Left out entirely:
 *
 *   - a tool the user has not added to the panel (`enabled: false`), for the
 *     reason the tray donut gives (tray-spec.js leadProvider): it would
 *     describe a row the user cannot see anywhere;
 *   - a tool that is not on this machine;
 *   - a tool with neither window, including a disconnected one.
 *
 * THE SAME NUMBERS AS THE TRAY. Each figure goes through `percentageOfWindow`,
 * the tray's own gate — no window, `certainty: 'unknown'`, a value outside
 * 0..100 or a reset inside the reading horizon all mean "no row" — and the
 * five-hour slot is the tray's (`trayFiveHourWindow`: the most-consumed model
 * group where a tool publishes one). The colour is the tray donut's ramp for
 * the ground the strip sits on (donut.js `rampFor`), stepped by the shared
 * thresholds on the ROUNDED value, so a strip bar, the donut and the panel
 * meter never disagree about a colour.
 */

const MAX_TILES = 8;

/** 'dark' | 'light' from the taskbar colour the strip sits on. */
function groundFor(hex) {
  const m = typeof hex === 'string' && /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return 'dark';
  const v = parseInt(m[1], 16);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin((v >> 16) & 0xFF) + 0.7152 * lin((v >> 8) & 0xFF) + 0.0722 * lin(v & 0xFF);
  // The midpoint in contrast terms: above it, dark ink reads better.
  return lum > 0.18 ? 'light' : 'dark';
}

/**
 * "1 sa 37 dk" drawn tight, "1sa 37dk": the strip has a few pixels per row, and
 * a number glued to its unit still reads as one figure. Only the space between
 * a digit and a letter goes, so "2 gün 4 sa" becomes "2gün 4sa", "1h 37m" is
 * untouched, and Chinese has no such space.
 */
function tight(duration) {
  return typeof duration === 'string' ? duration.replace(/(\d) (?=\p{L})/gu, '$1') : null;
}

function rowFor(kind, pct, ground, win, now) {
  const shown = Math.round(pct);
  const state = stateForPercentage(pct);
  return {
    kind,
    label: t(kind === 'fiveHour' ? 'strip.label.fiveHour' : 'strip.label.weekly'),
    percent: shown,
    // The same figure and countdown the tooltip prints, in their short form:
    // the owner wanted the strip readable without hovering (2026-10-20).
    percentText: formatPercent(pct),
    left: tight(remainingDuration(win, now)),
    colour: rampFor(ground)[state],
    text: t(kind === 'fiveHour' ? 'strip.tip.fiveHour' : 'strip.tip.weekly', { percent: formatPercent(pct) }),
  };
}

/**
 * @param {object} snapshot
 * @param {number} now
 * @param {'dark'|'light'} ground
 * @returns {Array<{id:string, title:string, rows:Array<{kind:string,label:string,percent:number,percentText:string,left:string|null,colour:string}>}>}
 */
function stripTiles(snapshot, now = Date.now(), ground = 'dark') {
  const providers = snapshot && Array.isArray(snapshot.providers) ? snapshot.providers : [];
  const out = [];
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue;
    if (provider.enabled === false) continue;
    if (provider.setupAction && provider.setupAction.kind === 'not-installed') continue;
    const rows = [];
    const fiveWin = trayFiveHourWindow(provider);
    const five = percentageOfWindow(provider, fiveWin, now);
    const week = percentageOfWindow(provider, provider.sevenDay, now);
    if (five !== null) rows.push(rowFor('fiveHour', five, ground, fiveWin, now));
    if (week !== null) rows.push(rowFor('sevenDay', week, ground, provider.sevenDay, now));
    if (rows.length === 0) continue;
    const name = typeof provider.displayName === 'string' ? provider.displayName : provider.id;
    out.push({
      id: provider.id,
      title: `${name} — ${rows.map((r) => r.text).join(' · ')}`,
      rows: rows.map(({ kind, label, percent, percentText, left, colour }) => ({ kind, label, percent, percentText, left, colour })),
    });
    if (out.length >= MAX_TILES) break;
  }
  return out;
}

module.exports = { stripTiles, groundFor, MAX_TILES };
