'use strict';
/**
 * Notional cost of Antigravity usage: "what these tokens would have cost at the
 * model vendor's published API rates". Never a bill: an Antigravity user pays
 * no per-token charge.
 *
 * Antigravity routes to two vendors' models, so there is no table of its own.
 * Each model is looked up in the table that already prices that vendor, with
 * that table's own rules and nothing added:
 *
 *   gemini-*   gemini-pricing.js   EXACT ids only (its rule 1), at the rate in
 *                                  effect at the event's own instant; the
 *                                  <=200k rate for a longer prompt, counted as
 *                                  a floor cause (its rule 2)
 *   claude-*   pricing.js          its model-key + date-suffix match, at
 *                                  Standard speed; cache reads at that row's
 *                                  read multiplier
 *
 * PRICE_KEYS names the few Antigravity model names that are a published model
 * under another name. Anything neither table prices is UNPRICED, `usd: null`
 * and named in `unpricedModels`, never $0 and never a neighbour's rate: that
 * includes the 'unknown' placeholder (a model enum with no recorded name) and
 * 'gemini-pro-default', which is not a published model id.
 *
 * cost = input (uncached; Antigravity's input EXCLUDES cache reads) x input + cacheRead x read + output x output. Output already
 * holds thinking tokens and is not added to again.
 *
 * A cache write (usage field 4) has never been observed. Should one appear on
 * a Claude model it is priced as Claude's own reader prices a write with no
 * TTL split: all of it at the 5-minute rate (1.25x input), counted in
 * `cacheWriteEvents` / `fallbackWriteEvents` (pricing.js `cacheWriteSplit`).
 * Google publishes no cache-write rate, so on a Gemini model it is counted
 * in the tokens and not charged.
 */

const claudePricing = require('../pricing');
const geminiPricing = require('./gemini-pricing');

/**
 * The OLDER of the two tables' dates: what a cost states when nothing in it
 * was priced. A cost states the older date of the tables it actually priced
 * from, so a single date never claims a table is newer than it is.
 */
const PRICES_AS_OF = claudePricing.PRICES_AS_OF < geminiPricing.PRICES_AS_OF
  ? claudePricing.PRICES_AS_OF
  : geminiPricing.PRICES_AS_OF;

/**
 * Antigravity model name -> the published model it is priced as.
 * 'claude-opus-4-6-thinking' is Claude Opus 4.6 with extended thinking, which
 * Anthropic bills at Opus 4.6's rates with the thinking tokens as output
 * (platform.claude.com/docs/en/about-claude/pricing, checked 2026-09-24).
 */
const PRICE_KEYS = Object.freeze({
  'claude-opus-4-6-thinking': 'claude-opus-4-6',
});

const SPEED_STANDARD = 'standard';

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

function cost1M(tokens, rate) {
  return (tokens * rate) / 1e6;
}

/**
 * How one model is priced at the instant `atMs`, or null when no table does.
 * @returns {{vendor:'gemini'|'claude', key:string, row:object}|null}
 */
function priceFor(model, atMs) {
  if (typeof model !== 'string' || model.length === 0 || model === 'unknown') return null;
  const id = Object.prototype.hasOwnProperty.call(PRICE_KEYS, model) ? PRICE_KEYS[model] : model;
  const g = geminiPricing.priceFor(id, atMs);
  if (g) return { vendor: 'gemini', key: id, row: g };
  const c = claudePricing.priceFor(id, claudePricing.DEFAULT_SPEED);
  if (c) return { vendor: 'claude', key: c.key, row: c };
  return null;
}

/** USD per class for one event at its price. */
function costOf(ev, price) {
  if (price.vendor === 'claude') {
    // Claude's own arithmetic, so a write here can never be priced differently
    // from the same write in a Claude Code transcript.
    return claudePricing.costOfEvent(
      { input: ev.input, output: ev.output, cacheWrite: ev.cacheWrite, cw5: 0, cw1h: 0, cacheRead: ev.cacheRead },
      price.row,
    );
  }
  return {
    input: cost1M(ev.input, price.row.input),
    output: cost1M(ev.output, price.row.output),
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: cost1M(ev.cacheRead, price.row.cached),
  };
}

/**
 * A `WeeklyCost` for Antigravity events in [startMs, endMs), or null when none.
 *
 * Event shape (antigravity/usage.js): `{ ts, model, input (uncached),
 * cacheWrite, cacheRead, output, longPrompt, count? }` — a folded 15-minute
 * bucket carries `count`, a raw call stands for one. A bucket never spans a
 * UTC midnight, so it is priced at one date's rates like a raw call.
 */
function antigravityCost(events, startMs, endMs, anchored) {
  const groups = new Map();
  const byClass = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  let totalUsd = 0;
  let seenAny = false;
  let longPromptFloorEvents = 0;
  let cacheWriteEvents = 0;
  const vendors = new Set();

  for (const ev of events || []) {
    if (!ev || !Number.isFinite(ev.ts) || ev.ts < startMs || ev.ts >= endMs) continue;
    seenAny = true;
    const n = Number.isSafeInteger(ev.count) && ev.count > 0 ? ev.count : 1;
    const price = priceFor(ev.model, ev.ts);
    let group = groups.get(ev.model);
    if (!group) {
      group = {
        model: ev.model,
        speed: SPEED_STANDARD,
        pricedAs: price ? price.key : null,
        usd: price ? 0 : null,
        tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      };
      groups.set(ev.model, group);
    }
    group.tokens.input += ev.input;
    group.tokens.output += ev.output;
    group.tokens.cacheWrite += ev.cacheWrite;
    group.tokens.cacheRead += ev.cacheRead;
    if (!price) continue;
    vendors.add(price.vendor);
    if (price.vendor === 'gemini' && geminiPricing.isLongPromptFloor(ev, price.row)) longPromptFloorEvents += n;
    if (price.vendor === 'claude' && ev.cacheWrite > 0) cacheWriteEvents += n;

    const c = costOf(ev, price);
    for (const cls of Object.keys(byClass)) byClass[cls] += c[cls];
    const usd = c.input + c.output + c.cacheWrite5m + c.cacheWrite1h + c.cacheRead;
    group.usd += usd;
    totalUsd += usd;
  }

  if (!seenAny) return null;

  const byModel = [...groups.values()].map((g) => ({
    model: g.model,
    speed: g.speed,
    pricedAs: g.pricedAs,
    usd: g.usd === null ? null : round(g.usd),
    tokens: { ...g.tokens, billable: g.tokens.input + g.tokens.output + g.tokens.cacheWrite },
  }));
  // Largest spend first; unpriced last, then by id, so the order does not
  // depend on which store happened to be read first.
  byModel.sort((a, b) => {
    const id = a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
    if (a.usd === null && b.usd === null) return id;
    if (a.usd === null) return 1;
    if (b.usd === null) return -1;
    return b.usd - a.usd || id;
  });

  return {
    totalUsd: round(totalUsd),
    byClass: {
      input: round(byClass.input),
      output: round(byClass.output),
      cacheWrite5m: round(byClass.cacheWrite5m),
      cacheWrite1h: 0,
      cacheRead: round(byClass.cacheRead),
    },
    byModel,
    unpricedModels: [...new Set(byModel.filter((m) => m.usd === null).map((m) => m.model))].sort(),
    // Antigravity records no TTL split, so every priced Claude write took the
    // 5-minute floor: the two counts are the same events.
    fallbackWriteEvents: cacheWriteEvents,
    cacheWriteEvents,
    // Codex's causes.
    unrecordedWriteEvents: 0,
    assumedTierEvents: 0,
    fastRequestedEvents: 0,
    // Qwen Code's standing cause. Whether Antigravity leaves calls unrecorded
    // is not known, so it is not claimed.
    unrecordedCalls: false,
    longPromptFloorEvents,
    toolTokenEvents: 0,
    partialUsageEvents: 0,
    // Set by the snapshot from the scan (ADR-002 A3.15).
    sourceIncomplete: false,
    pricesAsOf: vendors.size === 1
      ? (vendors.has('gemini') ? geminiPricing.PRICES_AS_OF : claudePricing.PRICES_AS_OF)
      : PRICES_AS_OF,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    windowAnchored: Boolean(anchored),
  };
}

module.exports = { antigravityCost, priceFor, PRICE_KEYS, PRICES_AS_OF, SPEED_STANDARD };
