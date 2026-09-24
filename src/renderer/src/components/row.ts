/**
 * A provider row. Five states, one geometry.
 *
 *   loading  skeleton drawn in the FINAL geometry, so nothing reflows
 *   ok       name, plan, one block per usage window, tokens, burn rate
 *   stale    last good value kept and dimmed; see below
 *   error    last good value kept, desaturated, retry offered
 *   passive  44px, no meter at all, and the action button is the brightest ink
 *
 * IDENTITY vs. STATE
 * ------------------
 * The row's left column is the provider's own mark (components/logo.ts), and it
 * doubles as the drag grip. A CONNECTED provider draws its mark in its brand
 * hex on a tinted tile; every other one draws the same geometry in the ink
 * scale, at a lighter stroke, with no tile. That is deliberately three signals
 * at once — hue, weight, ground — plus the absence of a meter, so "connected"
 * survives a monochrome screenshot and a colour-blind reader.
 *
 * This does NOT reopen the meter rule. Meters and percentages stay on the state
 * ramp, because those are the only marks a user compares ACROSS rows. An
 * identity mark is never compared; it is recognised. The 2px brand spine is
 * gone: it was carrying identity for a monogram tile that no longer exists, and
 * a second brand-coloured element in the same 16px gutter competed with the
 * meter column for the eye.
 *
 * ONE BLOCK PER WINDOW
 * --------------------
 * The five-hour and the weekly windows are drawn identically: label,
 * percentage, bar, reset countdown (components/meter.ts). Neither is a
 * subtitle of the other. The weekly window used to be a 2px hairline with no
 * figure and no countdown, and the user's verdict on that was that the app did
 * not show weekly usage at all — which, as a claim about what the app tells
 * you, was correct.
 *
 * Two shapes cut across those five.
 *
 * certainty === 'unknown' — no bar and no percentage for that window. When
 * NEITHER window is drawable the row shows absolute tokens and burn rate and
 * nothing else; when only one is, the other still names itself and says
 * "bilinmiyor". That is the Claude row before the bridge is connected, and it
 * is the honest rendering, not a degraded one.
 *
 * A STALE CAPTURE (ADR-001 amendment 2) — the statusline only emits while a
 * Claude Code session is open, and the tray is looked at precisely when it is
 * not. So a capture can be old and still TRUE, because the window it describes
 * has not rolled over. Such a row keeps its bars and its percentages, at the
 * stale weight, and never shows a figure without the instant it was measured
 * ("14:10 itibarıyla", printed under the bar it belongs to) plus the locally
 * measured tokens spent since. That delta is a floor on the gap, never divided
 * back into a percentage.
 */

import type { ProviderSnapshot, WindowUsage } from '../../../shared/contract.js';
import { el, on, replaceChildrenWith, setAttr, setText } from '../dom.js';
import {
  ago,
  agoSpoken,
  burnRate,
  compact,
  mixWithin,
  parseInstant,
  sinceCapture,
  tokens,
} from '../format.js';
import { t } from '../i18n.js';
import { keyIsSource } from '../keys.js';
import { allZero, hasTokenCount } from '../tokens.js';
import { createCost, type CostHandle } from './cost.js';
import { experimentalTag } from './experimental.js';
import { createKeyBlock, type KeyBlockHandle } from './keys.js';
import { createQuotas, type QuotaHandle } from './quotas.js';
import { gripDots, providerMark } from './logo.js';
import { createMeter, isDrawable, meterStateStep, type MeterHandle } from './meter.js';

/** The id of the hidden paragraph in the panel that explains how to reorder. */
export const REORDER_HELP_ID = 'reorder-help';

export interface RowContext {
  onRetry(providerId: string): void;
  onSetup(providerId: string): void;
  /** ADR-003 A8: the user asked to add an optional API key for this provider. */
  onAddKey(providerId: string): void;
  /** The user asked for the vendor's token page (owner's A8 addendum). */
  onOpenTokenPage(providerId: string): void;
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
}

interface Refs {
  grip: HTMLButtonElement;
  cost: CostHandle;
  keys: KeyBlockHandle;
  quotas: QuotaHandle;
  name: HTMLElement | null;
  plan: HTMLElement | null;
  meter: MeterHandle | null;
  metaTokens: HTMLElement | null;
  metaBurn: HTMLElement | null;
  staleAge: HTMLElement | null;
  delta: HTMLElement | null;
  action: HTMLButtonElement | null;
  retry: HTMLButtonElement | null;
}

const EMPTY_REFS: Refs = {
  grip: null as unknown as HTMLButtonElement,
  cost: null as unknown as CostHandle,
  keys: null as unknown as KeyBlockHandle,
  quotas: null as unknown as QuotaHandle,
  name: null,
  plan: null,
  meter: null,
  metaTokens: null,
  metaBurn: null,
  staleAge: null,
  delta: null,
  action: null,
  retry: null,
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
    p.planLabel ? 'plan' : 'no-plan',
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
    // presence is STRUCTURE and must rebuild the meter when it flips — a user
    // switching model in Antigravity, or clearing the selection, changes this.
    // Which model is a CONTENT change handled by the disclosure below, not by
    // the key.
    p.modelQuotas?.selectedModel ? 'sel' : 'no-sel',
  ].join('|');
}

/**
 * THE TOKEN FIGURE ON THIS LINE IS THE WEEK'S, AND IT SAYS SO.
 *
 * It used to be the five-hour count, printed bare. Bare was survivable while
 * there was one token figure in the row; it is not now. The line sits under
 * TWO meters — a five-hour block and a weekly one — so an unlabelled count is
 * read as whichever block the eye came from, and the burn rate beside it is
 * genuinely a FIVE-HOUR figure (`agg.burnRatePerHour(tokens.billable,
 * win.elapsedMs)` over the 5h window, src/core/snapshot.js:612). Two numbers
 * side by side describing two different windows, one of them labelled and one
 * not, is the misreading this change exists to remove. So every figure on this
 * line names its own window, and the pair is symmetric.
 *
 * Which weekly window it is comes from `weeklyTokensWindowAnchored` — the row's
 * OWN field, about this figure's window — and never from `sevenDay.resetsAt` or
 * from `weeklyCost.windowAnchored`. Two reasons, both load-bearing:
 *
 *  - Deriving a window from a reset instant is usage arithmetic, and the
 *    contract's division of labour is that main resolves windows and the
 *    renderer renders them. It would also be coupling two rules that only
 *    AGREE BY COINCIDENCE: `resetsAt` is nulled by `windowFrom` under a rule
 *    about whether a PERCENTAGE may be shown (a rolled-over window loses its
 *    figure), while main's refusal to anchor to a passed reset is a separate
 *    rule with its own reason (a closed window would exclude everything spent
 *    since). Backend measured the five reachable Claude states: today a
 *    non-null `resetsAt` and an anchored window always coincide, so a renderer
 *    deriving the label would be RIGHT today — and silently wrong the first
 *    time either rule moves, with no test able to see it. That is the worse
 *    failure, not the smaller one.
 *  - `weeklyCost.windowAnchored` states the same fact about the same window and
 *    is the right field to read WHEN a cost block exists, but it vanishes
 *    exactly where the label matters most: a quiet week prices nothing, so
 *    `weeklyCost` is null while a present all-zero count still has to name its
 *    window. When both are present they always agree — main derives them from
 *    one window object.
 *
 * `null` means unscanned, so there is no window to name and the label states the
 * SPAN only ("Haftalık" / "Weekly"). Gemini CLI and Kimi Code are always false
 * once scanned — neither publishes a weekly reset to us — so neither can ever be
 * labelled a quota week.
 */
function weeklyTokenLabel(p: ProviderSnapshot, value: string): string {
  const anchored = p.weeklyTokensWindowAnchored;
  if (anchored === null || anchored === undefined) return t('row.tokens.weekly', { value });
  return anchored ? t('row.tokens.quotaWeek', { value }) : t('row.tokens.last7', { value });
}

/**
 * What the line prints for the week: the count and its window, nothing else.
 *
 * No "en az" and no cause in brackets, even when main marks the count as a
 * lower bound (`weeklyTokenFloorCauses`): the owner ruled the floor marker out
 * of the panel (2026-09-23), and a bracketed cause on every Codex row was the
 * grey noise that ruling was about. The field is still accepted and sanitised;
 * it is only not drawn.
 */
function weeklyTokenText(p: ProviderSnapshot): string {
  const tk = p.weeklyTokens;
  if (!tk) return '';
  // ADR-002 A3.19, and the ONLY state that reads "could not be counted": the
  // reader KNOWS it could not read this window, so the zero it reports is not a
  // measurement. Recognised by `sourceIncomplete` WITH a zero count — never by
  // the zero alone, which is a real answer (see below).
  if (allZero(tk) && p.weeklyCost?.sourceIncomplete) return t('row.tokens.uncounted');

  // A MEASURED ZERO PRINTS AS ZERO. A user who did not touch this tool all week
  // is told they used nothing — our reading succeeded and its answer was zero.
  // Hiding the item instead would make the row indistinguishable from a
  // provider we never scanned, and would bring `row.noTokens` ("Token bilgisi
  // yok") back into reach on a row where we DO have the data.
  return weeklyTokenLabel(p, tokens(tk.billable));
}

/**
 * Which window this line's token figure describes.
 *
 * 'weekly' is the answer whenever main sent a weekly count at all — including
 * the all-zero "could not be counted" one, which is a statement ABOUT the week
 * and belongs under the week's label. 'fiveHour' is the compatibility path: a
 * main that predates `weeklyTokens` still has a true five-hour count, and the
 * honest thing is to show it AS a five-hour count, never to relabel a figure
 * into a window it does not describe.
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
 * Both windows' breakdowns, each named. The five-hour figure is not deleted by
 * this change — it moves here, and it is labelled, because `weeklyTokens` and
 * `tokens` are both a `TokenBreakdown` and become indistinguishable the moment
 * they are formatted.
 */
function tokensTitle(p: ProviderSnapshot): string {
  const lines: string[] = [];
  // `hasTokenCount` here and nowhere else: this is the one decision it is for —
  // whether a four-class breakdown has anything to say. It never decides
  // whether a figure prints; that is `null` vs non-null, and a zero prints.
  const week = p.weeklyTokens;
  const five = p.tokens;
  if (week && hasTokenCount(week)) lines.push(`${t('meter.window7d.label')} — ${classes(week)}`);
  if (five && hasTokenCount(five)) lines.push(`${t('meter.window5h.label')} — ${classes(five)}`);
  return lines.join('\n');
}

/**
 * The per-model split behind the burn rate. It is the FIVE-HOUR split
 * (src/core/snapshot.js:613 reads it from the same 5h window the rate is
 * measured over), so it is named as one rather than left to sit under a line
 * whose other figure is weekly.
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

// ---------------------------------------------------------------- builders

/** One placeholder window block, in the exact geometry a real one occupies. */
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
  // Two blocks, because a real connected row has two. A skeleton one block
  // short would make the list jump by 40px the moment data landed, which is
  // precisely what a skeleton exists to prevent.
  const meter = el('div', { class: 'meter' }, skeletonBlock(), skeletonBlock());
  const line3 = el('div', { class: 'row__meta' }, el('div', { class: 'sk sk--meta' }));
  replaceChildrenWith(body, [line1, meter, line3]);
  refs.name = null;
  refs.meter = null;
  refs.metaTokens = null;
  refs.metaBurn = null;
}

function buildPassive(
  refs: Refs,
  body: HTMLElement,
  root: HTMLLIElement,
  p: ProviderSnapshot,
  ctx: RowContext,
): void {
  const name = el('span', { class: 'row__name' }, p.displayName);
  const experimental = experimentalTag(p);
  const detailId = `setup-detail-${p.id}`;
  // A stored key is this row's source (ADR-003 A8): main drops the setup offer
  // then, and the key block below the name carries the row — the month's
  // credits, or the one fixed sentence for the key's state. "Not connected
  // yet" beside either would contradict it, so the line is not drawn at all.
  const keyed = !p.setupAction && keyIsSource(p);
  const detailText = p.setupAction?.detail || t('row.notConnected');
  const detail = keyed
    ? null
    : el(
        'span',
        { class: 'row__meta-detail', id: detailId, title: detailText },
        detailText,
      );

  replaceChildrenWith(body, [
    el('div', { class: 'row__line' }, name, experimental),
    detail ? el('div', { class: 'row__meta' }, detail) : null,
  ]);

  refs.name = name;
  refs.plan = null;
  refs.meter = null;
  refs.metaTokens = null;
  refs.metaBurn = null;
  refs.staleAge = null;
  refs.retry = null;

  if (p.setupAction) {
    const label = p.setupAction.label;
    // The brightest ink goes to the action that will actually do something.
    // `not-installed` means the tool is not on this machine, so its button
    // cannot connect anything; making six of those the loudest elements in the
    // panel would bury the one row the user can act on today.
    const actionable = p.setupAction.kind !== 'not-installed';
    const button = el(
      'button',
      {
        type: 'button',
        class: actionable ? 'btn btn--primary' : 'btn',
        'aria-label': `${p.displayName}: ${label}`,
        'aria-describedby': detailId,
      },
      label,
    ) as HTMLButtonElement;
    on(button, 'click', () => ctx.onSetup(p.id));
    root.appendChild(button);
    refs.action = button;
  } else {
    refs.action = null;
  }
}

function buildLive(
  refs: Refs,
  body: HTMLElement,
  p: ProviderSnapshot,
  ctx: RowContext,
  now: number,
): void {
  const name = el('span', { class: 'row__name' }, p.displayName);
  // The plan is the USER'S OWN STATEMENT, repeated back — it is in no local
  // file and no vendor tells us (`ProviderSnapshot.planLabel`: "from app
  // settings only. Never inferred, never guessed"). So it is a label beside a
  // name and nothing else: it never enters a usage claim, never colours a
  // figure, and `null` renders NOTHING — no placeholder, no "bilinmiyor", which
  // would be the app asking a question in the one place it should be quiet.
  //
  // Provenance for anything reading the row aloud: the visible pill is two or
  // three words with no context, and beside a tool name it could be heard as
  // something the tool reported. The screen-reader prefix says whose statement
  // it is. It is `u-sr` rather than a `title` deliberately — a tooltip may not
  // paint at all on this window (open question), and this is the reader who
  // most needs the provenance.
  // NOT on a passive or unconnected row, even when the label exists. A plan
  // QUALIFIES A READING — it is the allowance the percentages are a share of —
  // and a row with no reading has nothing for it to qualify. On a not-installed
  // row it would sit beside "Bu araç bu makinede bulunamadı", annotating a tool
  // the user is not using; that is noise, and noise that looks like data.
  const plan = p.connected && p.planLabel
    ? el(
        'span',
        { class: 'row__plan' },
        el('span', { class: 'u-sr' }, `${t('row.planSpoken')} `),
        p.planLabel,
      )
    : null;
  const line1Children: Array<HTMLElement | null> = [
    name,
    experimentalTag(p),
    plan,
    el('span', { class: 'row__gap' }),
  ];

  const drawable = isDrawable(p.fiveHour) || isDrawable(p.sevenDay);

  // The percentages used to live here, on the name line, one per row. They
  // moved into the window blocks below: with two windows to report there is no
  // honest way to put "the" percentage next to the provider's name, and the
  // one that was there described the five-hour window without saying so.

  // --- an inline connect action -----------------------------------------
  // Present whenever the snapshot offers a setupAction. For a passive,
  // unmeasurable row this is the row's only affordance. It ALSO appears on a
  // row that already draws a meter: Antigravity connects on the IDE store's
  // five-hour figure, yet its weekly window and a live five-hour reset only
  // arrive through the agy bridge, so the snapshot keeps offering "Bağla"
  // beside the live meter until that bridge is connected. The snapshot decides
  // when the action exists; this only renders whatever it was given.
  let action: HTMLButtonElement | null = null;
  if (p.setupAction) {
    action = el(
      'button',
      {
        type: 'button',
        class: 'btn',
        'aria-label': `${p.displayName}: ${p.setupAction.label}`,
        title: p.setupAction.detail,
      },
      p.setupAction.label,
    ) as HTMLButtonElement;
    on(action, 'click', () => ctx.onSetup(p.id));
    line1Children.push(action);
  }

  const line1 = el('div', { class: 'row__line' }, ...line1Children);

  // --- the meter, or the honest absence of one ---------------------------
  let meter: MeterHandle | null = null;
  let meterNode: HTMLElement;
  if (drawable) {
    // When a model is selected in Antigravity, main ties the five-hour figure
    // to that model's group, so the number changes as the user switches model.
    // Qualify the label — "seçili model", a role and not a name — so the change
    // has a visible cause. The name itself is only in the disclosure below.
    const fiveHourNote = p.modelQuotas?.selectedModel ? t('row.selectedModel') : undefined;
    meter = createMeter(p.fiveHour, p.sevenDay, p.status === 'stale', fiveHourNote);
    meter.update(p.fiveHour, p.sevenDay, p.status === 'stale', now);
    meterNode = meter.el;
  } else {
    meterNode = el(
      'div',
      { class: 'row__unknown' },
      el('span', {}, t('row.unknownUsage')),
    );
  }

  // --- line 3: what we DO know ------------------------------------------
  const metaChildren: HTMLElement[] = [];
  let metaTokens: HTMLElement | null = null;
  let metaBurn: HTMLElement | null = null;
  let staleAge: HTMLElement | null = null;
  let delta: HTMLElement | null = null;
  let retry: HTMLButtonElement | null = null;

  if (p.status === 'error') {
    const message = el('span', {}, errorText(p.errorCode));
    retry = el(
      'button',
      { type: 'button', class: 'btn', 'aria-label': t('row.retryLabel', { name: p.displayName }) },
      t('row.retry'),
    ) as HTMLButtonElement;
    on(retry, 'click', () => ctx.onRetry(p.id));
    const err = el('div', { class: 'row__err', role: 'status' }, message, retry);
    replaceChildrenWith(body, [line1, meterNode, err]);
  } else {
    if (p.status === 'stale') {
      const primary = primaryWindow(p);
      const deltaValue = primary?.billableSinceCapture ?? null;

      if (deltaValue !== null && deltaValue > 0) {
        // The one honest objection to showing a stale percentage is that
        // consumption only rises inside a window, so the figure errs
        // optimistic. This is the measured floor on that gap — a real token
        // count, never divided back into a percentage.
        delta = el('span', { class: 'row__delta' }, sinceCapture(deltaValue));
        metaChildren.push(delta);
      } else if (!primary?.capturedAt) {
        // No capture instant to name, so fall back to the row's own age.
        staleAge = el('span', { class: 'row__stale' }, '');
        const since = p.lastGoodAt ?? ctx.generatedAt;
        if (since) setAttr(staleAge, 'data-since', since);
        metaChildren.push(staleAge);
      } else if (tokenItemKind(p) !== 'none') {
        // The capture instant is already inside the window block; keep the
        // absolutes here. A stale CAPTURE is about the percentage, not about
        // the local corpus these counts come from, so the figure and its window
        // label are exactly the same as on a fresh row.
        metaTokens = el('span', { title: tokensTitle(p) }, tokenItemText(p));
        metaChildren.push(metaTokens);
      }
    } else {
      // Pending FIRST, as in cost.ts. Until the tool's first scan answers, a
      // token figure or burn rate on this line would present a partial read as
      // complete; and no figure is a gap in what we have READ, which "Token
      // bilgisi yok" would state as a fact about the tool.
      const pending = ctx.isPending(p.id);
      if (pending) {
        metaChildren.push(el('span', { class: 'row__pending' }, t('row.tokens.pending')));
      } else if (tokenItemKind(p) !== 'none') {
        metaTokens = el('span', { title: tokensTitle(p) }, tokenItemText(p));
        metaChildren.push(metaTokens);
      }
      if (!pending && p.burnRatePerHour !== null) {
        // The rate is measured over the FIVE-HOUR window and now sits beside a
        // weekly count, so it names its own window on the visible line. A title
        // alone would not do it: the misreading happens at a glance.
        metaBurn = el(
          'span',
          { title: modelsTitle(p) || t('row.burnTitle') },
          t('row.burn.fiveHour', { rate: burnRate(p.burnRatePerHour) }),
        );
        metaChildren.push(metaBurn);
      }
      // ADR-002 A3.19: when the cost reader KNOWS records could not be read,
      // "Token bilgisi yok" would state the gap as a fact about the tool. The
      // cost block used to say what happened with a cause line; with cause
      // lines gone (2026-09-23) this line says it, in the words the zero-count
      // case already uses, so the gap is never silent.
      if (metaChildren.length === 0) {
        metaChildren.push(
          el('span', {}, p.weeklyCost?.sourceIncomplete ? t('row.tokens.uncounted') : t('row.noTokens')),
        );
      }
    }

    // The five-hour reset used to be printed here too. It is now the weekly
    // block's neighbour, one countdown per window, so a single reset time on
    // this line would be the third figure describing the five-hour window and
    // none describing the weekly one.

    // A REAL SPACE BETWEEN ITEMS, not only a CSS one.
    //
    // The visible separator is a `::after` on every item but the last (row.css),
    // and pseudo-element content is NOT part of `textContent` — so with nothing
    // else between the spans, anything reading this line AS A STRING saw
    // "…6,2 Mn token5 saat: 240 B token/sa", two figures glued into one word.
    // That predates the labels (the old "·" was a pseudo-element too) but the
    // labels made it matter: each item is now a sentence, and assistive tech
    // that concatenates adjacent inline nodes runs them together.
    //
    // A whitespace-only text node between flex items is not rendered, so this
    // changes nothing visually and cannot reintroduce the stray leading dot; it
    // exists purely so the text stream has a boundary where the layout has one.
    const spaced: (HTMLElement | string)[] = [];
    metaChildren.forEach((child, i) => {
      if (i > 0) spaced.push(' ');
      spaced.push(child);
    });
    const meta = el('div', { class: 'row__meta' }, ...spaced);
    replaceChildrenWith(body, [line1, meterNode, meta]);
  }

  refs.name = name;
  refs.plan = plan;
  refs.meter = meter;
  refs.metaTokens = metaTokens;
  refs.metaBurn = metaBurn;
  refs.staleAge = staleAge;
  refs.delta = delta;
  refs.action = action;
  refs.retry = retry;
}

// ------------------------------------------------------------------- row

export function createRow(provider: ProviderSnapshot, ctx: RowContext, now: number): RowHandle {
  const root = el('li', { class: 'row', role: 'listitem' }) as HTMLLIElement;
  const refs: Refs = { ...EMPTY_REFS };

  // The identity tile IS the drag grip. Making it a real <button> is what buys
  // the keyboard path: it is tab-reachable, it takes focus, and Alt+Arrow on it
  // moves the row. A separate handle column would cost 12px of meter width and
  // add a second thing to aim at in a 360px panel.
  refs.grip = el('button', {
    type: 'button',
    class: 'grip',
    'aria-describedby': REORDER_HELP_ID,
  }) as HTMLButtonElement;
  // `connected` is the "account is wired up" flag (contract.ts): true for
  // Claude once the bridge reports and for Antigravity when its store is
  // readable, false for a provider the user has not added yet. It paints the
  // mark in brand colour vs grey. The value is stamped once here; the mark's
  // live colour is kept correct across (dis)connects by the [data-connected]
  // ancestor applyChrome() re-asserts every render.
  refs.grip.appendChild(providerMark(provider.id, provider.connected));
  refs.grip.appendChild(gripDots());

  const body = el('div', { class: 'row__body' });

  // Created once and re-appended after every rebuild, so the disclosure stays
  // open across the 15s snapshot cadence. A block that collapsed itself every
  // time main pushed would be unusable.
  refs.cost = createCost(provider.id);
  // Same lifetime and the same reason: a disclosure that collapsed itself on
  // every 15s push would be unusable.
  refs.quotas = createQuotas(provider.id);
  // ADR-003 A8: the optional key block. Created once, like the two above, and
  // for the same reason — it holds a confirm step the user must not lose to a
  // snapshot push.
  refs.keys = createKeyBlock(provider.id, {
    onAddKey: (id) => ctx.onAddKey(id),
    onOpenTokenPage: (id) => ctx.onOpenTokenPage(id),
  });

  root.appendChild(refs.grip);
  root.appendChild(body);

  let shapeKey = '';
  let current: ProviderSnapshot = provider;

  function rebuild(p: ProviderSnapshot, context: RowContext, atNow: number): void {
    // Drop any previous row-level trailing button before rebuilding.
    if (refs.action && refs.action.parentElement === root) root.removeChild(refs.action);

    // Every optional ref is cleared here rather than in each builder, so a node
    // from the previous shape can never be written to after it is detached.
    refs.name = null;
    refs.plan = null;
    refs.meter = null;
    refs.metaTokens = null;
    refs.metaBurn = null;
    refs.staleAge = null;
    refs.delta = null;
    refs.action = null;
    refs.retry = null;

    if (p.status === 'loading') {
      buildSkeleton(refs, body);
    } else if (p.status === 'passive') {
      buildPassive(refs, body, root, p, context);
    } else {
      buildLive(refs, body, p, context, atNow);
    }
  }

  function applyChrome(p: ProviderSnapshot, context: RowContext): void {
    root.classList.toggle('row--passive', p.status === 'passive');
    setAttr(root, 'data-status', p.status);
    setAttr(root, 'data-provider', p.id);
    root.style.setProperty('--accent', p.accent);

    // The single switch behind the whole identity treatment: a connected
    // provider's mark is drawn in its brand colour on a tinted tile; every
    // other one is monochrome ink on no tile, at a lighter stroke. Colour is
    // never the only carrier — the tile, the stroke weight and the absence of
    // a meter all move together.
    setAttr(root, 'data-connected', p.connected ? 'true' : 'false');

    const step = meterStateStep(p.fiveHour, p.sevenDay);
    setAttr(root, 'data-state', step);
    // The row-level ramp mixes too, from the same window the step came from,
    // or the row's own colour would step while the block inside it glides.
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
    setAttr(refs.grip, 'data-tray', tray ? 'true' : null);
    setAttr(refs.grip, 'aria-label', t('row.gripLabel', { name: p.displayName }));
    // The tray consequence is stated on the control that causes it, and it is
    // stated honestly: a provider with no five-hour window drives an empty
    // ring, not a donut. Being connected is not enough: a Copilot row with a
    // key is connected and still has no five-hour window.
    const title = t('row.gripTitle', { name: p.displayName });
    const trayNote = tray
      ? p.connected && p.fiveHour != null
        ? t('row.gripTray')
        : t('row.gripTrayNoData')
      : '';
    setAttr(refs.grip, 'title', trayNote ? `${title} ${trayNote}` : title);
    refs.grip.disabled = p.status === 'loading';
    context.attachGrip(refs.grip, p.id, p.displayName);
  }

  function tick(atNow: number): void {
    // Both window countdowns live in the meter and are repainted by it, so the
    // row does not have to know how many windows the provider reported.
    if (refs.meter) refs.meter.tick(atNow);
    if (refs.staleAge) {
      const since = parseInstant(refs.staleAge.getAttribute('data-since'));
      if (since !== null) {
        const elapsed = Math.max(0, atNow - since);
        setText(refs.staleAge, t('row.staleAge', { ago: ago(elapsed) }));
        setAttr(refs.staleAge, 'title', t('row.staleAgeTitle', { ago: agoSpoken(elapsed) }));
      }
    }
  }

  function update(raw: ProviderSnapshot, context: RowContext, atNow: number): void {
    current = raw;
    // One normalisation point: everything below draws the effective status, so
    // the local staleness check cannot be forgotten at an individual call site.
    const p: ProviderSnapshot = {
      ...raw,
      status: effectiveStatus(raw, context),
      fiveHour: expireWindow(raw.fiveHour, atNow),
      sevenDay: expireWindow(raw.sevenDay, atNow),
    };
    // Pending decides whether the token line is "calculating" or a figure, so
    // it is structure: the flip to [] must rebuild the line.
    // sourceIncomplete decides whether the empty meta line says "no token
    // data", so it is structure too: a flip must rebuild the line.
    const nextShape = `${shapeKeyOf(p)}|${context.isPending(p.id) ? 'pending' : 'read'}|${p.weeklyCost?.sourceIncomplete ? 'incomplete' : 'complete'}`;
    if (nextShape !== shapeKey) {
      shapeKey = nextShape;
      rebuild(p, context, atNow);
    } else {
      if (refs.name) setText(refs.name, p.displayName);
      if (refs.plan && p.planLabel) {
        // NOT setText: that would drop the screen-reader prefix beside it. Only
        // the last child — the visible label — is the value that changes.
        const last = refs.plan.lastChild;
        if (last) last.textContent = p.planLabel;
      }
      if (refs.meter) refs.meter.update(p.fiveHour, p.sevenDay, p.status === 'stale', atNow);
      if (refs.metaTokens && tokenItemKind(p) !== 'none') {
        // The window label is part of the text, so it is rewritten with the
        // figure: a count that moved from an anchored quota week to a trailing
        // seven days must not keep the old window's name.
        setText(refs.metaTokens, tokenItemText(p));
        setAttr(refs.metaTokens, 'title', tokensTitle(p));
      }
      if (refs.metaBurn && p.burnRatePerHour !== null) {
        setText(refs.metaBurn, t('row.burn.fiveHour', { rate: burnRate(p.burnRatePerHour) }));
      }
      if (refs.delta) {
        // Consumption only rises inside a window, so this number moves between
        // captures. Leaving it frozen would present a stale floor as current —
        // exactly the optimistic reading it exists to prevent.
        const value = primaryWindow(p)?.billableSinceCapture ?? null;
        if (value !== null && value > 0) setText(refs.delta, sinceCapture(value));
      }
      const since = p.lastGoodAt ?? context.generatedAt;
      if (refs.staleAge && since) setAttr(refs.staleAge, 'data-since', since);
    }

    applyChrome(p, context);

    // ADR-002. Lives inside the row because the figure is that provider's, and
    // under the text column rather than the mark so it aligns with the name.
    // Re-appended rather than rebuilt: the builders call replaceChildrenWith()
    // on `body`, which would otherwise detach it on every shape change.
    // `p.status` here is the EFFECTIVE status, already run through
    // effectiveStatus() at the top of update(). It describes the LIMIT capture,
    // so it qualifies the per-model quota figures below (same capture) and
    // NOT the cost block: whether the token logs were read is the cost
    // source's own `sourceIncomplete` (ADR-002 A3.15).
    const degraded = p.status === 'stale' || p.status === 'error';

    // Per-model quota detail, ABOVE the cost block. Order is deliberate: this
    // one is about the same limit the meter above reports, so it belongs next
    // to it, while the cost block is a different kind of claim entirely and
    // reads as the row's footnote.
    refs.quotas.update(p.modelQuotas ?? null, p.displayName, degraded);
    if (!refs.quotas.el.hidden && refs.quotas.el.parentElement !== body) {
      body.appendChild(refs.quotas.el);
    }

    refs.cost.update(p.weeklyCost, p.displayName, context.isPending(p.id));
    if (!refs.cost.el.hidden && refs.cost.el.parentElement !== body) {
      body.appendChild(refs.cost.el);
    }

    // ADR-003 A8: the optional key block, last in the row. It is an EXTRA, so
    // it sits after everything the row shows without a key — and a provider
    // that cannot use a key renders nothing here at all.
    refs.keys.update(p);
    if (!refs.keys.el.hidden && refs.keys.el.parentElement !== body) {
      body.appendChild(refs.keys.el);
    }
    // A row carrying the cost block is several times taller than a plain one,
    // and a vertically centred mark then floats away from the name it
    // identifies. The flag lets CSS pin it to the first line for those rows
    // only, leaving the 44px and 64px rows centred as they were.
    // Either block makes the row tall enough that a vertically centred mark
    // drifts away from the name it identifies, so both drive the same flag.
    setAttr(
      root,
      'data-cost',
      refs.cost.el.hidden && refs.quotas.el.hidden ? null : 'true',
    );

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
    update,
    tick,
  };
}

/**
 * An identity-free skeleton row, used before the first snapshot arrives.
 * It fabricates no provider name and no number; it only holds the final
 * geometry so the list does not jump when real rows land.
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

  // No mark and no grip: there is no provider here yet to identify or move.
  root.appendChild(el('span', { class: 'grip grip--empty', 'aria-hidden': 'true' }));
  root.appendChild(body);
  return root;
}
