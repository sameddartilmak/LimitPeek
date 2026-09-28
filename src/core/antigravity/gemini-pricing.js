'use strict';
/**
 * Google's PUBLISHED Gemini API prices, used by Antigravity's cost module
 * (antigravity/cost.js) to price the Gemini models Antigravity runs. The
 * notional "what this usage would have cost at Gemini API standard rates"
 * figure; never a bill.
 *
 * This table priced the Gemini CLI row until that provider was removed
 * (2026-09-28: Google retired Gemini CLI for consumers on 2026-06-18, and its
 * replacement, Antigravity CLI, is read by the Antigravity row). Only the
 * table and the two rules Antigravity applies are kept here.
 *
 * Transcribed, not recalled (ADR-001, ADR-002 rule 2). Every row below was
 * verified by cto against https://ai.google.dev/gemini-api/docs/pricing (page
 * last updated 2026-09-16, fetched twice on 2026-09-17; ADR-003 Amendment 6,
 * cto report F6). USD per 1,000,000 tokens, Standard paid tier, text/image/video
 * input rates. Nothing else on the page is used, and nothing is extrapolated.
 *
 * THE RULES ANTIGRAVITY APPLIES (ADR-003 A6, ADR-002 A3)
 * ------------------------------------------------------
 *  1. Exact model ids only. No prefix matching, no alias resolution
 *     ('gemini-3-flash' is a backend alias that is not on the page, and
 *     'gemini-3-pro-preview' was shut down 2026-03-09): anything not listed is
 *     UNPRICED, never $0.
 *  2. A prompt over 200,000 tokens on a model whose row publishes a separate
 *     >200k rate is priced at the <=200k rate AS A FLOOR, counted as its own
 *     cause (`longPromptFloorEvents`). The page does not say whether the higher
 *     rate reprices the whole request, so the lower rate is the only one that
 *     cannot overstate. Models with a single published rate have no such cause.
 */

const PRICES_AS_OF = '2026-09-16';

/** The prompt size above which some models publish a different rate. */
const LONG_PROMPT_TOKENS = 200000;

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
 * Is this event a long-prompt FLOOR (rule 2)? Decided from the event's own
 * `longPrompt` fact (prompt > 200k, set by the reader before folding) and the
 * model's row.
 */
function isLongPromptFloor(ev, price) {
  return Boolean(price) && price.long !== null && ev.longPrompt === true;
}

module.exports = {
  priceFor,
  isLongPromptFloor,
  PRICES,
  PRICES_AS_OF,
  LONG_PROMPT_TOKENS,
};
