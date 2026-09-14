'use strict';
/**
 * OpenAI's PUBLISHED API prices, for the notional "what this Codex usage would
 * have cost on the API" figure. Never a bill — the user is on a ChatGPT
 * subscription; this is the same framing the Claude cost block uses.
 *
 * Transcribed, not recalled (ADR-001's rule): a price this file invents is a
 * dollar figure with no source behind it. USD per 1,000,000 tokens, from
 * OpenAI's pricing pages on the date below.
 *
 * OpenAI's cache economics differ from Anthropic's, so this does NOT reuse the
 * Claude `pricing.js`: cached input is a flat ~0.1x of input (a single tier,
 * not a 5m/1h split), and a cache WRITE is charged only on gpt-5.6-and-later
 * (at 1.25x input); on older models the write bills at the plain input rate.
 *
 * Sources:
 *   https://developers.openai.com/api/docs/pricing
 *   https://developers.openai.com/api/docs/models/gpt-5.6-sol
 *   https://developers.openai.com/api/docs/guides/prompt-caching
 *   https://developers.openai.com/api/docs/guides/reasoning
 */

const PRICES_AS_OF = '2026-09-14';

/** `cacheWrite: null` -> no separate write charge; the write bills at `input`. */
const PRICES = Object.freeze({
  'gpt-5.6-sol': { input: 4.00, cachedInput: 0.40, output: 20.00, cacheWrite: 5.00 },
  'gpt-5.6-terra': { input: 2.00, cachedInput: 0.20, output: 12.00, cacheWrite: 2.50 },
  'gpt-5.6-luna': { input: 0.20, cachedInput: 0.02, output: 1.20, cacheWrite: 0.25 },
  'gpt-6-astra': { input: 10.00, cachedInput: 1.00, output: 50.00, cacheWrite: 12.50 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10.00, cacheWrite: null },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.00, cacheWrite: null },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.40, cacheWrite: null },
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10.00, cacheWrite: null },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14.00, cacheWrite: null },
  'gpt-5.4': { input: 2.50, cachedInput: 0.25, output: 15.00, cacheWrite: null },
  'gpt-5.5': { input: 5.00, cachedInput: 0.50, output: 30.00, cacheWrite: null },
  'gpt-5-codex': { input: 1.25, cachedInput: 0.125, output: 10.00, cacheWrite: null },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14.00, cacheWrite: null },
  o3: { input: 2.00, cachedInput: 0.50, output: 8.00, cacheWrite: null },
  'o4-mini': { input: 1.10, cachedInput: 0.275, output: 4.40, cacheWrite: null },
});

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

const CLASSES = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'];

function emptyByClass() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

/**
 * The price row for a Codex model id. Exact match first; then the id with a
 * trailing `-YYYYMMDD`-style date suffix stripped, so a dated snapshot of a
 * known model still prices. An unknown model returns null and is NEVER priced
 * at zero — it lands in `unpricedModels` instead (ADR-001 rule 2).
 */
function priceFor(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  if (PRICES[model]) return PRICES[model];
  const stripped = model.replace(/-\d{8}$/, '');
  return PRICES[stripped] || null;
}

/** Per-1M-token rate applied to a token count. */
function cost1M(tokens, rate) {
  return (tokens * rate) / 1e6;
}

/**
 * A WeeklyCost-shaped notional cost for Codex usage events in [startMs, endMs).
 * Events come from `codexUsageEvents` (per-turn deltas). Returns null when the
 * window has no events.
 *
 * The classes map onto the shared `CostByClass`: `cacheRead` carries the
 * discounted cached-input cost, and the single OpenAI cache-WRITE tier is put
 * in `cacheWrite5m` (with `cacheWrite1h` always 0) so the existing renderer can
 * show it without a new field. There is no floor here: a priced model with a
 * single, known write tier costs exactly this — `fallbackWriteEvents` is always
 * 0 and the block never reads "en az" unless a model is genuinely unpriced.
 */
function codexCost(events, startMs, endMs, anchored) {
  const groups = new Map();
  const byClass = emptyByClass();
  let totalUsd = 0;
  let seenAny = false;
  let cacheWriteEvents = 0;

  for (const ev of events || []) {
    if (!ev || !Number.isFinite(ev.ts)) continue;
    if (ev.ts < startMs || ev.ts >= endMs) continue;
    seenAny = true;

    const price = priceFor(ev.model);
    const key = `${ev.model}|standard`;
    let group = groups.get(key);
    if (!group) {
      group = {
        model: ev.model, speed: 'standard',
        pricedAs: price ? ev.model.replace(/-\d{8}$/, '') : null,
        usd: price ? 0 : null,
        tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      };
      groups.set(key, group);
    }

    group.tokens.input += ev.inputUncached;
    group.tokens.output += ev.output;
    group.tokens.cacheWrite += ev.cacheWrite;
    group.tokens.cacheRead += ev.cachedInput;

    if (!price) continue; // tokens accumulate, dollars do not (rule 2)

    if (ev.cacheWrite > 0) cacheWriteEvents += 1;
    const writeRate = price.cacheWrite != null ? price.cacheWrite : price.input;
    const c = {
      input: cost1M(ev.inputUncached, price.input),
      output: cost1M(ev.output, price.output),
      cacheWrite5m: cost1M(ev.cacheWrite, writeRate),
      cacheWrite1h: 0,
      cacheRead: cost1M(ev.cachedInput, price.cachedInput),
    };
    for (const cls of CLASSES) byClass[cls] += c[cls];
    const eventUsd = c.input + c.output + c.cacheWrite5m + c.cacheRead;
    group.usd += eventUsd;
    totalUsd += eventUsd;
  }

  if (!seenAny) return null;

  const byModel = [...groups.values()].map((g) => ({
    model: g.model,
    speed: g.speed,
    pricedAs: g.pricedAs,
    usd: g.usd === null ? null : round(g.usd),
    tokens: { ...g.tokens, billable: g.tokens.input + g.tokens.output + g.tokens.cacheWrite },
  }));
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
    fallbackWriteEvents: 0,
    cacheWriteEvents,
    pricesAsOf: PRICES_AS_OF,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    windowAnchored: Boolean(anchored),
  };
}

module.exports = { codexCost, priceFor, PRICES, PRICES_AS_OF };
