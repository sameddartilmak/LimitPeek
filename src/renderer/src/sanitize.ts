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
  Preferences,
  CostByClass,
  FigureSource,
  ModelCost,
  ModelQuotaDetail,
  ModelQuotaGroup,
  PeriodModelCost,
  PeriodUsage,
  Provenance,
  ProviderSnapshot,
  RefreshNotice,
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
const NEUTRAL_ACCENT = '#6B7A77';

const PROVIDER_IDS = new Set<ProviderSnapshot['id']>([
  'claude',
  'codex',
  'gemini',
  'copilot',
  'antigravity',
  'kimi',
]);
const ROW_STATUSES = new Set<RowStatus>(['loading', 'ok', 'stale', 'error', 'passive']);
const CERTAINTIES = new Set<Certainty>(['known', 'estimated', 'unknown']);
const SETUP_KINDS = new Set<SetupKind>(['install-bridge', 'add-api-key', 'not-installed']);
const THEME_CHOICES = new Set<ThemeChoice>(['dark', 'light', 'system']);

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
    speed: text(source.speed, 24) ?? 'standard',
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
 * free. There is no token field to carry: the contract defines none, so none
 * can cross this boundary — the same honesty invariant as the period itself.
 */
function periodModelCost(raw: unknown): PeriodModelCost | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const model = text(source.model, 64);
  if (model === null) return null;
  return {
    model,
    costUsd: nonNegative(source.costUsd),
    isFloor: source.isFloor === true,
  };
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
 * hides). There is deliberately no token-total field to carry — the contract
 * does not define one, so none can cross this boundary.
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
  return { weeks, months, pricesAsOf };
}

function setupAction(raw: unknown): SetupAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (!SETUP_KINDS.has(source.kind as SetupKind)) return null;
  const label = text(source.label, 24);
  if (label === null) return null;
  return {
    kind: source.kind as SetupKind,
    label,
    detail: text(source.detail, 160) ?? '',
  };
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
    // Absent means a main process that predates the field. Default TRUE, not
    // false: an unteachable producer must degrade to the previous behaviour
    // (every provider visible) rather than to a silently empty panel, which
    // is indistinguishable from "this machine has no tools".
    enabled: source.enabled !== false,
    connected: source.connected === true,
    status: ROW_STATUSES.has(source.status as RowStatus) ? (source.status as RowStatus) : 'loading',
    planLabel: text(source.planLabel, 24),
    fiveHour: windowUsage(source.fiveHour),
    sevenDay: windowUsage(source.sevenDay),
    tokens: tokenBreakdown(source.tokens),
    burnRatePerHour: nonNegative(source.burnRatePerHour),
    byModel,
    modelQuotas: modelQuotas(source.modelQuotas),
    weeklyCost: weeklyCost(source.weeklyCost),
    setupAction: setupAction(source.setupAction),
    errorCode: text(source.errorCode, 48) ?? undefined,
    lastGoodAt: isoInstant(source.lastGoodAt),
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

export function sanitizePreferences(raw: unknown): Preferences | null {
  if (!raw || typeof raw !== 'object') return null;
  const theme = (raw as Record<string, unknown>).theme;
  return isThemeChoice(theme) ? { theme } : null;
}

/** Returns null when the payload is not a usable Snapshot at all. */
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

  return notices.length > 0
    ? { generatedAt, providers, refreshNotices: notices, usageHistory: history }
    : { generatedAt, providers, usageHistory: history };
}
