/**
 * Usage Notch — the contract between the collector (main process) and the
 * renderer. Owned by the orchestrator; neither lane may change it unilaterally.
 *
 * Rule that drives the whole shape: the renderer performs NO arithmetic on
 * usage. Main sends absolute, already-resolved values. If main cannot state a
 * percentage truthfully, it sends `certainty: 'unknown'` and the renderer draws
 * no meter at all (see ADR-001).
 */

/** How much we trust the percentage. Drives meter geometry, not a badge. */
/**
 * The state ramp thresholds, in percent, compared against the ROUNDED value.
 *
 * This lives in the contract because two independent renderers now draw from
 * it — the panel meter (`src/renderer/src/format.ts`) and the tray donut
 * (`src/core/tray-spec.js`). They shipped with different values (60/85 vs
 * 70/90), which put a green icon next to an amber row at 62%: the icon
 * contradicting the number beside it, which is the same defect class as a
 * label contradicting its own colour. A value two lanes must agree on belongs
 * to neither lane.
 *
 * Values are the panel's, which was designed with the palette and shipped.
 * Compare rounded, always: a "%100" that is not styled `spent` reads as a bug.
 */
export const STATE_THRESHOLDS = { watch: 60, ember: 85, spent: 100 } as const;

export type StateStep = 'calm' | 'watch' | 'ember' | 'spent';

export type Certainty =
  | 'known'      // server-computed truth (Claude statusline rate_limits)
  | 'estimated'  // derived with a stated confidence interval
  | 'unknown';   // no defensible denominator -> renderer draws NO bar, NO %

/**
 * How much the INTERFACE the figure came through can be trusted — orthogonal
 * to `certainty`, which is about the number.
 *
 * Both of these are legitimately `certainty: 'known'`: both are computed by a
 * server, neither is a local estimate. But one arrived through a published
 * JSON field with a published name, and the other was decoded out of an
 * undocumented protobuf in an IDE's internal state store. Rendered in two
 * identically-styled blocks they would claim identical trust, and they do not
 * have it.
 *
 * The asymmetry that makes this a contract-level distinction rather than a
 * footnote: a documented field fails CLOSED when it is renamed (the read
 * yields undefined, the UI says "unknown"), while a field-numbered wire format
 * fails OPEN (some other float decodes in its place, passes every range guard,
 * and is shown). A `derived` figure carries a residual risk a `documented` one
 * does not, and the row must carry that distinction rather than average it
 * away.
 *
 *   'documented' — a published interface the vendor tells third parties to use
 *   'derived'    — decoded from an internal format that may change silently
 */
export type Provenance = 'documented' | 'derived';

/**
 * The server field a figure came from, named exactly.
 *
 * A discriminant, not a label: it says WHICH published number this is, so that
 * a future source cannot be quietly added to an existing list and inherit a
 * meaning it does not have. A provider reporting "43 of 300 requests" is a
 * count with a published denominator — a different kind of claim, needing a
 * new member here and a review, never a silent reuse of one of these.
 */
export type FigureSource =
  /** Claude Code statusline: `rate_limits.{five_hour,seven_day}.used_percentage`. */
  | 'claude.rate_limits.used_percentage'
  /** `agy` CLI statusline: `quota[bucket].remaining_fraction`, converted to used. */
  | 'antigravity.cli.quota.remaining_fraction'
  /** Antigravity IDE state store: `userStatus` model `quota_info.remaining_fraction`. */
  | 'antigravity.ide.quota_info.remaining_fraction'
  /** Codex session rollout `token_count.rate_limits.primary.used_percent` (5-hour). */
  | 'codex.rate_limits.primary.used_percent'
  /** Codex session rollout `token_count.rate_limits.secondary.used_percent` (weekly). */
  | 'codex.rate_limits.secondary.used_percent';

/**
 * Why a window carries no figure. Machine-readable, because the renderer must
 * be able to say something different for each, and free text from main is not
 * something the renderer is allowed to print.
 *
 * `not-supplied` is the one that earns its place. It means "this source does
 * not carry this window", which is NOT the same claim as "we do not know" and
 * emphatically not the same as "this provider has no such window". The
 * Antigravity IDE store carries no weekly figure; the Antigravity UI shows the
 * user a weekly limit. Reporting that window as absent would be a claim the
 * user can disprove on their own screen.
 */
export type WindowAbsence =
  /** Nothing has been captured at all — the bridge or source is not connected. */
  | 'no-capture'
  /** The source is connected and simply does not publish this window. */
  | 'not-supplied'
  /** Captured, but too old to stand behind, and no reset instant to reason with. */
  | 'stale'
  /** The window this figure described has already reset. */
  | 'rolled-over'
  /**
   * The source is connected and this window is CURRENT (not rolled over), but
   * its figure has not been reported yet. Claude Code renews the five-hour
   * window and only writes the new number the next time it runs, so for a
   * moment the bridge holds a fresh, valid capture whose window carries no
   * percentage. Distinct from `no-capture` (never connected — the row shows the
   * setup path) and from `rolled-over` (a figure whose window has ended). The
   * renderer says "yeni veri bekleniyor" rather than the bare "bilinmiyor".
   */
  | 'awaiting-report'
  /** Something was captured and could not be understood. */
  | 'unreadable';

export type RowStatus =
  | 'loading'
  | 'ok'
  | 'stale'      // last good value kept, dimmed, "as of" shown
  | 'error'      // last good value kept, retry offered
  | 'passive';   // provider not connected -> Ekle button

/** What the row's action button does when pressed. */
export type SetupKind =
  | 'install-bridge'  // Claude: install the statusline bridge (needs consent)
  | 'add-api-key'     // future: user pastes a key (DPAPI via safeStorage)
  | 'not-installed';  // the tool itself is absent on this machine

export interface SetupAction {
  kind: SetupKind;
  /** Turkish button label, e.g. "Ekle" / "Bağla". */
  label: string;
  /** One-line Turkish explanation shown before anything is written. */
  detail: string;
}

export interface WindowUsage {
  /**
   * 0-100, or null when certainty is 'unknown'.
   *
   * Still the ONLY figure this interface carries, on purpose. A percentage
   * with a server-computed denominator and a count like "43 of 300 requests"
   * are different claims; the second needs its own type and its own review,
   * not a second optional number here that some renderer eventually divides.
   */
  usedPercentage: number | null;
  certainty: Certainty;
  /**
   * Which published number this is. Present whenever `usedPercentage` is.
   * See `FigureSource`.
   */
  source?: FigureSource | null;
  /**
   * How much the interface behind the figure can be trusted. Present whenever
   * `usedPercentage` is. A row may legitimately carry one 'documented' window
   * and one 'derived' window, and must show that rather than average it.
   */
  provenance?: Provenance | null;
  /**
   * Why there is no figure. Non-null exactly when `usedPercentage` is null.
   * The renderer picks its wording from this: 'not-supplied' reads
   * "bildirilmiyor" (not reported), everything else reads "bilinmiyor"
   * (unknown). Saying "unknown" about a window we know is not published is a
   * small lie that makes the honest ones less believable.
   */
  absence?: WindowAbsence | null;
  /** ISO instant the window resets, or null when not knowable. */
  resetsAt: string | null;
  /**
   * When the percentage was captured from the server. Non-null whenever
   * usedPercentage is non-null. See ADR-001 amendment 2: a capture older than
   * the freshness budget is still shown — labelled with this instant — for as
   * long as the window it describes has not yet reset.
   */
  capturedAt?: string | null;
  /**
   * Billable tokens observed in local transcripts SINCE `capturedAt`. Only set
   * when the percentage is stale. This is the honest way to convey "you have
   * used more since then" without fabricating a newer percentage: it is a
   * measured floor on additional consumption, not a recomputed rate.
   */
  billableSinceCapture?: number | null;
  /** Confidence interval, only when certainty === 'estimated'. */
  confidenceLo?: number;
  confidenceHi?: number;
}

/** Absolute token counts. Always shown; never divided by anything. */
export interface TokenBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** input + output + cacheWrite. Excludes cacheRead, which is 98% of raw
   *  volume and bills at 0.1x — summing it produces a meaningless number. */
  billable: number;
}

/**
 * Notional USD cost. ADR-002: legitimate because cost has a PUBLISHED
 * denominator (price per million tokens), unlike the quota percentage which
 * has none. It is never a bill — the user is on a subscription and pays no
 * per-token charge. The UI must always frame it as "what this usage would
 * have cost at published API rates" and must never render a bare currency
 * total.
 */
export interface CostByClass {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/**
 * `ModelCost.speed` codes that say WHY a group is unpriced when the reason is
 * not a price tier (ADR-003 Amendment 6). Stable machine codes: the renderer
 * maps each to catalog text and never prints the code.
 *
 *   'no-model'            Gemini CLI recorded tokens on a message with no model
 *                         (a synthetic response); `model` is `'unknown'`.
 *   'no-published-price'  Kimi Code, a Kimi plan model (`kimi-code/<id>`): Kimi
 *                         publishes no per-token price for its plan models.
 *   'other-model-alias'   Kimi Code, any other model alias: another provider's
 *                         model used through Kimi Code ("other models via Kimi
 *                         Code"). The alias is resolved only by the user's Kimi
 *                         config, which this app never opens, so it is unpriced.
 *
 * Always `usd: null` and `pricedAs: null`.
 */
export type UnpricedReasonCode = 'no-model' | 'no-published-price' | 'other-model-alias';

export interface ModelCost {
  /**
   * Raw id as recorded, e.g. "claude-haiku-4-5-20251001". The exact string
   * `'unknown'` is a placeholder: the tool recorded usage but no model could be
   * resolved for it (Codex: no `turn_context` and no model in the session
   * header; Gemini: no model on the message, or one that is not id-shaped;
   * Kimi: an alias that is not id-shaped). Such usage is always unpriced; the
   * renderer maps the placeholder to a catalog label instead of printing it as
   * a model name. For Kimi this is the model ALIAS as configured in Kimi Code
   * (e.g. "kimi-code/kimi-for-coding").
   */
  model: string;
  /**
   * The speed this group was billed at ('standard' | 'fast' | ...). Present
   * because a model can be priced at one speed and unpriced at another, so
   * naming only the model would put a row in `unpricedModels` while an
   * identically-named priced row sits beside it.
   *
   * Gemini emits 'standard' (Gemini API Standard rates; an unknown model id is
   * 'standard' with `usd: null`) or 'no-model'. Kimi emits only
   * 'no-published-price' or 'other-model-alias'. See `UnpricedReasonCode`.
   */
  speed: string;
  /** The price-table key it matched, or null when unpriced. */
  pricedAs: string | null;
  /** USD, or null when the model is not in the price table. */
  usd: number | null;
  tokens: TokenBreakdown;
}

export interface WeeklyCost {
  /** Sum over PRICED models only. Never includes an unpriced model as zero. */
  totalUsd: number;
  byClass: CostByClass;
  byModel: ModelCost[];
  /**
   * Model ids seen in the window with no price-table entry. **Presence check
   * only** — it de-duplicates by model and therefore DROPS the speed.
   *
   * Render the user-facing warning from `byModel` entries whose `usd` is null,
   * which carry `model` AND `speed`. Rendering it from this array instead can
   * print "claude-opus-4-8 could not be priced" directly above a table row
   * showing claude-opus-4-8 priced — the exact self-contradiction
   * `ModelCost.speed` was added to prevent. An earlier version of this comment
   * demanded the opposite; it was wrong.
   *
   * Either way the obligation stands: unpriced usage MUST be visible. A silent
   * zero is a wrong number presented as a right one.
   */
  unpricedModels: string[];
  /**
   * ISO date the price table was current. Prices drift; say when.
   *
   * The empty string `''` when the provider HAS no price table (Kimi Code,
   * ADR-003 A6): nothing in this cost was priced from a list, so there is no
   * date to state. Never a made-up date.
   */
  pricesAsOf: string;
  /**
   * Events priced through the 1.25x top-level fallback because the
   * `cache_creation` TTL breakdown was absent. Non-zero means the figure is a
   * FLOOR: 1-hour writes bill at 2x and were charged at 1.25x. Surfaced so a
   * future Claude Code that stops emitting the breakdown drifts the number
   * VISIBLY rather than silently — the failure mode this project keeps
   * finding.
   */
  fallbackWriteEvents: number;
  /**
   * Total events in the window that carried cache writes — the denominator for
   * `fallbackWriteEvents`. Without it "1.412 events lacked a TTL split" reads
   * identically whether that is 1.412 out of 1.413 or out of 100.000, which
   * are very different claims about how much of a floor the total is.
   */
  cacheWriteEvents: number;
  /**
   * Priced events whose RECORDED cache writes are 0 although a write was
   * likely — they read from the cache, OR sent an uncached prompt of at least
   * 1,024 tokens (OpenAI's minimum cacheable prompt) — on a model that has a
   * published cache-write price (ADR-002 Amendment 3 rule 3, as broadened by
   * A3.9: Codex records 0 writes on every record). Zero recorded writes is not zero writes, so non-zero
   * means the figure is a FLOOR ("en az"); no write count is estimated. A
   * different claim from `fallbackWriteEvents` (a missing TTL split) and never
   * folded into it. Always present: Codex fills it, Claude is always 0.
   */
  unrecordedWriteEvents: number;
  /**
   * Priced events with NO recorded tier — Codex turns before the rollout's first
   * settings record — priced at Standard because every tier that rollout
   * records is default/priority/fast (ADR-002 A3.17: Codex core sends only a
   * tier the model catalog advertises, and no observed catalog lists the
   * cheaper Flex). Non-zero means the figure is a FLOOR ("en az") with its own
   * cause. A rollout recording any other tier leaves such turns unpriced (they
   * appear in `byModel` with `usd: null` and speed 'unknown-tier'), so they are
   * never counted here. Always present: Codex fills it, Claude is always 0.
   */
  assumedTierEvents: number;
  /**
   * Priced events whose recorded tier is `priority`/`fast` — the tier
   * REQUESTED, not proven billed — priced at STANDARD (ADR-002 A3.18): a Fast
   * price could exceed the true cost and break "en az". Non-zero means the
   * figure is a FLOOR with its own cause ("Fast requested: if applied, the real
   * cost is higher"). Their `byModel` row keeps speed 'fast' while `pricedAs`
   * names the Standard row. Always present: Codex fills it, Claude is always 0.
   */
  fastRequestedEvents: number;
  /**
   * Gemini CLI floor cause (ADR-003 A6): true whenever this is a Gemini cost
   * with an amount. The CLI never records its utility model calls (routing,
   * compression, loop detection, next-speaker checks, summaries, edit
   * correction, web search/fetch) or failed stream attempts, so every Gemini
   * figure is a FLOOR ("en az") with this as a standing cause. Always present:
   * `false` for every other provider, and `false` on an empty known-incomplete
   * Gemini cost (A3.19), which has no amount to qualify.
   */
  unrecordedCalls: boolean;
  /**
   * Gemini floor cause: priced events whose prompt exceeded 200,000 tokens on a
   * model that publishes a separate >200k rate. They are priced at the <=200k
   * rate AS A FLOOR (the page does not say whether the higher rate reprices the
   * whole request, so only the lower rate cannot overstate). Always present;
   * 0 for every other provider.
   */
  longPromptFloorEvents: number;
  /**
   * Gemini floor cause: events that recorded tool-use prompt tokens
   * (`toolUsePromptTokenCount` > 0), priced or not. Those tokens are not priced
   * (their billing is not published), so the figure is a FLOOR. Always present;
   * 0 for every other provider.
   */
  toolTokenEvents: number;
  /**
   * true ONLY when the cost reader KNOWS it could not read usage records that
   * may fall inside this window (ADR-002 A3.15): the last local scan failed or
   * timed out and an older result is being served, a log file or directory in
   * reach of the window could not be read (locked, access denied, refused as a
   * network target), or a usage record in the window was present but could not
   * be decoded. The figure then omits usage it knows exists, so it is a FLOOR
   * and the "data not current" caveat is true.
   *
   * Never derived from the rate-limit capture: a stale or rolled-over 5h/weekly
   * reading, or simply no recent use of the tool, says nothing about whether
   * the logs were read, and is `false` here. Drive the cost block's degraded
   * caveat and its floor from this field, never from `ProviderSnapshot.status`.
   *
   * A known-incomplete source is delivered even when NOTHING readable is left in
   * the window (A3.19): main then sends an empty WeeklyCost — `totalUsd` 0, empty
   * `byModel`/`unpricedModels`, every count 0 — with `sourceIncomplete: true`.
   * That zero is "nothing read", not an amount: render the gap in its own
   * no-figure sentence, never "en az $0" or "the amount is a lower bound".
   */
  sourceIncomplete: boolean;
  windowStart: string;
  windowEnd: string;
  /** true when anchored to sevenDay.resetsAt; false for a trailing 7 days. */
  windowAnchored: boolean;
}

/**
 * One model's notional cost inside a period.
 *
 * The SAME honesty rule as `PeriodUsage`, one level down: a cost plus a
 * per-class token BREAKDOWN, never a single merged token count — the shape has
 * nowhere to put one on purpose. Frame it exactly as the period figure: never a
 * bill, "en az" whenever `isFloor`, and a null `costUsd` reads "fiyatlanamadı",
 * never "$0,00".
 */
export interface PeriodModelCost {
  /**
   * The tool this usage was recorded by. A period's list holds the models of
   * every tool with usage (Claude Code, Codex, Gemini CLI, Kimi Code), each
   * priced through its own tool's rules (`src/core/pricing.js`,
   * `src/core/codex/pricing.js`, `src/core/gemini/pricing.js`; Kimi is never
   * priced) — so the renderer can mark which tool a model belongs to, and no
   * entry's figure mixes two tables. Only dollars are combined into the period
   * total; token counts are never summed across tools.
   *
   * Gemini entries with an amount are ALWAYS `isFloor: true` (unrecorded calls).
   * Kimi entries are always `costUsd: null`, `isFloor: false`.
   */
  provider: ProviderSnapshot['id'];
  /**
   * The RAW recorded model id, e.g. "claude-opus-5" (or a dated id like
   * "claude-haiku-4-5-20251001"). Shown as it appears — no marketing name is
   * invented, and the codebase has no display-label table to draw one from.
   * The exact string `'unknown'` is the unresolved-model placeholder (see
   * `ModelCost.model`): always unpriced, mapped to a catalog label.
   */
  model: string;
  /**
   * Notional USD for this model's PRICED usage in the period, or `null` when
   * the model has no price-table entry at any speed. Null is the "could not be
   * priced" signal (renderer: "fiyatlanamadı"); it is never coerced to 0, or an
   * unpriced model would read as a free one. Never a bill.
   */
  costUsd: number | null;
  /**
   * true when `costUsd` is a LOWER BOUND for this model: a cache-write TTL split
   * was missing (priced at the 1.25x floor), part of the model's usage was at
   * an unpriced speed and excluded, or (Codex) writes were unrecorded or a tier
   * was assumed Standard / Fast requested and priced at Standard (A3.17-18).
   * Every cause pushes the true figure up, so the renderer prints "en az" —
   * exactly as at the period level.
   */
  isFloor: boolean;
  /**
   * Absolute tokens of this entry — this tool, this model, this period. Always
   * present: an entry exists only because usage produced it, so there is always
   * something to count, including when `costUsd` is null (an unpriced model has
   * tokens; what it has no published price for is dollars). Never null, and a
   * genuine zero in a class simply means no tokens of that class.
   *
   * It is the SAME event set `costUsd` was computed from: the same deduped
   * corpus, the same half-open period `[startsAt, next period)`, and the same
   * grouping by RAW recorded model id — so the two figures on one line can never
   * be describing different usage. One asymmetry, by construction: when part of
   * a model's usage could not be priced (a speed or tier with no published row),
   * `costUsd` covers only the priced part and `isFloor` is true, while `tokens`
   * covers ALL of the model's usage in the period. That is the honest pairing —
   * the tokens were used whether or not a price exists for them — and it is why
   * a null `costUsd` still carries a non-zero count.
   *
   * `billable` (input + output + cacheWrite) EXCLUDES `cacheRead`, which is
   * ~98% of raw volume and bills at 0.1x, so folding it in yields a figure
   * dominated by the cheapest class that says nothing; `cacheRead` stands on
   * its own in the same breakdown. Per-tool accounting: these counts are NEVER
   * summed across tools, unlike dollars (see `PeriodUsage.tokensByProvider`).
   * Summing them WITHIN one tool's entries is legitimate — the entries of a
   * tool partition that tool's period tokens — but the list is capped at 24
   * entries, so a sum over what is shown can fall short of the tool's own
   * subtotal; read `tokensByProvider` for the subtotal instead of adding up
   * rows.
   *
   * When this COUNT is a lower bound is a narrower question than when `isFloor`
   * (a statement about `costUsd`) is true. Do not re-derive it: the period's
   * `tokenFloorCausesByProvider` answers it per tool, and applies to this entry
   * through its `provider` unchanged.
   *
   * NULLABLE, although main always sends it. The type has to be able to express
   * every state this boundary can be in, and "the count did not arrive" is one
   * of them: the sanitiser sees whatever an older or broken main sent, and a
   * non-nullable type forces it to mint an all-zero breakdown instead — a datum
   * main can never legitimately produce, reading as a measured zero. Null says
   * "absent"; zero says "measured zero". PRODUCER INVARIANT, tested rather than
   * typed: every entry `src/core/history.js` emits carries a count, because an
   * entry only exists where usage produced it.
   */
  tokens: TokenBreakdown | null;
}

/**
 * One calendar period (a week or a month) and its NOTIONAL cost.
 *
 * The honesty rule that shapes this shape: there is deliberately NO single
 * merged token total here. Summing the four token classes produces a figure
 * dominated by cache reads (≈98% of raw volume, billed at 0.1x) that means
 * nothing (README, ADR-001). A period is summarised the one honest way there
 * is — its cost at published API prices (ADR-002), which has a real published
 * denominator — carried in `costUsd` plus a per-class `byClass`. Main resolves
 * both; the renderer does no arithmetic on them. Frame `costUsd` exactly as
 * `WeeklyCost.totalUsd` is framed: never a bill, always "what this would have
 * cost at published API rates", and prefixed "en az" whenever `isFloor`.
 *
 * Absolute token counts ARE carried, because "how many tokens did I use" is a
 * real question with a true answer — but only in the two shapes that stay
 * honest: per tool and per class (`tokensByProvider`), and per tool, model and
 * class (`PeriodModelCost.tokens`). There is still no single number for the
 * period, and adding those breakdowns up to make one is the banned operation,
 * not an omission to be filled in.
 */
export interface PeriodUsage {
  /** Stable identity, derived from the LOCAL period start: a week is keyed by
   *  its Monday's date ("2026-09-07"), a month by "YYYY-MM". Not shown to the
   *  user — the visible range is formatted from `startsAt`/`endsAt`. */
  key: string;
  /** ISO instant the period starts (local calendar midnight). */
  startsAt: string;
  /** ISO instant of the period's INCLUSIVE last day (its local midnight), so
   *  the renderer formats "2 Eylül – 8 Eylül" directly, with no exclusive
   *  boundary to adjust for. */
  endsAt: string;
  /**
   * Notional USD over PRICED models only, at published API rates. Never a bill.
   * A real 0 means "no priced usage in this period" — read `hasUsage` to tell
   * that apart from "usage happened but none of it could be priced".
   */
  costUsd: number;
  /** Per-class USD split (same classes as `CostByClass`). Shown separately;
   *  never summed back into one token figure. */
  byClass: CostByClass;
  /**
   * Absolute tokens in this period, KEYED BY TOOL: one `TokenBreakdown` per
   * tool that has usage here, and no entry at all for a tool that does not.
   * Always an object, `{}` for an empty period.
   *
   * Keyed by tool and not merged, because dollars and tokens do not obey the
   * same arithmetic. Two tools' dollars are comparable — both are USD at
   * published rates — so `costUsd` and `byClass` add them. Two tools' token
   * counts are not: each vendor counts and bills its classes its own way, and
   * `cacheRead` (~98% of raw volume, billed at 0.1x, excluded from `billable`)
   * sits in a different proportion in each. So a period-level "tokens used"
   * total across tools is banned and is deliberately absent here. This map is
   * the shape that makes a per-tool subtotal renderable WITHOUT creating one:
   * show the entries side by side, labelled by tool, never added. Summing the
   * values of this map — in the renderer, in a test fixture, or anywhere else —
   * produces exactly the figure ADR-001 forbids.
   *
   * Within one tool the figure is a true total: it covers every event of that
   * tool in the half-open period `[startsAt, next period)`, from the same
   * deduped corpus the period's cost is priced over, so it equals the sum of
   * that tool's `byModel` entries' `tokens` — except that `byModel` is capped at
   * 24 entries, which is precisely why this subtotal is given rather than left
   * to be added up.
   *
   * Like every other figure here an entry can be a LOWER BOUND, but for
   * NARROWER reasons than `costUsd` is. Do NOT derive that from `isFloor`,
   * which is a statement about dollars: read `tokenFloorCausesByProvider`,
   * which answers the question per tool, WITH its causes, and is resolved in
   * main.
   */
  tokensByProvider: Partial<Record<ProviderSnapshot['id'], TokenBreakdown>>;
  /**
   * WHY each tool's `tokensByProvider` entry in this period is a LOWER BOUND —
   * tokens missing from the COUNT — as `HistoryFloorCause` codes in the order
   * that type lists them. A tool is a floor exactly when it has at least one
   * cause; a tool with an exact count has NO KEY here. Always an object, `{}`
   * when every count in the period is exact.
   *
   * Causes and not a bare flag, because ADR-002 A3.16 forbids showing a floor
   * without at least one visible cause line, and a token floor cannot always
   * borrow one from the cost side: a Gemini period where nothing could be priced
   * is a token floor while `floorCausesByProvider.gemini` carries no
   * 'unrecorded-calls' at all. Deliberately the same shape as the cost side's
   * `UsageHistory.floorCausesByProvider`, so one renderer routine can compose
   * either note.
   *
   * It exists so the "en az" rule lives in data rather than in one renderer's
   * memory, and `src/core/history.js tokenFloorCauses()` is that rule — the
   * panel row's `ProviderSnapshot.weeklyTokenFloorCauses` calls the same
   * function over its own window, so the two can never disagree about a tool.
   *
   * `isFloor` answers the MONEY question and is deliberately WIDER: a period can
   * be `isFloor: true` with every token count exact, and a tool's count is never
   * marked because a DIFFERENT tool's dollars are a floor. The monetary causes —
   * an unpriced model, a Codex tier assumed Standard or Fast-requested, Claude's
   * cache-write TTL fallback — never appear here: each counts every token it saw
   * and differs only in what it may charge.
   *
   * The codes a tool can carry:
   *   'unread-range'       any tool: a known-unread range overlaps this period,
   *                        so events are missing from the count (A3.20). Note
   *                        this code is TOKEN-side only — see
   *                        `HistoryFloorCause`.
   *   'unrecorded-calls'   Gemini CLI, unconditional while it has a count:
   *                        utility calls and failed streams are never recorded.
   *   'unrecorded-writes'  Codex: a turn recorded 0 cache writes although it read
   *                        cache or sent a prompt at or above the minimum
   *                        cacheable size (A3.3/A3.9), so `cacheWrite` and
   *                        `billable` are understated. Decided from the record
   *                        with no price lookup, so an unpriced turn sets it too.
   *
   * Always a SUBSET of `tokensByProvider`'s keys, and a tool whose count is
   * entirely ZERO is never keyed: with no amount there is nothing for "en az" to
   * qualify. That a period overlaps a known-unread range is still said by
   * `isFloor` and by `UsageHistory.incompleteProviders`, which is where the "we
   * could not read this range" note belongs (A3.20).
   */
  tokenFloorCausesByProvider: Partial<Record<ProviderSnapshot['id'], HistoryFloorCause[]>>;
  /**
   * The period split by recorded model id, largest priced cost first and
   * unpriced models last. Cost only — never a merged token total, same honesty
   * rule as the period figure. The priced entries partition `costUsd` (each
   * entry is `round()`ed independently, so their sum may differ from `costUsd`
   * by a cent). Empty for an empty period.
   */
  byModel: PeriodModelCost[];
  /**
   * true when `costUsd` is a LOWER BOUND: unpriced models were excluded, a
   * cache-write TTL split was missing and priced at the 1.25x floor, Codex
   * writes were unrecorded (`WeeklyCost.unrecordedWriteEvents`), a Codex tier
   * was assumed Standard or Fast was requested and priced at Standard
   * (`assumedTierEvents` / `fastRequestedEvents`, A3.17-18), or a range of
   * usage a reader KNOWS it could not read overlaps the period (A3.20; see
   * `UsageHistory.incompleteProviders`). Also (ADR-003 A6) whenever Gemini CLI
   * has usage in the period (unrecorded calls, always) and whenever Kimi Code
   * has usage (unpriced, always). Every such cause can only push the true
   * figure up, so the renderer prints "en az". An empty period
   * (`hasUsage: false`) can be a floor through the unread cause alone.
   * `UsageHistory.floorCausesByProvider` names the causes per tool.
   */
  isFloor: boolean;
  /** Model ids seen in the period with no price-table entry. Presence only —
   *  de-duplicated and speed-dropped, exactly like `WeeklyCost.unpricedModels`. */
  unpricedModels: string[];
  /** true when ANY event landed in the period, priced or not. Distinguishes a
   *  genuinely empty period from one whose usage could not be costed. */
  hasUsage: boolean;
}

/**
 * Why a tool's history figures are floors, as stable codes (ADR-003 A6). The
 * renderer maps each to catalog text, so a price note can be composed for ANY
 * set of tools instead of a sentence hard-coded per combination.
 *
 *   'unread-range'              TOKEN floors only: a range of usage the reader KNOWS
 *                               it could not read overlaps the window, so events are
 *                               missing from the COUNT (ADR-002 A3.15/A3.20)
 *   'unpriced'                  some usage has no price (unknown model, a tier with
 *                               no row, tokens without a model, every Kimi model)
 *   'cache-write-ttl-fallback'  Claude: TTL split missing, writes priced at 1.25x
 *   'unrecorded-writes'         Codex: writes recorded as 0 on a write-priced model
 *   'assumed-tier'              Codex: no tier recorded yet, priced at Standard
 *   'fast-requested'            Codex: Fast requested, priced at Standard
 *   'unrecorded-calls'          Gemini: utility calls and failed streams never recorded
 *   'long-prompt'               Gemini: prompt over 200k priced at the <=200k rate
 *   'tool-tokens'               Gemini: tool-use prompt tokens not priced
 *
 * ONE code is TOKEN-side only and never appears in `floorCausesByProvider`:
 * 'unread-range'. On the COST side a known-unread range already has its own
 * field (`UsageHistory.incompleteProviders`) and its own note, and ADR-002 A3.20
 * rules that the price notes do not grow a clause for it — that ruling stands.
 * But a TOKEN floor has no such field to lean on, and A3.16 forbids showing a
 * floor without a visible cause, so on that side the gap must be nameable.
 * Read it from `weeklyTokenFloorCauses` / `tokenFloorCausesByProvider` only.
 *
 * Two codes carry a slightly WIDER meaning on the token side than the cost
 * side's counters do, because a price qualifier that matters to dollars does not
 * matter to a count:
 *   'unrecorded-writes'  cost: 0 recorded writes on a WRITE-PRICED model.
 *                        tokens: 0 recorded writes at all — whether a write
 *                        price exists decides what may be CHARGED for the
 *                        missing writes, not whether they are missing.
 *   'unrecorded-calls'   cost: set only when something in the window priced.
 *                        tokens: unconditional while Gemini CLI has a count.
 */
export type HistoryFloorCause =
  | 'unread-range'
  | 'unpriced'
  | 'cache-write-ttl-fallback'
  | 'unrecorded-writes'
  | 'assumed-tier'
  | 'fast-requested'
  | 'unrecorded-calls'
  | 'long-prompt'
  | 'tool-tokens';

/**
 * Week-by-week and month-by-month notional usage, for the settings "Toplam
 * Kullanım" section. Derived from LOCAL records only: Claude Code transcripts
 * and Codex session rollouts. Each tool is priced by its own table; a period's
 * `costUsd`, `byClass`, `isFloor` and `hasUsage` combine both, and `byModel`
 * lists both tools' models tagged by `provider`. Both lists are contiguous and
 * NEWEST FIRST, and include honest empty periods between the first observed
 * usage and now. Main computes every figure; the renderer only renders
 * (contract rule: no renderer arithmetic on usage).
 */
export interface UsageHistory {
  /** ISO-week-aligned (Mon–Sun) buckets, newest first. */
  weeks: PeriodUsage[];
  /** Calendar-month buckets, newest first. */
  months: PeriodUsage[];
  /**
   * ISO date the CLAUDE price table was current (see `WeeklyCost.pricesAsOf`).
   * Kept for compatibility and always set, even when no Claude usage is in the
   * history; it is not the date of every figure — read `pricesAsOfByProvider`.
   */
  pricesAsOf: string;
  /**
   * ISO date each price table in these figures was current, keyed by tool. A
   * tool is present only when its usage is part of the history — Claude
   * included — because the date of a table that priced nothing is not a fact
   * about these figures. Empty when there is no usage at all. Prices drift
   * independently per vendor, so one date for all would be false for some.
   * Kimi Code NEVER appears here: it has no price table (read `usageProviders`).
   */
  pricesAsOfByProvider: Partial<Record<ProviderSnapshot['id'], string>>;
  /**
   * Every tool whose usage is part of this history, in the fixed order
   * claude, codex, gemini, kimi — including a tool with no price table (Kimi),
   * which therefore has no entry in `pricesAsOfByProvider`. Always present;
   * empty when there is no usage. With `pricesAsOfByProvider` and
   * `floorCausesByProvider` it is everything a composed price note needs:
   * for each listed tool, its price date (or none) and its floor causes.
   */
  usageProviders: ProviderSnapshot['id'][];
  /**
   * For each tool, the floor causes present in its usage across the LISTED
   * periods (weeks and months), in the fixed order of `HistoryFloorCause`. A
   * tool is present only when it has at least one cause; Gemini always has
   * 'unrecorded-calls' and Kimi always has 'unpriced' while they have usage.
   * Always present; empty object when no figure is a floor for these reasons.
   */
  floorCausesByProvider: Partial<Record<ProviderSnapshot['id'], HistoryFloorCause[]>>;
  /**
   * Tools whose reader KNOWS it could not read usage in a range overlapping at
   * least one listed period (ADR-002 A3.20) — the history counterpart of
   * `WeeklyCost.sourceIncomplete`, never derived from rate-limit freshness.
   * Every affected period has `isFloor: true`, and so does every `byModel`
   * entry of an affected tool in it. Always present; empty when no listed
   * period is affected. Lets the renderer show ONE note naming the cause, only
   * when some period is affected.
   *
   * When there are NO periods at all (`weeks` and `months` empty), it lists the
   * tools with a known-unread range inside the span the history covers, so the
   * renderer does not claim "no records found" over a known gap.
   */
  incompleteProviders: ProviderSnapshot['id'][];
}

/**
 * One figure and the models it was reported for.
 *
 * The split is the point and it is structural, not stylistic: the figure lives
 * on the GROUP and members carry NAMES ONLY. There is no shape here that pairs
 * one model name with one percentage, so no surface downstream can render
 * "Claude Opus 4.6 · %60" — a string that would sit directly beneath the
 * user's real Claude Code row and read as a statement about Claude's quota.
 * Making that string unconstructible is worth more than a styling rule,
 * because a rule cannot be screenshotted, cropped or read aloud incorrectly.
 */
export interface ModelQuotaGroup {
  /** 0-100 used. Never null: a group exists only because there is a figure. */
  usedPercentage: number;
  /** ISO instant this group's window resets, or null when not knowable. */
  resetsAt: string | null;
  /**
   * Display names reported with this figure, sorted. Names only — never a
   * name with a number attached.
   */
  members: string[];
}

/**
 * Optional per-model detail for a provider that publishes one figure per model.
 *
 * Groups are formed by DE-DUPLICATING identical (figure, reset) pairs. That is
 * all it means. It asserts no relationship between the models in a group — not
 * a shared pool, not a shared limit, not a product family. Two models are
 * listed together because their two numbers are the same two numbers.
 */
export interface ModelQuotaDetail {
  /** Most consumed first. */
  groups: ModelQuotaGroup[];
  /**
   * True when the groups do not all carry the same figure.
   *
   * MAIN-COMPUTED, and it has to be: this contract forbids the renderer doing
   * arithmetic on usage data, and comparing two percentages to decide whether
   * they differ is arithmetic on usage data. Without this flag the renderer
   * would have to do it anyway, silently.
   */
  diverged: boolean;
  /**
   * OPTIONAL in the type so the renderer lane can adopt it in its own pass;
   * main always populates both, on every Antigravity row that has a detail
   * block at all.
   *
   * The model the user currently has selected in Antigravity, by display name,
   * or null when it cannot be established truthfully.
   *
   * Null covers every doubtful case on purpose — no preference recorded, an id
   * that matches no listed model, an id that matches more than one, or an id
   * space the decoder refused. A highlight on the wrong model is a false
   * statement about the figure beside it, and "we do not know which" is not.
   */
  selectedModel?: string | null;
  /**
   * Index into `groups` of the group whose `members` include `selectedModel`,
   * or null when there is no selection or it is in no group.
   *
   * The pairing rule still holds and this does not weaken it: the figure lives
   * on the GROUP, and this points at a group, not at a number. Render the
   * selection as a marker on that member inside its group — never as
   * "Claude Opus 4.6 (Thinking) · %60", which is the string this shape exists
   * to make unconstructible.
   */
  selectedGroupIndex?: number | null;
  source: FigureSource;
  provenance: Provenance;
  /** When these figures were captured. */
  capturedAt: string;
}

/**
 * The state of the OPTIONAL, user-supplied API key for a provider (ADR-003
 * Amendment 8; the conditions are Amendment 5's K1-K25).
 *
 * Fixed codes, never provider text (K19). GitHub's own wording can name an
 * organisation, a repository or an account, so nothing from a reply, a header,
 * a URL or an `err.message` reaches this field — the renderer prints its own
 * sentence per code.
 *
 *  'none'                      no key stored; the row is exactly as it was
 *  'stored'                    a key is stored and nothing has refused it
 *  'key-rejected'              the provider refused the key (401). Polling STOPS
 *                              until the user replaces or removes it
 *  'key-lacks-permission'      authenticated, but not allowed to read the plan
 *  'rate-limited'              the provider asked us to come back later
 *  'not-available'             the provider has no such figure for this account
 *                              (including a reply we could not fully validate:
 *                              all-or-nothing, so no figure rather than a
 *                              partial one)
 *  'unreachable'              the request did not complete (timeout, transport,
 *                              a redirect, an oversized body, a 5xx)
 *  'unreadable'                a key IS stored and the local copy cannot be
 *                              read or decrypted — another Windows account, a
 *                              machine change, a truncated file
 *  'secure-storage-unavailable' Windows DPAPI is not available, so nothing was
 *                              stored. There is no plaintext fallback, by veto.
 */
export type KeyState =
  | 'none'
  | 'stored'
  | 'key-rejected'
  | 'key-lacks-permission'
  | 'rate-limited'
  | 'not-available'
  | 'unreachable'
  | 'unreadable'
  | 'secure-storage-unavailable';

/**
 * What a stored Copilot key buys: AI credits consumed in the current calendar
 * month (ADR-003 Amendment 6 decision 3).
 *
 * THERE IS NO PERCENTAGE AND NO ALLOWANCE, and there never will be one in this
 * shape. GitHub's reply carries no allowance (A6.3), so a percentage would need
 * a denominator we invented — the exact fabrication ADR-001 Decision 1 rejects
 * for token math, and it would be worse here because it would look authoritative
 * beside a real figure. The row prints three counts and the time they were read.
 *
 * All three numbers are finite and non-negative, and they are either ALL present
 * or the whole object is null: a sum over a reply we only partly understood is a
 * number with no meaning that looks exactly like a real one.
 *
 * `grossCredits` is everything consumed, `includedCredits` the part the plan
 * covered and `billedCredits` the overage that will be charged. Self-paid plans
 * only; the consent screen says so.
 */
export interface CreditUsage {
  grossCredits: number;
  includedCredits: number;
  billedCredits: number;
  /** ISO instant the billing period starts (UTC month for Copilot). */
  periodStart: string;
  /** ISO instant it ends — exclusive. Past it, the figure is dropped. */
  periodEnd: string;
  /** ISO instant this reading was taken. The row shows its age. */
  fetchedAt: string;
}

export interface ProviderSnapshot {
  id: 'claude' | 'codex' | 'gemini' | 'copilot' | 'antigravity' | 'kimi';
  displayName: string;
  /** Brand hex, used ONLY for the 2px spine + monogram tile. Never the meter. */
  accent: string;
  /**
   * true when this provider's local reader was written from the vendor's
   * source code and has NOT been confirmed against a real install (ADR-003
   * Amendment 6, decision 4). The row must carry a visible "experimental"
   * marker while true. Today: true for 'gemini' and 'kimi', false for every
   * other provider. A static registry fact, independent of whether the tool is
   * installed or has usage.
   */
  experimental: boolean;
  /**
   * An optional, user-supplied API key would add something defensible to this
   * row (ADR-003 Amendment 8).
   *
   * TRUE FOR 'copilot' AND NOTHING ELSE. Amendment 6 rules a Gemini key out (an
   * API key exposes no quota and is a different pool from the Google-login CLI,
   * so the figure would be a false statement) and holds Kimi (an undocumented
   * endpoint, reached with a full spend key). A row with `keyCapable: false`
   * must offer no key affordance at all — the offer itself is a claim that a
   * key would help.
   *
   * Main always sends it, on every row, including the loading skeleton.
   */
  keyCapable: boolean;
  /** See `KeyState`. 'none' on every row that is not key-capable. */
  keyState: KeyState;
  /**
   * ISO instant the local copy of the key was stored, from the local record —
   * never from the provider. Null whenever no key is stored, and null while
   * `keyState` is 'unreadable' (the envelope may be the unreadable part).
   */
  keyStoredAt: string | null;
  /**
   * The figure the key buys, or null. Null covers every honest absence: no key,
   * a key that has not been read yet, a reply that could not be fully
   * validated, and a reading whose billing period has since ended.
   */
  creditUsage: CreditUsage | null;
  /**
   * The user has ADDED this provider to the main panel. Distinct from
   * `connected`: adding is the user's choice to see the row at all, connecting
   * is whether we have data for it. An added-but-unconnected provider shows in
   * the panel with its setup action; an un-added one appears ONLY in settings.
   * Defaults to true for `claude` and false for everything else.
   */
  enabled: boolean;
  connected: boolean;
  status: RowStatus;
  /**
   * The plan the user TOLD US they are on for this tool, e.g. "Max 20x", shown
   * beside the tool name. Null when they have not said — and null then renders
   * as NOTHING: no "bilinmiyor", no placeholder, no dash. An absent fact is
   * absent, not a labelled gap.
   *
   * IT IS NOT A READING, AND IT IS NEVER GUESSED. The plan appears nowhere in
   * anything this app reads: Claude Code's transcripts carry no plan,
   * subscription, tier or account field, and the one file that does carry a tier
   * is `~/.claude/.credentials.json`, which ADR-001 security F1 forbids opening
   * at all. Codex's rollout and Antigravity's payload each state a plan we
   * deliberately do NOT read, for the same reason. So there are two honest
   * options — the user tells us, or the row says nothing — and this field is the
   * first one. Its only source is app settings (`src/main/settings.js`
   * `planLabels`, validated by `src/core/plan-labels.js`). Inferring it from
   * usage volume would be a guess printed as a fact.
   *
   * IT MUST NEVER TOUCH A NUMBER. No quota, no denominator, no price, no cost,
   * no floor and no limit may read it — there is no `if (plan === 'Max 20x')`
   * anywhere and there must never be one. It is an unverified string a person
   * typed and never spell-checked; the moment a figure depends on it, that
   * string becomes an input to arithmetic we present as measured. ADR-001
   * rejected a token-derived percentage for want of a trustworthy denominator,
   * and a self-reported plan name is not one. Its whole life cycle is: settings
   * -> snapshot -> displayed.
   *
   * PER TOOL. One person is on Claude Max 20x and perhaps a Codex plan at the
   * same time, so every row carries its own, and a row with no stated plan shows
   * nothing while its neighbour shows one.
   *
   * UNTRUSTED TEXT. Trimmed, whitespace-collapsed and capped at 24 characters by
   * main before it reaches here, and sanitised again by the renderer on the way
   * to the DOM. Two checks on one value is not redundancy: one keeps the
   * settings file sane, the other keeps the DOM sane, and neither may assume the
   * other ran. The cap is a layout constraint as much as a safety one — the
   * label sits inline in a fixed-width row header.
   */
  planLabel: string | null;
  fiveHour: WindowUsage | null;
  sevenDay: WindowUsage | null;
  /** Absolute tokens inside the 5h window, from local transcripts. */
  tokens: TokenBreakdown | null;
  /**
   * Absolute tokens inside the WEEK, from local records — the row's headline
   * token figure, with `tokens` (5 hours) kept for the detail beside it.
   *
   * The window is EXACTLY the one `sevenDay` describes and `weeklyCost` is
   * priced over: `[sevenDay.resetsAt - 7d, resetsAt)` while that reset is still
   * ahead of us, a trailing 7 days otherwise (`WeeklyCost.windowAnchored` says
   * which, per provider). That identity is the point — the figure is read
   * beside the 7-day percentage, so a window even slightly different would be
   * a false pairing: "this many tokens against that much of your weekly quota"
   * would be describing two different weeks. Half-open on both ends, like every
   * other window here: a record on the reset instant belongs to the NEW week.
   *
   * `billable` (input + output + cacheWrite) deliberately EXCLUDES `cacheRead`,
   * which is ~98% of raw volume and bills at 0.1x; `cacheRead` is reported in
   * the same breakdown as its own number. A single merged "tokens used this
   * week" total is banned (ADR-001) and there is nowhere in this shape to put
   * one: token counts are NEVER summed across tools, so no row's figure may be
   * added to another's.
   *
   * NULL MEANS "WE HAVE NOT LOOKED", AND NOTHING ELSE — uniformly, on every
   * provider. It is present, POSSIBLY ALL-ZERO, whenever that provider's local
   * corpus was scanned; it is null only when there is no corpus at all
   * (Antigravity and every passive row) or the scan has not produced its first
   * result yet (`Snapshot.pendingUsage`).
   *
   * So a measured zero is present and reads as a measurement: a user who did not
   * touch a tool all week is told they used nothing, never that we could not
   * count. Treating an all-zero breakdown as absent is the bug this rule exists
   * to prevent — it misreports our own successful reading, which is the same
   * class of error as inventing a number, committed by the guard meant to stop
   * it. "Sayılamadı" belongs to exactly one state, and it is not this one:
   * `weeklyCost.sourceIncomplete` true WITH a zero count (ADR-002 A3.19).
   *
   * `tokens` (5 hours) does NOT follow this rule and was deliberately left as
   * shipped: on the local-log rows it nulls a zero window. So the two fields can
   * legitimately disagree — a row can carry `weeklyTokens` with `tokens: null`
   * (a quiet five hours inside a busy week). Do not infer either from the other.
   *
   * This is an absolute measurement and is never divided by anything: it feeds
   * no percentage and no meter (ADR-001 Decision 1).
   *
   * DO NOT expect it to equal the newest week in "Toplam Kullanım"
   * (`PeriodUsage.tokensByProvider`), and do not file that as a bug. They
   * measure different spans on purpose: this one is the QUOTA week — anchored
   * to the provider's own reset, or a trailing 7 days — while a history period
   * is a LOCAL CALENDAR week, Monday 00:00 to Monday 00:00, because that is how
   * the user reads "2–8 Eylül". A secondary, much smaller difference: this
   * figure counts `cacheWrite` as the record states it, while the history
   * figure is folded from the pricer's rows, which resolve writes as
   * `max(total, cw5 + cw1h)` — that differed on 3 of 20,674 reference records
   * and is invisible behind the window difference anyway.
   */
  weeklyTokens: TokenBreakdown | null;
  /**
   * Which window `weeklyTokens` covers: `true` anchored to this provider's own
   * weekly reset, `[resetsAt - 7d, resetsAt)`; `false` a trailing 7 days ending
   * now. Null exactly when `weeklyTokens` is null — with no figure there is no
   * window to describe.
   *
   * It exists because every figure on this row must name its OWN window. An
   * unlabelled number inherits its neighbour's label, and the neighbour here is
   * a FIVE-HOUR figure — so a bare "0 token" would read as "nothing in the last
   * five hours" in exactly the state where the user is already wondering whether
   * we read anything at all.
   *
   * READABLE WHEN `weeklyCost` IS NULL, which is the whole point. A quiet week —
   * or the first minutes after a weekly reset, when the anchored window opens at
   * roughly now — produces a present, all-zero `weeklyTokens` and NO cost block
   * at all, because nothing priced. `WeeklyCost.windowAnchored` says the same
   * thing about the same window and is the right field to read WHEN a cost block
   * exists, but it vanishes precisely when the label matters most. When both are
   * present they always agree: main derives them from one window object.
   *
   * TAKE THE LABEL FROM HERE, NEVER FROM `sevenDay.resetsAt`. Measured, not
   * assumed: `resetsAt != null` and `weeklyTokensWindowAnchored === true`
   * currently coincide on every reachable state, so the derivation would happen
   * to be right today. It is still wrong to write, for two reasons.
   *
   * First, the coincidence is not a contract. `sevenDay.resetsAt` is nulled when
   * its window has ROLLED OVER, and that is a rule about whether a PERCENTAGE may
   * be displayed (ADR-001 Amendment 2, state 3) — not a statement about the token
   * window. Main's decision not to anchor to a reset already behind us is a
   * separate rule with a separate reason (anchoring to a closed window would
   * exclude everything spent since). Two independent rules that agree today; if
   * either moves, or a provider path resolves one without the other, a derived
   * label silently inverts and nothing fails.
   *
   * Second, deriving a window from a reset instant is usage arithmetic in the
   * renderer, which this contract exists to prevent: main resolves windows, the
   * renderer renders them.
   *
   * Gemini CLI and Kimi Code are always `false` once scanned: neither publishes
   * a weekly reset to us, so their window can only ever be trailing.
   */
  weeklyTokensWindowAnchored: boolean | null;
  /**
   * WHY `weeklyTokens` is a LOWER BOUND — tokens missing from the COUNT — as
   * `HistoryFloorCause` codes in the order that type lists them. EMPTY ARRAY
   * means the count is exact; main always sends an array, never null.
   *
   * Causes and not a bare boolean, because ADR-002 A3.16 forbids showing a floor
   * without at least one visible cause, and this row cannot always borrow one
   * from its own cost block: a Gemini week where nothing could be priced is a
   * token floor while `weeklyCost.unrecordedCalls` is false. Same shape as
   * `PeriodUsage.tokenFloorCausesByProvider`, one level up.
   *
   * Resolved in main so that no surface carries the rule: the tray tooltip, a
   * second panel and any future reader get the same answer from the same field,
   * and a surface that forgets to ask cannot quietly print a floor as exact. The
   * rule is `src/core/history.js tokenFloorCauses()`, and the history side calls
   * the SAME function over its own window, so a row and its period can never
   * disagree about a tool.
   *
   * The codes this row can carry:
   *   'unread-range'       the reader KNOWS it could not read part of this window
   *                        (`weeklyCost.sourceIncomplete`, A3.15), so events are
   *                        missing from the count. TOKEN-side only — see
   *                        `HistoryFloorCause`.
   *   'unrecorded-calls'   Gemini CLI, unconditional while it has a count: its
   *                        utility calls and failed streams are NEVER recorded.
   *                        Do NOT derive this from `weeklyCost.unrecordedCalls`,
   *                        a COST cause that goes false when nothing priced.
   *   'unrecorded-writes'  Codex: a turn recorded 0 cache writes although it read
   *                        cache or sent a prompt at or above OpenAI's minimum
   *                        cacheable size, so `cacheWrite` and therefore
   *                        `billable` are understated (A3.3/A3.9). Decided from
   *                        the RECORD with no price lookup: whether a write price
   *                        exists decides what may be CHARGED for the missing
   *                        writes, not whether they are missing. Over-marking is
   *                        never false here.
   *
   * The purely MONETARY floor causes never appear, because each counts every
   * token it saw and differs only in what it may charge: an unpriced model, a
   * Codex tier assumed Standard or Fast-requested (A3.17-18), and Claude's
   * cache-write TTL fallback (which resolves writes as `max(total, cw5 + cw1h)`
   * and so cannot lose a write token). A row can therefore show an exact token
   * count beside a cost marked "en az".
   *
   * Always EMPTY when `weeklyTokens` is null, and also when the count is
   * entirely ZERO: with no amount there is nothing for "en az" to qualify. A
   * zero count whose `weeklyCost.sourceIncomplete` is true is the A3.19 "could
   * not be counted" state — read that from `sourceIncomplete`, not from here,
   * and never render it as "en az 0 token".
   */
  weeklyTokenFloorCauses: HistoryFloorCause[];
  /** Billable tokens per hour over the active window. */
  burnRatePerHour: number | null;
  /** Per-model split inside the window, largest first. */
  byModel?: Array<{ model: string; billable: number }>;
  /**
   * Per-model quota detail, when the provider publishes one figure per model.
   * Absent for every provider that does not. See `ModelQuotaDetail`.
   */
  modelQuotas?: ModelQuotaDetail | null;
  /** Notional weekly spend. null when the provider has no priced usage. */
  weeklyCost: WeeklyCost | null;
  setupAction: SetupAction | null;
  /** Machine-readable reason for status 'error'. Never free text from a file. */
  errorCode?: string;
  /**
   * ISO instant this row's values were last known-good. Added per frontend F1:
   * a row marked 'stale' must report ITS OWN age, not the snapshot-wide age,
   * otherwise a single failing provider claims it was updated "just now" while
   * five healthy ones refresh around it. Renderer falls back to
   * Snapshot.generatedAt when this is absent.
   */
  lastGoodAt?: string | null;
}

/**
 * Something the user should be told about the refresh they just asked for —
 * not about the data, about the attempt.
 *
 * `ANTIGRAVITY_NOT_RUNNING`: the Antigravity IDE process is not running, so
 * its state store cannot be updating. Without this the user presses Yenile,
 * sees the same "… önce güncellendi" as before, and has no way to know the
 * reason is on their side rather than ours.
 */
export type RefreshNotice = 'ANTIGRAVITY_NOT_RUNNING';

export interface Snapshot {
  /** ISO. Renderer derives staleness locally from this. */
  generatedAt: string;
  /**
   * ALL providers, IN USER ORDER — including un-added ones, because the
   * settings view needs the full list. Main applies the persisted order before
   * emitting; the renderer renders the array as given and never re-sorts.
   *
   * The main panel shows only entries with `enabled: true`. The tray icon is
   * driven by the FIRST ENABLED provider, not by `providers[0]` — an un-added
   * provider must never drive the icon, because the user cannot see the row it
   * comes from. When nothing is enabled the tray shows the no-data ring.
   */
  providers: ProviderSnapshot[];
  /**
   * Present ONLY on the snapshot returned from `requestRefresh()`, and never
   * on a pushed one.
   *
   * The distinction is the point: these describe one explicit user action, so
   * repeating them on every background push would turn a one-off answer into a
   * standing claim. Main builds this onto a copy of the snapshot for the
   * invoke reply; the object it pushes is untouched.
   */
  refreshNotices?: RefreshNotice[];
  /**
   * Week-by-week / month-by-month notional usage for the settings "Toplam
   * Kullanım" section. Optional and additive: an older main process omits it,
   * and the renderer simply shows the section's empty state. Present on both
   * pushed and refresh snapshots — unlike `refreshNotices`, it is a standing
   * fact about the local corpus, not a one-off answer to a user action.
   */
  usageHistory?: UsageHistory | null;
  /**
   * Tools whose LOCAL usage scan has not produced its first result yet
   * (ADR-002 A3.12). Always present; empty when nothing is pending.
   *
   * While a tool is listed, its absent figures mean "not read yet", never "no
   * usage": its `tokens` / `weeklyCost` are null because they are unknown, and
   * its contribution to `usageHistory` is missing, not zero. The renderer must
   * say so rather than show "no token data", hide the cost block silently, or
   * present a history that leaves the tool out as complete.
   *
   * Listed: 'codex' until its rollout scan worker's first result, and
   * 'gemini' / 'kimi' (ADR-003 A6) until their scan workers' first result —
   * but only while that tool is INSTALLED (its data directory exists); a tool
   * that is not on this machine is a passive "not installed" row and is never
   * pending. Claude is not listed —
   * before its first scan the collector sends `loadingSnapshot` (rows in
   * status 'loading', `usageHistory: null`), and on a warm start it shows the
   * persisted store, so it never presents unread data as absent. A worker
   * restart does not re-enter pending: the previous result stays valid.
   */
  pendingUsage: ProviderSnapshot['id'][];
}

/**
 * The tray icon is a donut chart of `providers[0].fiveHour`.
 *
 * ADR-001's honesty rule applies to the tray exactly as it applies to the
 * panel: when that window is null, or its `certainty` is 'unknown', or its
 * `usedPercentage` is null, the icon MUST render the no-data ring and MUST NOT
 * draw a sweep. An icon is a claim like any other. The panel already refuses to
 * draw a meter it cannot defend; a 16px circle is not exempt.
 */
export interface TrayIconSpec {
  /** 0-100, or null => draw the no-data ring, no sweep. */
  usedPercentage: number | null;
  /** Provider accent for the identity dot at the centre. */
  accent: string;
  /** Which state-ramp colour the sweep uses. Derived from the ROUNDED value,
   *  so the icon never contradicts the percentage the panel prints. */
  state: 'calm' | 'watch' | 'ember' | 'spent' | 'none';
}

/** IPC channel names. Renderer never fetches; main pushes. */
export const IPC = {
  /** main -> renderer, absolute snapshot (never deltas). */
  SNAPSHOT: 'usage:snapshot',
  /** renderer -> main, hint that the panel opened. */
  PANEL_OPENED: 'usage:panel-opened',
  /** renderer -> main invoke, returns updated Snapshot. */
  REQUEST_REFRESH: 'usage:request-refresh',
  /** renderer -> main invoke(providerId), runs SetupAction. Returns
   *  { ok: boolean; message: string }. Must ask for confirmation in main
   *  before writing to any file outside the app's own userData. */
  RUN_SETUP: 'provider:run-setup',
  /** renderer -> main, close/pin controls. */
  PANEL_CLOSE: 'panel:close',
  PANEL_PIN: 'panel:pin',
  /** main -> renderer, tray anchor geometry. Re-sent on every open. */
  ANCHOR: 'panel:anchor',
  /**
   * main -> renderer, boolean: the panel was revealed (true) or concealed
   * (false).
   *
   * Drives the CONTENT open/close animation — the `.anchor` transform/opacity
   * INSIDE the fixed, always-composited window — so it replays on every open,
   * not just at app start. It NEVER animates the OS window: main still moves
   * that on/off screen instantly (panel-window.js `_reveal`/`_conceal`).
   *
   * `false` is sent while the window is OFF-SCREEN, so the closed visual state
   * (scaleY .96, opacity 0) is set invisibly, and the next reveal has a clean
   * false->true transition to grow in — no flash of the final state.
   */
  PANEL_VISIBILITY: 'panel:visibility',
  /**
   * renderer -> main invoke(ids: string[]). Persists the user's provider
   * order. Main re-emits an ordered Snapshot and re-renders the tray icon.
   * Returns { ok: boolean }.
   */
  SET_ORDER: 'providers:set-order',
  /**
   * renderer -> main invoke(id, enabled). Adds a provider to the main panel or
   * removes it. Returns { ok: boolean }; on false nothing changed anywhere and
   * the renderer must revert its toggle.
   */
  SET_ENABLED: 'providers:set-enabled',
  /** main -> renderer, user preferences. Pushed on change and at startup. */
  PREFERENCES: 'prefs:changed',
  /**
   * renderer -> main invoke(theme). Persists the theme choice.
   * Returns { ok: boolean }; on false nothing changed and the renderer reverts.
   */
  SET_THEME: 'prefs:set-theme',
  /**
   * renderer -> main invoke(language). Persists, then main re-resolves, rebuilds
   * the tray tooltip and menu, re-publishes the snapshot (so setup text is
   * re-translated) and pushes PREFERENCES. NOT optimistic: the renderer applies
   * the new language only when the push arrives. Returns { ok: boolean }.
   */
  SET_LANGUAGE: 'prefs:set-language',
  /**
   * renderer -> main invoke(enabled). Persists "start with Windows", then main
   * updates the Windows login item, rebuilds the tray menu (its checkbox shows
   * the same value) and pushes PREFERENCES. `enabled` must be a real boolean;
   * anything else is refused, not coerced. Returns { ok: boolean }; on false
   * nothing changed and the renderer reverts its switch.
   */
  SET_AUTOSTART: 'prefs:set-autostart',
  SET_PLAN_LABEL: 'prefs:set-plan-label',
  /**
   * renderer -> main invoke(providerId). Asks main to START the optional-key
   * flow for a key-capable provider: one short-lived window of its own that
   * shows the consent screen first and the entry form only after Continue
   * (ADR-003 Amendment 5 K1/K2, Amendment 9). Returns `{ok}`, which says
   * whether the window opened and never anything about a key.
   *
   * `{ok:true}` means the window opened. Declining happens inside it and is
   * not reported back. `{ok:false}` answers a second call while a window is
   * open, a provider that is not key-capable, and unavailable secure storage.
   * One flow at a time: fifty calls in one tick open exactly one window.
   */
  KEY_ENTRY: 'keys:request-entry',
  /**
   * renderer -> main invoke(providerId). Deletes the LOCAL copy of the key,
   * cancels its timers, aborts anything in flight, closes the keyed session's
   * connections and drops the cached figure (K20). Returns `{ok}`.
   *
   * It is NOT revocation: only the user can revoke a token at the vendor, and
   * the copy is all this app can remove. The copy says so.
   */
  KEY_REMOVE: 'keys:remove',
  /**
   * renderer -> main invoke(providerId). Opens the provider's token-creation
   * page in the DEFAULT BROWSER, for the 'key-rejected' /
   * 'key-lacks-permission' states where a new key is the fix. Returns `{ok}`.
   *
   * The argument only SELECTS a hard-coded branch; main holds the URL as a
   * literal and no argument, provider reply or stored value ever reaches it. A
   * call naming a provider that is not key-capable is refused.
   */
  KEY_TOKEN_PAGE: 'keys:open-token-page',
  /**
   * renderer -> main invoke(providerId). "Refresh now": asks main to read the
   * credit figure early. Main's schedule still decides; it refuses within a
   * minute of the last request, after a 401, and during a backoff or a
   * Retry-After wait. Returns `{ok}`, and the figure arrives in the snapshot.
   */
  KEY_REFRESH: 'keys:refresh',
} as const;

/**
 * The key-entry window's OWN channels. Not part of `UsageNotchApi`: they are
 * exposed by a different preload, to a different window, on its own session
 * (ADR-003 Amendment 8).
 *
 * `usageNotchKeyEntry` exposes exactly five methods and NO GETTER (K3):
 *
 *   entryInfo(): { provider, language, formatLocale? } | null   (synchronous)
 *   consent(): Promise<{ ok, code? }>                           (no argument)
 *   submit(key, username): Promise<{ ok, code? }>
 *   cancel(): void
 *   openTokenPage(): Promise<{ ok }>                            (no argument)
 *
 * `submit` is Amendment 8's `submit(key)` with the username as a second
 * argument: the page collects both, main validates both, and one call carrying
 * the pair means main never holds half of it. Main accepts it only from the
 * entry window's main frame, against a one-shot pending entry that `consent()`
 * creates, with the provider fixed and a five-minute expiry (K4). The window
 * itself shows the consent text first (Amendment 9). There is no native box.
 *
 * `code` is from a closed set, chosen so a message can never carry a value:
 * 'wrong-token-type' (another GitHub credential: ghp_/gho_/ghu_/ghs_/ghr_),
 * 'wrong-provider' (another vendor's key), 'invalid', 'invalid-username',
 * 'secure-storage-unavailable', 'busy', 'no-entry', 'expired', 'rejected',
 * 'store-failed'.
 */
export const IPC_KEY_ENTRY = {
  CONSENT: 'keys:consent',
  SUBMIT: 'keys:submit',
  CANCEL: 'keys:cancel',
  ENTRY_INFO: 'keys:entry-info',
  ENTRY_TOKEN_PAGE: 'keys:entry-token-page',
} as const;

/**
 * 'system' follows the OS setting via `prefers-color-scheme` and must keep
 * following it while chosen — it is a live binding, not a one-time read.
 */
export type ThemeChoice = 'dark' | 'light' | 'system';

/** ADR-004. 'system' resolves in MAIN from the OS display language. */
export type LanguageChoice = 'tr' | 'en' | 'system';

export interface Preferences {
  theme: ThemeChoice;
  /** What the user chose. */
  language: LanguageChoice;
  /**
   * What main resolved it to. Main is the only place this is decided, because
   * main also writes user-facing text (tray tooltip, menu, dialogs, setup
   * labels carried in the snapshot) — two resolvers could disagree, and the
   * tooltip would then speak a different language from the panel.
   */
  resolvedLanguage: 'tr' | 'en';
  /**
   * BCP 47 locale for numbers, currency, percent, dates and clocks. tr -> tr-TR.
   * en -> the OS region when the OS locale is en-* (en-GB, en-AU, ...),
   * otherwise en-US. Resolved in main for the same reason as resolvedLanguage.
   */
  formatLocale: string;
  /**
   * "Start with Windows": whether Windows starts the app in the tray at sign-in.
   * The same `settings.autostart` the tray menu's checkbox reads, so the
   * settings screen and the menu are two views of one value. Re-sanitised on
   * the way out of main; anything that is not a boolean reaches the renderer as
   * the default, `true`.
   */
  autostart: boolean;
}

/**
 * Tray anchor geometry. Main measures this fresh on every open and pushes it;
 * the renderer does all arrow/offset math in the DOM because the OS window is
 * created once and never moved or resized during animation.
 * `scaleFactor` is that of the display CONTAINING THE TRAY ICON, not the
 * primary display — mixed-DPI setups are exactly where this breaks.
 */
export interface AnchorPayload {
  /**
   * The rect the panel points at. ALWAYS present — main synthesises a small
   * rect at its fallback anchor point rather than sending null, so the renderer
   * never has to discard an otherwise-valid payload (which previously threw
   * away `edge` and `mode` too, leaving the pin control lying about its state).
   */
  tray: { x: number; y: number; width: number; height: number };
  /**
   * Where `tray` came from. 'cursor' means the real tray rect was unavailable
   * or implausible — most commonly because Windows 11 put the icon in the
   * hidden-icons overflow flyout, where it reports a zero-size rect. This is a
   * COMMON path, not an edge case. The renderer must render the tail dimmed
   * when this is 'cursor', because it is no longer pointing at a known icon.
   */
  anchorSource: 'tray' | 'cursor';
  display: {
    id: number;
    scaleFactor: number;
    bounds: { x: number; y: number; width: number; height: number };
    workArea: { x: number; y: number; width: number; height: number };
  };
  window: { x: number; y: number; width: number; height: number };
  /** Which screen edge the taskbar sits on. */
  edge: 'bottom' | 'top' | 'left' | 'right';
  /**
   * How the panel is currently held open.
   *
   * 'pin'   — the user pinned it. It stays regardless of focus: clicking away,
   *           switching apps, or working elsewhere on the desktop must NOT
   *           dismiss it. Only an explicit close or unpin ends it.
   * 'hover' — opened by a tray click but not pinned. It survives only while
   *           the pointer is over the panel, and closes quickly once the
   *           pointer leaves.
   *
   * Note this INVERTS the original behaviour, where `pinned` armed a
   * hide-on-blur. That implemented "click outside dismisses a popover"; the
   * product wants "pin means keep it on screen". The tray icon no longer opens
   * the panel on hover at all — hover shows the tooltip only.
   */
  mode: 'hover' | 'pin';
}

/**
 * The exact surface `preload.ts` must expose via contextBridge, as
 * `window.usageNotch`. Orchestrator-owned: the renderer codes against these
 * names and the main process must match them exactly. No generic
 * `invoke(channel, args)` passthrough is permitted (security F8).
 */
export interface UsageNotchApi {
  /**
   * Last snapshot main already holds, returned SYNCHRONOUSLY so the panel can
   * paint real data in frame one. Null only before the very first scan.
   */
  initialSnapshot(): Snapshot | null;
  /** Subscribe to pushed snapshots. Returns an unsubscribe function. */
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  /** Subscribe to tray anchor geometry. Returns an unsubscribe function. */
  onAnchor(cb: (a: AnchorPayload) => void): () => void;
  /**
   * Subscribe to panel reveal (true) / conceal (false) from main. The renderer
   * drives its CONTENT open animation off this so it replays on every open, not
   * only at app start. Returns an unsubscribe function.
   */
  onPanelVisibility(cb: (open: boolean) => void): () => void;
  /** Ask main to refresh now. */
  requestRefresh(): Promise<Snapshot>;
  /**
   * Run a provider's SetupAction. `confirmed` must be true for any action that
   * writes outside the app's own userData (e.g. installing the statusline
   * bridge into the user's Claude Code settings).
   */
  runSetup(providerId: string, confirmed: boolean): Promise<{ ok: boolean; message: string }>;
  /**
   * Persist the user's provider order (drag-and-drop). Main writes settings
   * first and applies nothing if the write fails, so `{ok:false}` means the
   * order changed NOWHERE — the renderer must revert the dragged rows.
   */
  setOrder(ids: string[]): Promise<{ ok: boolean }>;
  /** Add a provider to the main panel, or remove it. See IPC.SET_ENABLED. */
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean }>;
  /** Preferences main already holds, returned synchronously for frame one —
   *  a theme applied after first paint is a visible flash of the wrong one. */
  initialPreferences(): Preferences | null;
  /** Subscribe to preference pushes. Returns an unsubscribe function. */
  onPreferences(cb: (p: Preferences) => void): () => void;
  /** Persist the theme choice. See IPC.SET_THEME. */
  setTheme(theme: ThemeChoice): Promise<{ ok: boolean }>;
  /** Persist the language choice. See IPC.SET_LANGUAGE. */
  setLanguage(language: LanguageChoice): Promise<{ ok: boolean }>;
  /** Persist "start with Windows". See IPC.SET_AUTOSTART. */
  setAutostart(enabled: boolean): Promise<{ ok: boolean }>;
  /**
   * Persist the plan the user says they are on for ONE tool, or clear it. See
   * IPC.SET_PLAN_LABEL and `ProviderSnapshot.planLabel`.
   *
   * `label` is free text — the control offers known plans through a `datalist`
   * but accepts anything typed — so main validates rather than trusting it: a
   * known provider id, a plain string, trimmed, whitespace-collapsed and capped
   * at 24 characters. An empty or blank label means CLEAR, which removes the
   * setting rather than storing `''`; the row then shows nothing at all.
   *
   * NOT OPTIMISTIC. `{ ok: false }` means main wrote NOTHING — a bad id, a
   * non-string, or a settings file that could not be persisted — and the
   * renderer must revert the control to the value it had. Persist first, apply
   * second: a label that only lives in the DOM is a setting the user will lose
   * without being told. `{ ok: true }` is followed by a snapshot carrying the
   * new `planLabel`, which is what the row renders from.
   */
  setPlanLabel(providerId: string, label: string): Promise<{ ok: boolean }>;
  /**
   * Start the optional-key flow for a key-capable provider. See IPC.KEY_ENTRY.
   *
   * Write-only, like every key channel: the answer is whether main accepted the
   * request. There is NO method on this interface that returns a key, a masked
   * key or its length, and there never may be (K3).
   */
  requestKeyEntry(providerId: string): Promise<{ ok: boolean }>;
  /** Delete the local copy of a provider's key. See IPC.KEY_REMOVE. */
  removeKey(providerId: string): Promise<{ ok: boolean }>;
  /** Open the provider's token page in the default browser. See IPC.KEY_TOKEN_PAGE. */
  openTokenPage(providerId: string): Promise<{ ok: boolean }>;
  /** Read the credit figure early, if the schedule allows. See IPC.KEY_REFRESH. */
  refreshKey(providerId: string): Promise<{ ok: boolean }>;
  /** Tell main the panel opened, so it can raise its refresh cadence. */
  panelOpened(): void;
  close(): void;
  pin(): void;
}

declare global {
  interface Window { usageNotch?: UsageNotchApi }
}

/**
 * Push cadence main guarantees, so the renderer can size its staleness
 * thresholds against a real number instead of guessing (frontend risk note).
 */
export const CADENCE = {
  /** Max gap between pushes while the panel is open. */
  OPEN_MS: 15_000,
  /** Max gap while the panel is closed. */
  IDLE_MS: 60_000,
  /** Renderer marks a row stale past this age. */
  STALE_AFTER_MS: 180_000,
} as const;
