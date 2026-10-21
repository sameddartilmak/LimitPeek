/**
 * Everything crossing the IPC boundary is treated as untrusted input.
 *
 * Not because main is hostile, but because the values inside a Snapshot are
 * derived from file names and file contents on disk: provider display names,
 * model names, project slugs. Text is safe by construction (dom.ts never uses
 * innerHTML), but two things still need checking here:
 *
 *   1. `accent` is written into a CSS custom property. An unvalidated string
 *      there is CSS injection, so it must match a strict hex pattern.
 *   2. Numbers must be finite and in range before they drive geometry, or a
 *      NaN silently becomes a meter of undefined width.
 */

import type {
  AnchorPayload,
  Certainty,
  LanguageChoice,
  Preferences,
  CostByClass,
  FigureSource,
  HistoryFloorCause,
  ModelCost,
  ModelQuotaDetail,
  ModelQuotaGroup,
  PeriodModelCost,
  PeriodUsage,
  Provenance,
  ProviderSnapshot,
  RefreshNotice,
  TrayView,
  Gauge,
  PanelMaterial,
  PanelFrame,
  Layout,
  StripStyle,
  RowStatus,
  SetupAction,
  SetupKind,
  Snapshot,
  ThemeChoice,
  TokenBreakdown,
  UsageHistory,
  WeeklyCost,
  WindowAbsence,
  WindowUsage,
} from '../../shared/contract.js';

// Control, zero-width and bidi-override characters. Bidi overrides matter:
// a name carrying U+202E would visually reverse the rest of the row.
const CONTROL_CHARS = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]',
  'g',
);
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const NEUTRAL_ACCENT = '#98989F';

/** ADR-003 A6: the history floor-cause codes the renderer has copy for. */
const HISTORY_FLOOR_CAUSES = new Set<HistoryFloorCause>([
  'unpriced',
  'cache-write-ttl-fallback',
  'unrecorded-writes',
  'assumed-tier',
  'fast-requested',
  'unrecorded-calls',
  'long-prompt',
  'tool-tokens',
  'partial-usage',
]);

/**
 * The causes a TOKEN count may carry — a different, strictly smaller set.
 *
 * `'unread-range'` is token-side ONLY: on the cost side a known-unread range has
 * its own field and note, and ADR-002 A3.20 rules the price notes do not grow a
 * clause for it, so letting it through the cost allowlist would put a cause on
 * screen that ruling excludes. And the MONETARY causes are excluded here for the
 * mirror-image reason: an unpriced model, an assumed or Fast-requested tier and
 * Claude's cache-write TTL fallback each counted every token they saw, so
 * offering one as the reason a COUNT is short would be a false explanation —
 * worse than none, because A3.16 exists to make the reason trustworthy.
 *
 * Two allowlists rather than one filtered at the call site: the boundary is
 * where a wrong code must die, and each field has its own legal vocabulary.
 */
const TOKEN_FLOOR_CAUSES = new Set<HistoryFloorCause>([
  'unread-range',
  'unrecorded-calls',
  'unrecorded-writes',
  'partial-usage',
]);

const PROVIDER_IDS = new Set<ProviderSnapshot['id']>([
  'claude',
  'codex',
  'antigravity',
  'kimi',
  'qwen',
  'grok',
]);
const ROW_STATUSES = new Set<RowStatus>(['loading', 'ok', 'stale', 'error', 'passive']);
const CERTAINTIES = new Set<Certainty>(['known', 'estimated', 'unknown']);
const SETUP_KINDS = new Set<SetupKind>(['install-bridge', 'not-installed']);
const THEME_CHOICES = new Set<ThemeChoice>(['dark', 'light', 'system']);
const LANGUAGE_CHOICES = new Set<LanguageChoice>(['tr', 'en', 'zh', 'system']);

/**
 * The three discriminants the contract added for the Antigravity IDE reader.
 *
 * All three are CLOSED sets checked here, not free text, and that is the whole
 * reason they are worth having. `absence` and `provenance` choose which
 * Turkish sentence the panel prints, and `source` names a wire field; if any
 * of them could carry an arbitrary string from a file, main would be able to
 * put text on screen without the renderer's copy ever mentioning it. An
 * unrecognised value is dropped to null, never passed through.
 */
const PROVENANCES = new Set<Provenance>(['documented', 'derived']);
const FIGURE_SOURCES = new Set<FigureSource>([
  'claude.rate_limits.used_percentage',
  'antigravity.cli.quota.remaining_fraction',
  'antigravity.ide.quota_info.remaining_fraction',
  'codex.rate_limits.primary.used_percent',
  'codex.rate_limits.secondary.used_percent',
]);
const WINDOW_ABSENCES = new Set<WindowAbsence>([
  'no-capture',
  'not-supplied',
  'stale',
  'rolled-over',
  'awaiting-report',
  'unreadable',
]);
/**
 * The closed set of refresh notices. Like every other discriminant here it is
 * checked, not trusted: it drives a user-facing message and an unknown value
 * must produce silence, not a bubble with no copy behind it.
 */
const REFRESH_NOTICES = new Set<RefreshNotice>(['ANTIGRAVITY_NOT_RUNNING']);

/**
 * Hard caps on the model-quota block.
 *
 * The live reading is eight models in one or two groups. These are two and a
 * half times that, which is room for the shape to grow without a rebuild and
 * still a bound: the members are display names from a foreign local process,
 * they are rendered as list items, and an unbounded array is a way to make the
 * panel unusable without ever being malformed.
 */
const MAX_QUOTA_GROUPS = 8;
const MAX_QUOTA_MEMBERS = 12;

/** Text is rendered with textContent, so we only bound length and strip
 *  control characters that would mangle the line box. */
function text(value: unknown, max = 64): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_CHARS, '').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const n = finite(value);
  return n === null || n < 0 ? null : n;
}

/** A count of records: a non-negative integer, else 0. */
function eventCount(value: unknown): number {
  const n = nonNegative(value);
  return n !== null && Number.isInteger(n) ? n : 0;
}

function percentage(value: unknown): number | null {
  const n = finite(value);
  if (n === null) return null;
  // REJECT, do not clamp. Clamping 250 to 100 would draw a confident full
  // meter out of a value that proves the producer is wrong; returning null
  // lets windowUsage() demote the window to 'unknown' and draw nothing.
  return n < 0 || n > 100 ? null : n;
}

function isoInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function accent(value: unknown): string {
  return typeof value === 'string' && HEX.test(value) ? value : NEUTRAL_ACCENT;
}

/**
 * `absence` decides which sentence the panel prints in place of a figure, so
 * an unrecognised value must not reach the renderer as itself.
 *
 * It falls back to `'no-capture'` rather than null when a window has no figure
 * and main said nothing usable. That is the most conservative of the five: it
 * maps to today's "bilinmiyor", which claims the least. Falling back to
 * `'not-supplied'` would have the renderer assert "this tool does not publish
 * this limit" on no evidence at all — a claim the user can disprove by opening
 * the tool, which is exactly the failure `not-supplied` was added to prevent.
 */
function windowAbsence(raw: unknown): WindowAbsence {
  return WINDOW_ABSENCES.has(raw as WindowAbsence) ? (raw as WindowAbsence) : 'no-capture';
}

/**
 * `provenance` falls to `'derived'`, never `'documented'`.
 *
 * Same direction-of-failure rule the rest of this file follows: an unteachable
 * or malformed producer must make the figure look LESS certain, not more.
 * `documented` is a claim that a published interface stands behind the number,
 * and that claim needs a producer that said so.
 */
function provenanceOf(raw: unknown): Provenance {
  return PROVENANCES.has(raw as Provenance) ? (raw as Provenance) : 'derived';
}

function figureSource(raw: unknown): FigureSource | null {
  return FIGURE_SOURCES.has(raw as FigureSource) ? (raw as FigureSource) : null;
}

function windowUsage(raw: unknown): WindowUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const certainty: Certainty = CERTAINTIES.has(source.certainty as Certainty)
    ? (source.certainty as Certainty)
    : 'unknown';

  let usedPercentage = percentage(source.usedPercentage);
  // The contract says unknown means no defensible number. Enforce it here so a
  // single upstream slip cannot make the renderer draw a bar it must not draw.
  if (certainty === 'unknown') usedPercentage = null;
  if (usedPercentage === null && certainty !== 'unknown') {
    // The figure was rejected HERE, by this validator — main believed it had
    // one. `unreadable` is the honest reason, and it is not taken from the
    // payload: whatever main said about why there is no figure describes a
    // different situation than "we threw yours away".
    return {
      usedPercentage: null,
      certainty: 'unknown',
      absence: 'unreadable',
      resetsAt: isoInstant(source.resetsAt),
    };
  }

  const usage: WindowUsage = {
    usedPercentage,
    certainty,
    resetsAt: isoInstant(source.resetsAt),
    capturedAt: isoInstant(source.capturedAt),
    billableSinceCapture: nonNegative(source.billableSinceCapture),
  };

  // The contract's own invariant, enforced rather than trusted: `absence` is
  // non-null exactly when there is no figure. A window carrying both a
  // percentage and a reason it has none is a contradiction, and the renderer
  // would have to pick one; it never sees the pair.
  if (usedPercentage === null) {
    usage.absence = windowAbsence(source.absence);
  } else {
    usage.source = figureSource(source.source);
    usage.provenance = provenanceOf(source.provenance);
  }

  if (certainty === 'estimated') {
    const lo = percentage(source.confidenceLo);
    const hi = percentage(source.confidenceHi);
    if (lo !== null && hi !== null && hi >= lo) {
      usage.confidenceLo = lo;
      usage.confidenceHi = hi;
    }
  }
  return usage;
}

/**
 * One quota group: a figure, its reset, and the names it was reported for.
 *
 * Every member name is a display string decoded from the Antigravity IDE's own
 * state store — a foreign local process, and not one that promises us
 * anything. They go through `text()` like every other file-sourced string:
 * control, zero-width and bidi-override characters stripped (a name carrying
 * U+202E would reverse the rest of the list) and bounded at 64, the same cap
 * `modelCost()` uses for the same kind of value.
 *
 * A group with no usable figure is DROPPED, not zeroed. The contract says a
 * group exists only because there is a figure; manufacturing `0` for a
 * malformed one would put "%0 kullanıldı" — the most optimistic reading there
 * is — under a list of real model names.
 */
function modelQuotaGroup(raw: unknown): ModelQuotaGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const usedPercentage = percentage(source.usedPercentage);
  if (usedPercentage === null) return null;

  const members = (Array.isArray(source.members) ? source.members : [])
    .map((entry) => text(entry, 64))
    .filter((entry): entry is string => entry !== null)
    .slice(0, MAX_QUOTA_MEMBERS);
  // A figure attributed to nobody is not this shape. The whole point of the
  // block is which models a number was reported for.
  if (members.length === 0) return null;

  return { usedPercentage, resetsAt: isoInstant(source.resetsAt), members };
}

/**
 * The per-model quota block.
 *
 * `diverged` is main's to compute and is read as a strict boolean: comparing
 * the group figures here would be arithmetic on usage data, which the contract
 * forbids the renderer outright. An absent or non-boolean flag reads FALSE,
 * which collapses the row to its single headline figure — the quieter
 * rendering, and the one that cannot mislead: it shows one number instead of
 * claiming a spread nobody reported.
 *
 * `capturedAt` is required. Without it the block is a set of figures with no
 * instant they were true at, and this project does not print those.
 */
function modelQuotas(raw: unknown): ModelQuotaDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const capturedAt = isoInstant(source.capturedAt);
  if (capturedAt === null) return null;

  const groups = (Array.isArray(source.groups) ? source.groups : [])
    .map(modelQuotaGroup)
    .filter((entry): entry is ModelQuotaGroup => entry !== null)
    .slice(0, MAX_QUOTA_GROUPS);
  if (groups.length === 0) return null;

  const source_ = figureSource(source.source);
  if (source_ === null) return null;

  // The selected model, and the group it lives in — validated against the
  // FINAL groups array, not main's. Groups can be dropped or truncated above,
  // and the selection must never point at a member this validator no longer
  // holds: a marker on the wrong row is a false statement about the figure
  // beside it. Same treatment (text, cap 64) the member names got, so the
  // equality below compares like with like.
  const selectedModel = text(source.selectedModel, 64);
  let selectedGroupIndex: number | null = null;
  if (selectedModel !== null) {
    const idx = source.selectedGroupIndex;
    if (
      typeof idx === 'number' &&
      Number.isInteger(idx) &&
      idx >= 0 &&
      idx < groups.length &&
      groups[idx]!.members.includes(selectedModel)
    ) {
      selectedGroupIndex = idx;
    }
    // else: the selection is real but unplaceable in the sanitised groups (the
    // group or the member was dropped). Keep `selectedModel` — "a selection
    // exists" is still true and drives the headline label — but leave the
    // index null, so the disclosure marks nothing rather than the wrong row.
  }

  return {
    groups,
    // One surviving group cannot be diverged from anything, whatever main
    // said. Groups are dropped above when they are unusable, so main's flag
    // can legitimately describe a set this validator no longer holds.
    diverged: groups.length > 1 && source.diverged === true,
    selectedModel,
    selectedGroupIndex,
    source: source_,
    provenance: provenanceOf(source.provenance),
    capturedAt,
  };
}

function tokenBreakdown(raw: unknown): TokenBreakdown | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const billable = nonNegative(source.billable);
  if (billable === null) return null;
  return {
    input: nonNegative(source.input) ?? 0,
    output: nonNegative(source.output) ?? 0,
    cacheWrite: nonNegative(source.cacheWrite) ?? 0,
    cacheRead: nonNegative(source.cacheRead) ?? 0,
    billable,
  };
}

/**
 * Notional weekly cost (ADR-002).
 *
 * ONE FIELD IS LOAD-BEARING; THE REST DEGRADE
 * -------------------------------------------
 * This validator used to return null — deleting the entire cost view — if any
 * of `byClass`, `pricesAsOf`, `windowStart` or `windowEnd` failed to parse.
 * That is this project's recurring failure shape one layer up: an absent block
 * is INDISTINGUISHABLE from a legitimate `weeklyCost: null`, so a main process
 * that stopped emitting one provenance string would silently remove a figure
 * the user could still have been told truthfully, and it would look exactly
 * like "this provider has no cost data".
 *
 * So only `totalUsd` drops the object, because it IS the figure and every
 * other field is a statement ABOUT that figure — with no number there is
 * nothing to frame, caveat or date. Everything else is neutralised in place:
 *
 *   byClass                   -> zeros; the composition hides, the total stays
 *   pricesAsOf                -> ''; the block SAYS the date was not reported
 *                                rather than quietly omitting it, because
 *                                ADR-002 rule 3 obliges us to say when the
 *                                prices were current, and "we were not told"
 *                                discharges that better than silence
 *   windowStart / windowEnd   -> ''; the label falls back to the un-dated form
 *   byModel / unpricedModels  -> []
 *   *WriteEvents              -> 0; the floor caveat simply does not render
 *
 * `unpricedModels` is carried through verbatim (bounded, control chars
 * stripped) because the contract makes surfacing it mandatory: a total that
 * silently omits an unpriced model is a wrong number wearing a right one's
 * clothes.
 */
/**
 * All or nothing, deliberately.
 *
 * Defaulting a single bad class to 0 keeps the other four and the headline
 * total unchanged, so every surviving class's SHARE is then computed against a
 * smaller sum and silently inflates — a composition that adds to 100% while
 * describing only part of the figure above it. Returning null instead makes
 * weeklyCost() substitute zeros for the whole object, which the renderer
 * already handles by suppressing the composition and keeping the total. One
 * distorted explanation is worse than no explanation.
 */
function costByClass(raw: unknown): CostByClass | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const input = nonNegative(source.input);
  const output = nonNegative(source.output);
  const cacheWrite5m = nonNegative(source.cacheWrite5m);
  const cacheWrite1h = nonNegative(source.cacheWrite1h);
  const cacheRead = nonNegative(source.cacheRead);
  if (
    input === null ||
    output === null ||
    cacheWrite5m === null ||
    cacheWrite1h === null ||
    cacheRead === null
  ) {
    return null;
  }
  return { input, output, cacheWrite5m, cacheWrite1h, cacheRead };
}

function modelCost(raw: unknown): ModelCost | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const model = text(source.model, 64);
  const breakdown = tokenBreakdown(source.tokens);
  if (model === null || breakdown === null) return null;
  return {
    model,
    // A model can be priced at one speed and unpriced at another, so the
    // speed is part of the row's identity, not a decoration.
    // 40, not 24: Codex's group label is a tier of up to 24 characters plus
    // "-long-context" (src/core/codex/pricing.js speedOf). At 24,
    // "unknown-tier-long-context" (25) was cut to "unknown-tier-long-conte…",
    // and cost.ts could no longer tell it was long context.
    // A missing or unusable speed is NOT 'standard': that would be a price-tier
    // claim the payload never made. 'other' is the neutral code cost.ts
    // renders as "tanınmayan fiyat katmanı" (it is also what Codex's own
    // normalizeTier emits for an unrecognisable tier). Safe for priced rows:
    // speed is only ever read for UNPRICED rows (cost.ts unpricedRows), and
    // both producers always emit a string (core/pricing.js speedOf defaults
    // it; codex/pricing.js speedOf always builds one).
    speed: text(source.speed, 40) ?? 'other',
    pricedAs: text(source.pricedAs, 64),
    // null means "no price for this model". A missing price must never be
    // coerced to 0, or an unpriced model quietly reads as a free one.
    usd: nonNegative(source.usd),
    tokens: breakdown,
  };
}

/** The one value whose absence leaves nothing to say. See the note above. */
function weeklyCost(raw: unknown): WeeklyCost | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const totalUsd = nonNegative(source.totalUsd);
  if (totalUsd === null) return null;

  // '' is the "not reported" sentinel for these three. It is unambiguous
  // because no valid ISO string is empty, and the renderer branches on it to
  // print the absence instead of rendering "Fiyatlar  tarihli listeye göre".
  const pricesAsOf = isoInstant(source.pricesAsOf) ?? '';
  const windowStart = isoInstant(source.windowStart) ?? '';
  const windowEnd = isoInstant(source.windowEnd) ?? '';
  const byClass = costByClass(source.byClass) ?? {
    input: 0,
    output: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
  };

  const byModel = (Array.isArray(source.byModel) ? source.byModel : [])
    .map(modelCost)
    .filter((entry): entry is ModelCost => entry !== null)
    .slice(0, 24);

  // A model that still has a PRICED row in `byModel` must never be named as
  // unpriced. `unpricedModels` is de-duplicated by model and drops the speed
  // (src/core/pricing.js:261), so a model unpriced at 'fast' and priced at
  // 'standard' appears in both lists — and if modelCost() then rejects the
  // unpriced row for a malformed field, the warning survives with nothing left
  // to justify it, contradicting the table beside it. That contradiction is
  // exactly what ADR-002 amendment 2 added `ModelCost.speed` to prevent, so it
  // must not re-enter through the validator.
  const pricedModels = new Set(
    byModel.filter((entry) => entry.usd !== null).map((entry) => entry.model),
  );
  const unpricedModels = (Array.isArray(source.unpricedModels) ? source.unpricedModels : [])
    .map((entry) => text(entry, 64))
    .filter((entry): entry is string => entry !== null && !pricedModels.has(entry))
    .slice(0, 24);

  return {
    totalUsd,
    byClass,
    byModel,
    unpricedModels,
    pricesAsOf,
    // Counted, not inferred: a zero here means the breakdown was complete.
    fallbackWriteEvents: nonNegative(source.fallbackWriteEvents) ?? 0,
    // The denominator that turns "N events lacked a TTL split" from a bare
    // presence into a proportion. Zero is legitimate — a window whose only
    // usage is output tokens has no cache writes at all.
    cacheWriteEvents: nonNegative(source.cacheWriteEvents) ?? 0,
    // ADR-002 Amendment 3 rule 3: a COUNT of records, so only a non-negative
    // integer is one. Anything else is not this field and reads as 0 — which
    // only drops a floor the producer failed to state, never invents one.
    unrecordedWriteEvents: eventCount(source.unrecordedWriteEvents),
    // ADR-002 A3.21: Codex events priced at Standard as a floor, because no tier
    // was recorded yet (A3.17) or Fast was only requested (A3.18). Counts, so
    // only a non-negative integer is one; anything else reads as 0.
    assumedTierEvents: eventCount(source.assumedTierEvents),
    fastRequestedEvents: eventCount(source.fastRequestedEvents),
    // ADR-003 A6, the local tools' floor causes (Qwen Code, Antigravity, Grok
    // Build). Only a literal true is the claim that calls went unrecorded; the
    // counts are non-negative integers, else 0.
    unrecordedCalls: source.unrecordedCalls === true,
    longPromptFloorEvents: eventCount(source.longPromptFloorEvents),
    toolTokenEvents: eventCount(source.toolTokenEvents),
    partialUsageEvents: eventCount(source.partialUsageEvents),
    // ADR-002 A3.15: the reader KNOWS it missed events in the window. Only a
    // literal true is that claim; anything else (absent on an older main,
    // "true", 1) is not, and reads as false rather than inventing a floor
    // and a "could not be read" line the producer never stated.
    sourceIncomplete: source.sourceIncomplete === true,
    windowStart,
    windowEnd,
    windowAnchored: source.windowAnchored === true,
  };
}

/**
 * A hard cap on each period list. The producer emits at most a dozen, but a
 * malformed main process could send an unbounded array, and every entry becomes
 * a row in a narrow scrolling panel. Generous enough that the real payload is
 * never clipped, bounded enough that a bad one cannot make the view unusable.
 */
const MAX_PERIODS = 60;

/**
 * A hard cap on each period's per-model list. The producer emits at most a
 * handful (the price table has five model families), but a malformed main
 * process could send an unbounded array and each entry is a row in the
 * disclosure. Generous enough never to clip the real payload, bounded enough
 * that a bad one cannot blow up the panel.
 */
const MAX_PERIOD_MODELS = 24;

/**
 * One per-model entry inside a period.
 *
 * Dropped — not zeroed — when it has no usable model name, because an entry is
 * a labelled figure and an unlabelled one is not this shape. `costUsd` mirrors
 * the contract precisely: `nonNegative` yields `null` for a missing, negative
 * or non-finite value, and null is the "could not be priced" signal the
 * renderer prints as "fiyatlanamadı" — never coerced to 0, which would read as
 * free.
 *
 * `tokens` is NULL when no count arrived, and a zero count is a real zero.
 * Those are two different states and the boundary type can now express both,
 * which is the whole reason this stopped minting an all-zero datum main can
 * never legitimately send. An entry with no count keeps its cost line — a true
 * figure a missing count must not delete — and simply carries no count beside
 * it; an entry whose count IS zero prints zero.
 */
function periodModelCost(raw: unknown): PeriodModelCost | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const model = text(source.model, 64);
  if (model === null) return null;
  // Same rule as the model name: the provider is part of the entry's label (a
  // period lists two tools' models), and there is no honest default to invent.
  if (!PROVIDER_IDS.has(source.provider as ProviderSnapshot['id'])) return null;
  return {
    provider: source.provider as ProviderSnapshot['id'],
    model,
    costUsd: nonNegative(source.costUsd),
    isFloor: source.isFloor === true,
    tokens: tokenBreakdown(source.tokens),
  };
}

/**
 * WHY THE TOKEN FLOOR ARRIVES AS CAUSES AND IS NEVER A RULE HERE
 * --------------------------------------------------------------
 * Whether a token COUNT is a lower bound is a narrower question than whether
 * `costUsd` is: the monetary causes — unpriced model, assumed or Fast tier,
 * Claude's cache-write TTL fallback — counted every token they saw and differ
 * only in what they may CHARGE for it. Only events missing from the count
 * itself make the count a floor.
 *
 * Deciding that needs per-provider knowledge (Qwen Code's unrecorded side
 * queries, Codex's unrecorded cache writes) that main holds and the renderer must
 * not: the next surface to show a token count would not carry the rule with it,
 * and nothing would fail when it forgot. And it arrives as CAUSES rather than a
 * boolean because ADR-002 A3.16 forbids printing a floor with no visible
 * reason, and there is a real state with no cost cause to borrow — a Qwen
 * week where nothing could be priced sets the token floor while
 * `unrecordedCalls` stays false. So main states the causes and this validator
 * only carries them, for both fields that hold them:
 *
 *   `ProviderSnapshot.weeklyTokenFloorCauses`      — the row's weekly count
 *   `PeriodUsage.tokenFloorCausesByProvider`       — per tool, this period
 *
 * Known codes only, each once, in the producer's order; anything else is
 * dropped rather than printed. An empty list is "not a floor", which is the
 * state that adds no claim and is what an older main degrades to.
 */
function floorCauseList(raw: unknown): HistoryFloorCause[] {
  const codes: HistoryFloorCause[] = [];
  for (const code of Array.isArray(raw) ? raw : []) {
    if (!TOKEN_FLOOR_CAUSES.has(code as HistoryFloorCause)) continue;
    if (codes.includes(code as HistoryFloorCause)) continue;
    codes.push(code as HistoryFloorCause);
  }
  return codes;
}

/**
 * One period bucket.
 *
 * Dropped — not zeroed — when it has no valid date range, because the whole row
 * is a labelled range and an unlabelled one is not this shape. Everything else
 * degrades in place, on the same reasoning as `weeklyCost()`: a single bad field
 * must not delete a period the user could still have been shown truthfully.
 *
 * `costUsd` is coerced to a non-negative number and never to a bill: the
 * renderer frames it. `byClass` falls back to zeros (the composition simply
 * hides).
 *
 * `tokensByProvider` (contract :520-554) is carried as what it is: a map from
 * tool to that tool's own count, one entry per tool, never merged. There is
 * still deliberately NO single merged token total crossing this boundary — the
 * contract defines none, so none can be sanitised into existence, and an
 * unreadable entry is DROPPED rather than zeroed, because `{}` (no entry for
 * this tool) is the contract's own empty state and reads as "nothing to show",
 * while a zero would read as "this tool used nothing".
 */
function periodUsage(raw: unknown): PeriodUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const startsAt = isoInstant(source.startsAt);
  const endsAt = isoInstant(source.endsAt);
  if (startsAt === null || endsAt === null) return null;

  const unpricedModels = (Array.isArray(source.unpricedModels) ? source.unpricedModels : [])
    .map((entry) => text(entry, 64))
    .filter((entry): entry is string => entry !== null)
    .slice(0, 24);

  const byModel = (Array.isArray(source.byModel) ? source.byModel : [])
    .map(periodModelCost)
    .filter((entry): entry is PeriodModelCost => entry !== null)
    .slice(0, MAX_PERIOD_MODELS);

  // One entry per known tool, each validated on its own. An unknown key is
  // dropped (it names no row the panel can label) and so is an unreadable
  // breakdown; nothing here is ever added to anything else.
  const tokensByProvider: PeriodUsage['tokensByProvider'] = {};
  const rawTokens = source.tokensByProvider;
  if (rawTokens && typeof rawTokens === 'object') {
    for (const [id, raw] of Object.entries(rawTokens as Record<string, unknown>)) {
      if (!PROVIDER_IDS.has(id as ProviderSnapshot['id'])) continue;
      const breakdown = tokenBreakdown(raw);
      if (breakdown !== null) tokensByProvider[id as ProviderSnapshot['id']] = breakdown;
    }
  }

  // Which tools' COUNTS are lower bounds here, AND WHY — main's statement,
  // carried, not re-derived. Never `isFloor`, which is about dollars. A tool
  // with an empty cause list is not listed at all: a floor with no reason is
  // the bare hedge ADR-002 A3.16 forbids, so it must not be representable here.
  const tokenFloorCausesByProvider: PeriodUsage['tokenFloorCausesByProvider'] = {};
  const floorRaw = source.tokenFloorCausesByProvider;
  if (floorRaw && typeof floorRaw === 'object' && !Array.isArray(floorRaw)) {
    for (const [id, list] of Object.entries(floorRaw as Record<string, unknown>)) {
      if (!PROVIDER_IDS.has(id as ProviderSnapshot['id'])) continue;
      const causes = floorCauseList(list);
      if (causes.length > 0) tokenFloorCausesByProvider[id as ProviderSnapshot['id']] = causes;
    }
  }

  return {
    key: text(source.key, 32) ?? startsAt,
    startsAt,
    endsAt,
    costUsd: nonNegative(source.costUsd) ?? 0,
    byClass: costByClass(source.byClass) ?? {
      input: 0,
      output: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    },
    tokensByProvider,
    tokenFloorCausesByProvider,
    byModel,
    isFloor: source.isFloor === true,
    unpricedModels,
    hasUsage: source.hasUsage === true,
  };
}

/**
 * Week/month history. Absent or malformed collapses to null, which the settings
 * section renders as its empty state — indistinguishable, correctly, from a main
 * process that predates the field.
 */
function usageHistory(raw: unknown): UsageHistory | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const weeks = (Array.isArray(source.weeks) ? source.weeks : [])
    .map(periodUsage)
    .filter((entry): entry is PeriodUsage => entry !== null)
    .slice(0, MAX_PERIODS);
  const months = (Array.isArray(source.months) ? source.months : [])
    .map(periodUsage)
    .filter((entry): entry is PeriodUsage => entry !== null)
    .slice(0, MAX_PERIODS);
  // '' is the same "not reported" sentinel weeklyCost() uses: no valid ISO date
  // is empty, and the renderer branches on it to say the date was not given
  // rather than printing an empty one.
  const pricesAsOf = isoInstant(source.pricesAsOf) ?? '';
  // Per-tool price dates. Unknown tools and unparseable dates are dropped, not
  // blanked: an absent key already reads as "that table's date was not given".
  const pricesAsOfByProvider: UsageHistory['pricesAsOfByProvider'] = {};
  const byProvider = source.pricesAsOfByProvider;
  if (byProvider && typeof byProvider === 'object' && !Array.isArray(byProvider)) {
    for (const [id, date] of Object.entries(byProvider as Record<string, unknown>)) {
      if (!PROVIDER_IDS.has(id as ProviderSnapshot['id'])) continue;
      const iso = isoInstant(date);
      if (iso !== null) pricesAsOfByProvider[id as ProviderSnapshot['id']] = iso;
    }
  }
  // ADR-002 A3.20: tools with a known-unread range. Known ids only, each once;
  // anything else is dropped rather than named in the note.
  const incompleteProviders: UsageHistory['incompleteProviders'] = [];
  for (const id of Array.isArray(source.incompleteProviders) ? source.incompleteProviders : []) {
    if (!PROVIDER_IDS.has(id as ProviderSnapshot['id'])) continue;
    if (incompleteProviders.includes(id as ProviderSnapshot['id'])) continue;
    incompleteProviders.push(id as ProviderSnapshot['id']);
  }
  // ADR-003 A6: the tools in the history (fixed order from main) and each
  // tool's floor causes. Known ids and known codes only, each once, in the
  // producer's order; anything else is dropped rather than printed.
  const usageProviders: UsageHistory['usageProviders'] = [];
  for (const id of Array.isArray(source.usageProviders) ? source.usageProviders : []) {
    if (!PROVIDER_IDS.has(id as ProviderSnapshot['id'])) continue;
    if (usageProviders.includes(id as ProviderSnapshot['id'])) continue;
    usageProviders.push(id as ProviderSnapshot['id']);
  }
  const floorCausesByProvider: UsageHistory['floorCausesByProvider'] = {};
  const causesRaw = source.floorCausesByProvider;
  if (causesRaw && typeof causesRaw === 'object' && !Array.isArray(causesRaw)) {
    for (const [id, list] of Object.entries(causesRaw as Record<string, unknown>)) {
      if (!PROVIDER_IDS.has(id as ProviderSnapshot['id']) || !Array.isArray(list)) continue;
      const codes: HistoryFloorCause[] = [];
      for (const code of list) {
        if (!HISTORY_FLOOR_CAUSES.has(code as HistoryFloorCause)) continue;
        if (codes.includes(code as HistoryFloorCause)) continue;
        codes.push(code as HistoryFloorCause);
      }
      if (codes.length > 0) floorCausesByProvider[id as ProviderSnapshot['id']] = codes;
    }
  }
  return {
    weeks,
    months,
    pricesAsOf,
    pricesAsOfByProvider,
    incompleteProviders,
    usageProviders,
    floorCausesByProvider,
  };
}

function setupAction(raw: unknown): SetupAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (!SETUP_KINDS.has(source.kind as SetupKind)) return null;
  const label = text(source.label, 24);
  if (label === null) return null;
  const out: SetupAction = {
    kind: source.kind as SetupKind,
    label,
    detail: text(source.detail, 160) ?? '',
  };
  // The consent paragraphs: a short list of bounded lines, or nothing. A path
  // under a long user name still fits in 400 characters.
  if (Array.isArray(source.consent)) {
    const lines = source.consent
      .slice(0, 4)
      .map((line) => text(line, 400))
      .filter((line): line is string => line !== null);
    if (lines.length > 0) out.consent = lines;
  }
  return out;
}

function provider(raw: unknown): ProviderSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (!PROVIDER_IDS.has(source.id as ProviderSnapshot['id'])) return null;

  const displayName = text(source.displayName, 40);
  if (displayName === null) return null;

  const byModelRaw = Array.isArray(source.byModel) ? source.byModel : [];
  const byModel = byModelRaw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const e = entry as Record<string, unknown>;
      const model = text(e.model, 48);
      const billable = nonNegative(e.billable);
      return model !== null && billable !== null ? { model, billable } : null;
    })
    .filter((entry): entry is { model: string; billable: number } => entry !== null)
    .slice(0, 8);

  return {
    id: source.id as ProviderSnapshot['id'],
    displayName,
    accent: accent(source.accent),
    // ADR-003 A6.4: only a literal true carries the marker. Absent (an older
    // main) is false: the flag is a static registry fact main always sends.
    experimental: source.experimental === true,
    // Absent means a main process that predates the field. Default TRUE, not
    // false: an unteachable producer must degrade to the previous behaviour
    // (every provider visible) rather than to a silently empty panel, which
    // is indistinguishable from "this machine has no tools".
    enabled: source.enabled !== false,
    connected: source.connected === true,
    status: ROW_STATUSES.has(source.status as RowStatus) ? (source.status as RowStatus) : 'loading',
    planLabel: text(source.planLabel, 24),
    // Where the label came from, and the tool's own value. Carried only when
    // valid, so an older main's payload reads exactly as it did.
    ...(source.planSource === 'user' || source.planSource === 'tool' ? { planSource: source.planSource } : {}),
    ...(text(source.planDetected, 24) !== null ? { planDetected: text(source.planDetected, 24) } : {}),
    fiveHour: windowUsage(source.fiveHour),
    sevenDay: windowUsage(source.sevenDay),
    tokens: tokenBreakdown(source.tokens),
    // The row's headline count, anchored to exactly the window `sevenDay`
    // describes. Validated independently of `tokens` and never derived from
    // it: main states that the two are null together, but a producer that
    // breaks that invariant must lose the field it got wrong, not have the
    // other one re-labelled into a window it does not describe.
    weeklyTokens: tokenBreakdown(source.weeklyTokens),
    // Which window that count describes, from the row's own field. NOT derived
    // here or downstream from `sevenDay.resetsAt` — that would be usage
    // arithmetic on the renderer's side of the boundary, and it would couple two
    // rules that agree only by coincidence (see row.ts) — and not from
    // `weeklyCost.windowAnchored`, which is absent on a quiet week, exactly when
    // a zero count still has to name its window. Only a real boolean passes;
    // anything else is "no window to name".
    weeklyTokensWindowAnchored:
      typeof source.weeklyTokensWindowAnchored === 'boolean'
        ? source.weeklyTokensWindowAnchored
        : null,
    // Main's statement about the COUNT and its reasons, never re-derived here.
    // An empty list is "not a floor" — no claim added — which is what an older
    // main degrades to. A cause is required because a floor with no visible
    // reason is the bare hedge ADR-002 A3.16 forbids.
    weeklyTokenFloorCauses: floorCauseList(source.weeklyTokenFloorCauses),
    burnRatePerHour: nonNegative(source.burnRatePerHour),
    byModel,
    modelQuotas: modelQuotas(source.modelQuotas),
    weeklyCost: weeklyCost(source.weeklyCost),
    setupAction: setupAction(source.setupAction),
    errorCode: text(source.errorCode, 48) ?? undefined,
    lastGoodAt: isoInstant(source.lastGoodAt),
    // Both answers are kept: `false` is what offers "Bağla" again in Settings.
    hookInstalled: typeof source.hookInstalled === 'boolean' ? source.hookInstalled : undefined,
    // Qwen Code with no usage log at all: only a literal true is that claim.
    usageLogAbsent: source.usageLogAbsent === true ? true : undefined,
  };
}

// ------------------------------------------------------------------ anchor

function rect(raw: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const x = finite(r.x);
  const y = finite(r.y);
  const width = finite(r.width);
  const height = finite(r.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < 0 || height < 0) return null;
  return { x, y, width, height };
}

const EDGES = new Set<AnchorPayload['edge']>(['bottom', 'top', 'left', 'right']);
const MODES = new Set<AnchorPayload['mode']>(['hover', 'pin']);
const ANCHOR_SOURCES = new Set<AnchorPayload['anchorSource']>(['tray', 'cursor']);

/**
 * Anchor geometry drives absolute positioning, so a NaN here would push the
 * panel off-canvas with no visible error. Every field is required; a partial
 * payload is rejected outright rather than half-applied.
 */
export function sanitizeAnchor(raw: unknown): AnchorPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const tray = rect(source.tray);
  const window = rect(source.window);
  if (!tray || !window) return null;

  const displayRaw = source.display;
  if (!displayRaw || typeof displayRaw !== 'object') return null;
  const d = displayRaw as Record<string, unknown>;
  const bounds = rect(d.bounds);
  const workArea = rect(d.workArea);
  const id = finite(d.id);
  const scaleFactor = finite(d.scaleFactor);
  if (!bounds || !workArea || id === null) return null;
  // The panel's height budget. A main from before the fitted window sends
  // none, and its canvas IS the budget.
  const maxHeight = finite(source.maxHeight);

  return {
    tray,
    display: {
      id,
      // A zero or negative scale factor would make device-pixel snapping
      // divide by zero. Fall back to 1 rather than reject the whole anchor.
      scaleFactor: scaleFactor !== null && scaleFactor > 0 ? scaleFactor : 1,
      bounds,
      workArea,
    },
    window,
    maxHeight: maxHeight !== null && maxHeight > 0 ? maxHeight : window.height,
    // An absent or unrecognised value falls back to 'cursor', never 'tray':
    // we cannot claim the rect is a real tray icon unless we were told so, and
    // the failure direction should be "look less certain", not more.
    anchorSource: ANCHOR_SOURCES.has(source.anchorSource as AnchorPayload['anchorSource'])
      ? (source.anchorSource as AnchorPayload['anchorSource'])
      : 'cursor',
    edge: EDGES.has(source.edge as AnchorPayload['edge'])
      ? (source.edge as AnchorPayload['edge'])
      : 'bottom',
    mode: MODES.has(source.mode as AnchorPayload['mode'])
      ? (source.mode as AnchorPayload['mode'])
      : 'hover',
  };
}

// ------------------------------------------------------- preferences

/**
 * Preferences drive a CSS attribute on <html>, so an unrecognised string here
 * would put the document in a state no stylesheet describes. Rejected rather
 * than coerced: a null tells the caller "main said nothing usable", which is
 * different from "main said dark", and the caller falls back to its own
 * default instead of silently adopting a value nobody chose.
 */
export function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEME_CHOICES.has(value as ThemeChoice);
}

export function isLanguageChoice(value: unknown): value is LanguageChoice {
  return LANGUAGE_CHOICES.has(value as LanguageChoice);
}

/** A language the catalogs carry. 'system' is a choice, never a resolution. */
export function isResolvedLanguage(value: unknown): value is 'tr' | 'en' | 'zh' {
  return value === 'tr' || value === 'en' || value === 'zh';
}

/**
 * ADR-004's resolution rule, for the ONE case main did not resolve for us (an
 * absent or older preload): `tr*` -> tr, `zh*` -> zh, anything else -> en. Everywhere else
 * the renderer takes main's `resolvedLanguage` and never decides on its own,
 * because the tray tooltip is written by main and must match the panel.
 */
export function fallbackLanguage(tag: unknown): 'tr' | 'en' | 'zh' {
  if (typeof tag !== 'string') return 'en';
  if (/^tr(?:[-_]|$)/i.test(tag)) return 'tr';
  if (/^zh(?:[-_]|$)/i.test(tag)) return 'zh';
  return 'en';
}

/** The format locale main would choose when it has no OS region to offer. */
export function defaultFormatLocale(language: 'tr' | 'en' | 'zh'): string {
  if (language === 'tr') return 'tr-TR';
  if (language === 'zh') return 'zh-CN';
  return 'en-US';
}

/**
 * True when Intl accepts the tag. The format locale is handed straight to Intl
 * constructors, which throw a RangeError on a malformed tag — so an unusable
 * one is replaced here rather than allowed to blank the panel.
 */
export function isUsableLocale(tag: unknown): tag is string {
  if (typeof tag !== 'string' || tag.length === 0 || tag.length > 35) return false;
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

function navigatorLanguage(): string | undefined {
  try {
    return (globalThis as { navigator?: { language?: string } }).navigator?.language;
  } catch {
    return undefined;
  }
}

/**
 * The theme is the gate: without a usable theme the payload is refused (null),
 * exactly as before. The language fields are COERCED rather than refused,
 * because refusing them would also throw away a good theme and flash the other
 * palette. Coercion follows the same rule main applies, so a coerced value is
 * one main could have sent. `autostart` is coerced the same way: anything that
 * is not a boolean is the shipped default, `true`, as main's own load() says.
 */
export function sanitizePreferences(raw: unknown): Preferences | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const theme = source.theme;
  if (!isThemeChoice(theme)) return null;
  const language = isLanguageChoice(source.language) ? source.language : 'system';
  const resolvedLanguage = isResolvedLanguage(source.resolvedLanguage)
    ? source.resolvedLanguage
    : language !== 'system'
      ? language
      : fallbackLanguage(navigatorLanguage());
  const formatLocale = isUsableLocale(source.formatLocale)
    ? source.formatLocale
    : defaultFormatLocale(resolvedLanguage);
  const autostart = typeof source.autostart === 'boolean' ? source.autostart : true;
  const autostartByWindows = source.autostartByWindows === true;
  // Only a real `false` opens the first-run card; a main that predates the
  // field, or any odd value, keeps it closed.
  const setupCoachDismissed = source.setupCoachDismissed !== false;
  // Görünüm: anything but the two literals is the tray icon, as main's own
  // load() says; and only a real `false` claims the strip cannot be shown.
  const trayView: TrayView = source.trayView === 'strip' ? 'strip' : 'tray';
  const stripAvailable = source.stripAvailable !== false;
  const stripNoRoom = source.stripNoRoom === true;
  // Gösterge: anything but 'ring' is the bars, as main's own load() says; a
  // main from before the rings sends nothing and gets the bars it always drew.
  const gauge: Gauge = source.gauge === 'ring' ? 'ring' : 'bar';
  // Saydamlığı azalt, and Windows asking for it: only a real `true` either
  // way, so a main from before the glass sends nothing and gets the glass.
  const reduceTransparency = source.reduceTransparency === true;
  const systemReducedTransparency = source.systemReducedTransparency === true;
  // The window: only the exact literals count, and the fallbacks are the
  // opaque base in the transparent canvas — what every earlier main sent, and
  // a look that is right over any window.
  const material: PanelMaterial = source.material === 'acrylic' ? 'acrylic' : 'none';
  const frame: PanelFrame = source.frame === 'fitted' ? 'fitted' : 'canvas';
  // Düzen and Şerit stili: anything but the other literals is the default, as
  // main's own load() says; a main from before them sends nothing and gets the
  // list and the plain strip it always drew.
  const layout: Layout = source.layout === 'focus' || source.layout === 'tiles' ? source.layout : 'list';
  const stripStyle: StripStyle = source.stripStyle === 'rings' || source.stripStyle === 'fill' ? source.stripStyle : 'plain';
  return {
    theme, language, resolvedLanguage, formatLocale, autostart, autostartByWindows, setupCoachDismissed,
    trayView, stripAvailable, stripNoRoom, gauge, reduceTransparency, systemReducedTransparency,
    material, frame, layout, stripStyle,
  };
}

/** Returns null when the payload is not a usable Snapshot at all. */
/**
 * ADR-002 A3.12: the tools whose local usage scan has not produced its FIRST
 * result yet. Known provider ids only, de-duplicated; anything else is dropped
 * and a missing or malformed field is []. An unknown id is not a pending tool,
 * and a malformed payload must not put every row into a "calculating" state.
 */
function pendingUsage(raw: unknown): ProviderSnapshot['id'][] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderSnapshot['id'][] = [];
  for (const entry of raw) {
    if (PROVIDER_IDS.has(entry as ProviderSnapshot['id']) && !out.includes(entry)) {
      out.push(entry as ProviderSnapshot['id']);
    }
  }
  return out;
}

/** The pending tools on a snapshot, [] when there is no snapshot yet. */
export function pendingUsageOf(snapshot: Snapshot | null | undefined): readonly string[] {
  return snapshot?.pendingUsage ?? [];
}

export function sanitizeSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const generatedAt = isoInstant(source.generatedAt) ?? new Date().toISOString();
  if (!Array.isArray(source.providers)) return null;

  const providers = source.providers
    .map(provider)
    .filter((entry): entry is ProviderSnapshot => entry !== null);

  // Present only on a refresh reply, never on a push. Each entry is checked
  // against the closed set; unknown values are dropped, so a producer that
  // invents a notice cannot make the panel show an empty bubble. The field is
  // omitted entirely when nothing survives, so `refreshNotices` is either a
  // non-empty array or absent — the caller tests membership, not length.
  const notices = (Array.isArray(source.refreshNotices) ? source.refreshNotices : []).filter(
    (entry): entry is RefreshNotice => REFRESH_NOTICES.has(entry as RefreshNotice),
  );

  // A standing fact about the local corpus, carried on every snapshot (unlike
  // refreshNotices). null when absent or unusable; the section shows its empty
  // state, which is the same thing an older main process should produce.
  const history = usageHistory(source.usageHistory);

  const pending = pendingUsage(source.pendingUsage);

  const base: Snapshot = {
    generatedAt,
    providers,
    usageHistory: history,
    pendingUsage: pending,
  };
  return notices.length > 0 ? { ...base, refreshNotices: notices } : base;
}
