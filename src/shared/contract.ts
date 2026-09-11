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
  | 'antigravity.ide.quota_info.remaining_fraction';

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

export interface ModelCost {
  /** Raw id as recorded, e.g. "claude-haiku-4-5-20251001". */
  model: string;
  /**
   * The speed this group was billed at ('standard' | 'fast' | ...). Present
   * because a model can be priced at one speed and unpriced at another, so
   * naming only the model would put a row in `unpricedModels` while an
   * identically-named priced row sits beside it.
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
  /** ISO date the price table was current. Prices drift; say when. */
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
  windowStart: string;
  windowEnd: string;
  /** true when anchored to sevenDay.resetsAt; false for a trailing 7 days. */
  windowAnchored: boolean;
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
   * true when `costUsd` is a LOWER BOUND: unpriced models were excluded, or a
   * cache-write TTL split was missing and priced at the 1.25x floor. Every such
   * cause can only push the true figure up, so the renderer prints "en az".
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
 * Week-by-week and month-by-month notional usage, for the settings "Toplam
 * Kullanım" section. Derived from LOCAL transcripts, which today means Claude
 * Code — the only provider with a local corpus (README). Both lists are
 * contiguous and NEWEST FIRST, and include honest empty periods between the
 * first observed usage and now. Main computes every figure; the renderer only
 * renders (contract rule: no renderer arithmetic on usage).
 */
export interface UsageHistory {
  /** ISO-week-aligned (Mon–Sun) buckets, newest first. */
  weeks: PeriodUsage[];
  /** Calendar-month buckets, newest first. */
  months: PeriodUsage[];
  /** ISO date the price table was current (see `WeeklyCost.pricesAsOf`). */
  pricesAsOf: string;
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

export interface ProviderSnapshot {
  id: 'claude' | 'codex' | 'gemini' | 'copilot' | 'antigravity' | 'kimi';
  displayName: string;
  /** Brand hex, used ONLY for the 2px spine + monogram tile. Never the meter. */
  accent: string;
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
  /** e.g. "Max 20x", or null when not known. Never guessed. */
  planLabel: string | null;
  fiveHour: WindowUsage | null;
  sevenDay: WindowUsage | null;
  /** Absolute tokens inside the 5h window, from local transcripts. */
  tokens: TokenBreakdown | null;
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
} as const;

/**
 * 'system' follows the OS setting via `prefers-color-scheme` and must keep
 * following it while chosen — it is a live binding, not a one-time read.
 */
export type ThemeChoice = 'dark' | 'light' | 'system';

export interface Preferences {
  theme: ThemeChoice;
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
