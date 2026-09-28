'use strict';

/**
 * Notional USD cost of local token usage (ADR-002).
 *
 * Why this is allowed at all, when ADR-001 banned token arithmetic: ADR-001
 * banned deriving a PERCENTAGE, because a percentage needs a denominator and
 * no published quota denominator exists. Cost has one — price per million
 * tokens, published and per-model. The distinction is the denominator, not the
 * token counts.
 *
 * It is NOT a bill. The user is on a subscription and pays no per-token
 * charge; the UI must frame every figure here as "what this usage would have
 * cost at published API rates" (ADR-002, and contract.ts `WeeklyCost`).
 *
 * Three rules are load-bearing and each one is a wrong number if broken:
 *
 *   1. Cache writes are priced by TTL. 5-minute writes bill at 1.25x the
 *      input rate, 1-hour writes at 2.0x. Pricing both at 1.25x understated
 *      the reference week by ~$8.
 *   2. An unknown model is never priced at zero. It is excluded from the
 *      total and named in `unpricedModels`, because a silent zero is a wrong
 *      number wearing a right number's clothes.
 *   3. Price is a LOOKUP, never a branch. The table is keyed by
 *      (model, speed), so fast mode is a second row. Every factor that sets
 *      the price is read from the usage record itself: the model, the token
 *      class, the speed and the cache TTL — never from a setting or a
 *      preference (ADR-002 amendment 1).
 */

/**
 * The date the price table was current. Carried all the way to the UI:
 * prices drift, and a figure computed from stale prices has to say when the
 * prices were true.
 */
const PRICES_AS_OF = '2026-06-24';

/**
 * USD per 1,000,000 tokens, from the `claude-api` skill's cached table
 * (2026-06-24). Keyed by `<model>|<speed>`. Transcribed, not recalled: a price
 * remembered wrongly is indistinguishable from a price read correctly, right
 * up until the number is wrong.
 *
 * A model with no `|fast` row cannot be priced at fast speed — that is a
 * missing price, not an invitation to use the standard one. Fast mode IS
 * available on Opus 4.8, but no published price for it exists in the source
 * material, so there is deliberately no `claude-opus-4-8|fast` row here: that
 * usage falls to `usd: null` and surfaces in `unpricedModels`, which is a
 * visible gap instead of a plausible guess (ADR-002 rule 2, amendment 2).
 */
const PRICES = Object.freeze({
  // Opus 5.5 reads cache at 0.05x its input rate, half the usual 0.1x
  // ($0.20 standard). Writes use the standard multipliers. Fast mode is
  // $8/$40 and the cache multipliers apply on top of it. Source:
  // platform.claude.com/docs/en/about-claude/pricing, checked 2026-09-23.
  'claude-opus-5-5|standard': { input: 4.00, output: 20.00, read: 0.05 },
  'claude-opus-5-5|fast': { input: 8.00, output: 40.00, read: 0.05 },
  'claude-opus-5|standard': { input: 5.00, output: 25.00 },
  'claude-opus-5|fast': { input: 10.00, output: 50.00 },
  'claude-opus-4-8|standard': { input: 5.00, output: 25.00 },
  // Source: platform.claude.com/docs/en/about-claude/pricing, checked
  // 2026-09-24: $5 / $25, cache hits $0.50 (the standard 0.1x), 5m write
  // $6.25 (1.25x), 1h write $10 (2x); the 1M context is billed at the standard
  // rate, and there is no fast mode, so no `|fast` row.
  'claude-opus-4-6|standard': { input: 5.00, output: 25.00 },
  'claude-opus-4-7|standard': { input: 5.00, output: 25.00 },
  'claude-sonnet-5|standard': { input: 2.00, output: 10.00 },
  'claude-haiku-4-5|standard': { input: 1.00, output: 5.00 },
});

/**
 * Multipliers against that model's INPUT price. A row may override `read`
 * with its own, as Opus 5.5 does.
 */
const CACHE_MULTIPLIER = Object.freeze({
  read: 0.1,
  write5m: 1.25,
  write1h: 2.0,
});

const DEFAULT_SPEED = 'standard';

/** Model keys only, longest first, so prefix matching is unambiguous. */
const MODEL_KEYS = Object.freeze(
  [...new Set(Object.keys(PRICES).map((k) => k.slice(0, k.indexOf('|'))))]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1)),
);

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** USD, at 4 decimals. Cent-level presentation is the renderer's job. */
function round(usd) {
  return Math.round(usd * 1e4) / 1e4;
}

/**
 * Longest known model prefix, or null.
 *
 * Recorded ids carry a date suffix (`claude-haiku-4-5-20251001`), so an exact
 * match is not enough — but "any `-` segment" is far too generous, and this
 * table's own naming proves it: Opus 4.8 is written `claude-opus-4-8`, so a
 * MINOR VERSION has exactly the shape of a suffix. Matching on a segment break
 * alone, the day `claude-opus-5-1` ships every dollar of it would be computed
 * at Opus 5's rate and land in `totalUsd` looking sourced. That is ADR-002
 * rule 2 defeated by the single most likely form of unknown model.
 *
 * So the remainder must be a DATE and nothing else. An undated future suffix
 * falls through to unpriced, which is the safe direction: a visible gap rather
 * than a plausible number.
 */
function modelKeyFor(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  for (const key of MODEL_KEYS) {
    if (!model.startsWith(key)) continue;
    const rest = model.slice(key.length);
    if (rest === '' || /^-\d{8}$/.test(rest)) return key;
  }
  return null;
}

/** Absent, empty or 'standard' all mean standard. Anything else is verbatim. */
function speedOf(event) {
  const speed = event && event.speed;
  if (typeof speed !== 'string' || speed.length === 0) return DEFAULT_SPEED;
  return speed;
}

/**
 * The price row for one (model, speed), or null when the table has none.
 * @returns {{key:string, model:string, speed:string, input:number, output:number, read:number}|null}
 */
function priceFor(model, speed) {
  const modelKey = modelKeyFor(model);
  if (!modelKey) return null;
  const speedKey = typeof speed === 'string' && speed.length > 0 ? speed : DEFAULT_SPEED;
  const key = `${modelKey}|${speedKey}`;
  const row = PRICES[key];
  if (!row) return null;
  const read = typeof row.read === 'number' ? row.read : CACHE_MULTIPLIER.read;
  return { key, model: modelKey, speed: speedKey, input: row.input, output: row.output, read };
}

/**
 * Splits a record's cache writes into 5-minute and 1-hour tokens.
 *
 * The two per-TTL counters sum EXACTLY to the top-level
 * `cache_creation_input_tokens` on the reference corpus (2,913,704 +
 * 2,901,576 = 5,815,280), and that identity is used here as the validity
 * test — which is why no extra "was the breakdown present" flag is stored per
 * event. A record written before the breakdown existed carries 0 + 0 against
 * a non-zero total, fails the identity, and falls back to the documented
 * behaviour: the whole amount at the 5-minute rate.
 *
 * The fallback UNDERSTATES a 1-hour-heavy record, which is deliberate: it is
 * ADR-002's rule 1, and inventing a TTL mix we did not observe would be the
 * same class of error as inventing a percentage.
 */
function cacheWriteSplit(event) {
  const write5m = num(event.cw5);
  const write1h = num(event.cw1h);
  /**
   * The identity is run against the LARGER of the two counts, not against the
   * top-level total alone.
   *
   * Measured on the real corpus: 3 of 20,674 records carry
   * `cache_creation_input_tokens: 0` alongside a genuine
   * `ephemeral_1h_input_tokens` of 1,280-1,592. Against the bare total those
   * satisfy `0 + 0 === 0` only if the per-TTL counts are ignored, and the
   * event prices two thousand real cache-write tokens at nothing while raising
   * no floor caveat — a silent zero, which is the one outcome ADR-002 rule 2
   * exists to prevent.
   *
   * Taking the maximum never reduces an observed count and never invents one.
   * Where the identity already holds — 20,671 of 20,674 records — `observed`
   * IS the total and nothing moves.
   */
  const observed = Math.max(num(event.cacheWrite), write5m + write1h);
  if (write5m + write1h === observed) return { write5m, write1h, fromBreakdown: observed > 0 };
  return { write5m: observed, write1h: 0, fromBreakdown: false };
}

function emptyByClass() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function emptyTokens() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };
}

/**
 * USD for one event's five token classes at a given price row.
 * @returns {{input:number,output:number,cacheWrite5m:number,cacheWrite1h:number,cacheRead:number}}
 */
function costOfEvent(event, price, precomputedSplit) {
  const perToken = (tokens, usdPerMillion) => (num(tokens) / 1e6) * usdPerMillion;
  const split = precomputedSplit || cacheWriteSplit(event);
  return {
    input: perToken(event.input, price.input),
    output: perToken(event.output, price.output),
    cacheWrite5m: perToken(split.write5m, price.input * CACHE_MULTIPLIER.write5m),
    cacheWrite1h: perToken(split.write1h, price.input * CACHE_MULTIPLIER.write1h),
    cacheRead: perToken(event.cacheRead, price.input * (typeof price.read === 'number' ? price.read : CACHE_MULTIPLIER.read)),
  };
}

/**
 * Notional cost of a window.
 *
 * `events` MUST already be deduped — the same set every other figure is
 * derived from. Session resume and /compact replay the same assistant records
 * into fresh files, and the 115.3% inflation that causes would land directly
 * on the money.
 *
 * Grouping is by (raw model id, speed), not by model alone: two speeds are two
 * prices, so they cannot share one `ModelCost` row. `pricedAs` names the exact
 * price-table key used, which is what makes the figure auditable.
 *
 * @param {Array} events   deduped usage events
 * @param {number} startMs inclusive
 * @param {number} endMs   exclusive — a record on the reset instant belongs to
 *                         the new window, matching agg.sumWindow()
 * @param {boolean} anchored true when the window came from sevenDay.resetsAt
 * @returns {object|null} WeeklyCost, or null when the window holds no usage
 */
function weeklyCost(events, startMs, endMs, anchored) {
  const groups = new Map();
  const byClass = emptyByClass();
  let totalUsd = 0;
  let seenAny = false;
  /**
   * Events that HAD cache writes but no usable TTL breakdown, and were
   * therefore priced at the 1.25x floor. Counted only for events that
   * contributed dollars: this number qualifies `totalUsd`, and an unpriced
   * model contributes none. An event with no cache writes at all took no
   * fallback — there was nothing to fall back on.
   */
  let fallbackWriteEvents = 0;
  /**
   * Its denominator: events that carried cache writes at all, under exactly
   * the same scope. A bare numerator cannot tell 1-of-1413 from 1413-of-1413,
   * and those are very different claims about how much of a floor the total
   * is. Scoping the two differently would make the ratio quietly dishonest —
   * so the guards below are the same guards, in the same order.
   */
  let cacheWriteEvents = 0;

  for (const event of events || []) {
    if (!event || !Number.isFinite(event.ts)) continue;
    if (event.ts < startMs || event.ts >= endMs) continue;
    seenAny = true;

    const speed = speedOf(event);
    const price = priceFor(event.model, speed);
    const groupKey = `${event.model}|${speed}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        model: event.model,
        speed,
        pricedAs: price ? price.key : null,
        usd: price ? 0 : null,
        tokens: emptyTokens(),
      };
      groups.set(groupKey, group);
    }

    // Resolved once, ABOVE the token accumulation, so that every consumer of
    // this event agrees on how many cache-write tokens it carries: the token
    // breakdown, the two counters and the dollars. Gating any of them on the
    // raw top-level field instead would report an event as costing money while
    // counting it as having no cache writes.
    const split = cacheWriteSplit(event);
    const observedCacheWrite = split.write5m + split.write1h;

    group.tokens.input += num(event.input);
    group.tokens.output += num(event.output);
    group.tokens.cacheWrite += observedCacheWrite;
    group.tokens.cacheRead += num(event.cacheRead);

    // An unpriced group accumulates TOKENS but never dollars: it is excluded
    // from byClass and from the total, and named in unpricedModels instead.
    if (!price) continue;

    if (Number.isFinite(event.nCw)) {
      // An archive row (scan/archive.js) stands for many records, each one
      // counted when it was folded in, and its writes are stored already split.
      cacheWriteEvents += event.nCw;
      fallbackWriteEvents += num(event.nFb);
    } else if (observedCacheWrite > 0) {
      cacheWriteEvents += 1;
      if (!split.fromBreakdown) fallbackWriteEvents += 1;
    }

    const cost = costOfEvent(event, price, split);
    for (const cls of Object.keys(byClass)) byClass[cls] += cost[cls];
    const eventUsd = cost.input + cost.output + cost.cacheWrite5m + cost.cacheWrite1h + cost.cacheRead;
    group.usd += eventUsd;
    totalUsd += eventUsd;
  }

  if (!seenAny) return null;

  const byModel = [...groups.values()].map((group) => ({
    model: group.model,
    speed: group.speed,
    pricedAs: group.pricedAs,
    usd: group.usd === null ? null : round(group.usd),
    tokens: {
      ...group.tokens,
      billable: group.tokens.input + group.tokens.output + group.tokens.cacheWrite,
    },
  }));
  // Largest spend first; unpriced models last, then by id, so the order does
  // not depend on which file happened to be read first.
  byModel.sort((a, b) => {
    if (a.usd === null && b.usd === null) return a.model < b.model ? -1 : 1;
    if (a.usd === null) return 1;
    if (b.usd === null) return -1;
    return b.usd - a.usd || (a.model < b.model ? -1 : 1);
  });

  const unpricedModels = [...new Set(byModel.filter((m) => m.usd === null).map((m) => m.model))].sort();

  return {
    totalUsd: round(totalUsd),
    byClass: {
      input: round(byClass.input),
      output: round(byClass.output),
      cacheWrite5m: round(byClass.cacheWrite5m),
      cacheWrite1h: round(byClass.cacheWrite1h),
      cacheRead: round(byClass.cacheRead),
    },
    byModel,
    unpricedModels,
    fallbackWriteEvents,
    cacheWriteEvents,
    // Codex-only floor cause (ADR-002 A3 rule 3). Claude records its writes.
    unrecordedWriteEvents: 0,
    // Codex-only tier floors (ADR-002 A3.17-18). Claude records its speed.
    assumedTierEvents: 0,
    fastRequestedEvents: 0,
    // The local tools' floor causes (Qwen Code, Antigravity, Grok Build).
    // Always present, zero here.
    unrecordedCalls: false,
    longPromptFloorEvents: 0,
    toolTokenEvents: 0,
    partialUsageEvents: 0,
    // A pure price lookup cannot know whether the events were fully read; the
    // snapshot sets this from the scan (ADR-002 A3.15).
    sourceIncomplete: false,
    pricesAsOf: PRICES_AS_OF,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    windowAnchored: Boolean(anchored),
  };
}

module.exports = {
  PRICES,
  PRICES_AS_OF,
  CACHE_MULTIPLIER,
  MODEL_KEYS,
  DEFAULT_SPEED,
  modelKeyFor,
  speedOf,
  priceFor,
  cacheWriteSplit,
  costOfEvent,
  weeklyCost,
};
