'use strict';
/**
 * Kimi Code usage in the `WeeklyCost` shape, ALL UNPRICED (ADR-003 A1 item 4,
 * A6 decision 2). Kimi publishes no per-token price for its plan models, and an
 * alias outside `kimi-code/*` names another provider's model through a config
 * this app never opens (`config.toml` can hold a plaintext api_key). So there is
 * no price table, no price date and no dollar figure: every group has
 * `usd: null`, `totalUsd` is 0 ("no priced usage"), and `pricesAsOf` is ''.
 *
 * The `ModelCost.speed` CODES this module emits (stable; the renderer maps them):
 *   SPEED_NO_PUBLISHED_PRICE  'no-published-price': a Kimi plan model (`kimi-code/*`)
 *   SPEED_OTHER_MODEL_ALIAS   'other-model-alias': another model used through Kimi Code
 */

const { isKimiPlanAlias } = require('./usage');

const SPEED_NO_PUBLISHED_PRICE = 'no-published-price';
const SPEED_OTHER_MODEL_ALIAS = 'other-model-alias';

function speedOf(model) {
  return isKimiPlanAlias(model) ? SPEED_NO_PUBLISHED_PRICE : SPEED_OTHER_MODEL_ALIAS;
}

/** A `WeeklyCost` for Kimi events in [startMs, endMs), or null when none. */
function kimiCost(events, startMs, endMs, anchored) {
  const groups = new Map();
  for (const ev of events || []) {
    if (!ev || !Number.isFinite(ev.ts) || ev.ts < startMs || ev.ts >= endMs) continue;
    let g = groups.get(ev.model);
    if (!g) {
      g = { model: ev.model, speed: speedOf(ev.model), tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } };
      groups.set(ev.model, g);
    }
    g.tokens.input += ev.input;
    g.tokens.output += ev.output;
    g.tokens.cacheWrite += ev.cacheWrite;
    g.tokens.cacheRead += ev.cacheRead;
  }
  if (groups.size === 0) return null;
  const byModel = [...groups.values()]
    .map((g) => ({
      model: g.model,
      speed: g.speed,
      pricedAs: null,
      usd: null,
      tokens: { ...g.tokens, billable: g.tokens.input + g.tokens.output + g.tokens.cacheWrite },
    }))
    // Plan models first, then by billable volume, then id: a stable order.
    .sort((a, b) => (a.speed === b.speed ? 0 : a.speed === SPEED_NO_PUBLISHED_PRICE ? -1 : 1)
      || b.tokens.billable - a.tokens.billable
      || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return {
    totalUsd: 0,
    byClass: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    byModel,
    unpricedModels: byModel.map((m) => m.model).sort(),
    fallbackWriteEvents: 0,
    cacheWriteEvents: 0,
    unrecordedWriteEvents: 0,
    assumedTierEvents: 0,
    fastRequestedEvents: 0,
    unrecordedCalls: false,
    longPromptFloorEvents: 0,
    toolTokenEvents: 0,
    sourceIncomplete: false,
    // No price table exists, so no date can be stated.
    pricesAsOf: '',
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    windowAnchored: Boolean(anchored),
  };
}

module.exports = { kimiCost, speedOf, SPEED_NO_PUBLISHED_PRICE, SPEED_OTHER_MODEL_ALIAS };
