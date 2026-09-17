'use strict';
/**
 * OpenAI's PUBLISHED API prices, for the notional "what this Codex usage would
 * have cost on the API" figure. Never a bill — the user is on a ChatGPT
 * subscription; this is the same framing the Claude cost block uses.
 *
 * Transcribed, not recalled (ADR-001's rule): a price this file invents is a
 * dollar figure with no source behind it. USD per 1,000,000 tokens, from
 * OpenAI's pricing pages on the date below. Every row was re-verified against
 * the published pages by cto on 2026-09-16 (ADR-002 Amendment 3).
 *
 * OpenAI's cache economics differ from Anthropic's, so this does NOT reuse the
 * Claude `pricing.js`: cached input is a single discounted tier (not a 5m/1h
 * split), and a cache WRITE has its own price only on the models whose row
 * carries one (GPT-5.6 family, GPT-6-Astra: 1.25x input); on every other model
 * a write bills at the plain input rate — never free.
 *
 * THE ACCOUNTING RULES (ADR-002 Amendment 3)
 * ------------------------------------------
 *  1. The key is `model|tier`, as Claude's is `model|speed`. A tier with no
 *     row for that model is UNPRICED. As amended by A3.17-18, the tier used for
 *     the DISPLAYED figure is:
 *       - `default`/`standard` recorded -> Standard;
 *       - `priority`/`fast` recorded -> Standard AS A FLOOR, counted as
 *         `fastRequestedEvents`. The record is the tier REQUESTED, not proven
 *         billed (core drops a tier the catalog does not list; the API documents
 *         downgrading Fast), so a Fast price could exceed the true cost. The
 *         Fast rows below stay for reference and are not used for the figure;
 *       - no tier recorded yet (before the first settings record) -> Standard
 *         AS A FLOOR, counted as `assumedTierEvents`, ONLY in a rollout whose
 *         every recorded tier is default/priority/fast (`tierAssumable`, from
 *         usage.js): Codex core sends only a tier the model catalog advertises,
 *         no observed catalog lists flex, and an omitted tier is Standard. A
 *         rollout recording flex, ultrafast or anything else keeps them UNPRICED;
 *       - any other recorded tier (flex, ...) -> its own row, i.e. unpriced.
 *  2. The model is the one in effect for each turn (resolved in usage.js).
 *  3. Zero RECORDED cache writes are not zero writes. On a model with a write
 *     price, an event with recorded writes of 0 that read cache or sent an
 *     uncached prompt of >= 1,024 tokens makes the figure a FLOOR (A3.9). No
 *     write count is estimated.
 *  4. Input over 272,000 tokens on a model whose page prices long prompts
 *     differently is UNPRICED.
 *  5. Exact model ids only. OpenAI snapshot ids (e.g. gpt-5.5-2026-04-23) can
 *     carry prices different from the alias, so a dated id is unpriced until
 *     its own row is added from its model page.
 *
 * Sources:
 *   https://developers.openai.com/api/docs/pricing
 *   https://developers.openai.com/api/docs/models/<id>
 *   https://developers.openai.com/api/docs/guides/prompt-caching
 *   https://developers.openai.com/api/docs/guides/reasoning
 */

const PRICES_AS_OF = '2026-09-14';

/**
 * The `ModelCost.speed` CODES this module emits. Stable: the renderer maps
 * them to catalog text, so changing one is a contract change.
 *   'standard' | 'fast'          the RECORDED tier ('fast' events are priced at
 *                                Standard, A3.18; see `pricedAs`)
 *   SPEED_UNKNOWN_TIER            'unknown-tier': no tier recorded yet — priced at
 *                                Standard when its rollout is eligible (A3.17),
 *                                unpriced otherwise
 *   <tier> + LONG_CONTEXT_SUFFIX  e.g. 'standard-long-context', 'fast-long-context',
 *                                 'unknown-tier-long-context': prompt over 272K
 *                                 on a long-context model (unpriced)
 *   any other normalized tier     e.g. 'flex', or 'other': no published row
 */
const SPEED_UNKNOWN_TIER = 'unknown-tier';
const LONG_CONTEXT_SUFFIX = '-long-context';

/** The prompt size above which the long-context models price differently. */
const LONG_CONTEXT_INPUT = 272000;

/** Models whose pages publish separate long-prompt pricing (not modelled here). */
const LONG_CONTEXT_MODELS = new Set([
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-5.5', 'gpt-5.4',
]);

/**
 * `model|tier` -> USD per 1M tokens. `cacheWrite: null` -> no separate write
 * price; a write bills at `input`.
 */
const PRICES = Object.freeze({
  // Standard tier.
  // gpt-5.6-sol is PROMOTIONAL pricing, "at least through 2026-11-21" per its
  // model page. Re-verify BEFORE that date; the post-promotion price is not
  // published and must not be guessed.
  'gpt-5.6-sol|standard': { input: 4.00, cachedInput: 0.40, output: 20.00, cacheWrite: 5.00 },
  'gpt-5.6-terra|standard': { input: 2.00, cachedInput: 0.20, output: 12.00, cacheWrite: 2.50 },
  'gpt-5.6-luna|standard': { input: 0.20, cachedInput: 0.02, output: 1.20, cacheWrite: 0.25 },
  'gpt-6-astra|standard': { input: 10.00, cachedInput: 1.00, output: 50.00, cacheWrite: 12.50 },
  'gpt-5|standard': { input: 1.25, cachedInput: 0.125, output: 10.00, cacheWrite: null },
  'gpt-5-mini|standard': { input: 0.25, cachedInput: 0.025, output: 2.00, cacheWrite: null },
  'gpt-5-nano|standard': { input: 0.05, cachedInput: 0.005, output: 0.40, cacheWrite: null },
  'gpt-5.1|standard': { input: 1.25, cachedInput: 0.125, output: 10.00, cacheWrite: null },
  'gpt-5.2|standard': { input: 1.75, cachedInput: 0.175, output: 14.00, cacheWrite: null },
  'gpt-5.4|standard': { input: 2.50, cachedInput: 0.25, output: 15.00, cacheWrite: null },
  'gpt-5.5|standard': { input: 5.00, cachedInput: 0.50, output: 30.00, cacheWrite: null },
  'gpt-5-codex|standard': { input: 1.25, cachedInput: 0.125, output: 10.00, cacheWrite: null },
  'gpt-5.3-codex|standard': { input: 1.75, cachedInput: 0.175, output: 14.00, cacheWrite: null },
  'o3|standard': { input: 2.00, cachedInput: 0.50, output: 8.00, cacheWrite: null },
  'o4-mini|standard': { input: 1.10, cachedInput: 0.275, output: 4.40, cacheWrite: null },

  // Fast tier (formerly "priority"; renamed Fast mode 2026-07-30).
  // Kept as the published reference only: a recorded priority/fast is the tier
  // REQUESTED, so the displayed figure prices it at Standard as a floor
  // (A3.18, `billingTierOf`) and never looks these rows up.
  // gpt-5-nano and gpt-5-codex publish no Fast row.
  'gpt-5.6-sol|fast': { input: 8.00, cachedInput: 0.80, output: 40.00, cacheWrite: 10.00 },
  'gpt-5.6-terra|fast': { input: 4.00, cachedInput: 0.40, output: 24.00, cacheWrite: 5.00 },
  'gpt-5.6-luna|fast': { input: 0.40, cachedInput: 0.04, output: 2.40, cacheWrite: 0.50 },
  'gpt-6-astra|fast': { input: 20.00, cachedInput: 2.00, output: 100.00, cacheWrite: 25.00 },
  'gpt-5.5|fast': { input: 12.50, cachedInput: 1.25, output: 75.00, cacheWrite: null },
  'gpt-5.4|fast': { input: 5.00, cachedInput: 0.50, output: 30.00, cacheWrite: null },
  'gpt-5.2|fast': { input: 3.50, cachedInput: 0.35, output: 28.00, cacheWrite: null },
  'gpt-5.1|fast': { input: 2.50, cachedInput: 0.25, output: 20.00, cacheWrite: null },
  'gpt-5|fast': { input: 2.50, cachedInput: 0.25, output: 20.00, cacheWrite: null },
  'gpt-5-mini|fast': { input: 0.45, cachedInput: 0.045, output: 3.60, cacheWrite: null },
  'gpt-5.3-codex|fast': { input: 3.50, cachedInput: 0.35, output: 28.00, cacheWrite: null },
  'o3|fast': { input: 3.50, cachedInput: 0.875, output: 14.00, cacheWrite: null },
  'o4-mini|fast': { input: 2.00, cachedInput: 0.50, output: 8.00, cacheWrite: null },
});

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

const CLASSES = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'];

function emptyByClass() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

/**
 * A recorded `service_tier` as a price-table tier. `priority` and `fast` are
 * one published tier; `default` (Codex sends no tier) and `standard` are
 * Standard. Any other string is kept as-is and simply has no row (e.g. flex).
 * Anything that is not a string is `null`: the tier is not known.
 */
function normalizeTier(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const t = raw.trim().toLowerCase();
  if (t === 'priority' || t === 'fast') return 'fast';
  if (t === 'default' || t === 'standard') return 'standard';
  return /^[a-z0-9_-]{1,24}$/.test(t) ? t : 'other';
}

/**
 * The tier an event is PRICED at for the displayed figure (A3.17-18), and which
 * floor cause that choice carries. `tier: null` -> unpriced.
 *
 * @returns {{tier: string|null, fastRequested: boolean, assumed: boolean}}
 */
function billingTierOf(ev) {
  if (ev.tier === 'fast') return { tier: 'standard', fastRequested: true, assumed: false };
  if (ev.tier === null || ev.tier === undefined) {
    return ev.tierAssumable === true
      ? { tier: 'standard', fastRequested: false, assumed: true }
      : { tier: null, fastRequested: false, assumed: false };
  }
  return { tier: typeof ev.tier === 'string' ? ev.tier : null, fastRequested: false, assumed: false };
}

/**
 * The price row for an EXACT model id at a tier, or null. No prefix matching
 * and no date-suffix stripping (Amendment 3 rule 5). An unknown model, an
 * unknown tier, or a null tier returns null and is NEVER priced at zero.
 */
function priceFor(model, tier) {
  if (typeof model !== 'string' || model.length === 0) return null;
  if (typeof tier !== 'string') return null;
  return PRICES[`${model}|${tier}`] || null;
}

/** OpenAI's minimum cacheable prompt: a prompt this long can create a cache entry. */
const MIN_CACHEABLE_PROMPT = 1024;

/**
 * The per-event facts pricing needs beyond token sums, decided ONCE per raw
 * turn so they survive folding old turns into UTC 15-minute buckets (usage.js):
 *
 *   longContext  prompt > 272,000 tokens on a long-context model (rule 4)
 *   writeFloor   a write-priced model|tier recorded 0 writes although the turn
 *                read cache OR sent an uncached prompt of at least 1,024
 *                tokens (rule 3 as broadened by A3.9: Codex records 0 writes on
 *                EVERY record, so a first turn most likely paid a write too)
 *   hasWrite     recorded writes > 0 (the `cacheWriteEvents` denominator)
 *
 * A folded bucket carries these as fields plus `count`; a raw event may omit
 * them and they are computed here.
 */
function classifyCodexEvent(ev) {
  const promptTokens = ev.inputUncached + ev.cachedInput + ev.cacheWrite;
  const longContext = typeof ev.longContext === 'boolean'
    ? ev.longContext
    : LONG_CONTEXT_MODELS.has(ev.model) && promptTokens > LONG_CONTEXT_INPUT;
  let writeFloor = ev.writeFloor;
  if (typeof writeFloor !== 'boolean') {
    // Decided against the row the event would be priced at if it is priced at
    // all. A pre-settings turn is judged at Standard whatever its rollout's
    // eligibility today: the flag is only ever counted while the event is
    // priced, and eligibility can change after the turn is folded.
    const tier = ev.tier === null || ev.tier === undefined ? 'standard' : billingTierOf(ev).tier;
    const price = longContext ? null : priceFor(ev.model, tier);
    writeFloor = Boolean(price) && price.cacheWrite != null && ev.cacheWrite === 0
      && (ev.cachedInput > 0 || ev.inputUncached >= MIN_CACHEABLE_PROMPT);
  }
  const hasWrite = typeof ev.hasWrite === 'boolean' ? ev.hasWrite : ev.cacheWrite > 0;
  return { longContext, writeFloor, hasWrite };
}

/** Per-1M-token rate applied to a token count. */
function cost1M(tokens, rate) {
  return (tokens * rate) / 1e6;
}

/**
 * The group label for an event: the tier it ran at, or `unknown-tier`, with a
 * `-long-context` suffix when rule 4 excluded it. Shown verbatim beside an
 * unpriced model, so the reason it was not priced is on screen.
 */
function speedOf(ev, longContext) {
  const tier = typeof ev.tier === 'string' ? ev.tier : SPEED_UNKNOWN_TIER;
  return longContext ? `${tier}${LONG_CONTEXT_SUFFIX}` : tier;
}

/**
 * The Codex notional cost for events in [startMs, endMs), plus the per-model
 * floor counts the usage history needs.
 *
 * `writeFloorEvents` counts priced events on a model WITH a write price whose
 * recorded writes are 0 while they read cache or sent a cacheable prompt
 * (rule 3, A3.9): the figure is a floor. The cost carries it as `unrecordedWriteEvents`; it is NOT folded into
 * `fallbackWriteEvents`, whose meaning (and whose on-screen caveat) is Claude's
 * missing TTL split — a different claim.
 * `writeFloorByModel` is the same count per model id.
 *
 * `assumedTierEvents` / `fastRequestedEvents` count priced events whose tier was
 * assumed Standard or requested Fast (A3.17-18); `tierFloorByModel` is their
 * sum per model id. Each makes the figure a floor.
 *
 * @returns {{cost: object|null, writeFloorEvents: number, writeFloorByModel: Map<string, number>,
 *   assumedTierEvents: number, fastRequestedEvents: number, tierFloorByModel: Map<string, number>}}
 */
function codexCostDetail(events, startMs, endMs, anchored) {
  const groups = new Map();
  const byClass = emptyByClass();
  let totalUsd = 0;
  let seenAny = false;
  let cacheWriteEvents = 0;
  let writeFloorEvents = 0;
  const writeFloorByModel = new Map();
  let assumedTierEvents = 0;
  let fastRequestedEvents = 0;
  /** Per model: priced events carrying a tier floor cause (A3.17-18). */
  const tierFloorByModel = new Map();

  for (const ev of events || []) {
    if (!ev || !Number.isFinite(ev.ts)) continue;
    if (ev.ts < startMs || ev.ts >= endMs) continue;
    seenAny = true;

    // A folded 15-minute bucket stands for `count` turns; a raw event for one.
    const n = Number.isSafeInteger(ev.count) && ev.count > 0 ? ev.count : 1;
    const { longContext, writeFloor, hasWrite } = classifyCodexEvent(ev);
    const billing = billingTierOf(ev);
    const price = longContext || billing.tier === null ? null : priceFor(ev.model, billing.tier);
    // The speed CODE stays the recorded tier ('fast', 'unknown-tier'), so a row
    // says what was recorded; `pricedAs` says which row priced it. Priced and
    // unpriced events of one code (an eligible and an ineligible rollout) are
    // separate groups: a group is either priced or not.
    const speed = speedOf(ev, longContext);
    const key = `${ev.model}|${speed}|${price ? 1 : 0}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        model: ev.model,
        speed,
        pricedAs: price ? `${ev.model}|${billing.tier}` : null,
        usd: price ? 0 : null,
        tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      };
      groups.set(key, group);
    }

    group.tokens.input += ev.inputUncached;
    group.tokens.output += ev.output;
    group.tokens.cacheWrite += ev.cacheWrite;
    group.tokens.cacheRead += ev.cachedInput;

    if (!price) continue; // tokens accumulate, dollars do not (ADR-002 rule 2)

    if (billing.assumed) assumedTierEvents += n;
    if (billing.fastRequested) fastRequestedEvents += n;
    if (billing.assumed || billing.fastRequested) {
      tierFloorByModel.set(ev.model, (tierFloorByModel.get(ev.model) || 0) + n);
    }
    if (hasWrite) cacheWriteEvents += n;
    if (writeFloor) {
      writeFloorEvents += n;
      writeFloorByModel.set(ev.model, (writeFloorByModel.get(ev.model) || 0) + n);
    }
    const writeRate = price.cacheWrite != null ? price.cacheWrite : price.input;
    const c = {
      input: cost1M(ev.inputUncached, price.input),
      output: cost1M(ev.output, price.output),
      // OpenAI has ONE write tier; it is carried in the 5m slot so the shared
      // `CostByClass` shape needs no new field (the renderer merges the two).
      cacheWrite5m: cost1M(ev.cacheWrite, writeRate),
      cacheWrite1h: 0,
      cacheRead: cost1M(ev.cachedInput, price.cachedInput),
    };
    for (const cls of CLASSES) byClass[cls] += c[cls];
    const eventUsd = c.input + c.output + c.cacheWrite5m + c.cacheRead;
    group.usd += eventUsd;
    totalUsd += eventUsd;
  }

  if (!seenAny) {
    return { cost: null, writeFloorEvents: 0, writeFloorByModel, assumedTierEvents: 0, fastRequestedEvents: 0, tierFloorByModel };
  }

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

  const unpricedModels = [...new Set(byModel.filter((m) => m.usd === null).map((m) => m.model))].sort();

  return {
    cost: {
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
      // Claude's missing-TTL fallback; Codex never takes it. Unrecorded Codex
      // writes are `writeFloorEvents` above, not this.
      fallbackWriteEvents: 0,
      cacheWriteEvents,
      // Rule 3 (A3.9): priced events with 0 recorded writes that read cache or
      // sent a cacheable prompt, on a write-priced model. Non-zero: a floor.
      unrecordedWriteEvents: writeFloorEvents,
      // A3.17: pre-settings turns in an eligible rollout, priced at Standard.
      assumedTierEvents,
      // A3.18: turns that REQUESTED Fast, priced at Standard.
      fastRequestedEvents,
      // Set by the snapshot from the rollout scan (ADR-002 A3.15); pricing
      // alone cannot know what was not read.
      sourceIncomplete: false,
      pricesAsOf: PRICES_AS_OF,
      windowStart: new Date(startMs).toISOString(),
      windowEnd: new Date(endMs).toISOString(),
      windowAnchored: Boolean(anchored),
    },
    writeFloorEvents,
    writeFloorByModel,
    assumedTierEvents,
    fastRequestedEvents,
    tierFloorByModel,
  };
}

/**
 * A `WeeklyCost`-shaped notional cost for Codex events in [startMs, endMs), or
 * null when the window has no events. Carries every floor signal, including
 * the zero-recorded-write floor (rule 3) as `unrecordedWriteEvents` and the tier
 * floors (A3.17-18) as `assumedTierEvents` / `fastRequestedEvents`.
 */
function codexCost(events, startMs, endMs, anchored) {
  return codexCostDetail(events, startMs, endMs, anchored).cost;
}

module.exports = {
  codexCost,
  codexCostDetail,
  normalizeTier,
  priceFor,
  billingTierOf,
  PRICES,
  PRICES_AS_OF,
  LONG_CONTEXT_INPUT,
  LONG_CONTEXT_MODELS,
  MIN_CACHEABLE_PROMPT,
  classifyCodexEvent,
  SPEED_UNKNOWN_TIER,
  LONG_CONTEXT_SUFFIX,
};
