'use strict';

const HOUR_MS = 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * 24 * HOUR_MS;

/**
 * `billable = input + output + cacheWrite`. cacheRead is deliberately
 * excluded: measured across the reference corpus it is 97.94% of all raw
 * tokens (2.40bn of 2.46bn) and bills at 0.1x, so folding it into a single
 * "tokens used" figure produces a number that means nothing. It is still
 * reported separately in TokenBreakdown.
 */
function billableOf(ev) {
  return ev.input + ev.output + ev.cacheWrite;
}

/**
 * Global dedup on the request identity, across ALL files at once.
 *
 * Per-file dedup is not enough: resuming or compacting a session replays the
 * same assistant records into a new transcript file. Measured inflation when
 * skipped: 115.3%.
 *
 * Sorted by (ts, key) first so the surviving record is deterministic and does
 * not depend on directory iteration order.
 */
function dedupe(events) {
  const sorted = events.slice().sort((a, b) => (a.ts - b.ts) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set();
  const out = [];
  for (const ev of sorted) {
    if (seen.has(ev.key)) continue;
    seen.add(ev.key);
    out.push(ev);
  }
  return out;
}

function emptyBreakdown() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };
}

/**
 * Half-open window: `start <= ts < end`. A record landing exactly on a reset
 * instant belongs to the NEW window, never the one that just closed.
 * `events` must already be deduped.
 */
function sumWindow(events, startMs, endMs) {
  const tokens = emptyBreakdown();
  const perModel = new Map();
  let count = 0;

  for (const ev of events) {
    if (ev.ts < startMs || ev.ts >= endMs) continue;
    tokens.input += ev.input;
    tokens.output += ev.output;
    tokens.cacheWrite += ev.cacheWrite;
    tokens.cacheRead += ev.cacheRead;
    count += 1;
    perModel.set(ev.model, (perModel.get(ev.model) || 0) + billableOf(ev));
  }
  tokens.billable = tokens.input + tokens.output + tokens.cacheWrite;

  const byModel = Array.from(perModel, ([model, billable]) => ({ model, billable }))
    .sort((a, b) => b.billable - a.billable || (a.model < b.model ? -1 : 1));

  return { tokens, byModel, count };
}

/**
 * The 5-hour token window.
 *
 * When Claude's statusline gave us a real `resetsAt`, the window is
 * `[resetsAt - 5h, resetsAt)` — that is the actual server window. When it did
 * not, we fall back to a trailing `[now - 5h, now)` and the caller labels the
 * result `certainty: 'unknown'` so the renderer draws no meter.
 *
 * `apiBlockIndex` is NOT used to derive this: it is present on only 9.3% of
 * records, is always 0, and spans 25.3 hours. It carries no window signal.
 */
function fiveHourWindow(now, resetsAtMs) {
  if (Number.isFinite(resetsAtMs)) {
    const end = resetsAtMs;
    const start = end - FIVE_HOURS_MS;
    // Elapsed part of the window only; the remainder has not happened yet.
    const elapsedMs = Math.max(0, Math.min(now, end) - start);
    return { start, end, elapsedMs, anchored: true };
  }
  return { start: now - FIVE_HOURS_MS, end: now, elapsedMs: FIVE_HOURS_MS, anchored: false };
}

function sevenDayWindow(now, resetsAtMs) {
  if (Number.isFinite(resetsAtMs)) {
    const end = resetsAtMs;
    const start = end - SEVEN_DAYS_MS;
    return { start, end, elapsedMs: Math.max(0, Math.min(now, end) - start), anchored: true };
  }
  return { start: now - SEVEN_DAYS_MS, end: now, elapsedMs: SEVEN_DAYS_MS, anchored: false };
}

/**
 * Billable tokens per hour over the elapsed part of the window. Returns null
 * rather than a spike when barely any time has elapsed (a window that just
 * reset would otherwise report a burn rate in the millions).
 */
function burnRatePerHour(billable, elapsedMs, minElapsedMs = 60 * 1000) {
  if (!Number.isFinite(billable) || billable <= 0) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs < minElapsedMs) return null;
  return Math.round((billable / elapsedMs) * HOUR_MS);
}

module.exports = {
  billableOf,
  dedupe,
  sumWindow,
  emptyBreakdown,
  fiveHourWindow,
  sevenDayWindow,
  burnRatePerHour,
  HOUR_MS,
  FIVE_HOURS_MS,
  SEVEN_DAYS_MS,
};
