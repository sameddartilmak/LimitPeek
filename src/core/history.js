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
 * WHAT TOKEN FIGURES IT DOES EMIT, AND WHY THEY ARE NOT THAT
 * ----------------------------------------------------------
 * "How many tokens did I use" is a real question with a true answer, and the
 * ban is on ONE specific answer: a single scalar that folds the four classes —
 * and, worse, the four tools — into one. So the counts are emitted only in the
 * two shapes that keep every distinction the scalar destroys:
 *   `PeriodUsage.tokensByProvider`  one TokenBreakdown per tool with usage,
 *   `PeriodModelCost.tokens`        one per (tool, model) entry,
 * both of them per-class, both with `billable` excluding cacheRead. There is
 * still no period-level number, and producing one by adding these up is the
 * banned operation, not a gap — `test/token-merge-scan.test.js` scans the
 * source for anyone attempting it.
 *
 * `tokenFloorCausesByProvider` says which of those counts is a lower bound and
 * WHY, per tool (A3.16: never a floor without a visible cause). It is NARROWER
 * than `isFloor`: a count is only ever a floor because the recorder did not
 * record something (Gemini's utility calls, Codex's cache writes) or the reader
 * knows it could not read something. What a figure may be CHARGED at never
 * enters it. `tokenFloorCauses()` is that rule, and the panel row calls the
 * same function over its own window. Each figure is folded from the SAME pricer rows
 * that produced the dollars beside it (`sumRowTokens`), so a count and a cost
 * on one line can never be describing different events.
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
 *
 * PER-MODEL BREAKDOWN
 * -------------------
 * Each period also carries a `byModel` list: the same period, split by the
 * event's recorded `model` id, each entry priced through `pricing.js` exactly
 * the way the period total is. The honesty rule is IDENTICAL and
 * non-negotiable — an entry carries a `costUsd` and a per-class `tokens`
 * breakdown (never a merged token count), is a `isFloor` lower bound exactly
 * when its own usage was excluded or hit the
 * 1.25x cache-write floor, and a model with no published price carries
 * `costUsd: null` (the renderer says "fiyatlanamadı", never "$0,00"). Grouping
 * is by the RAW recorded model id, matching how `pricing.js` groups, so the
 * per-model priced figures partition the period total.
 *
 * TWO TOOLS, ONE LIST
 * -------------------
 * A period covers Claude Code AND Codex. Each side is priced by its OWN price
 * table under its OWN honesty rules — Claude through `pricing.js` (TTL split,
 * speed rows), Codex through `codex/pricing.js` (OpenAI's single cached tier)
 * — and only the resulting DOLLARS are combined: `costUsd` and `byClass` are
 * sums of the two priced figures, `isFloor` is true when either side is a
 * floor, `hasUsage` when either side has usage, and `byModel` holds both
 * sides' entries, each tagged with its `provider`, in one order. No token count
 * is ever summed across the two tools: `tokensByProvider` keys them BY tool for
 * exactly that reason, and a Claude count and a Codex count never meet in one
 * number. Codex events are the per-turn deltas from `codex/usage.js`
 * (cumulative-total deltas; reasoning is a subset of output and is never added
 * twice).
 *
 * GEMINI CLI AND KIMI CODE (ADR-003 A6)
 * -------------------------------------
 * The same rule extends to four tools. Gemini messages (deduped by message id in
 * `gemini/usage.js`) are priced by `gemini/pricing.js` and are ALWAYS a floor
 * (unrecorded utility calls). Kimi usage (`kimi/usage.js`) has no price at all:
 * its models appear in `byModel` with `costUsd: null`, contribute no dollars,
 * and make the period a floor exactly as any other unpriced model does.
 *
 * `usageProviders` and `floorCausesByProvider` exist so the renderer can compose
 * its price note for ANY set of tools ("dates + causes") instead of a sentence
 * hard-coded per combination.
 */

const pricing = require('./pricing');
const codexPricing = require('./codex/pricing');
const geminiPricing = require('./gemini/pricing');
const kimiCostMod = require('./kimi/cost');

/** How many of the most recent periods to surface. Bounds both the compute
 *  (one price pass over the corpus per bucket) and the list length in a narrow
 *  hover panel. Older periods are dropped, newest kept. */
const DEFAULT_MAX_WEEKS = 12;
const DEFAULT_MAX_MONTHS = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Longest per-model list a period or a cost carries (security F4; the renderer's own cap). */
const MAX_LIST = 24;

/** Tools whose local usage feeds the history, in the order they are listed. */
const INCOMPLETE_ORDER = ['claude', 'codex', 'gemini', 'kimi'];

/**
 * `UsageHistory.floorCausesByProvider` codes, in the order they are listed.
 * Stable: the renderer maps each to catalog text.
 */
const FLOOR_CAUSE_ORDER = [
  // TOKEN-side only (see `tokenFloorCauses`): a range the reader KNOWS it could
  // not read. Deliberately never emitted into the COST-side
  // `floorCausesByProvider`, where the gap already has its own field
  // (`UsageHistory.incompleteProviders`) and its own note, and where ADR-002
  // A3.20 rules that the price notes do not grow a clause for it.
  'unread-range',
  'unpriced', // some usage has no price (unknown model, unpriced tier, no model, Kimi)
  'cache-write-ttl-fallback', // Claude: TTL split missing, writes priced at 1.25x
  'unrecorded-writes', // Codex: 0 recorded cache writes on a write-priced model (A3.3/A3.9)
  'assumed-tier', // Codex: no tier recorded yet, priced at Standard (A3.17)
  'fast-requested', // Codex: Fast requested, priced at Standard (A3.18)
  'unrecorded-calls', // Gemini: utility calls and failed streams are never recorded
  'long-prompt', // Gemini: prompt over 200k priced at the <=200k rate
  'tool-tokens', // Gemini: tool-use prompt tokens not priced
];

/**
 * Did this breakdown count ANYTHING? Any class, not just `billable` — a week of
 * nothing but cache reads is a real measurement, and `billable` excludes them.
 *
 * The gate on every token floor: with no amount there is nothing for a cause to
 * qualify, so a zero count is never "en az 0". The same reasoning
 * `emptyWeeklyCost` already applies on the cost side.
 */
function hasAnyTokens(t) {
  return Boolean(t) && (t.input > 0 || t.output > 0 || t.cacheWrite > 0 || t.cacheRead > 0);
}

/**
 * Why one tool's token COUNT is a lower bound, as `HistoryFloorCause` codes in
 * `FLOOR_CAUSE_ORDER`. Empty array = the count is exact.
 *
 * THE ONE DEFINITION OF THE RULE, for both producers. The panel row
 * (`snapshot.js`) and a history period (this module) compute over different
 * windows — an anchored-or-trailing quota week versus a local calendar week —
 * but the rule that turns facts into causes is identical, and two copies of it
 * would drift with nothing asserting they agree. So each caller keeps its OWN
 * window arithmetic, reduces it to the booleans below, and calls this.
 *
 * Every cause is SOURCE BEHAVIOUR: the recorder did not record something, or
 * the reader could not read something. The MONETARY causes are deliberately
 * absent and no caller may pass one in — an unpriced model, a Codex tier
 * assumed Standard or Fast-requested, and Claude's cache-write TTL fallback
 * each count every token they saw and differ only in what they may charge. That
 * is why this is narrower than `PeriodUsage.isFloor`.
 *
 * @param {string} providerId
 * @param {{hasCount: boolean, sourceIncomplete?: boolean, unrecordedWrites?: boolean}} facts
 *   hasCount           the count is not entirely zero (see `hasAnyTokens`)
 *   sourceIncomplete   a known-unread range overlaps this caller's window
 *   unrecordedWrites   Codex only: a turn recorded 0 cache writes although it
 *                      read cache or sent a cacheable prompt (A3.3/A3.9),
 *                      decided with no price lookup
 * @returns {string[]} fresh array, safe for the caller to keep
 */
function tokenFloorCauses(providerId, facts) {
  const f = facts || {};
  // No amount, no bound. A zero count with `sourceIncomplete` is the A3.19
  // "could not be counted" state, which is NOT a floor and carries its own
  // sentence; the caller reads that from `WeeklyCost.sourceIncomplete`.
  if (f.hasCount !== true) return [];
  const hit = new Set();
  if (f.sourceIncomplete === true) hit.add('unread-range');
  // Unconditional while Gemini CLI has a count (ADR-003 A6): its utility calls
  // and failed streams are NEVER recorded, so tokens are missing whether or not
  // the recorded ones could be priced. Never derived from
  // `WeeklyCost.unrecordedCalls`, which is a cost cause and goes false when
  // nothing in the window priced.
  if (providerId === 'gemini') hit.add('unrecorded-calls');
  if (providerId === 'codex' && f.unrecordedWrites === true) hit.add('unrecorded-writes');
  return FLOOR_CAUSE_ORDER.filter((c) => hit.has(c));
}

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

/** Same rounding as both pricers, so a sum of two rounded figures stays tidy. */
function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * One `TokenBreakdown` over a set of `ModelCost` rows FROM ONE TOOL.
 *
 * Every pricer already accumulates each (model, speed/tier) group's four raw
 * counts while it prices it — including for a group it cannot price, where
 * "tokens accumulate, dollars do not" (`pricing.js`, `codex/pricing.js`). So
 * folding those rows up is not a second, parallel accounting of the corpus: it
 * is the SAME pass that produced the dollars, read one level higher. That is
 * what makes a period's token figure and its cost figure incapable of
 * describing different events.
 *
 * `billable` is RE-DERIVED from the summed classes rather than added up from
 * the rows, so the `input + output + cacheWrite` identity holds exactly at
 * every level and cannot drift by a row that carried a stale one. cacheRead
 * stays out of it: ~98% of raw volume at 0.1x (ADR-001), reported on its own.
 *
 * CALLER'S OBLIGATION: rows from two different tools must never be passed in
 * together. Dollars are comparable across tools and are summed; token counts
 * are not and never are.
 */
function sumRowTokens(rows) {
  const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };
  for (const row of rows || []) {
    const rt = row && row.tokens;
    if (!rt) continue;
    t.input += rt.input;
    t.output += rt.output;
    t.cacheWrite += rt.cacheWrite;
    t.cacheRead += rt.cacheRead;
  }
  t.billable = t.input + t.output + t.cacheWrite;
  return t;
}

/**
 * Largest priced cost first; unpriced entries last; ties by provider then id,
 * so the order does not depend on which file (or which tool) was read first.
 */
function compareModelEntries(a, b) {
  const byId = (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0)
    || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
  if (a.costUsd === null && b.costUsd === null) return byId;
  if (a.costUsd === null) return 1;
  if (b.costUsd === null) return -1;
  return b.costUsd - a.costUsd || byId;
}

/**
 * The per-model split of one period.
 *
 * Groups the in-window events by their RAW recorded `model` id (the same key
 * `pricing.js` groups on, so two speeds of a model stay in one entry and the
 * priced entries partition the period total), then prices each model's slice
 * through `pricing.weeklyCost`. Reusing the pricer verbatim is what keeps the
 * per-model figures honest without a second copy of the TTL and unpriced rules:
 *
 *   costUsd  the model's priced total, or `null` when NONE of its usage could
 *            be priced (no price-table row at any speed). Never 0-for-unpriced:
 *            a silent zero is the ADR-002 rule-2 failure this whole section
 *            exists to avoid, so the renderer reads null as "fiyatlanamadı".
 *   isFloor  true when this model's own figure is a LOWER BOUND — a cache-write
 *            TTL split was missing (priced at the 1.25x floor) or part of its
 *            usage was at an unpriced speed and excluded. Every cause pushes
 *            the true figure up, exactly as at the period level.
 *   tokens   the four raw counts of the SAME slice `costUsd` was priced from,
 *            summed across the model's speeds — never a single merged total,
 *            and `billable` excludes cacheRead (ADR-001). Present even when
 *            `costUsd` is null: an unpriced model still used tokens; what it
 *            lacks is a published price, not usage.
 *
 * Largest priced cost first; unpriced models last, then by id, so the order
 * does not depend on which file was read first.
 *
 * @param {Array}  events         deduped usage events
 * @param {number} startMs        inclusive period start
 * @param {number} endExclusiveMs exclusive period end
 * @returns {Array<{provider:'claude', model:string, costUsd:number|null,
 *                  isFloor:boolean, tokens:object}>}
 */
function byModelUsageFrom(events, startMs, endExclusiveMs) {
  // One pass: partition the in-window events by raw model id. `pricing.js`
  // filters by ts again on each slice, but the slices are already small and
  // in-window, so that second filter is cheap.
  const groups = new Map();
  for (const event of events || []) {
    if (!event || !Number.isFinite(event.ts)) continue;
    if (event.ts < startMs || event.ts >= endExclusiveMs) continue;
    const model = event.model;
    let slice = groups.get(model);
    if (!slice) {
      slice = [];
      groups.set(model, slice);
    }
    slice.push(event);
  }

  const out = [];
  for (const [model, slice] of groups) {
    const cost = pricing.weeklyCost(slice, startMs, endExclusiveMs, false);
    if (!cost) continue; // unreachable — the slice is non-empty and in-window
    const hasPricedRow = cost.byModel.some((m) => m.usd !== null);
    const hasUnpricedRow = cost.byModel.some((m) => m.usd === null);
    out.push({
      provider: 'claude',
      model,
      // null when the model has no priced usage at all; the period total already
      // excluded it and the renderer must not print it as $0,00.
      costUsd: hasPricedRow ? cost.totalUsd : null,
      isFloor: cost.fallbackWriteEvents > 0 || hasUnpricedRow,
      // The whole slice, priced rows and unpriced ones alike — these events are
      // exactly the ones `costUsd` was computed over.
      tokens: sumRowTokens(cost.byModel),
    });
  }

  out.sort(compareModelEntries);

  return out;
}

/**
 * The Codex per-model split of an already-priced Codex window, grouped by RAW
 * model id exactly as the Claude side is (the tiers of one model fold into one
 * entry, as Claude's speeds do). Under ADR-002 Amendment 3:
 *
 *   costUsd  the model's priced total across its tiers, or `null` when none
 *            of its usage could be priced (unknown model, a tier with no row,
 *            an undeterminable tier, a long-context prompt). Never 0.
 *   isFloor  true when part of the model's usage was excluded (an unpriced
 *            tier or long-context row beside a priced one), or when a priced
 *            event on a model with a write price recorded 0 writes although
 *            it read cache or sent an uncached prompt of >= 1,024 tokens
 *            (rule 3, A3.9), or when a priced event's tier was assumed Standard
 *            or requested Fast and priced at Standard (A3.17-18). Every cause
 *            pushes the true figure up.
 *
 *   tokens   the model's four raw counts across its tiers, from the very rows
 *            that produced `costUsd` — so the pair cannot describe different
 *            turns. Present on an unpriced model too. NOTE for the caller: a
 *            Codex `cacheWrite` count is a LOWER BOUND wherever
 *            `writeFloorByModel` is non-zero (A3.3/A3.9 — Codex records 0
 *            writes on every record), which makes `billable` one as well.
 *
 * @param {{cost: object|null, writeFloorByModel: Map<string, number>,
 *          tierFloorByModel?: Map<string, number>}} detail
 *        `codexPricing.codexCostDetail` result for the period
 * @returns {Array<{provider:'codex', model:string, costUsd:number|null,
 *                  isFloor:boolean, tokens:object}>}
 */
function codexByModelFrom(detail) {
  const cost = detail && detail.cost;
  if (!cost) return [];
  const byModel = new Map();
  for (const row of cost.byModel) {
    let entry = byModel.get(row.model);
    if (!entry) {
      entry = { provider: 'codex', model: row.model, priced: 0, anyPriced: false, anyUnpriced: false, rows: [] };
      byModel.set(row.model, entry);
    }
    // Every row of this model, whatever its tier and whether or not it could be
    // priced: the tokens were used either way.
    entry.rows.push(row);
    if (row.usd === null) {
      entry.anyUnpriced = true;
    } else {
      entry.anyPriced = true;
      entry.priced += row.usd;
    }
  }
  const floors = detail.writeFloorByModel || new Map();
  const tierFloors = detail.tierFloorByModel || new Map();
  return [...byModel.values()].map((e) => ({
    provider: 'codex',
    model: e.model,
    costUsd: e.anyPriced ? round(e.priced) : null,
    isFloor: (e.anyPriced && e.anyUnpriced) || (floors.get(e.model) || 0) > 0
      || (tierFloors.get(e.model) || 0) > 0,
    tokens: sumRowTokens(e.rows),
  }));
}

/**
 * Gemini or Kimi per-model entries of a period's cost, grouped by raw model id.
 *   costUsd  the model's priced total, or null when none of it could be priced
 *            (Kimi always; Gemini for an unknown id or tokens with no model).
 *   isFloor  Gemini: true for every priced entry, since utility calls and failed
 *            streams are never recorded, whatever the model. Kimi: false (a null
 *            figure has no bound to be lower than).
 *   tokens   the model's four raw counts, from the rows the cost was built
 *            from. This is the one place a Kimi entry carries a real figure:
 *            it has no price, but it has usage. Gemini's counts are a LOWER
 *            BOUND for the same reason its cost is — the unrecorded calls are
 *            missing from the count too, not merely from the price.
 */
function localByModelFrom(provider, cost) {
  if (!cost) return [];
  const byModel = new Map();
  for (const row of cost.byModel) {
    let e = byModel.get(row.model);
    if (!e) { e = { priced: 0, anyPriced: false, rows: [] }; byModel.set(row.model, e); }
    e.rows.push(row);
    if (row.usd !== null) { e.anyPriced = true; e.priced += row.usd; }
  }
  return [...byModel].map(([model, e]) => ({
    provider,
    model,
    costUsd: e.anyPriced ? round(e.priced) : null,
    isFloor: provider === 'gemini' && e.anyPriced,
    tokens: sumRowTokens(e.rows),
  }));
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
 * @param {Array}  [codexEvents]    Codex per-turn deltas (codex/usage.js)
 * @param {Set<string>|string[]|boolean} [knownIncomplete] the tools with a
 *        known-unread range overlapping this period (ADR-002 A3.20); `true`
 *        means both. The period is then a floor, and so is every model entry of
 *        an affected tool (review F6).
 */
function periodUsageFrom(events, startMs, endExclusiveMs, key, codexEvents, knownIncomplete = false, more = {}) {
  const incomplete = knownIncomplete === true
    ? new Set(INCOMPLETE_ORDER)
    : new Set(knownIncomplete instanceof Set ? knownIncomplete : (Array.isArray(knownIncomplete) ? knownIncomplete : []));
  const lastDayMs = startOfDayMs(endExclusiveMs - 1);
  const base = {
    key,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(lastDayMs).toISOString(),
  };

  // `anchored: false` — these are calendar periods, not quota windows.
  const cost = pricing.weeklyCost(events, startMs, endExclusiveMs, false);
  const cxDetail = codexPricing.codexCostDetail(codexEvents || [], startMs, endExclusiveMs, false);
  const cxCost = cxDetail.cost;
  const gmCost = geminiPricing.geminiCost(more.geminiEvents || [], startMs, endExclusiveMs, false);
  const kmCost = kimiCostMod.kimiCost(more.kimiEvents || [], startMs, endExclusiveMs, false);
  if (!cost && !cxCost && !gmCost && !kmCost) {
    return {
      ...base,
      costUsd: 0,
      byClass: emptyByClass(),
      // No tool has usage here, so no tool has an entry. Always an object: the
      // renderer reads a map, never a null it has to guard.
      tokensByProvider: {},
      // No count exists, so no count can be a lower bound. That this period
      // overlaps a known-unread range is said by `isFloor` just below and by
      // `UsageHistory.incompleteProviders` (A3.20), which is where that note
      // belongs — a token figure that does not exist is not "en az".
      tokenFloorCausesByProvider: {},
      byModel: [],
      // Nothing was READ here; if usage is known to be unread, $0 is a floor.
      isFloor: incomplete.size > 0,
      unpricedModels: [],
      hasUsage: false,
    };
  }

  // A lower bound whenever anything was left out of the total or priced at a
  // floor: unpriced models excluded (either tool), or a Claude cache-write TTL
  // split missing and charged at 1.25x instead of up to 2x. Every one is
  // one-way — it can only make the true cost HIGHER — so the renderer prefixes
  // "en az". Codex's `fallbackWriteEvents` is always 0 today, but it is read
  // the same way so a future change there cannot be dropped silently.
  const floorOf = (c) => Boolean(c) && (
    c.fallbackWriteEvents > 0 || c.unpricedModels.length > 0 || c.byModel.some((m) => m.usd === null)
  );
  // Codex adds its own floor cause (Amendment 3 rule 3, A3.9): writes recorded
  // as 0 on a model that charges for them, although the turn read cache or sent
  // a cacheable (>= 1,024-token) uncached prompt.
  // A3.17-18: turns priced at Standard although their tier was only assumed or
  // was Fast REQUESTED. A3.20: a known-unread range overlaps the period.
  // Gemini (ADR-003 A6): always a floor while it has usage (unrecorded calls),
  // plus its own counted causes. Kimi: every model is unpriced, so floorOf holds.
  const isFloor = floorOf(cost) || floorOf(cxCost) || cxDetail.writeFloorEvents > 0
    || cxDetail.assumedTierEvents > 0 || cxDetail.fastRequestedEvents > 0
    || floorOf(gmCost) || Boolean(gmCost && gmCost.unrecordedCalls) || floorOf(kmCost)
    || incomplete.size > 0;

  // Per-tool causes for UsageHistory.floorCausesByProvider.
  if (more.causes) {
    const add = (provider, cause) => {
      let set = more.causes.get(provider);
      if (!set) { set = new Set(); more.causes.set(provider, set); }
      set.add(cause);
    };
    const unpriced = (c) => c.unpricedModels.length > 0 || c.byModel.some((m) => m.usd === null);
    if (cost) {
      if (unpriced(cost)) add('claude', 'unpriced');
      if (cost.fallbackWriteEvents > 0) add('claude', 'cache-write-ttl-fallback');
    }
    if (cxCost) {
      if (unpriced(cxCost)) add('codex', 'unpriced');
      if (cxDetail.writeFloorEvents > 0) add('codex', 'unrecorded-writes');
      if (cxDetail.assumedTierEvents > 0) add('codex', 'assumed-tier');
      if (cxDetail.fastRequestedEvents > 0) add('codex', 'fast-requested');
    }
    if (gmCost) {
      if (unpriced(gmCost)) add('gemini', 'unpriced');
      if (gmCost.unrecordedCalls) add('gemini', 'unrecorded-calls');
      if (gmCost.longPromptFloorEvents > 0) add('gemini', 'long-prompt');
      if (gmCost.toolTokenEvents > 0) add('gemini', 'tool-tokens');
    }
    if (kmCost) add('kimi', 'unpriced');
  }

  // Dollars are added across the tools, class by class; token counts never are.
  const byClass = emptyByClass();
  for (const k of Object.keys(byClass)) {
    byClass[k] = round((cost ? cost.byClass[k] : 0) + (cxCost ? cxCost.byClass[k] : 0)
      + (gmCost ? gmCost.byClass[k] : 0));
  }

  // ...and here is the same rule from the other side: one entry PER TOOL, so a
  // subtotal can be shown without ever existing as one merged number. A tool
  // appears only when it has usage in the period, which is exactly when its
  // pricer returned a cost at all. Each entry folds only that tool's own rows
  // (`sumRowTokens`), so nothing here can add Claude's cacheRead to Codex's.
  const tokensByProvider = {};
  for (const [provider, c] of [['claude', cost], ['codex', cxCost], ['gemini', gmCost], ['kimi', kmCost]]) {
    if (c) tokensByProvider[provider] = sumRowTokens(c.byModel);
  }

  /**
   * WHY each of those counts is a lower bound, per tool — not a bare flag,
   * because ADR-002 A3.16 forbids showing a floor without a visible cause, and
   * a token floor cannot always borrow one from the cost side (a Gemini period
   * with nothing priced sets the token floor while `unrecordedCalls` is false).
   *
   * The rule itself lives in `tokenFloorCauses`, shared with the panel row, so
   * the two producers cannot drift. This side contributes only its own window
   * arithmetic: which tools a known-unread range overlaps THIS period, and
   * whether a Codex turn in it recorded no cache writes.
   *
   * Keyed only for tools with a count here, and only when the count is not
   * entirely zero: an absent or zero figure has no bound to be lower than.
   */
  const tokenFloorCausesByProvider = {};
  for (const id of INCOMPLETE_ORDER) {
    const counted = tokensByProvider[id];
    if (!counted) continue;
    const causes = tokenFloorCauses(id, {
      hasCount: hasAnyTokens(counted),
      sourceIncomplete: incomplete.has(id),
      unrecordedWrites: cxDetail.unrecordedWriteTokens === true,
    });
    if (causes.length > 0) tokenFloorCausesByProvider[id] = causes;
  }

  const byModel = [
    ...(cost ? byModelUsageFrom(events, startMs, endExclusiveMs) : []),
    ...codexByModelFrom(cxDetail),
    ...localByModelFrom('gemini', gmCost),
    ...localByModelFrom('kimi', kmCost),
  ]
    // A tool with usage known unread in this period: each of its figures is a floor.
    .map((entry) => (incomplete.has(entry.provider) && !entry.isFloor ? { ...entry, isFloor: true } : entry))
    .sort(compareModelEntries);

  const unpricedModels = [...new Set([
    ...(cost ? cost.unpricedModels : []),
    ...(cxCost ? cxCost.unpricedModels : []),
    ...(gmCost ? gmCost.unpricedModels : []),
    ...(kmCost ? kmCost.unpricedModels : []),
  ])].sort();

  return {
    ...base,
    costUsd: round((cost ? cost.totalUsd : 0) + (cxCost ? cxCost.totalUsd : 0) + (gmCost ? gmCost.totalUsd : 0)),
    byClass,
    // Uncapped on purpose, unlike `byModel`: this is what a per-tool subtotal
    // must be read from, because adding up a list truncated at MAX_LIST would
    // silently understate it.
    tokensByProvider,
    tokenFloorCausesByProvider,
    // Bounded lists (security F4): the renderer shows at most MAX_LIST entries.
    byModel: byModel.slice(0, MAX_LIST),
    isFloor,
    unpricedModels: unpricedModels.slice(0, MAX_LIST),
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
 * @param {Array}  [codexEvents]
 * @param {(startMs:number, endMs:number) => Set<string>} [incompleteIn] the tools
 *        with a known-unread range overlapping [startMs, endMs)
 */
function bucketsOf(events, firstMs, now, max, kind, codexEvents, incompleteIn = () => new Set(), more = {}) {
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
    const end = nextOf(kept[i]);
    out.push(periodUsageFrom(events, kept[i], end, keyOf(kept[i]), codexEvents, incompleteIn(kept[i], end), more));
  }
  return out;
}

/**
 * The earliest instant any emitted period can start: the older of the first
 * kept month and the first kept week. A caller that has to READ events for the
 * history (the Codex rollout scan) needs nothing before this.
 *
 * @param {number} now
 * @param {{maxWeeks?:number, maxMonths?:number}} [opts]
 */
function historyStartMs(now, opts) {
  const maxWeeks = opts && Number.isFinite(opts.maxWeeks) ? opts.maxWeeks : DEFAULT_MAX_WEEKS;
  const maxMonths = opts && Number.isFinite(opts.maxMonths) ? opts.maxMonths : DEFAULT_MAX_MONTHS;
  const m = new Date(monthStartMs(now));
  m.setMonth(m.getMonth() - Math.max(0, maxMonths - 1));
  const w = new Date(weekStartMs(now));
  w.setDate(w.getDate() - 7 * Math.max(0, maxWeeks - 1));
  return Math.min(m.getTime(), w.getTime());
}

/**
 * Week-by-week and month-by-month notional cost over `events` (Claude Code)
 * and `opts.codexEvents` (Codex).
 *
 * `events` MUST already be deduped — the same set every other figure is derived
 * from — because session resume and /compact replay identical records into new
 * files, and the 115.3% inflation that causes would land directly on the money
 * (see aggregate.dedupe / pricing.weeklyCost). Codex events need no dedup:
 * they are deltas of a per-session cumulative total, so a re-emitted record is
 * a zero delta, not a second charge.
 *
 * `pricesAsOf` keeps its original meaning, the Claude table's date, for
 * compatibility. `pricesAsOfByProvider` names exactly the tables whose prices
 * are in the figures: a tool appears only when its usage is part of the
 * history — the date of a table that priced nothing is not a fact about these
 * figures.
 *
 * @param {Array} events         deduped usage events, each with `ts`
 * @param {number} now
 * `opts.unreadRanges` maps a tool id to the `{ fromMs, throughMs }` ranges of
 * usage its reader KNOWS it could not read (ADR-002 A3.20). A period overlapping
 * one is a floor, and `incompleteProviders` lists every tool with a range
 * overlapping any listed period, so the renderer can show one note.
 *
 * @param {{maxWeeks?:number, maxMonths?:number, codexEvents?:Array,
 *          unreadRanges?:Object<string, Array<{fromMs:number, throughMs:number}>>}} [opts]
 * @returns {{weeks:Array, months:Array, pricesAsOf:string, pricesAsOfByProvider:Object,
 *            incompleteProviders:string[]}}
 */
function usageHistory(events, now, opts) {
  const list = Array.isArray(events) ? events : [];
  const codexList = opts && Array.isArray(opts.codexEvents) ? opts.codexEvents : [];
  const when = Number.isFinite(now) ? now : Date.now();
  const maxWeeks = opts && Number.isFinite(opts.maxWeeks) ? opts.maxWeeks : DEFAULT_MAX_WEEKS;
  const maxMonths = opts && Number.isFinite(opts.maxMonths) ? opts.maxMonths : DEFAULT_MAX_MONTHS;

  let firstMs = Infinity;
  let claudeUsed = false;
  for (const ev of list) {
    if (ev && Number.isFinite(ev.ts) && ev.ts <= when) {
      claudeUsed = true;
      if (ev.ts < firstMs) firstMs = ev.ts;
    }
  }
  const usedIn = (arr) => {
    let used = false;
    for (const ev of arr) {
      if (ev && Number.isFinite(ev.ts) && ev.ts <= when) {
        used = true;
        if (ev.ts < firstMs) firstMs = ev.ts;
      }
    }
    return used;
  };
  const codexUsed = usedIn(codexList);
  const geminiList = opts && Array.isArray(opts.geminiEvents) ? opts.geminiEvents : [];
  const kimiList = opts && Array.isArray(opts.kimiEvents) ? opts.kimiEvents : [];
  const geminiUsed = usedIn(geminiList);
  const kimiUsed = usedIn(kimiList);

  const pricesAsOfByProvider = {};
  if (claudeUsed) pricesAsOfByProvider.claude = pricing.PRICES_AS_OF;
  if (codexUsed) pricesAsOfByProvider.codex = codexPricing.PRICES_AS_OF;
  if (geminiUsed) pricesAsOfByProvider.gemini = geminiPricing.PRICES_AS_OF;
  // Kimi has no price table, so it never has a date here.
  const usageProviders = INCOMPLETE_ORDER.filter((id) => (
    (id === 'claude' && claudeUsed) || (id === 'codex' && codexUsed)
    || (id === 'gemini' && geminiUsed) || (id === 'kimi' && kimiUsed)
  ));

  const unread = [];
  const rawRanges = opts && opts.unreadRanges && typeof opts.unreadRanges === 'object' ? opts.unreadRanges : {};
  for (const provider of INCOMPLETE_ORDER) {
    const ranges = Array.isArray(rawRanges[provider]) ? rawRanges[provider] : [];
    for (const r of ranges) {
      if (r && Number.isFinite(r.fromMs) && Number.isFinite(r.throughMs)) unread.push({ provider, ...r });
    }
  }
  const affected = new Set();
  const incompleteIn = (startMs, endMs) => {
    const hit = new Set();
    for (const r of unread) {
      if (r.throughMs >= startMs && r.fromMs < endMs) {
        affected.add(r.provider);
        hit.add(r.provider);
      }
    }
    return hit;
  };

  const causes = new Map();
  const more = { geminiEvents: geminiList, kimiEvents: kimiList, causes };
  const weeks = bucketsOf(list, firstMs, when, maxWeeks, 'week', codexList, incompleteIn, more);
  const months = bucketsOf(list, firstMs, when, maxMonths, 'month', codexList, incompleteIn, more);
  const floorCausesByProvider = {};
  for (const id of INCOMPLETE_ORDER) {
    const set = causes.get(id);
    if (set && set.size > 0) floorCausesByProvider[id] = FLOOR_CAUSE_ORDER.filter((c) => set.has(c));
  }
  // No period at all (nothing READ yet): still name the tools with unread usage
  // in the span the history would cover, so "no records found" is not claimed
  // over a known gap (review F6).
  if (weeks.length === 0 && months.length === 0) {
    incompleteIn(historyStartMs(when, { maxWeeks, maxMonths }), when + 1);
  }
  return {
    weeks,
    months,
    pricesAsOf: pricing.PRICES_AS_OF,
    pricesAsOfByProvider,
    usageProviders,
    floorCausesByProvider,
    incompleteProviders: INCOMPLETE_ORDER.filter((id) => affected.has(id)),
  };
}

module.exports = {
  usageHistory,
  historyStartMs,
  codexByModelFrom,
  localByModelFrom,
  periodUsageFrom,
  FLOOR_CAUSE_ORDER,
  MAX_LIST,
  byModelUsageFrom,
  bucketsOf,
  startOfDayMs,
  weekStartMs,
  nextWeekStartMs,
  monthStartMs,
  nextMonthStartMs,
  weekKey,
  monthKey,
  emptyByClass,
  sumRowTokens,
  tokenFloorCauses,
  hasAnyTokens,
  DEFAULT_MAX_WEEKS,
  DEFAULT_MAX_MONTHS,
};
