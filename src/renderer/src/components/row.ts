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
  parseInstant,
  sinceCapture,
  tokens,
} from '../format.js';
import { createCost, type CostHandle } from './cost.js';
import { createQuotas, type QuotaHandle } from './quotas.js';
import { gripDots, providerMark } from './logo.js';
import { createMeter, isDrawable, meterStateStep, type MeterHandle } from './meter.js';

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
    p.tokens ? 'tok' : 'no-tok',
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

function tokensTitle(p: ProviderSnapshot): string {
  if (!p.tokens) return '';
  const t = p.tokens;
  return [
    `Girdi ${compact(t.input)}`,
    `Çıktı ${compact(t.output)}`,
    `Önbellek yazma ${compact(t.cacheWrite)}`,
    `Önbellek okuma ${compact(t.cacheRead)} (faturalanan toplama dahil değil)`,
  ].join(' · ');
}

function modelsTitle(p: ProviderSnapshot): string {
  const list = p.byModel ?? [];
  if (list.length === 0) return '';
  return list.map((entry) => `${entry.model}: ${compact(entry.billable)}`).join(' · ');
}

function errorText(code: string | undefined): string {
  switch (code) {
    case 'bridge-missing':
      return 'Köprü kurulu değil';
    case 'permission-denied':
      return 'Dosyalara erişilemedi';
    case 'parse-failed':
      return 'Kayıtlar okunamadı';
    case 'timeout':
      return 'Zaman aşımı';
    default:
      return 'Güncellenemedi';
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
  const detailId = `setup-detail-${p.id}`;
  const detailText = p.setupAction?.detail || 'Bu araç henüz bağlı değil.';
  const detail = el(
    'span',
    { class: 'row__meta-detail', id: detailId, title: detailText },
    detailText,
  );

  replaceChildrenWith(body, [
    el('div', { class: 'row__line' }, name),
    el('div', { class: 'row__meta' }, detail),
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
  const plan = p.planLabel ? el('span', { class: 'row__plan' }, p.planLabel) : null;
  const line1Children: Array<HTMLElement | null> = [name, plan, el('span', { class: 'row__gap' })];

  const drawable = isDrawable(p.fiveHour) || isDrawable(p.sevenDay);

  // The percentages used to live here, on the name line, one per row. They
  // moved into the window blocks below: with two windows to report there is no
  // honest way to put "the" percentage next to the provider's name, and the
  // one that was there described the five-hour window without saying so.

  // --- an inline connect action for a connected-but-unmeasurable row -----
  let action: HTMLButtonElement | null = null;
  if (!drawable && p.setupAction) {
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
    const fiveHourNote = p.modelQuotas?.selectedModel ? 'seçili model' : undefined;
    meter = createMeter(p.fiveHour, p.sevenDay, p.status === 'stale', fiveHourNote);
    meter.update(p.fiveHour, p.sevenDay, p.status === 'stale', now);
    meterNode = meter.el;
  } else {
    meterNode = el(
      'div',
      { class: 'row__unknown' },
      el('span', {}, 'Kullanım oranı bilinmiyor'),
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
      { type: 'button', class: 'btn', 'aria-label': `${p.displayName}: yeniden dene` },
      'Yeniden dene',
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
      } else if (p.tokens) {
        // The capture instant is already inside the window block; keep the
        // absolutes here.
        metaTokens = el('span', { title: tokensTitle(p) }, tokens(p.tokens.billable));
        metaChildren.push(metaTokens);
      }
    } else {
      if (p.tokens) {
        metaTokens = el('span', { title: tokensTitle(p) }, tokens(p.tokens.billable));
        metaChildren.push(metaTokens);
      }
      if (p.burnRatePerHour !== null) {
        metaBurn = el(
          'span',
          { title: modelsTitle(p) || 'Etkin penceredeki faturalanan token hızı' },
          burnRate(p.burnRatePerHour),
        );
        metaChildren.push(metaBurn);
      }
      if (metaChildren.length === 0) {
        metaChildren.push(el('span', {}, 'Token bilgisi yok'));
      }
    }

    // The five-hour reset used to be printed here too. It is now the weekly
    // block's neighbour, one countdown per window, so a single reset time on
    // this line would be the third figure describing the five-hour window and
    // none describing the weekly one.

    const meta = el('div', { class: 'row__meta' }, ...metaChildren);
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
  refs.grip.appendChild(providerMark(provider.id));
  refs.grip.appendChild(gripDots());

  const body = el('div', { class: 'row__body' });

  // Created once and re-appended after every rebuild, so the disclosure stays
  // open across the 15s snapshot cadence. A block that collapsed itself every
  // time main pushed would be unusable.
  refs.cost = createCost(provider.id);
  // Same lifetime and the same reason: a disclosure that collapsed itself on
  // every 15s push would be unusable.
  refs.quotas = createQuotas(provider.id);

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

    setAttr(root, 'aria-busy', p.status === 'loading' ? 'true' : null);
    setAttr(
      root,
      'aria-label',
      p.status === 'loading' ? `${p.displayName}: yükleniyor` : null,
    );

    // --- the grip -------------------------------------------------------
    const tray = context.isTrayRow(p.id);
    setAttr(refs.grip, 'data-tray', tray ? 'true' : null);
    setAttr(refs.grip, 'aria-label', `${p.displayName}: sırayı değiştir`);
    // The tray consequence is stated on the control that causes it, and it is
    // stated honestly: a provider with no five-hour window drives an empty
    // ring, not a donut.
    const trayNote = tray
      ? p.connected
        ? ' Tepsi simgesi bu aracı gösteriyor.'
        : ' Tepsi simgesi bu aracı gösteriyor, ancak bu araç bağlı olmadığı için veri çizilmiyor.'
      : '';
    setAttr(
      refs.grip,
      'title',
      `${p.displayName} — sürükleyerek taşıyın.${trayNote}`,
    );
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
        setText(refs.staleAge, `${ago(elapsed)} güncellendi`);
        setAttr(refs.staleAge, 'title', `Son doğru değer: ${agoSpoken(elapsed)}`);
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
    const nextShape = shapeKeyOf(p);
    if (nextShape !== shapeKey) {
      shapeKey = nextShape;
      rebuild(p, context, atNow);
    } else {
      if (refs.name) setText(refs.name, p.displayName);
      if (refs.plan && p.planLabel) setText(refs.plan, p.planLabel);
      if (refs.meter) refs.meter.update(p.fiveHour, p.sevenDay, p.status === 'stale', atNow);
      if (refs.metaTokens && p.tokens) {
        setText(refs.metaTokens, tokens(p.tokens.billable));
        setAttr(refs.metaTokens, 'title', tokensTitle(p));
      }
      if (refs.metaBurn && p.burnRatePerHour !== null) {
        setText(refs.metaBurn, burnRate(p.burnRatePerHour));
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
    // effectiveStatus() at the top of update(), so a snapshot that main has
    // stopped pushing degrades the cost figure too — not just the meter.
    const degraded = p.status === 'stale' || p.status === 'error';

    // Per-model quota detail, ABOVE the cost block. Order is deliberate: this
    // one is about the same limit the meter above reports, so it belongs next
    // to it, while the cost block is a different kind of claim entirely and
    // reads as the row's footnote.
    refs.quotas.update(p.modelQuotas ?? null, p.displayName, degraded);
    if (!refs.quotas.el.hidden && refs.quotas.el.parentElement !== body) {
      body.appendChild(refs.quotas.el);
    }

    refs.cost.update(p.weeklyCost, p.displayName, degraded);
    if (!refs.cost.el.hidden && refs.cost.el.parentElement !== body) {
      body.appendChild(refs.cost.el);
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
    'aria-label': 'Yükleniyor',
  }) as HTMLLIElement;

  const body = el('div', { class: 'row__body' });
  const refs: Refs = { ...EMPTY_REFS };
  buildSkeleton(refs, body);

  // No mark and no grip: there is no provider here yet to identify or move.
  root.appendChild(el('span', { class: 'grip grip--empty', 'aria-hidden': 'true' }));
  root.appendChild(body);
  return root;
}
