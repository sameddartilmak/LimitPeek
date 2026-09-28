'use strict';
/**
 * Grok Build usage in the `WeeklyCost` shape, priced by NOTHING of ours: the
 * amount is the one xAI's server reported for each turn (`costUsdTicks` in the
 * session's usage.json, grok/usage.js). xAI's per-token prices could not be
 * verified, so there is no price table, no price date (`pricesAsOf: ''`) and
 * no attempt to recompute or split the amount: `byClass` stays all zero,
 * because xAI reports one amount per turn, not one per token class.
 *
 *  - A turn with a reported amount is counted at that amount (speed
 *    SPEED_REPORTED, `pricedAs` its model id).
 *  - A turn that reports none is UNPRICED (speed SPEED_NO_REPORTED_COST,
 *    `usd: null`), never $0.
 *  - A turn xAI marked `costIsPartial` or `usageIsIncomplete` keeps its
 *    amount and is counted in `partialUsageEvents`: the figure is a FLOOR.
 *
 * Never a bill: what xAI reports is what the same usage costs at its API
 * rates, whatever the user's plan.
 */

const SPEED_REPORTED = 'reported';
const SPEED_NO_REPORTED_COST = 'no-reported-cost';

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

/** A `WeeklyCost` for Grok Build events in [startMs, endMs), or null when none. */
function grokCost(events, startMs, endMs, anchored) {
  const groups = new Map();
  let totalUsd = 0;
  let seenAny = false;
  let partialUsageEvents = 0;

  for (const ev of events || []) {
    if (!ev || !Number.isFinite(ev.ts) || ev.ts < startMs || ev.ts >= endMs) continue;
    seenAny = true;
    const n = Number.isSafeInteger(ev.count) && ev.count > 0 ? ev.count : 1;
    const priced = typeof ev.usd === 'number' && Number.isFinite(ev.usd) && ev.usd > 0;
    const speed = priced ? SPEED_REPORTED : SPEED_NO_REPORTED_COST;
    const key = `${ev.model}|${speed}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        model: ev.model,
        speed,
        pricedAs: priced ? ev.model : null,
        usd: priced ? 0 : null,
        tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      };
      groups.set(key, group);
    }
    group.tokens.input += ev.input;
    group.tokens.output += ev.output;
    group.tokens.cacheWrite += ev.cacheWrite;
    group.tokens.cacheRead += ev.cacheRead;
    if (!priced) continue;
    if (ev.partial === true) partialUsageEvents += n;
    group.usd += ev.usd;
    totalUsd += ev.usd;
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
    const id = a.model < b.model ? -1 : a.model > b.model ? 1 : (a.speed < b.speed ? -1 : a.speed > b.speed ? 1 : 0);
    if (a.usd === null && b.usd === null) return id;
    if (a.usd === null) return 1;
    if (b.usd === null) return -1;
    return b.usd - a.usd || id;
  });

  return {
    totalUsd: round(totalUsd),
    // xAI reports one amount per turn: no class split exists to show.
    byClass: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    byModel,
    unpricedModels: [...new Set(byModel.filter((m) => m.usd === null).map((m) => m.model))].sort(),
    fallbackWriteEvents: 0,
    cacheWriteEvents: 0,
    unrecordedWriteEvents: 0,
    assumedTierEvents: 0,
    fastRequestedEvents: 0,
    unrecordedCalls: false,
    longPromptFloorEvents: 0,
    toolTokenEvents: 0,
    partialUsageEvents,
    // Set by the snapshot from the scan (ADR-002 A3.15).
    sourceIncomplete: false,
    // No price table: the amounts are xAI's own, so no list date exists.
    pricesAsOf: '',
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    windowAnchored: Boolean(anchored),
  };
}

module.exports = { grokCost, SPEED_REPORTED, SPEED_NO_REPORTED_COST };
