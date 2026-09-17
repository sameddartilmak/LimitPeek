/**
 * Notional weekly cost (ADR-002).
 *
 * THE CONSTRAINT THAT SHAPES EVERY LINE HERE
 * ------------------------------------------
 * The user is on a subscription and pays nothing per token. A currency figure
 * in a usage panel is read as money owed unless something stops it, so:
 *
 *   - the figure NEVER appears without its frame. "Yayımlanan API fiyatlarıyla
 *     … tutardı" is one sentence with the number inside it, not a label above
 *     a total. There is no code path that renders the amount alone.
 *   - the collapsed state carries the frame; the expanded state repeats it and
 *     adds the flat denial ("bu bir fatura değil").
 *   - the amount is a lower bound whenever anything was excluded from it, and
 *     it then reads "en az $X" rather than "$X". Both caveats — unpriced usage
 *     and the 1.25x cache-write fallback — can only push the true figure UP, so
 *     they collapse into one honest word in the number itself rather than into
 *     a footnote the user has to find.
 *
 * WHY THE BREAKDOWN IS NOT BEHIND THE DISCLOSURE
 * ----------------------------------------------
 * On this machine cache reads are 65% of the figure while being the cheapest
 * class per token, because there are 294 million of them. A single number
 * asserts; the composition explains. So the stacked bar and the two largest
 * classes are always visible, and only the table and the provenance are
 * behind the toggle. The causes of a floor are visible too, as one short line
 * each; their full sentences are behind their own "why" disclosure (ADR-002
 * A3.16), so "en az" is never on screen without a reason beside it.
 *
 * The composition bar is deliberately NOT on the state ramp. The ramp means
 * "distance to a limit"; this is a share of a whole with no limit in it, and
 * borrowing the ramp would make a large cache-read share look like danger.
 */

import type { CostByClass, ModelCost, WeeklyCost } from '../../../shared/contract.js';
import { el, on, replaceChildrenWith, setAttr, setText } from '../dom.js';
import {
  atLeast,
  dayRange,
  modelName,
  multiplier,
  priceDate,
  share,
  tokens as tokenCount,
  usd,
  usdWithUnit,
} from '../format.js';
import { t, type MessageKey } from '../i18n.js';

export interface CostHandle {
  el: HTMLElement;
  /**
   * There is deliberately no `degraded` parameter (ADR-002 A3.15). The row's
   * status says whether the RATE-LIMIT capture is fresh; it says nothing about
   * whether the token logs behind this figure were read. The only completeness
   * signal this block honours is the cost source's own
   * `WeeklyCost.sourceIncomplete`.
   */
  update(cost: WeeklyCost | null, providerName: string, pending?: boolean): void;
}

/**
 * DISPLAY classes. The price model splits a cache WRITE into 5-minute and
 * 1-hour tiers because they cost different multiples, but that split is a
 * pricing internal, not something the reader needs two rows for — so they are
 * shown as one cache-write line (`cost.class.cacheWrite`). Four rows read far
 * more calmly than five, and the total is identical (the two tiers are simply
 * summed for display). The TTL split still drives the PRICE (ADR-002 rule 1)
 * and the 1.25x-fallback caveat below; only the display merges.
 */
type DisplayKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/** Fixed labels, as catalog keys so they follow the language; order is by value at render time, largest first. */
const CLASS_LABEL: Record<DisplayKey, MessageKey> = {
  cacheRead: 'cost.class.cacheRead',
  output: 'cost.class.output',
  cacheWrite: 'cost.class.cacheWrite',
  input: 'cost.class.input',
};

const DISPLAY_KEYS: readonly DisplayKey[] = ['input', 'output', 'cacheWrite', 'cacheRead'];

/** The long-context suffix Codex pricing appends to a tier it excluded
 *  (src/core/codex/pricing.js `speedOf`: `${tier}-long-context`). */
const LONG_CONTEXT_SUFFIX = '-long-context';

/**
 * `ModelCost.speed` as words. ONE mapping for both tools: Claude's speed
 * ('standard' | 'fast') and Codex's tier group label, which is the tier
 * ('standard' | 'fast' | another recorded tier), `unknown-tier`, or either of
 * those with `-long-context` (src/core/codex/pricing.js `speedOf`).
 *
 * A code this table does not know is NEVER printed raw: a producer string is
 * not copy, and "unknown-tier" beside a model name reads as a model variant.
 * It degrades to a neutral label that still says the price tier is what could
 * not be matched — which is the only thing an unpriced row's label claims.
 */
function speedLabel(speed: string): string {
  if (speed.endsWith(LONG_CONTEXT_SUFFIX) && speed.length > LONG_CONTEXT_SUFFIX.length) {
    const tier = speed.slice(0, -LONG_CONTEXT_SUFFIX.length);
    return t('cost.speed.longContext', { tier: tierLabel(tier) });
  }
  return tierLabel(speed);
}

function tierLabel(tier: string): string {
  if (tier === 'standard') return t('cost.speed.standard');
  if (tier === 'fast') return t('cost.speed.fast');
  if (tier === 'unknown-tier') return t('cost.speed.unknownTier');
  return t('cost.speed.other');
}

interface Slice {
  key: DisplayKey;
  usd: number;
  fraction: number;
}

/** A byClass value, or 0 when it is missing/negative/non-finite. */
function pos(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0;
}

/**
 * Shares are computed against the SUM OF THE CLASSES, not against `totalUsd`.
 * They then always add to 100% whatever the producer's rounding does, and a
 * class can never claim a share of a total it was not part of. The two
 * cache-write tiers are summed into the single display class here.
 */
function slicesOf(byClass: CostByClass): { slices: Slice[]; sum: number } {
  const usdByKey: Record<DisplayKey, number> = {
    input: pos(byClass.input),
    output: pos(byClass.output),
    cacheRead: pos(byClass.cacheRead),
    cacheWrite: pos(byClass.cacheWrite5m) + pos(byClass.cacheWrite1h),
  };
  let sum = 0;
  for (const key of DISPLAY_KEYS) sum += usdByKey[key];
  const slices: Slice[] = DISPLAY_KEYS.map((key) => ({
    key,
    usd: usdByKey[key],
    fraction: sum > 0 ? usdByKey[key] / sum : 0,
  })).sort((a, b) => b.usd - a.usd);
  return { slices, sum };
}

/** Model+speed rows the price table had no entry for. */
function unpricedRows(cost: WeeklyCost): ModelCost[] {
  return cost.byModel.filter((entry) => entry.usd === null);
}

/** How many unpriced (model, tier) lines the COLLAPSED list names before the
 *  rest collapse into one counted line. Three reads at a glance. */
const MAX_UNPRICED_CAUSES = 3;

/** How many unpriced entries the OPEN "why" names before a counted
 *  "… N more" line. Every entry is either named or counted, never dropped. */
const MAX_UNPRICED_LISTED = 8;

/** The cause kinds, in display order; also the `data-cause`/`data-caveat` values. */
type CauseKind =
  | 'unpriced'
  | 'ttl'
  | 'unrecorded-writes'
  | 'assumed-tier'
  | 'fast-requested'
  | 'source-incomplete';

/**
 * One reason the figure is not exact: its short line(s), with the count, and
 * ONE short explanation (ADR-004 A3.2) revealed by "why". Unpriced usage is
 * one group with a line per (model, tier) and a single explanation for all.
 */
interface CauseGroup {
  kind: CauseKind;
  lines: { text: string; more?: boolean }[];
  explanation: string;
}

/**
 * The cause list (ADR-002 A3.16): one short line per reason the figure is not
 * exact. Every entry is one-way: an unpriced model adds cost that is missing,
 * a 1-hour write charged at 1.25x is undercharged, a write Codex recorded as 0
 * is missing, an event priced at Standard may have cost more, and events the
 * reader could not read are missing. None can make the true figure smaller.
 *
 * THE FLOOR IS DERIVED FROM THIS LIST, not from a parallel predicate. "en az"
 * is printed exactly when this returns at least one group, so a floor with no
 * visible cause is not a state the code can reach (A3.16), and a cause with no
 * floor is not one either.
 *
 * `sourceIncomplete` is the cost reader's own statement that it missed events
 * in the window (A3.15). The row's status is NOT read here: it describes the
 * limit capture, and the stale-limit caveat it used to drive was false for a
 * user who had simply not used the tool lately.
 *
 * `open` widens only the unpriced group: collapsed it names two entries and
 * counts the rest; open it names up to eight and counts the rest.
 */
function causeGroups(cost: WeeklyCost, noFigure: boolean, open: boolean): CauseGroup[] {
  const groups: CauseGroup[] = [];

  // Named from byModel, not from `unpricedModels`: see unpricedItems().
  const items = unpricedItems(cost);
  if (items.length > 0) {
    const cap = open ? MAX_UNPRICED_LISTED : MAX_UNPRICED_CAUSES;
    const shown = items.length > cap ? (open ? cap : cap - 1) : items.length;
    const lines: CauseGroup['lines'] = items
      .slice(0, shown)
      .map((item) => ({ text: t('cost.cause.unpriced', { item }) }));
    if (items.length > shown) {
      lines.push({ text: t('cost.cause.unpricedMore', { count: items.length - shown }), more: true });
    }
    groups.push({ kind: 'unpriced', lines, explanation: t('cost.caveat.unpriced') });
  }

  // NOT the unrecorded-writes cause below: this one is Claude's missing 5m/1h
  // split priced at the 1.25x floor, a claim that is false for Codex.
  if (cost.fallbackWriteEvents > 0) {
    groups.push({
      kind: 'ttl',
      lines: [{ text: t('cost.cause.ttl', { count: cost.fallbackWriteEvents }) }],
      explanation: t('cost.caveat.ttl', { low: multiplier(1.25), high: multiplier(2) }),
    });
  }
  if (cost.unrecordedWriteEvents > 0) {
    groups.push({
      kind: 'unrecorded-writes',
      lines: [{ text: t('cost.cause.unrecordedWrites', { count: cost.unrecordedWriteEvents }) }],
      explanation: t('cost.caveat.unrecordedWrites'),
    });
  }
  // ADR-002 A3.17/A3.21: no recorded tier yet, priced at Standard as a floor.
  if (cost.assumedTierEvents > 0) {
    groups.push({
      kind: 'assumed-tier',
      lines: [{ text: t('cost.cause.assumedTier', { count: cost.assumedTierEvents }) }],
      explanation: t('cost.caveat.assumedTier'),
    });
  }
  // A3.18: Fast was REQUESTED, not proven billed; priced at Standard as a floor.
  if (cost.fastRequestedEvents > 0) {
    groups.push({
      kind: 'fast-requested',
      lines: [{ text: t('cost.cause.fastRequested', { count: cost.fastRequestedEvents }) }],
      explanation: t('cost.caveat.fastRequested'),
    });
  }
  // With no amount on screen, "the amount covers only…" describes a figure
  // that is not there (A3.19): the no-figure line says no amount can be given.
  if (cost.sourceIncomplete) {
    groups.push({
      kind: 'source-incomplete',
      lines: [{ text: t('cost.cause.sourceIncomplete') }],
      explanation: noFigure ? t('cost.caveat.degradedNoFigure') : t('cost.caveat.degraded'),
    });
  }
  return groups;
}

/**
 * Unpriced usage as "model · tier · tokens". Named from byModel, because
 * `unpricedModels` is de-duplicated by model and DROPS the speed
 * (src/core/pricing.js:261): it would say "claude-opus-4-8 is unpriced" while
 * a priced standard-speed row for the same model sits in the table. ADR-002
 * amendment 2 added ModelCost.speed for exactly this contradiction. The bare
 * list is only a fallback for a payload whose rows were rejected.
 */
function unpricedItems(cost: WeeklyCost): string[] {
  const rows = unpricedRows(cost);
  return rows.length > 0
    ? rows.map((row) => {
        const tokens = row.tokens ? ` · ${tokenCount(row.tokens.billable)}` : '';
        return `${modelName(row.model)} · ${speedLabel(row.speed)}${tokens}`;
      })
    : cost.unpricedModels.slice();
}

/**
 * `windowAnchored` is not cosmetic: when true the window ends at the weekly
 * quota reset, which is in the FUTURE, so it is the current week in progress
 * and calling it "son 7 gün" would be wrong in both directions — wrong end,
 * wrong tense.
 */
function windowLabel(cost: WeeklyCost, now: number): string {
  const range = dayRange(cost.windowStart, cost.windowEnd);
  if (!cost.windowAnchored) {
    return range ? t('cost.window.last7Range', { range }) : t('cost.window.last7');
  }
  const end = Date.parse(cost.windowEnd);
  const ongoing = Number.isFinite(end) && now < end;
  const base = range ? t('cost.window.quotaWeekRange', { range }) : t('cost.window.quotaWeek');
  return ongoing ? t('cost.window.ongoing', { base }) : base;
}

export function createCost(providerId: string): CostHandle {
  const detailId = `cost-detail-${providerId}`;

  // --- collapsed ---------------------------------------------------------
  const chevron = el('span', { class: 'cost__chev', 'aria-hidden': 'true' });
  const summary = el('span', { class: 'cost__summary' });
  const toggle = el(
    'button',
    { type: 'button', class: 'cost__toggle', 'aria-expanded': 'false', 'aria-controls': detailId },
    chevron,
    summary,
  ) as HTMLButtonElement;

  const bar = el('div', { class: 'cost__bar', 'aria-hidden': 'true' });
  const caption = el('p', { class: 'cost__caption' });

  // --- causes (ADR-002 A3.16, ADR-004 A3) ----------------------------------
  // Always visible whenever the figure is a floor or absent: "en az" is in the
  // collapsed summary, so its reasons must be too. The "why" toggle HEADS the
  // list, so what it reveals (one shared lead, then one short muted line under
  // each cause) always appears after the control, never above it.
  const causesId = `cost-causes-${providerId}`;
  const whyId = `cost-why-${providerId}`;
  const whyLead = el('p', { class: 'cost__why-lead' });
  whyLead.hidden = true;
  const causes = el('ul', { class: 'cost__causes', id: causesId });
  const whyBody = el('div', { class: 'cost__why-body', id: whyId }, whyLead, causes);
  const whyChevron = el('span', { class: 'cost__chev', 'aria-hidden': 'true' });
  const whyText = el('span', { class: 'cost__whytext' });
  // The accessible name IS the visible text (label-in-name), and the cause
  // list is its description, so a reader tabbing between rows hears which
  // causes this "why" belongs to without a second, divergent label.
  const whyToggle = el(
    'button',
    {
      type: 'button',
      class: 'cost__why',
      'aria-expanded': 'false',
      'aria-controls': whyId,
      'aria-describedby': causesId,
    },
    whyChevron,
    whyText,
  ) as HTMLButtonElement;
  const causeBlock = el('div', { class: 'cost__cause-block' }, whyToggle, whyBody);
  causeBlock.hidden = true;

  // --- expanded ----------------------------------------------------------
  const detailLead = el('p', { class: 'cost__lead' });
  const detailDenial = el('p', { class: 'cost__denial' });
  const table = el('div', { class: 'cost__table' });
  const provenance = el('div', { class: 'cost__prov' });
  const detail = el(
    'div',
    { class: 'cost__detail', id: detailId },
    detailLead,
    detailDenial,
    table,
    provenance,
  );
  detail.hidden = true;

  // ADR-002 A3.12: the line shown while the tool's first scan is running. A
  // hidden block would read as "no usage"; a "$0" would be a figure built out
  // of data not yet read. Plain text, not the toggle: there is nothing to open.
  const pendingLine = el('p', { class: 'cost__pending' });
  pendingLine.hidden = true;

  const root = el('div', { class: 'cost' }, pendingLine, toggle, bar, caption, causeBlock, detail);
  root.hidden = true;

  let expanded = false;
  function applyExpanded(): void {
    detail.hidden = !expanded;
    setAttr(toggle, 'aria-expanded', expanded ? 'true' : 'false');
    setAttr(root, 'data-expanded', expanded ? 'true' : 'false');
  }
  on(toggle, 'click', () => {
    expanded = !expanded;
    applyExpanded();
  });

  // Its own state, independent of the breakdown: a user who only wants to
  // know why the figure is a bound should not have to open the table too.
  let whyExpanded = false;
  /** The last rendered cost, so toggling "why" can re-render the list. */
  let lastCauses: { cost: WeeklyCost; noFigure: boolean } | null = null;
  function applyWhy(): void {
    setAttr(whyToggle, 'aria-expanded', whyExpanded ? 'true' : 'false');
    setAttr(causeBlock, 'data-why', whyExpanded ? 'true' : 'false');
    if (lastCauses) renderCauses(lastCauses.cost, lastCauses.noFigure);
  }
  on(whyToggle, 'click', () => {
    whyExpanded = !whyExpanded;
    applyWhy();
  });

  function renderBar(slices: readonly Slice[]): void {
    // Sub-pixel segments are dropped rather than rounded up to a visible sliver
    // that overstates them. At 328px, 0.5% is 1.6px — the floor for a segment
    // that can still be told apart from its neighbour's gap.
    const shown = slices.filter((s) => s.fraction >= 0.005);
    replaceChildrenWith(
      bar,
      shown.map((slice, index) => {
        const segment = el('i', { class: 'cost__seg', 'data-rank': String(Math.min(index, 4)) });
        segment.style.flexGrow = slice.fraction.toFixed(4);
        return segment;
      }),
    );
    // An empty track is not a composition; it is a grey line pretending to be
    // one. Hide it rather than draw a bar with nothing in it.
    bar.hidden = shown.length === 0;
  }

  function renderTable(slices: readonly Slice[]): void {
    replaceChildrenWith(
      table,
      slices
        .filter((slice) => slice.usd > 0)
        .map((slice) => {
          const fill = el('i', { class: 'cost__rowbar', 'aria-hidden': 'true' });
          fill.style.setProperty('--w', slice.fraction.toFixed(4));
          return el(
            'div',
            { class: 'cost__row' },
            el('span', { class: 'cost__k' }, t(CLASS_LABEL[slice.key])),
            el('span', { class: 'cost__v u-num' }, usd(slice.usd)),
            el('span', { class: 'cost__p u-num' }, share(slice.fraction)),
            fill,
          );
        }),
    );
  }

  /**
   * The cause list and, when "why" is open, its explanations. Each cause stays
   * its own statement, tied to its own line: usage MISSING from the total,
   * usage IN it at too low a rate, writes never recorded, a tier not recorded
   * or not proven, and records never read are different failures, and merging
   * them would lose which is happening (ADR-004 A3: short, not merged).
   *
   * The shared lead carries the lower-bound claim once. With no figure there
   * is no bound to state, so there is no lead: only the short lines.
   */
  function renderCauses(cost: WeeklyCost, noFigure: boolean): number {
    const groups = causeGroups(cost, noFigure, whyExpanded);
    replaceChildrenWith(
      causes,
      groups.map((group) => {
        const item = el('li', { class: 'cost__group', 'data-cause': group.kind });
        for (const line of group.lines) {
          item.appendChild(
            el('span', { class: line.more ? 'cost__cause cost__cause--more' : 'cost__cause' }, line.text),
          );
        }
        const explanation = el(
          'span',
          { class: 'cost__caveat', 'data-caveat': group.kind },
          group.explanation,
        );
        explanation.hidden = !whyExpanded;
        item.appendChild(explanation);
        return item;
      }),
    );
    setText(whyLead, t('cost.why.lead'));
    whyLead.hidden = !whyExpanded || noFigure || groups.length === 0;
    return groups.length;
  }

  function update(
    cost: WeeklyCost | null,
    providerName: string,
    pending = false,
  ): void {
    // Pending wins over any figure: until the first scan result the cost is
    // incomplete, and nothing here may present it as known, as zero or as none.
    setAttr(root, 'data-pending', pending ? 'true' : null);
    pendingLine.hidden = !pending;
    toggle.hidden = pending;
    if (pending) {
      setText(pendingLine, t('cost.pending'));
      bar.hidden = true;
      caption.hidden = true;
      causeBlock.hidden = true;
      detail.hidden = true;
      root.hidden = false;
      return;
    }
    detail.hidden = !expanded;

    if (!cost) {
      root.hidden = true;
      return;
    }

    const { slices, sum } = slicesOf(cost.byClass);
    // Counted once, collapsed, for the floor decision below; the open state
    // only names more of the same unpriced entries, never adds a cause.
    const causeCount = causeGroups(cost, false, false).length;
    const hasCaveat = causeCount > 0;

    /**
     * THE MOST IMPORTANT LINE IN THIS FILE.
     *
     * A figure is printed only when there is a priced figure to print. When
     * every model in the window was unpriced, `totalUsd` is 0 and `byClass` is
     * all zeros — a truthful report that NOTHING COULD BE PRICED — and the
     * previous guard turned that into "en az $0,00", a currency claim built
     * out of the absence of one.
     *
     * The mechanism was the bitter part: the old guard was
     * `sum <= 0 && totalUsd <= 0 && !hasCaveat`, so the caveat — the very
     * thing that exists to signal unpriced usage — was what let the zero
     * through. The guard written to prevent a silent zero admitted it.
     *
     * This is not hypothetical. The price table is a hand-transcribed
     * 2026-06-24 snapshot of five model families; one release naming a new
     * family turns a real week of spend into "$0,00".
     *
     * Testing `hasFigure` rather than `byModel.every(m => m.usd === null)`
     * also covers the variant where `byModel` is empty but `unpricedModels`
     * is not — same lie, no rows to detect it from.
     */
    const hasFigure = cost.totalUsd > 0 || sum > 0;

    // Nothing priced and nothing to warn about is not a $0 week, it is no
    // week. But an all-unpriced week is SHOWN, never hidden: a hidden block is
    // indistinguishable from a provider with no usage, which is the same
    // no-data-versus-zero collision as the tray's ring.
    if (!hasFigure && !hasCaveat) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    setAttr(root, 'data-unpriced', hasFigure ? null : 'true');

    // No figure AND nothing unpriced: the causes are all there is to say (in
    // practice sourceIncomplete: the reader missed records and priced none).
    // Hiding the block would read as "no usage", and cost.unpricedSummary
    // ("not in the price list") would be false, so the block is the cause
    // list and its "why" alone: no toggle, no amount, no breakdown.
    const causesOnly = !hasFigure && unpricedItems(cost).length === 0;
    setAttr(root, 'data-causes-only', causesOnly ? 'true' : null);
    toggle.hidden = causesOnly;

    // A floor exactly when there is a visible cause for it (A3.16).
    const floor = hasFigure && causeCount > 0;

    if (hasFigure) {
      // The floor word is bound to the figure by atLeast(), so the English
      // word order ("{amount} at published API prices") cannot separate them.
      const amount = floor ? atLeast(usd(cost.totalUsd)) : usd(cost.totalUsd);
      setText(summary, t('cost.summary', { amount }));
      // The spoken name carries the whole frame plus the denial, because a
      // screen reader user gets the button label with no surrounding layout to
      // qualify it.
      const named = usdWithUnit(cost.totalUsd);
      setAttr(
        toggle,
        'aria-label',
        t('cost.toggleLabel', {
          provider: providerName,
          amount: floor ? atLeast(named) : named,
        }),
      );
    } else {
      // No number anywhere in this branch — not zero, not a bound. The user is
      // told that usage happened and that we could not price it, and the model
      // list below carries the token counts that prove the first half.
      setText(summary, t('cost.unpricedSummary'));
      setAttr(toggle, 'aria-label', t('cost.unpricedToggleLabel', { provider: providerName }));
    }

    renderBar(slices);

    // The two largest classes, named. This is the line that turns the figure
    // from an assertion into an explanation, so it is never behind the toggle.
    const top = slices.filter((slice) => slice.usd > 0).slice(0, 2);
    setText(
      caption,
      top.map((slice) => `${t(CLASS_LABEL[slice.key])} ${share(slice.fraction)}`).join(' · '),
    );
    caption.hidden = top.length === 0;

    setText(
      detailLead,
      hasFigure
        ? t('cost.detailLead', {
            amount: floor ? atLeast(usdWithUnit(cost.totalUsd)) : usdWithUnit(cost.totalUsd),
          })
        : t('cost.detailLeadUnpriced'),
    );
    // The denial answers "is this money I owe?". With no amount on screen there
    // is nothing to deny, and printing it anyway would imply a figure exists.
    detailDenial.hidden = !hasFigure;
    setText(detailDenial, t('cost.denial'));

    renderTable(slices);

    // A cause list that empties closes its disclosure, so a later floor does
    // not reappear already open with no click behind it.
    if (causeCount === 0) whyExpanded = false;
    lastCauses = { cost, noFigure: !hasFigure };
    causeBlock.hidden = causeCount === 0;
    setText(whyText, hasFigure ? t('cost.why.toggle') : t('cost.why.toggleUnpriced'));
    applyWhy();
    if (causesOnly) {
      bar.hidden = true;
      caption.hidden = true;
      detail.hidden = true;
      setAttr(root, 'data-expanded', 'false');
      return;
    }

    // ADR-002 rule 3 obliges the figure to say when its prices were current.
    // When main did not tell us, SAYING SO discharges that obligation; quietly
    // dropping the line would leave a priced figure with no provenance at all
    // and nothing on screen to reveal the gap.
    replaceChildrenWith(provenance, [
      el('span', {}, windowLabel(cost, Date.now())),
      el(
        'span',
        cost.pricesAsOf ? {} : { class: 'cost__gap' },
        cost.pricesAsOf
          ? t('cost.pricesAsOf', { date: priceDate(cost.pricesAsOf) })
          : t('cost.pricesDateMissing'),
      ),
    ]);

    applyExpanded();
  }

  return { el: root, update };
}
