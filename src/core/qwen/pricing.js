'use strict';
/**
 * Alibaba Cloud Model Studio's PUBLISHED prices, for the notional "what this
 * Qwen Code usage would have cost at Model Studio rates" figure. Never a bill:
 * a Qwen Code user on a plan or on Qwen OAuth pays no per-token charge.
 *
 * Transcribed, not recalled (ADR-001, ADR-002 rule 2), from
 * https://www.alibabacloud.com/help/en/model-studio/model-pricing ("Last
 * updated Sep 28, 2026"), fetched 2026-09-28: the Singapore (international)
 * deployment, USD per 1,000,000 tokens, input / output. Nothing else on the
 * page is used, and nothing is extrapolated.
 *
 * THE ACCOUNTING RULES
 * --------------------
 *  1. Exact model ids only, no prefix matching and no alias resolution: a
 *     dated or other id is UNPRICED, never $0. So are the other vendors'
 *     models the Coding Plan also serves (glm-5, glm-4.7, kimi-k2.5,
 *     MiniMax-M2.5): their tokens are counted, their price is not Alibaba's
 *     to state. `qwen3.7-plus` is listed at a "limited-time 20% off" price
 *     and is left unpriced rather than pinned to a promotional rate.
 *  2. The rate is chosen by the request's WHOLE input (qwen/tiers.js), and
 *     every token of that request is billed at it. A request above the
 *     model's last published tier has no rate and is unpriced, grouped under
 *     SPEED_OVER_TIER so the priced part of the same model stays visible.
 *  3. cost = uncached input x input + cached x cached + output x output.
 *     `output` already holds the thinking tokens.
 *  4. CACHED INPUT at 10% of the tier's input rate. Model Studio bills an
 *     implicit-cache hit at 20% of input and an explicit-cache hit at 10%
 *     (https://www.alibabacloud.com/help/en/model-studio/context-cache, "Last
 *     updated Sep 28, 2026"). Qwen Code turns EXPLICIT caching on by default
 *     for DashScope (core/openaiContentGenerator/provider/dashscope.ts,
 *     `enableCacheControl` unless set false), and the usage log does not say
 *     which kind a hit was, so the lower rate is the only one that cannot
 *     overstate. The explicit cache's 125% creation charge cannot be priced
 *     either: creation tokens are not recorded apart from input, so they are
 *     priced at the plain input rate.
 *  5. Every Qwen Code figure is a FLOOR (`unrecordedCalls`): failed calls,
 *     retries and internal side queries are never written to the log. Rules
 *     2 and 4 only ever push the true figure further up.
 */

const { TIER_LIMITS } = require('./tiers');

const PRICES_AS_OF = '2026-09-28';

/** The cached-input share of a tier's input rate (rule 4). */
const CACHED_SHARE = 0.10;

/**
 * The `ModelCost.speed` CODES this module emits. Stable: the renderer maps
 * them to catalog text.
 *   SPEED_STANDARD   'standard': priced (or looked up) at Model Studio rates
 *   SPEED_OVER_TIER  'standard-long-context': a request above the model's
 *                    last published tier (unpriced, rule 2)
 */
const SPEED_STANDARD = 'standard';
const SPEED_OVER_TIER = 'standard-long-context';

/**
 * model -> tiers, ascending. `upTo` is the inclusive input bound of the tier,
 * in tokens (K = 1,000).
 */
const PRICES = Object.freeze({
  'qwen3-coder-plus': [
    { upTo: 32000, input: 1.00, output: 5.00 },
    { upTo: 128000, input: 1.80, output: 9.00 },
    { upTo: 256000, input: 3.00, output: 15.00 },
    { upTo: 1000000, input: 6.00, output: 60.00 },
  ],
  'qwen3-coder-next': [
    { upTo: 32000, input: 0.30, output: 1.50 },
    { upTo: 128000, input: 0.50, output: 2.50 },
    { upTo: 256000, input: 0.80, output: 4.00 },
  ],
  'qwen3.5-plus': [
    { upTo: 256000, input: 0.40, output: 2.40 },
    { upTo: 1000000, input: 0.50, output: 3.00 },
  ],
  'qwen3.6-plus': [
    { upTo: 256000, input: 0.50, output: 3.00 },
    { upTo: 1000000, input: 2.00, output: 6.00 },
  ],
  'qwen3-max': [
    { upTo: 32000, input: 1.20, output: 6.00 },
    { upTo: 128000, input: 2.40, output: 12.00 },
    { upTo: 256000, input: 3.00, output: 15.00 },
  ],
});

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

function cost1M(tokens, rate) {
  return (tokens * rate) / 1e6;
}

function hasTable(model) {
  return typeof model === 'string' && Object.prototype.hasOwnProperty.call(PRICES, model);
}

/**
 * The tier row for an EXACT model id and a size class, `'over'` when the
 * model is priced but publishes no tier that large, or null when the model
 * has no table at all.
 */
function priceFor(model, tierClass) {
  if (!hasTable(model)) return null;
  const limit = tierClass < TIER_LIMITS.length ? TIER_LIMITS[tierClass] : Infinity;
  const row = PRICES[model].find((t) => t.upTo >= limit);
  return row ? { input: row.input, output: row.output, cached: row.input * CACHED_SHARE } : 'over';
}

/**
 * A `WeeklyCost` for Qwen Code events in [startMs, endMs), or null when none.
 *
 * Event shape (qwen/usage.js): `{ ts, model, tier, input (uncached), cached,
 * output, count? }`; a folded 15-minute bucket carries `count` and one tier.
 */
function qwenCost(events, startMs, endMs, anchored) {
  const groups = new Map();
  const byClass = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  let totalUsd = 0;
  let seenAny = false;

  for (const ev of events || []) {
    if (!ev || !Number.isFinite(ev.ts) || ev.ts < startMs || ev.ts >= endMs) continue;
    seenAny = true;
    const price = priceFor(ev.model, ev.tier);
    const speed = price === 'over' ? SPEED_OVER_TIER : SPEED_STANDARD;
    const rates = price && price !== 'over' ? price : null;
    const key = `${ev.model}|${speed}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        model: ev.model,
        speed,
        pricedAs: rates ? ev.model : null,
        usd: rates ? 0 : null,
        tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      };
      groups.set(key, group);
    }
    group.tokens.input += ev.input;
    group.tokens.output += ev.output;
    group.tokens.cacheRead += ev.cached;
    if (!rates) continue;
    const c = {
      input: cost1M(ev.input, rates.input),
      output: cost1M(ev.output, rates.output),
      cacheRead: cost1M(ev.cached, rates.cached),
    };
    byClass.input += c.input;
    byClass.output += c.output;
    byClass.cacheRead += c.cacheRead;
    const usd = c.input + c.output + c.cacheRead;
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
  // Largest spend first; unpriced last, then by id and speed, so the order
  // does not depend on which file was read first.
  byModel.sort((a, b) => {
    const id = a.model < b.model ? -1 : a.model > b.model ? 1 : (a.speed < b.speed ? -1 : a.speed > b.speed ? 1 : 0);
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
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: round(byClass.cacheRead),
    },
    byModel,
    unpricedModels: [...new Set(byModel.filter((m) => m.usd === null).map((m) => m.model))].sort(),
    // Claude's and Codex's causes; Qwen records no cache writes.
    fallbackWriteEvents: 0,
    cacheWriteEvents: 0,
    unrecordedWriteEvents: 0,
    assumedTierEvents: 0,
    fastRequestedEvents: 0,
    // Rule 5, whenever this cost has an amount (as the contract states). With
    // nothing priced there is no figure for the cause to qualify.
    unrecordedCalls: totalUsd > 0,
    longPromptFloorEvents: 0,
    toolTokenEvents: 0,
    partialUsageEvents: 0,
    // Set by the snapshot from the scan (ADR-002 A3.15).
    sourceIncomplete: false,
    pricesAsOf: PRICES_AS_OF,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    windowAnchored: Boolean(anchored),
  };
}

module.exports = {
  qwenCost,
  priceFor,
  PRICES,
  PRICES_AS_OF,
  CACHED_SHARE,
  SPEED_STANDARD,
  SPEED_OVER_TIER,
};
