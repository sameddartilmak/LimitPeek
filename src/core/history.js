'use strict';

/**
 * Per-period usage history (week-by-week / month-by-month).
 *
 * WHY THIS IS COST AND NOT "TOKENS USED PER PERIOD"
 * ------------------------------------------------
 * This project's whole thesis (README) is that summing the four token classes
 * into ONE figure is meaningless: on the reference machine `cache_read` is
 * ~98% of raw volume and bills at 0.1x, so a single "tokens used this week"
 * number is dominated by the cheapest class and says nothing about how much a
 * period actually cost. ADR-001 bans deriving such figures.
 *
 * So a period is summarised the one honest way there is: its NOTIONAL COST at
 * published API prices (ADR-002), exactly the figure the weekly cost block
 * already shows on the Claude row. Cost has a published denominator — price per
 * million tokens, per model, per class — which is the distinction ADR-001 drew.
 * It is NOT a bill (the user is on a subscription); the renderer frames every
 * figure here as "what this would have cost at published API rates", carries
 * the same "en az" lower-bound wording when anything was excluded, and NEVER
 * shows a bare merged token total. This module deliberately emits no such total:
 * a `PeriodUsage` carries `costUsd` and a per-class `byClass`, never a single
 * summed token count.
 *
 * WHAT A "PERIOD" IS
 * ------------------
 * Buckets are aligned to the LOCAL calendar, because the user reads them as
 * calendar periods ("2–8 Eylül"): a week runs Monday 00:00 local to the next
 * Monday 00:00 (half-open, matching every other window in this app — a record
 * on the boundary belongs to the NEW period), and a month runs from the 1st at
 * 00:00 local to the 1st of the next month. Local arithmetic via Date methods
 * also makes the boundaries DST- and month-length-correct for free.
 *
 * Empty periods between the first observed usage and now are emitted as honest
 * zeros (`hasUsage: false`), never invented and never omitted, so a quiet week
 * reads as a quiet week and not as missing data.
 */

const pricing = require('./pricing');

/** How many of the most recent periods to surface. Bounds both the compute
 *  (one price pass over the corpus per bucket) and the list length in a narrow
 *  hover panel. Older periods are dropped, newest kept. */
const DEFAULT_MAX_WEEKS = 12;
const DEFAULT_MAX_MONTHS = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight of the day containing `ms`. */
function startOfDayMs(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local Monday 00:00 of the week containing `ms`. */
function weekStartMs(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0=Sunday..6=Saturday. Distance back to Monday.
  const sinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - sinceMonday);
  return d.getTime();
}

/** The Monday that opens the week AFTER the one containing `ms`. `setDate`
 *  rather than `+ 7*DAY_MS` so a DST change inside the week cannot drift the
 *  boundary off midnight. */
function nextWeekStartMs(ms) {
  const d = new Date(weekStartMs(ms));
  d.setDate(d.getDate() + 7);
  return d.getTime();
}

/** Local 1st-of-month 00:00 of the month containing `ms`. */
function monthStartMs(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** First instant of the next month. `Date(y, m+1, 1)` rolls December into
 *  January of the next year on its own. */
function nextMonthStartMs(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Stable, human-legible key from a LOCAL start instant. Weeks are keyed by the
 *  Monday's date ("2026-09-07"), months by "YYYY-MM". Used for identity only;
 *  the user-facing range is formatted by the renderer from `startsAt`/`endsAt`. */
function weekKey(startMs) {
  const d = new Date(startMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function monthKey(startMs) {
  const d = new Date(startMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function emptyByClass() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

/**
 * One period, priced.
 *
 * `startsAt` is the period start; `endsAt` is the INCLUSIVE last day of the
 * period (its local midnight), NOT the exclusive next-period boundary — so the
 * renderer can format "2 Eylül – 8 Eylül" straight through the existing
 * `dayRange()` with no off-by-one adjustment. Pricing still uses the exclusive
 * boundary internally.
 *
 * @param {Array}  events           deduped usage events
 * @param {number} startMs          inclusive period start (local midnight)
 * @param {number} endExclusiveMs   exclusive period end (next period start)
 * @param {string} key
 */
function periodUsageFrom(events, startMs, endExclusiveMs, key) {
  const lastDayMs = startOfDayMs(endExclusiveMs - 1);
  const base = {
    key,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(lastDayMs).toISOString(),
  };

  // `anchored: false` — these are calendar periods, not quota windows.
  const cost = pricing.weeklyCost(events, startMs, endExclusiveMs, false);
  if (!cost) {
    return {
      ...base,
      costUsd: 0,
      byClass: emptyByClass(),
      isFloor: false,
      unpricedModels: [],
      hasUsage: false,
    };
  }

  // A lower bound whenever anything was left out of the total or priced at a
  // floor: unpriced models excluded, or a cache-write TTL split missing and
  // charged at 1.25x instead of up to 2x. Every one is one-way — it can only
  // make the true cost HIGHER — so the renderer prefixes "en az".
  const hasUnpricedRow = cost.byModel.some((m) => m.usd === null);
  const isFloor = cost.fallbackWriteEvents > 0 || cost.unpricedModels.length > 0 || hasUnpricedRow;

  return {
    ...base,
    costUsd: cost.totalUsd,
    byClass: cost.byClass,
    isFloor,
    unpricedModels: cost.unpricedModels.slice(),
    // Something landed in the period even if none of it could be priced, so the
    // renderer can tell a genuinely quiet period from one it could not cost.
    hasUsage: true,
  };
}

/**
 * The contiguous run of period buckets from the first observed usage to `now`,
 * newest first, capped to the most recent `max`.
 *
 * @param {Array}  events
 * @param {number} firstMs   earliest event timestamp
 * @param {number} now
 * @param {number} max
 * @param {'week'|'month'} kind
 */
function bucketsOf(events, firstMs, now, max, kind) {
  if (!Number.isFinite(firstMs)) return [];
  const startOf = kind === 'week' ? weekStartMs : monthStartMs;
  const nextOf = kind === 'week' ? nextWeekStartMs : nextMonthStartMs;
  const keyOf = kind === 'week' ? weekKey : monthKey;

  const first = startOf(firstMs);
  const last = startOf(now);

  const starts = [];
  let cur = first;
  // A guard against a pathological clock (now far in the past, or NaN slipping
  // through): never spin, and never emit an unbounded list.
  for (let guard = 0; cur <= last && guard < 5000; guard += 1) {
    starts.push(cur);
    const next = nextOf(cur);
    if (next <= cur) break;
    cur = next;
  }

  const kept = starts.slice(Math.max(0, starts.length - max));
  const out = [];
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    out.push(periodUsageFrom(events, kept[i], nextOf(kept[i]), keyOf(kept[i])));
  }
  return out;
}

/**
 * Week-by-week and month-by-month notional cost over `events`.
 *
 * `events` MUST already be deduped — the same set every other figure is derived
 * from — because session resume and /compact replay identical records into new
 * files, and the 115.3% inflation that causes would land directly on the money
 * (see aggregate.dedupe / pricing.weeklyCost).
 *
 * @param {Array} events         deduped usage events, each with `ts`
 * @param {number} now
 * @param {{maxWeeks?:number, maxMonths?:number}} [opts]
 * @returns {{weeks:Array, months:Array, pricesAsOf:string}}
 */
function usageHistory(events, now, opts) {
  const list = Array.isArray(events) ? events : [];
  const when = Number.isFinite(now) ? now : Date.now();
  const maxWeeks = opts && Number.isFinite(opts.maxWeeks) ? opts.maxWeeks : DEFAULT_MAX_WEEKS;
  const maxMonths = opts && Number.isFinite(opts.maxMonths) ? opts.maxMonths : DEFAULT_MAX_MONTHS;

  let firstMs = Infinity;
  for (const ev of list) {
    if (ev && Number.isFinite(ev.ts) && ev.ts <= when && ev.ts < firstMs) firstMs = ev.ts;
  }

  return {
    weeks: bucketsOf(list, firstMs, when, maxWeeks, 'week'),
    months: bucketsOf(list, firstMs, when, maxMonths, 'month'),
    pricesAsOf: pricing.PRICES_AS_OF,
  };
}

module.exports = {
  usageHistory,
  periodUsageFrom,
  bucketsOf,
  startOfDayMs,
  weekStartMs,
  nextWeekStartMs,
  monthStartMs,
  nextMonthStartMs,
  weekKey,
  monthKey,
  emptyByClass,
  DEFAULT_MAX_WEEKS,
  DEFAULT_MAX_MONTHS,
};
