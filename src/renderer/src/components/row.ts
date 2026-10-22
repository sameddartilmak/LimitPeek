/**
 * A provider card. Five states, one geometry.
 *
 *   loading  skeleton drawn in the FINAL geometry, so nothing reflows
 *   ok       name, plan, the two window columns (or the tool's main measure)
 *   stale    last good value kept, neutral ink, hatched bar, a "Güncel değil" chip
 *   error    last good value kept, desaturated, the error and retry in the card
 *   passive  compact, no meter at all, and the action button is the brightest ink
 *
 * THE CLOSED CARD ANSWERS ONE QUESTION (UI plan 2026-09-29)
 * ---------------------------------------------------------
 * "How close am I to my limit?" — so a closed card is: the mark, the name with
 * its plan / experimental / status chips, and the two quota windows side by
 * side, each with its figure, its 8px bar and its reset countdown. Tokens, the
 * burn rate, the per-model split and the notional cost used to share the card
 * with the limits and competed with them for the eye; they now live behind
 * "Ayrıntılar", in that order, followed by where the figures came from. Only
 * one card's details are open at a time (the panel enforces it).
 *
 * A tool that publishes NO quota (Kimi, Qwen Code, Grok Build) gets no empty
 * rail pretending to be one. Its closed card shows the most trustworthy thing
 * we have instead: the week's token count, else the cost the tool itself
 * reported, else the reason there is nothing — stated, never a blank.
 *
 * IDENTITY vs. STATE
 * ------------------
 * The card's mark (components/logo.ts) doubles as the drag grip. A CONNECTED
 * provider draws its brand art in colour; every other one the same art in grey.
 * Brand colour stays in the mark: meters, percentages and actions never take it,
 * because those are the marks compared ACROSS cards.
 *
 * A STALE CAPTURE (ADR-001 amendment 2) — a figure can be old and still TRUE,
 * because the window it describes has not rolled over. Such a card keeps its
 * figures and bars, says "Güncel değil · 22 dk" in its title line, prints its
 * figures in neutral ink over a hatched, faded bar, and never shows a figure
 * without the instant it was measured (under each window). Colour is never the
 * only carrier: the chip's words and the hatch say it too.
 */

import type { ProviderSnapshot, WindowUsage } from '../../../shared/contract.js';
import { el, on, replaceChildrenWith, setAttr, setText, svg } from '../dom.js';
import {
  ago,
  agoSpoken,
  burnRate,
  clockTime,
  compact,
  countdown,
  mixWithin,
  parseInstant,
  sinceCapture,
  tokens,
  usd,
} from '../format.js';
import { t } from '../i18n.js';
import { allZero, hasTokenCount } from '../tokens.js';
import { createCost, type CostHandle } from './cost.js';
import { experimentalTag } from './experimental.js';
import { createQuotas, type QuotaHandle } from './quotas.js';
import { gripDots, providerMark } from './logo.js';
import { absenceFigure, createMeter, isDrawable, meterStateStep, percentLabel, type MeterHandle } from './meter.js';

/** The id of the hidden paragraph in the panel that explains how to reorder. */
export const REORDER_HELP_ID = 'reorder-help';

export interface RowContext {
  onRetry(providerId: string): void;
  onSetup(providerId: string): void;
  isBusy(providerId: string): boolean;
  /**
   * Wire this row's grip to the reorder controller. Called on every update so
   * the controller always holds the current display name for its
   * announcements; it de-duplicates its own listeners.
   */
  attachGrip(grip: HTMLElement, providerId: string, displayName: string): void;
  /**
   * True for the row at index 0. That row's five-hour window is what main
   * draws the tray icon from, so the row says so instead of leaving the user
   * to infer it.
   */
  isTrayRow(providerId: string): boolean;
  /**
   * True while this tool's local usage scan has not produced its first result
   * (Snapshot.pendingUsage, ADR-002 A3.12). Its tokens and cost are then
   * MISSING, not absent: the row says "calculating", never "no token data".
   */
  isPending(providerId: string): boolean;
  /** Is this card's "Ayrıntılar" the open one? Optional: absent means closed. */
  isExpanded?(providerId: string): boolean;
  /** The user pressed this card's "Ayrıntılar". The panel keeps one open. */
  onToggleExpand?(providerId: string): void;
  /**
   * Can this card be dragged and moved with Alt+Arrow? Optional: absent
   * means yes. False in "Halka kutuları", which follows the stored order but
   * only the short list rearranges it: the mark stays as the tool's logo, and
   * stops being a control.
   */
  canReorder?(providerId: string): boolean;
  /**
   * Does a click anywhere on this card open its details? Optional: absent
   * means no ("Ayrıntılar" is then its own button). True for every closed
   * line and tile, where the whole card is the way in; the "Ayrıntılar"
   * button stays the keyboard's way in (Enter / Space). Every closed card also
   * carries its hover line (`data-tip`, see rowTip).
   */
  opensOnCard?(providerId: string): boolean;
  /** Snapshot.generatedAt, used for the "as of" line on stale rows. */
  generatedAt: string | null;
  /**
   * Set when the renderer has independently decided the snapshot is too old to
   * present at full confidence. A main process that stops pushing keeps saying
   * `ok` forever, so this is derived locally from generatedAt, not trusted.
   */
  staleOverride: boolean;
}

/** The status the row actually draws, after the local staleness check. */
function effectiveStatus(p: ProviderSnapshot, ctx: RowContext): ProviderSnapshot['status'] {
  return ctx.staleOverride && p.status === 'ok' ? 'stale' : p.status;
}

/**
 * ADR-001 amendment 2: a stale capture keeps `certainty:'known'` only while
 * the window it describes has not rolled over. Backend drops it to 'unknown'
 * once `resetsAt` passes — but the renderer ticks at 1Hz and main is only
 * obliged to push every 15s while open, so for up to fifteen seconds the panel
 * would keep drawing a meter for a window that no longer exists. We cross that
 * boundary locally, on the tick, rather than waiting to be told.
 */
export function captureExpired(usage: WindowUsage | null | undefined, now: number): boolean {
  if (!usage || !usage.capturedAt) return false;
  const resetsAt = parseInstant(usage.resetsAt);
  return resetsAt !== null && now >= resetsAt;
}

function expireWindow(usage: WindowUsage | null, now: number): WindowUsage | null {
  if (!usage || !captureExpired(usage, now)) return usage;
  return {
    ...usage,
    usedPercentage: null,
    certainty: 'unknown',
    // The renderer just crossed this boundary itself, ahead of main, so it
    // states the reason itself too. Without this the block would fall back to
    // "bilinmiyor" for up to fifteen seconds and then flip to "yenileniyor"
    // when main's next push arrived — one fact, two words, in sequence, on the
    // same line. `source` and `provenance` go with the figure they described.
    absence: 'rolled-over',
    source: null,
    provenance: null,
    billableSinceCapture: null,
  };
}

export interface RowHandle {
  el: HTMLLIElement;
  readonly id: string;
  update(provider: ProviderSnapshot, ctx: RowContext, now: number): void;
  tick(now: number): void;
  /** The "Ayrıntılar" control, so the panel can move focus onto it. */
  readonly moreButton: HTMLButtonElement;
}

interface Refs {
  grip: HTMLButtonElement;
  cost: CostHandle;
  quotas: QuotaHandle;
  name: HTMLElement | null;
  plan: HTMLElement | null;
  meter: MeterHandle | null;
  metaTokens: HTMLElement | null;
  metaBurn: HTMLElement | null;
  staleAge: HTMLElement | null;
  staleChip: HTMLElement | null;
  delta: HTMLElement | null;
  action: HTMLButtonElement | null;
  retry: HTMLButtonElement | null;
  primary: HTMLElement | null;
}

const EMPTY_REFS: Refs = {
  grip: null as unknown as HTMLButtonElement,
  cost: null as unknown as CostHandle,
  quotas: null as unknown as QuotaHandle,
  name: null,
  plan: null,
  meter: null,
  metaTokens: null,
  metaBurn: null,
  staleAge: null,
  staleChip: null,
  delta: null,
  action: null,
  retry: null,
  primary: null,
};

/**
 * The window this row actually draws: the five-hour one when it is drawable,
 * otherwise the weekly one. shapeKeyOf() and buildLive() MUST agree on this —
 * when they did not, an expired 5h window made the key describe a different
 * window than the one whose delta was rendered.
 */
function primaryWindow(p: ProviderSnapshot): WindowUsage | null {
  return isDrawable(p.fiveHour) ? p.fiveHour : p.sevenDay;
}

/**
 * Does this tool publish a quota at all? Claude Code, Codex and Antigravity
 * send window objects (even when a figure is unknown for now); Kimi, Qwen Code
 * and Grok Build send none. The first kind gets the two window columns, the
 * second its main measure — never an empty rail pretending to be a limit.
 */
function publishesQuota(p: ProviderSnapshot): boolean {
  return p.fiveHour != null || p.sevenDay != null;
}

/** Structural identity. When this changes the row is rebuilt; when it does not
 *  the row is updated in place, which is what keeps the meter transition. */
function shapeKeyOf(p: ProviderSnapshot): string {
  const c5 = p.fiveHour?.certainty ?? 'none';
  const c7 = p.sevenDay?.certainty ?? 'none';
  const primary = primaryWindow(p);
  return [
    p.status,
    c5,
    c7,
    // Each window owns a block, and a block's countdown line exists only when
    // that window states a reset instant. Presence is therefore structure, and
    // the value is not: the countdown itself is repainted on the 1Hz tick.
    p.fiveHour?.resetsAt ? 'r5' : 'no-r5',
    p.sevenDay?.resetsAt ? 'r7' : 'no-r7',
    p.setupAction ? p.setupAction.kind : 'no-setup',
    // Where the plan came from decides the spoken prefix, so it is structure.
    p.planLabel ? `plan-${p.planSource ?? 'user'}` : 'no-plan',
    // WHICH window the token item describes is structure, not content: the
    // weekly and the five-hour figure are different claims, and a row that
    // silently swapped one for the other in place would relabel a number
    // without redrawing the line that names its window.
    tokenItemKind(p),
    p.burnRatePerHour !== null ? 'burn' : 'no-burn',
    primary?.capturedAt ? 'cap' : 'no-cap',
    // Presence only. The VALUE must not be part of the key, or every new
    // measurement would rebuild the row and kill the meter transition; it is
    // refreshed in the in-place branch instead.
    (primary?.billableSinceCapture ?? 0) > 0 ? 'delta' : 'no-delta',
    // The five-hour label carries "· seçili model" only when a selection
    // exists. The suffix is set at meter construction (createBlock), so its
    // presence is STRUCTURE and must rebuild the meter when it flips.
    p.modelQuotas?.selectedModel ? 'sel' : 'no-sel',
    // The main measure of a tool without a quota: which kind it is.
    publishesQuota(p) ? 'quota' : `measure-${measureKind(p)}`,
    (p.byModel ?? []).length > 0 ? 'models' : 'no-models',
  ].join('|');
}

/**
 * THE TOKEN FIGURE ON THIS LINE IS THE WEEK'S, AND IT SAYS SO.
 *
 * The line names its window because the burn rate beside it is genuinely a
 * FIVE-HOUR figure (src/core/snapshot.js), and two figures describing two
 * windows, one labelled and one not, is the misreading this avoids.
 *
 * Which weekly window it is comes from `weeklyTokensWindowAnchored` — the row's
 * OWN field, about this figure's window — and never from `sevenDay.resetsAt` or
 * from `weeklyCost.windowAnchored`: deriving a window from a reset instant is
 * usage arithmetic, and the two rules only agree by coincidence today.
 *
 * `null` means unscanned, so there is no window to name and the label states the
 * SPAN only ("Haftalık" / "Weekly"). Kimi Code, Qwen Code and Grok Build are
 * always false once scanned — none publishes a weekly reset to us — so none can
 * ever be labelled a quota week.
 */
function weeklyTokenLabel(p: ProviderSnapshot, value: string): string {
  const anchored = p.weeklyTokensWindowAnchored;
  if (anchored === null || anchored === undefined) return t('row.tokens.weekly', { value });
  return anchored ? t('row.tokens.quotaWeek', { value }) : t('row.tokens.last7', { value });
}

/** The same window, named on its own, for the main measure's caption. */
function weeklyWindowName(p: ProviderSnapshot): string {
  const anchored = p.weeklyTokensWindowAnchored;
  if (anchored === null || anchored === undefined) return t('row.measure.weekly');
  return anchored ? t('row.measure.quotaWeek') : t('row.measure.last7');
}

/**
 * What the line prints for the week: the count and its window, nothing else.
 * No "en az" and no cause in brackets, even when main marks the count as a
 * lower bound (the owner ruled the floor marker out, 2026-09-23).
 */
function weeklyTokenText(p: ProviderSnapshot): string {
  const tk = p.weeklyTokens;
  if (!tk) return '';
  // ADR-002 A3.19, and the ONLY state that reads "could not be counted": the
  // reader KNOWS it could not read this window. Recognised by
  // `sourceIncomplete` WITH a zero count — never by the zero alone.
  if (allZero(tk) && p.weeklyCost?.sourceIncomplete) return t('row.tokens.uncounted');
  // A MEASURED ZERO PRINTS AS ZERO: our reading succeeded and its answer was zero.
  return weeklyTokenLabel(p, tokens(tk.billable));
}

/**
 * Which window this line's token figure describes: 'weekly' whenever main sent
 * a weekly count at all; 'fiveHour' is the compatibility path for a main that
 * predates `weeklyTokens` — shown AS a five-hour count, never relabelled.
 */
function tokenItemKind(p: ProviderSnapshot): 'weekly' | 'fiveHour' | 'none' {
  if (p.weeklyTokens) return 'weekly';
  if (p.tokens) return 'fiveHour';
  return 'none';
}

function tokenItemText(p: ProviderSnapshot): string {
  if (tokenItemKind(p) === 'weekly') return weeklyTokenText(p);
  const tk = p.tokens;
  return tk ? t('row.tokens.fiveHour', { value: tokens(tk.billable) }) : '';
}

/** The four classes of one breakdown, in one line. */
function classes(tk: NonNullable<ProviderSnapshot['weeklyTokens']>): string {
  return [
    t('row.tokens.input', { value: compact(tk.input) }),
    t('row.tokens.output', { value: compact(tk.output) }),
    t('row.tokens.cacheWrite', { value: compact(tk.cacheWrite) }),
    t('row.tokens.cacheRead', { value: compact(tk.cacheRead) }),
  ].join(' · ');
}

/**
 * Both windows' breakdowns, each named, one per line. `weeklyTokens` and
 * `tokens` are both a `TokenBreakdown` and become indistinguishable the moment
 * they are formatted, so each line says which window it is.
 */
function tokensTitle(p: ProviderSnapshot): string {
  return tokenClassLines(p).join('\n');
}

function tokenClassLines(p: ProviderSnapshot): string[] {
  const lines: string[] = [];
  // `hasTokenCount` decides only whether a breakdown has anything to say; it
  // never decides whether a figure prints (that is null vs non-null).
  const week = p.weeklyTokens;
  const five = p.tokens;
  if (week && hasTokenCount(week)) lines.push(`${t('meter.window7d.label')} — ${classes(week)}`);
  if (five && hasTokenCount(five)) lines.push(`${t('meter.window5h.label')} — ${classes(five)}`);
  return lines;
}

/**
 * The per-model split behind the burn rate. It is the FIVE-HOUR split, so it is
 * named as one rather than left to sit under a line whose other figure is weekly.
 */
function modelsTitle(p: ProviderSnapshot): string {
  const list = p.byModel ?? [];
  if (list.length === 0) return '';
  const split = list.map((entry) => `${entry.model}: ${compact(entry.billable)}`).join(' · ');
  return `${t('meter.window5h.label')} — ${split}`;
}

function errorText(code: string | undefined): string {
  switch (code) {
    case 'bridge-missing':
      return t('row.error.bridgeMissing');
    case 'permission-denied':
      return t('row.error.permissionDenied');
    case 'parse-failed':
      return t('row.error.parseFailed');
    case 'timeout':
      return t('row.error.timeout');
    default:
      return t('row.error.generic');
  }
}

/** "22 dk" / "3 sa" / "2 gün": an age with no "önce", for the stale chip. */
function shortAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t('dur.lessMinute');
  if (minutes < 60) return t('dur.minutes', { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('dur.hours', { h: hours });
  return t('dur.days', { d: Math.floor(hours / 24) });
}

/**
 * The instant a stale card's figures were true: the primary window's capture,
 * else the row's last good read, else the snapshot. Null when none is known.
 */
function staleSince(p: ProviderSnapshot, ctx: RowContext): number | null {
  return (
    parseInstant(primaryWindow(p)?.capturedAt ?? null) ??
    parseInstant(p.lastGoodAt ?? null) ??
    parseInstant(ctx.generatedAt)
  );
}

// ------------------------------------------------------------- main measure

type MeasureKind = 'pending' | 'tokens' | 'cost' | 'absent' | 'uncounted' | 'none';

/**
 * The closed card's main figure for a tool with no quota, in the plan's order:
 * the week's tokens; else the cost the tool reported; else the stated reason.
 * Pending comes first: until the first scan answers, any figure would present a
 * partial read as complete.
 */
function measureKind(p: ProviderSnapshot, pending = false): MeasureKind {
  if (pending) return 'pending';
  const week = p.weeklyTokens;
  if (week) {
    if (allZero(week) && p.weeklyCost?.sourceIncomplete) return 'uncounted';
    return 'tokens';
  }
  if (p.tokens) return 'tokens';
  if (p.weeklyCost && p.weeklyCost.totalUsd > 0) return 'cost';
  if (p.usageLogAbsent === true) return 'absent';
  if (p.weeklyCost?.sourceIncomplete) return 'uncounted';
  return 'none';
}

interface MeasureCopy {
  kind: MeasureKind;
  value: string;
  caption: string;
  title: string;
}

/** The main measure's words, apart from its element: the hover line reads them too. */
function measureCopy(p: ProviderSnapshot, pending: boolean): MeasureCopy {
  const kind = measureKind(p, pending);
  const out: MeasureCopy = { kind, value: '', caption: '', title: '' };
  switch (kind) {
    case 'pending':
      out.value = t('row.tokens.pending');
      break;
    case 'tokens': {
      const week = p.weeklyTokens;
      if (week) {
        out.value = tokens(week.billable);
        out.caption = weeklyWindowName(p);
      } else if (p.tokens) {
        out.value = tokens(p.tokens.billable);
        out.caption = t('row.measure.fiveHour');
      }
      out.title = tokensTitle(p);
      break;
    }
    case 'cost':
      // Never a bare amount: the tool's own figure, framed as not a bill.
      out.value = usd((p.weeklyCost as NonNullable<ProviderSnapshot['weeklyCost']>).totalUsd);
      out.caption = t('row.measure.reportedCost');
      break;
    case 'absent':
      out.value = t('row.usageLogAbsent');
      out.title = t('row.usageLogAbsentDetail', { provider: p.displayName });
      break;
    case 'uncounted':
      out.value = t('row.tokens.uncounted');
      break;
    default:
      out.value = t('row.noTokens');
  }
  return out;
}

function buildMeasure(p: ProviderSnapshot, pending: boolean): HTMLElement {
  const copy = measureCopy(p, pending);
  const value = el('span', { class: 'row__primary-value u-num' }, copy.value);
  const caption = el('span', { class: 'row__primary-caption' }, copy.caption);
  const root = el('div', { class: 'row__primary', 'data-kind': copy.kind }, value, caption);
  if (copy.title) setAttr(root, 'title', copy.title);
  caption.hidden = copy.caption === '';
  return root;
}

// --------------------------------------------------------------- hover line

/**
 * One window in the hover line: "5 saatlik 2 sa 13 dk sonra sıfırlanır".
 *
 * The compact layouts print only "5sa %62" on the card (owner, 2026-10-22: no
 * countdown on the line), so WHEN the window resets moved here and into the
 * details. A window without a reset instant states its figure, or the word
 * printed in its place ("bildirilmiyor"), so no window drops out of the line
 * silently. A window that is not in the snapshot at all has nothing to name.
 */
function windowTip(kind: '5h' | '7d', usage: WindowUsage | null, now: number): string | null {
  if (!usage) return null;
  const window = t(kind === '5h' ? 'meter.window5h.short' : 'meter.window7d.short');
  const resetsAt = parseInstant(usage.resetsAt);
  if (resetsAt !== null) {
    const left = resetsAt - now;
    return left < 1000
      ? t('row.tip.resetting', { window })
      : t('row.tip.resets', { window, duration: countdown(left) });
  }
  return t('row.tip.figure', { window, figure: isDrawable(usage) ? percentLabel(usage) : absenceFigure(usage) });
}

/**
 * The closed card's hover line, shown 400 ms after the pointer settles on it
 * and at once when the keyboard lands on its "Ayrıntılar" (tooltip.ts):
 *
 *     Codex CLI
 *     5 saatlik 2 sa 13 dk sonra sıfırlanır
 *     Haftalık 3 gün 4 sa sonra sıfırlanır
 *
 * It always opens with the tool's name, because the ring tiles print none. A tool with no window says what its card says instead:
 * why it is not connected, or its main measure.
 *
 * Written as `data-tip`, not `title`: a title would also become the list
 * item's accessible description, and a screen reader already hears every
 * one of these facts in the meters' own sentences.
 */
function rowTip(p: ProviderSnapshot, pending: boolean, now: number): string | null {
  if (p.status === 'loading') return null;
  const parts: string[] = [];
  if (p.status === 'passive') {
    parts.push(p.setupAction?.detail || t('row.notConnected'));
  } else if (publishesQuota(p)) {
    for (const part of [windowTip('5h', p.fiveHour, now), windowTip('7d', p.sevenDay, now)]) {
      if (part) parts.push(part);
    }
  } else {
    const measure = measureCopy(p, pending);
    parts.push(measure.caption ? `${measure.value} ${measure.caption}` : measure.value);
  }
  // The experimental pill is not drawn on a closed line or tile (layouts.css),
  // so its sentence is said here, where the pointer already is.
  if (p.experimental) parts.push(t('row.tip.experimental', { detail: t('provider.experimentalDetail') }));
  // One line per window, under the name: the bubble keeps line breaks
  // (panel.css .tip, pre-line), and a wrapped run-on sentence would break a
  // countdown across two lines.
  return parts.length > 0 ? t('row.tip.lead', { name: p.displayName, windows: parts.join('\n') }) : p.displayName;
}

// ---------------------------------------------------------------- builders

/** One placeholder window column, in the exact geometry a real one occupies. */
function skeletonBlock(): HTMLElement {
  return el(
    'div',
    { class: 'win' },
    el(
      'div',
      { class: 'win__head' },
      el('div', { class: 'sk sk--label' }),
      el('span', { class: 'win__gap' }),
      el('div', { class: 'sk sk--pct' }),
    ),
    el('div', { class: 'sk sk--rail' }),
    el('div', { class: 'win__foot' }, el('div', { class: 'sk sk--foot' })),
  );
}

function buildSkeleton(refs: Refs, body: HTMLElement): void {
  const line1 = el('div', { class: 'row__line' }, el('div', { class: 'sk sk--name' }));
  // Two columns, because a real card has two. A skeleton one short would make
  // the list jump the moment data landed, which a skeleton exists to prevent.
  const meter = el('div', { class: 'meter' }, skeletonBlock(), skeletonBlock());
  replaceChildrenWith(body, [line1, meter]);
  refs.name = null;
  refs.meter = null;
  refs.metaTokens = null;
  refs.metaBurn = null;
}

function buildPassive(
  refs: Refs,
  body: HTMLElement,
  p: ProviderSnapshot,
  ctx: RowContext,
): void {
  const name = el('span', { class: 'row__name' }, p.displayName);
  const experimental = experimentalTag(p);
  const detailId = `setup-detail-${p.id}`;
  const detailText = p.setupAction?.detail || t('row.notConnected');
  const detail = el(
    'span',
    { class: 'row__meta-detail', id: detailId, title: detailText },
    detailText,
  );

  let action: HTMLButtonElement | null = null;
  if (p.setupAction) {
    const label = p.setupAction.label;
    // The brightest ink goes to the action that will actually do something.
    // `not-installed` means the tool is not on this machine, so its button
    // cannot connect anything.
    const actionable = p.setupAction.kind !== 'not-installed';
    action = el(
      'button',
      {
        type: 'button',
        class: actionable ? 'btn btn--primary row__action' : 'btn row__action',
        'aria-label': `${p.displayName}: ${label}`,
        'aria-describedby': detailId,
      },
      label,
    ) as HTMLButtonElement;
    on(action, 'click', () => ctx.onSetup(p.id));
  }

  replaceChildrenWith(body, [
    el('div', { class: 'row__line' }, name, experimental, el('span', { class: 'row__gap' }), action),
    el('div', { class: 'row__meta row__meta--passive' }, detail),
  ]);

  refs.name = name;
  refs.plan = null;
  refs.meter = null;
  refs.metaTokens = null;
  refs.metaBurn = null;
  refs.staleAge = null;
  refs.retry = null;
  refs.action = action;
}

function buildLive(
  refs: Refs,
  body: HTMLElement,
  detailMeta: HTMLElement,
  p: ProviderSnapshot,
  ctx: RowContext,
  now: number,
): void {
  const name = el('span', { class: 'row__name' }, p.displayName);
  // The plan is the USER'S OWN STATEMENT, repeated back — it is in no local
  // file and no vendor tells us. So it is a label beside a name and nothing
  // else: it never enters a usage claim, and `null` renders NOTHING. The
  // screen-reader prefix says whose statement it is. Not on a row with no
  // reading: a plan qualifies a reading, and there is none to qualify.
  const plan = p.connected && p.planLabel
    ? el(
        'span',
        { class: 'row__plan' },
        // Whose statement it is: the user's, or the tool's own record.
        el('span', { class: 'u-sr' }, `${t(p.planSource === 'tool' ? 'row.planSpokenTool' : 'row.planSpoken')} `),
        p.planLabel,
      )
    : null;

  // "Güncel değil · 22 dk": the stale state in words, in the title line, so it
  // is read before the figures it qualifies. Repainted on the tick.
  const staleChip = p.status === 'stale'
    ? el('span', { class: 'row__chip row__chip--stale' }, '')
    : null;
  const since = p.status === 'stale' ? staleSince(p, ctx) : null;
  if (staleChip && since !== null) setAttr(staleChip, 'data-since', new Date(since).toISOString());

  const line1Children: Array<HTMLElement | null> = [
    name,
    experimentalTag(p),
    plan,
    staleChip,
    el('span', { class: 'row__gap' }),
  ];

  // --- an inline connect action -----------------------------------------
  // Present whenever the snapshot offers a setupAction — also on a card that
  // already draws a meter (Antigravity connects on the IDE store's figure, and
  // its weekly window arrives only through the agy bridge).
  let action: HTMLButtonElement | null = null;
  if (p.setupAction) {
    action = el(
      'button',
      {
        type: 'button',
        class: 'btn row__action',
        'aria-label': `${p.displayName}: ${p.setupAction.label}`,
        title: p.setupAction.detail,
      },
      p.setupAction.label,
    ) as HTMLButtonElement;
    on(action, 'click', () => ctx.onSetup(p.id));
    line1Children.push(action);
  }

  const line1 = el('div', { class: 'row__line' }, ...line1Children);

  // --- the two windows, or the tool's main measure ------------------------
  let meter: MeterHandle | null = null;
  let mainNode: HTMLElement;
  let primary: HTMLElement | null = null;
  if (publishesQuota(p)) {
    // When a model is selected in Antigravity, main ties the five-hour figure
    // to that model's group; the label says "seçili model" (a role, never a
    // name) so the change has a visible cause.
    const fiveHourNote = p.modelQuotas?.selectedModel ? t('row.selectedModel') : undefined;
    meter = createMeter(p.fiveHour, p.sevenDay, p.status === 'stale', fiveHourNote);
    meter.update(p.fiveHour, p.sevenDay, p.status === 'stale', now);
    mainNode = meter.el;
  } else {
    primary = buildMeasure(p, ctx.isPending(p.id));
    mainNode = primary;
  }

  const bodyChildren: HTMLElement[] = [line1, mainNode];

  // A stale Claude card means no Claude Code session has run its status line
  // for a while; the chip says how long. Under the meter, say what brings the
  // figures back (owner, 2026-10-09: "Güncel değil · 13 sa" read as a lost
  // connection). Status is part of the shape key, so this follows it.
  if (p.id === 'claude' && p.status === 'stale') {
    bodyChildren.push(el('p', { class: 'row__stalehint' }, t('row.claudeStaleHint')));
  }

  // --- the error, in the card it belongs to --------------------------------
  let retry: HTMLButtonElement | null = null;
  if (p.status === 'error') {
    const message = el('span', {}, errorText(p.errorCode));
    retry = el(
      'button',
      { type: 'button', class: 'btn', 'aria-label': t('row.retryLabel', { name: p.displayName }) },
      t('row.retry'),
    ) as HTMLButtonElement;
    on(retry, 'click', () => ctx.onRetry(p.id));
    bodyChildren.push(el('div', { class: 'row__err', role: 'status' }, message, retry));
  }
  replaceChildrenWith(body, bodyChildren);

  // --- the token line, inside "Ayrıntılar" ---------------------------------
  const metaChildren: HTMLElement[] = [];
  let metaTokens: HTMLElement | null = null;
  let metaBurn: HTMLElement | null = null;
  let staleAge: HTMLElement | null = null;
  let delta: HTMLElement | null = null;

  if (p.status === 'stale') {
    const primaryWin = primaryWindow(p);
    const deltaValue = primaryWin?.billableSinceCapture ?? null;
    if (deltaValue !== null && deltaValue > 0) {
      // The one honest objection to a stale percentage is that consumption
      // only rises inside a window. This is the measured floor on that gap — a
      // real token count, never divided back into a percentage.
      delta = el('span', { class: 'row__delta' }, sinceCapture(deltaValue));
      metaChildren.push(delta);
    } else if (!primaryWin?.capturedAt) {
      staleAge = el('span', { class: 'row__stale' }, '');
      const lastGood = p.lastGoodAt ?? ctx.generatedAt;
      if (lastGood) setAttr(staleAge, 'data-since', lastGood);
      metaChildren.push(staleAge);
    }
    if (tokenItemKind(p) !== 'none') {
      metaTokens = el('span', { title: tokensTitle(p) }, tokenItemText(p));
      metaChildren.push(metaTokens);
    }
  } else if (p.status !== 'error' || tokenItemKind(p) !== 'none') {
    const pending = ctx.isPending(p.id);
    if (pending) {
      metaChildren.push(el('span', { class: 'row__pending' }, t('row.tokens.pending')));
    } else if (tokenItemKind(p) !== 'none') {
      metaTokens = el('span', { title: tokensTitle(p) }, tokenItemText(p));
      metaChildren.push(metaTokens);
    }
    if (!pending && p.burnRatePerHour !== null) {
      // Measured over the FIVE-HOUR window and sitting beside a weekly count,
      // so it names its own window on the visible line.
      metaBurn = el(
        'span',
        { title: modelsTitle(p) || t('row.burnTitle') },
        t('row.burn.fiveHour', { rate: burnRate(p.burnRatePerHour) }),
      );
      metaChildren.push(metaBurn);
    }
    if (metaChildren.length === 0) {
      metaChildren.push(
        p.usageLogAbsent === true
          ? el('span', { class: 'row__hint', title: t('row.usageLogAbsentDetail', { provider: p.displayName }) }, t('row.usageLogAbsent'))
          : el('span', {}, p.weeklyCost?.sourceIncomplete ? t('row.tokens.uncounted') : t('row.noTokens')),
      );
    }
  }

  // A REAL SPACE BETWEEN ITEMS, not only a CSS one: the visible separator is a
  // pseudo-element, which is not part of `textContent`, so without this the
  // text stream read "…6,2 Mn token5 saat: 240 B token/sa".
  const spaced: (HTMLElement | string)[] = [];
  metaChildren.forEach((child, i) => {
    if (i > 0) spaced.push(' ');
    spaced.push(child);
  });
  const meta = el('div', { class: 'row__meta' }, ...spaced);

  // The four classes of each window, visible now that there is room for them.
  const classLines = tokenClassLines(p).map((line) => el('li', { class: 'row__class' }, line));
  const classList = classLines.length > 0
    ? el('ul', { class: 'row__classes', role: 'list' }, ...classLines)
    : null;

  // The five-hour split by model: names and token counts, never a percentage.
  const models = p.byModel ?? [];
  const modelList = models.length > 0
    ? el(
        'div',
        { class: 'row__models' },
        el('p', { class: 'row__subhead' }, t('row.detail.models')),
        el(
          'ul',
          { class: 'row__model-list', role: 'list' },
          ...models.map((entry) =>
            el(
              'li',
              { class: 'row__model' },
              el('span', { class: 'row__model-name', title: entry.model }, entry.model),
              el('span', { class: 'row__model-count u-num' }, compact(entry.billable)),
            ),
          ),
        ),
      )
    : null;

  replaceChildrenWith(detailMeta, [meta, classList, modelList]);

  refs.name = name;
  refs.plan = plan;
  refs.meter = meter;
  refs.metaTokens = metaTokens;
  refs.metaBurn = metaBurn;
  refs.staleAge = staleAge;
  refs.staleChip = staleChip;
  refs.delta = delta;
  refs.action = action;
  refs.retry = retry;
  refs.primary = primary;
}

/** The disclosure chevron, pointing right; CSS turns it when open. */
function chevron(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', {
      d: 'M6 4l4 4-4 4',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
}

// ------------------------------------------------------------------- row

export function createRow(provider: ProviderSnapshot, ctx: RowContext, now: number): RowHandle {
  const root = el('li', { class: 'row', role: 'listitem' }) as HTMLLIElement;
  const refs: Refs = { ...EMPTY_REFS };

  // The identity tile IS the drag grip: a real <button>, so it takes focus and
  // Alt+Arrow on it moves the card.
  refs.grip = el('button', {
    type: 'button',
    class: 'grip',
    'aria-describedby': REORDER_HELP_ID,
  }) as HTMLButtonElement;
  refs.grip.appendChild(providerMark(provider.id, provider.connected));
  refs.grip.appendChild(gripDots());

  // `display: contents` in CSS: its children are laid out on the card's grid,
  // the title line beside the mark and the windows across the full width.
  const body = el('div', { class: 'row__body' });

  // "Ayrıntılar": created once, so its open state and its focus survive the
  // snapshot cadence.
  const detailId = `row-detail-${provider.id}`;
  const moreLabel = el('span', { class: 'row__more-label' }, t('row.detail.toggle'));
  const moreButton = el(
    'button',
    {
      type: 'button',
      class: 'row__more',
      'aria-expanded': 'false',
      'aria-controls': detailId,
    },
    moreLabel,
    el('span', { class: 'row__more-chev', 'aria-hidden': 'true' }, chevron()),
  ) as HTMLButtonElement;
  on(moreButton, 'click', () => ctx.onToggleExpand?.(current.id));
  // A closed tile or focus row opens on a click anywhere on it, except on a
  // control of its own ("Bağla", "Yeniden dene"), which keeps its action, and
  // inside the setup question drawn in it (panel.ts placeConsent).
  on(root, 'click', (event: MouseEvent) => {
    if (!lastCtx.opensOnCard?.(current.id) || moreButton.hidden) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, a, input, select, textarea, [role="button"], .consent')) return;
    lastCtx.onToggleExpand?.(current.id);
  });

  const detailMeta = el('div', { class: 'row__detail-tokens' });
  // Created once and re-appended, so their own disclosures stay open across
  // the 15s snapshot cadence.
  refs.cost = createCost(provider.id);
  refs.quotas = createQuotas(provider.id);
  const notes = el('ul', { class: 'row__notes', role: 'list' });
  const detail = el(
    'div',
    { class: 'row__detail', id: detailId, role: 'region', 'aria-label': t('row.detail.region', { name: provider.displayName }) },
    detailMeta,
    refs.quotas.el,
    refs.cost.el,
    notes,
  );
  detail.hidden = true;

  root.appendChild(refs.grip);
  root.appendChild(body);
  root.appendChild(moreButton);
  root.appendChild(detail);

  let shapeKey = '';
  let current: ProviderSnapshot = provider;
  let lastCtx: RowContext = ctx;
  /** The effective snapshot last drawn (status and expiry applied), for the tick's hover line. */
  let drawn: ProviderSnapshot = provider;
  let drawnPending = false;

  function rebuild(p: ProviderSnapshot, context: RowContext, atNow: number): void {
    // Every optional ref is cleared here rather than in each builder, so a node
    // from the previous shape can never be written to after it is detached.
    refs.name = null;
    refs.plan = null;
    refs.meter = null;
    refs.metaTokens = null;
    refs.metaBurn = null;
    refs.staleAge = null;
    refs.staleChip = null;
    refs.delta = null;
    refs.action = null;
    refs.retry = null;
    refs.primary = null;

    if (p.status === 'loading') {
      buildSkeleton(refs, body);
      replaceChildrenWith(detailMeta, []);
    } else if (p.status === 'passive') {
      buildPassive(refs, body, p, context);
      replaceChildrenWith(detailMeta, []);
    } else {
      buildLive(refs, body, detailMeta, p, context, atNow);
    }
  }

  /** Where the figures came from and when: the details' last section. */
  function renderNotes(p: ProviderSnapshot): void {
    const lines: string[] = [];
    for (const [usage, key] of [[p.fiveHour, 'meter.window5h.label'], [p.sevenDay, 'meter.window7d.label']] as const) {
      if (!usage || !isDrawable(usage)) continue;
      if (usage.capturedAt) {
        lines.push(t('row.note.measuredAt', { window: t(key), time: clockTime(usage.capturedAt) }));
      }
    }
    if (p.lastGoodAt && lines.length === 0 && p.status !== 'ok') {
      lines.push(t('row.note.lastGood', { time: clockTime(p.lastGoodAt) }));
    }
    if (lastCtx.generatedAt) lines.push(t('row.note.scanned', { time: clockTime(lastCtx.generatedAt) }));
    replaceChildrenWith(notes, lines.map((line) => el('li', { class: 'row__note' }, line)));
    notes.hidden = lines.length === 0;
  }

  function applyChrome(p: ProviderSnapshot, context: RowContext): void {
    root.classList.toggle('row--passive', p.status === 'passive');
    setAttr(root, 'data-status', p.status);
    setAttr(root, 'data-provider', p.id);
    root.style.setProperty('--accent', p.accent);

    // The single switch behind the identity treatment: brand art in colour
    // while connected, the same art in grey otherwise.
    setAttr(root, 'data-connected', p.connected ? 'true' : 'false');

    const step = meterStateStep(p.fiveHour, p.sevenDay);
    setAttr(root, 'data-state', step);
    const primary = primaryWindow(p);
    const pct = primary && isDrawable(primary) ? primary.usedPercentage : null;
    if (step && pct !== null) root.style.setProperty('--mix', mixWithin(pct).toFixed(4));
    else root.style.removeProperty('--mix');

    setAttr(root, 'aria-busy', p.status === 'loading' ? 'true' : null);
    setAttr(
      root,
      'aria-label',
      p.status === 'loading' ? t('row.loadingLabel', { name: p.displayName }) : null,
    );

    // --- the grip -------------------------------------------------------
    const tray = context.isTrayRow(p.id);
    // Outside the list the mark is the tool's logo and nothing else: not a
    // tab stop, not announced as a drag handle, no "drag to move" tooltip.
    const movable = context.canReorder?.(p.id) ?? true;
    setAttr(refs.grip, 'data-tray', tray && movable ? 'true' : null);
    setAttr(refs.grip, 'aria-label', t('row.gripLabel', { name: p.displayName }));
    setAttr(refs.grip, 'aria-hidden', movable ? null : 'true');
    setAttr(refs.grip, 'aria-describedby', movable ? REORDER_HELP_ID : null);
    // The tray consequence is stated on the control that causes it, honestly:
    // a provider with no five-hour window drives an empty ring, not a donut.
    const title = t('row.gripTitle', { name: p.displayName });
    const trayNote = tray
      ? p.connected && p.fiveHour != null
        ? t('row.gripTray')
        : t('row.gripTrayNoData')
      : '';
    setAttr(refs.grip, 'title', movable ? (trayNote ? `${title} ${trayNote}` : title) : null);
    refs.grip.disabled = p.status === 'loading' || !movable;
    context.attachGrip(refs.grip, p.id, p.displayName);

    // --- "Ayrıntılar" ----------------------------------------------------
    // Nothing to detail on a loading or passive card: no control at all, and a
    // stale "open" state cannot leave a region showing.
    const hasDetail = p.status !== 'loading' && p.status !== 'passive';
    const expanded = hasDetail && (context.isExpanded?.(p.id) ?? false);
    moreButton.hidden = !hasDetail;
    setAttr(moreButton, 'aria-expanded', expanded ? 'true' : 'false');
    setAttr(moreButton, 'aria-label', t(expanded ? 'row.detail.hideLabel' : 'row.detail.showLabel', { name: p.displayName }));
    setText(moreLabel, t(expanded ? 'row.detail.hide' : 'row.detail.toggle'));
    if (!expanded && detail.contains(document.activeElement)) {
      // Focus must not be lost inside a region that is closing.
      moreButton.focus({ preventScroll: true });
    }
    detail.hidden = !expanded;
    setAttr(root, 'data-expanded', expanded ? 'true' : null);
    setAttr(root, 'data-opens', hasDetail && (context.opensOnCard?.(p.id) ?? false) ? 'true' : null);
  }

  function tick(atNow: number): void {
    // Both window countdowns live in the meter and are repainted by it.
    if (refs.meter) refs.meter.tick(atNow);
    // The hover line counts down with them, on a closed card only: an open
    // one shows every countdown itself, and a tip over the whole sheet would
    // cover the details it opened. A tool that is not connected has one too
    // (it opens no details): in the ring tiles its name is not printed.
    const closed = root.getAttribute('data-expanded') !== 'true';
    setAttr(root, 'data-tip', closed ? rowTip(drawn, drawnPending, atNow) : null);
    if (refs.staleAge) {
      const since = parseInstant(refs.staleAge.getAttribute('data-since'));
      if (since !== null) {
        const elapsed = Math.max(0, atNow - since);
        setText(refs.staleAge, t('row.staleAge', { ago: ago(elapsed) }));
        setAttr(refs.staleAge, 'title', t('row.staleAgeTitle', { ago: agoSpoken(elapsed) }));
      }
    }
    if (refs.staleChip) {
      const since = parseInstant(refs.staleChip.getAttribute('data-since'));
      setText(
        refs.staleChip,
        since === null ? t('row.staleChipBare') : t('row.staleChip', { age: shortAge(atNow - since) }),
      );
      if (since !== null) setAttr(refs.staleChip, 'title', t('row.staleAgeTitle', { ago: agoSpoken(atNow - since) }));
    }
  }

  function update(raw: ProviderSnapshot, context: RowContext, atNow: number): void {
    current = raw;
    lastCtx = context;
    // One normalisation point: everything below draws the effective status.
    const p: ProviderSnapshot = {
      ...raw,
      status: effectiveStatus(raw, context),
      fiveHour: expireWindow(raw.fiveHour, atNow),
      sevenDay: expireWindow(raw.sevenDay, atNow),
    };
    // Pending and sourceIncomplete decide which words the token line and the
    // main measure use, so both are structure.
    const pending = context.isPending(p.id);
    drawn = p;
    drawnPending = pending;
    const nextShape = `${shapeKeyOf(p)}|${pending ? 'pending' : 'read'}|${p.weeklyCost?.sourceIncomplete ? 'incomplete' : 'complete'}|${publishesQuota(p) ? '' : measureKind(p, pending)}`;
    if (nextShape !== shapeKey) {
      shapeKey = nextShape;
      rebuild(p, context, atNow);
    } else {
      if (refs.name) setText(refs.name, p.displayName);
      if (refs.plan && p.planLabel) {
        // NOT setText: that would drop the screen-reader prefix beside it.
        const last = refs.plan.lastChild;
        if (last) last.textContent = p.planLabel;
      }
      if (refs.meter) refs.meter.update(p.fiveHour, p.sevenDay, p.status === 'stale', atNow);
      if (refs.primary) {
        const next = buildMeasure(p, pending);
        refs.primary.replaceWith(next);
        refs.primary = next;
      }
      if (refs.metaTokens && tokenItemKind(p) !== 'none') {
        // The window label is part of the text, so it is rewritten with the
        // figure: a count that moved windows must not keep the old name.
        setText(refs.metaTokens, tokenItemText(p));
        setAttr(refs.metaTokens, 'title', tokensTitle(p));
      }
      if (refs.metaBurn && p.burnRatePerHour !== null) {
        setText(refs.metaBurn, t('row.burn.fiveHour', { rate: burnRate(p.burnRatePerHour) }));
      }
      if (refs.delta) {
        // Consumption only rises inside a window, so this number moves between
        // captures; a frozen one would present a stale floor as current.
        const value = primaryWindow(p)?.billableSinceCapture ?? null;
        if (value !== null && value > 0) setText(refs.delta, sinceCapture(value));
      }
      const since = p.lastGoodAt ?? context.generatedAt;
      if (refs.staleAge && since) setAttr(refs.staleAge, 'data-since', since);
      if (refs.staleChip) {
        const at = staleSince(p, context);
        setAttr(refs.staleChip, 'data-since', at === null ? null : new Date(at).toISOString());
      }
    }

    applyChrome(p, context);

    // `p.status` here is the EFFECTIVE status. It describes the LIMIT capture,
    // so it qualifies the per-model quota figures (same capture) and NOT the
    // cost block: whether the token logs were read is the cost source's own
    // `sourceIncomplete` (ADR-002 A3.15).
    const degraded = p.status === 'stale' || p.status === 'error';
    refs.quotas.update(p.modelQuotas ?? null, p.displayName, degraded);
    refs.cost.update(p.weeklyCost, p.displayName, pending);
    renderNotes(p);

    // Pending state on whichever action this shape owns.
    const busy = context.isBusy(p.id);
    for (const button of [refs.action, refs.retry]) {
      if (!button) continue;
      button.disabled = busy;
      setAttr(button, 'aria-busy', busy ? 'true' : null);
      button.classList.toggle('is-busy', busy);
    }

    tick(atNow);
  }

  update(provider, ctx, now);

  return {
    el: root,
    get id(): string {
      return current.id;
    },
    moreButton,
    update,
    tick,
  };
}

/**
 * An identity-free skeleton card, used before the first snapshot arrives. It
 * fabricates no provider name and no number; it only holds the final geometry
 * so the list does not jump when real cards land.
 */
export function createSkeletonRow(): HTMLLIElement {
  const root = el('li', {
    class: 'row',
    role: 'listitem',
    'data-status': 'loading',
    'aria-busy': 'true',
    'aria-label': t('row.skeletonLabel'),
  }) as HTMLLIElement;

  const body = el('div', { class: 'row__body' });
  const refs: Refs = { ...EMPTY_REFS };
  buildSkeleton(refs, body);

  root.appendChild(el('span', { class: 'grip grip--empty', 'aria-hidden': 'true' }));
  root.appendChild(body);
  return root;
}
