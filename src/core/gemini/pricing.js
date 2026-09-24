'use strict';
/**
 * Google's PUBLISHED Gemini API prices, for the notional "what this Gemini CLI
 * usage would have cost at Gemini API standard rates" figure. Never a bill: a
 * Gemini CLI user signed in with a Google account pays no per-token charge.
 *
 * Transcribed, not recalled (ADR-001, ADR-002 rule 2). Every row below was
 * verified by cto against https://ai.google.dev/gemini-api/docs/pricing (page
 * last updated 2026-09-16, fetched twice on 2026-09-17; ADR-003 Amendment 6,
 * cto report F6). USD per 1,000,000 tokens, Standard paid tier, text/image/video
 * input rates. Nothing else on the page is used, and nothing is extrapolated.
 *
 * THE ACCOUNTING RULES (ADR-003 A6, ADR-002 A3)
 * ---------------------------------------------
 *  1. Exact model ids only. No prefix matching, no alias resolution
 *     ('gemini-3-flash' is a backend alias that is not on the page, and
 *     'gemini-3-pro-preview' was shut down 2026-03-09): anything not listed is
 *     UNPRICED, never $0.
 *  2. cost = (input - cached) x input + cached x cached + (output + thoughts) x output.
 *     The CLI records `input` = promptTokenCount, which INCLUDES the cached
 *     tokens (ai.google.dev/api/generate-content), and `output` =
 *     candidatesTokenCount, which does not include thinking tokens; the page
 *     prices output "including thinking tokens".
 *  3. A prompt over 200,000 tokens on a model whose row publishes a separate
 *     >200k rate is priced at the <=200k rate AS A FLOOR, counted as its own
 *     cause (`longPromptFloorEvents`). The page does not say whether the higher
 *     rate reprices the whole request, so the lower rate is the only one that
 *     cannot overstate. Models with a single published rate have no such cause.
 *  4. `tool` (toolUsePromptTokenCount) > 0 is its own floor cause
 *     (`toolTokenEvents`): the page does not say how those tokens are billed,
 *     so they are not priced and the figure is a lower bound.
 *  5. Every Gemini figure is a FLOOR (`unrecordedCalls`): the CLI never
 *     records its utility calls (router, compressor, loop detector,
 *     next-speaker, summarizer, edit corrector, web search/fetch) or failed
 *     stream attempts (cto F5, geminiChat.ts:1573-1641).
 *  6. A message with tokens but no recorded model is UNPRICED with the reason
 *     code SPEED_NO_MODEL (geminiChat.ts:1659-1662 records a synthetic gemini
 *     message with model undefined).
 *
 * Not modelled, and why the figure stays "at Gemini API standard rates": the
 * file records no service tier. Vertex AI users can route requests as flex or
 * priority (cli/config/settingsSchema.ts:1043-1055), which is not on disk.
 */

const PRICES_AS_OF = '2026-09-16';

/** The prompt size above which some models publish a different rate. */
const LONG_PROMPT_TOKENS = 200000;

/**
 * The `ModelCost.speed` CODES this module emits. Stable: the renderer maps
 * them to catalog text.
 *   SPEED_STANDARD  'standard': priced (or looked up) at Gemini API Standard rates
 *   SPEED_NO_MODEL  'no-model': the CLI recorded tokens but no model (unpriced)
 */
const SPEED_STANDARD = 'standard';
const SPEED_NO_MODEL = 'no-model';

/**
 * model -> USD per 1M tokens. `long` is the published >200k row, or null when
 * the model publishes one rate for every prompt length.
 */
const PRICES = Object.freeze({
  'gemini-3.1-pro-preview': { input: 2.00, output: 12.00, cached: 0.20, long: { input: 4.00, output: 18.00, cached: 0.40 } },
  'gemini-3.5-flash': { input: 1.50, output: 9.00, cached: 0.15, long: null },
  'gemini-3-flash-preview': { input: 0.50, output: 3.00, cached: 0.05, long: null },
  'gemini-2.5-pro': { input: 1.25, output: 10.00, cached: 0.125, long: { input: 2.50, output: 15.00, cached: 0.25 } },
  'gemini-2.5-flash': { input: 0.30, output: 2.50, cached: 0.03, long: null },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.50, cached: 0.025, long: null },
  // Transcribed 2026-09-24 from https://ai.google.dev/gemini-api/docs/pricing
  // (page last updated 2026-09-24), Standard paid tier; no >200k row. The page
  // publishes a rate change: these rates apply through 2026-12-31 and `changes`
  // holds the rates from 2027-01-01 (UTC). Each event is priced at the rate in
  // effect at its own timestamp (`priceFor(model, atMs)`).
  'gemini-3.8-flash': {
    input: 0.75,
    output: 3.75,
    cached: 0.075,
    long: null,
    changes: [{ from: '2027-01-01', input: 1.50, output: 7.50, cached: 0.15 }],
  },
});

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

function cost1M(tokens, rate) {
  return (tokens * rate) / 1e6;
}

/**
 * The price row for an EXACT model id at the instant `atMs`, or null. A row
 * with published `changes` answers with the latest change whose UTC start
 * date is at or before `atMs`; with no instant, the row's first rates.
 */
function priceFor(model, atMs) {
  if (typeof model !== 'string' || model.length === 0) return null;
  if (!Object.prototype.hasOwnProperty.call(PRICES, model)) return null;
  const row = PRICES[model];
  if (!Array.isArray(row.changes) || !Number.isFinite(atMs)) return row;
  let rates = row;
  for (const change of row.changes) {
    if (atMs >= Date.parse(`${change.from}T00:00:00.000Z`)) rates = change;
  }
  return rates === row ? row : { input: rates.input, output: rates.output, cached: rates.cached, long: row.long };
}

/**
 * Is this event a long-prompt FLOOR (rule 3)? Decided from the event's own
 * `longPrompt` fact (prompt > 200k, set by the reader before folding) and the
 * model's row.
 */
function isLongPromptFloor(ev, price) {
  return Boolean(price) && price.long !== null && ev.longPrompt === true;
}

/**
 * Notional cost detail for Gemini events in [startMs, endMs).
 *
 * Event shape (gemini/usage.js): `{ ts, model, noModel?, input (uncached),
 * cached, output, thoughts, tool, longPrompt, count? }` — a folded 15-minute
 * bucket carries `count`, a raw message stands for one.
 *
 * @returns {{cost: object|null}}
 */
function geminiCostDetail(events, startMs, endMs, anchored) {
  const groups = new Map();
  const byClass = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  let totalUsd = 0;
  let seenAny = false;
  let longPromptFloorEvents = 0;
  let toolTokenEvents = 0;

  for (const ev of events || []) {
    if (!ev || !Number.isFinite(ev.ts) || ev.ts < startMs || ev.ts >= endMs) continue;
    seenAny = true;
    const n = Number.isSafeInteger(ev.count) && ev.count > 0 ? ev.count : 1;
    const noModel = ev.noModel === true;
    const price = noModel ? null : priceFor(ev.model, ev.ts);
    const speed = noModel ? SPEED_NO_MODEL : SPEED_STANDARD;
    const key = `${ev.model}|${speed}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        model: ev.model,
        speed,
        pricedAs: price ? ev.model : null,
        usd: price ? 0 : null,
        tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      };
      groups.set(key, group);
    }
    group.tokens.input += ev.input;
    group.tokens.output += ev.output + ev.thoughts;
    group.tokens.cacheRead += ev.cached;

    // Rule 4 counts every event with tool tokens, priced or not: those tokens
    // are never in the figure either way.
    if (ev.tool > 0 || ev.hasTool === true) toolTokenEvents += n;
    if (!price) continue;
    if (isLongPromptFloor(ev, price)) longPromptFloorEvents += n;

    const c = {
      input: cost1M(ev.input, price.input),
      output: cost1M(ev.output + ev.thoughts, price.output),
      cacheRead: cost1M(ev.cached, price.cached),
    };
    byClass.input += c.input;
    byClass.output += c.output;
    byClass.cacheRead += c.cacheRead;
    const usd = c.input + c.output + c.cacheRead;
    group.usd += usd;
    totalUsd += usd;
  }

  if (!seenAny) return { cost: null };

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
    cost: {
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
      // Claude's and Codex's causes; Gemini records no cache writes at all.
      fallbackWriteEvents: 0,
      cacheWriteEvents: 0,
      unrecordedWriteEvents: 0,
      assumedTierEvents: 0,
      fastRequestedEvents: 0,
      // Rule 5: whenever this Gemini cost has an amount (review F8, as the contract
      // states). With nothing priced there is no figure for the cause to qualify.
      unrecordedCalls: totalUsd > 0,
      longPromptFloorEvents,
      toolTokenEvents,
      // Set by the snapshot from the scan (ADR-002 A3.15).
      sourceIncomplete: false,
      pricesAsOf: PRICES_AS_OF,
      windowStart: new Date(startMs).toISOString(),
      windowEnd: new Date(endMs).toISOString(),
      windowAnchored: Boolean(anchored),
    },
  };
}

/** A `WeeklyCost` for Gemini events in [startMs, endMs), or null when none. */
function geminiCost(events, startMs, endMs, anchored) {
  return geminiCostDetail(events, startMs, endMs, anchored).cost;
}

module.exports = {
  geminiCost,
  geminiCostDetail,
  priceFor,
  isLongPromptFloor,
  PRICES,
  PRICES_AS_OF,
  LONG_PROMPT_TOKENS,
  SPEED_STANDARD,
  SPEED_NO_MODEL,
};
