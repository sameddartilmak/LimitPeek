'use strict';

/**
 * Bound the number of distinct model ids one reader hands out (ADR-003 A6
 * review, security F4). Model ids and Kimi aliases come from files another
 * program writes; thousands of distinct ones would become thousands of rows and
 * price groups. The first MAX_MODELS distinct ids in time order are kept; every
 * later event is relabelled 'unknown' (always unpriced) and its time range is
 * returned so the scan reports it as KNOWN unread (ADR-002 A3.15): the figure
 * then says it is incomplete rather than silently misattributing usage.
 */
const MAX_MODELS = 64;

/**
 * @param {Array<{ts:number, model:string}>} events  sorted by ts
 * @returns {{events: Array, overflow: {fromMs:number, throughMs:number}|null}}
 */
function capModels(events, max = MAX_MODELS) {
  const kept = new Set();
  let overflow = null;
  let out = events;
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (ev.model === 'unknown' || kept.has(ev.model)) continue;
    if (kept.size < max) {
      kept.add(ev.model);
      continue;
    }
    if (out === events) out = events.slice();
    const { noModel, ...rest } = ev;
    out[i] = { ...rest, model: 'unknown' };
    if (overflow === null) overflow = { fromMs: ev.ts, throughMs: ev.ts };
    else {
      overflow.fromMs = Math.min(overflow.fromMs, ev.ts);
      overflow.throughMs = Math.max(overflow.throughMs, ev.ts);
    }
  }
  return { events: out, overflow };
}

module.exports = { capModels, MAX_MODELS };
