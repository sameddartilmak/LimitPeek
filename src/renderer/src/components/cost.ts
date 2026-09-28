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
 *   - the amount is printed as it is, with no "en az" and no cause lines under
 *     it. The owner ruled the floor marker out (2026-09-23): it was grey text
 *     under every figure that the reader learned to skip. The producer still
 *     sends the floor fields (contract.ts WeeklyCost); this block just does not
 *     draw them.
 *
 * WHY THE BREAKDOWN IS NOT BEHIND THE DISCLOSURE
 * ----------------------------------------------
 * On this machine cache reads are 65% of the figure while being the cheapest
 * class per token, because there are 294 million of them. A single number
 * asserts; the composition explains. So the stacked bar and the two largest
 * classes are always visible, and only the table and the provenance are
 * behind the toggle.
 *
 * The composition bar is deliberately NOT on the state ramp. The ramp means
 * "distance to a limit"; this is a share of a whole with no limit in it, and
 * borrowing the ramp would make a large cache-read share look like danger.
 */

import type { CostByClass, WeeklyCost } from '../../../shared/contract.js';
import { el, on, replaceChildrenWith, setAttr, setText } from '../dom.js';
import { dayRange, priceDate, share, usd, usdWithUnit } from '../format.js';
import { t, type MessageKey } from '../i18n.js';

export interface CostHandle {
  el: HTMLElement;
  /**
   * There is deliberately no `degraded` parameter (ADR-002 A3.15). The row's
   * status says whether the RATE-LIMIT capture is fresh; it says nothing about
   * whether the token logs behind this figure were read, so it never qualifies
   * the figure here.
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

/**
 * True when the tool has no price table at all (Kimi, ADR-003 A6): every row is
 * unpriced for a reason that says so. "The price list's date was not reported"
 * would then imply a list exists.
 */
function noPriceTable(cost: WeeklyCost): boolean {
  return (
    cost.byModel.length > 0 &&
    cost.byModel.every(
      (row) => row.usd === null && (row.speed === 'no-published-price' || row.speed === 'other-model-alias'),
    )
  );
}

/** True when every unpriced row recorded no model ('no-model'). */
function noModelOnly(cost: WeeklyCost): boolean {
  const rows = cost.byModel.filter((entry) => entry.usd === null);
  return rows.length > 0 && rows.every((row) => row.speed === 'no-model');
}

/** True when every unpriced row is a Grok Build turn xAI reported no amount for. */
function noReportedCostOnly(cost: WeeklyCost): boolean {
  const rows = cost.byModel.filter((entry) => entry.usd === null);
  return rows.length > 0 && rows.every((row) => row.speed === 'no-reported-cost');
}

/**
 * The tools whose figure is NOT "at published API prices" and so must name
 * its own source wherever the figure is shown (review F11): Qwen Code at
 * Alibaba Cloud Model Studio rates, Grok Build at the amount xAI itself
 * reported. `undated`: the source has no price list, so no date is stated.
 */
const PRICE_SOURCE: Readonly<Record<string, { summary: MessageKey; toggleLabel: MessageKey; asOf: MessageKey; undated?: true }>> = {
  qwen: { summary: 'cost.summaryQwen', toggleLabel: 'cost.toggleLabelQwen', asOf: 'cost.pricesAsOfQwen' },
  grok: { summary: 'cost.summaryGrok', toggleLabel: 'cost.toggleLabelGrok', asOf: 'cost.pricesReportedGrok', undated: true },
};

/**
 * True when some usage in the window could not be priced. `unpricedModels` is
 * read as well as the rows so a payload whose rows were rejected at the
 * boundary still counts as usage that happened.
 */
function hasUnpriced(cost: WeeklyCost): boolean {
  return cost.byModel.some((entry) => entry.usd === null) || cost.unpricedModels.length > 0;
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
  // Qwen Code and Grok Build name their own price source (PRICE_SOURCE).
  const source = Object.prototype.hasOwnProperty.call(PRICE_SOURCE, providerId) ? PRICE_SOURCE[providerId] : null;
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

  const root = el('div', { class: 'cost' }, pendingLine, toggle, bar, caption, detail);
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

    // Nothing priced and nothing unpriced is not a $0 week, it is no week. But
    // an all-unpriced week is SHOWN, never hidden: a hidden block is
    // indistinguishable from a provider with no usage, which is the same
    // no-data-versus-zero collision as the tray's ring.
    //
    // A week with no figure and nothing unpriced — in practice records the
    // reader could not open (sourceIncomplete) — used to show its cause line
    // alone. With cause lines gone there is nothing true left to print here,
    // so it is hidden; the row's token line already reads "sayılamadı" for
    // that week (row.ts weeklyTokenText).
    if (!hasFigure && !hasUnpriced(cost)) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    setAttr(root, 'data-unpriced', hasFigure ? null : 'true');

    if (hasFigure) {
      const amount = usd(cost.totalUsd);
      // Review F11: a figure not at published API prices names its source
      // where it is shown.
      setText(summary, t(source ? source.summary : 'cost.summary', { amount }));
      // The spoken name carries the whole frame plus the denial, because a
      // screen reader user gets the button label with no surrounding layout to
      // qualify it.
      const named = usdWithUnit(cost.totalUsd);
      setAttr(
        toggle,
        'aria-label',
        t(source ? source.toggleLabel : 'cost.toggleLabel', {
          provider: providerName,
          amount: named,
        }),
      );
    } else {
      // No number anywhere in this branch — not zero, not a bound. The user is
      // told that usage happened and that we could not price it, and the row's
      // token line carries the count that proves the first half.
      // Review F2: the reason is chosen by what is true. A tool with no price
      // table has no list to be missing from; tokens with no model were never
      // priceable; only a model absent from a real list is "not in the list".
      // A Grok turn with no amount was not missing from a list either: xAI
      // simply reported none.
      const reason = noPriceTable(cost)
        ? 'noTable'
        : noModelOnly(cost)
          ? 'noModel'
          : noReportedCostOnly(cost)
            ? 'noReport'
            : 'list';
      setText(
        summary,
        reason === 'noTable'
          ? t('cost.unpricedSummaryNoTable', { provider: providerName })
          : reason === 'noModel'
            ? t('cost.unpricedSummaryNoModel')
            : reason === 'noReport'
              ? t('cost.unpricedSummaryNoReport', { provider: providerName })
              : t('cost.unpricedSummary'),
      );
      setAttr(
        toggle,
        'aria-label',
        reason === 'noTable'
          ? t('cost.unpricedToggleLabelNoTable', { provider: providerName })
          : reason === 'noModel'
            ? t('cost.unpricedToggleLabelNoModel', { provider: providerName })
            : reason === 'noReport'
              ? t('cost.unpricedToggleLabelNoReport', { provider: providerName })
              : t('cost.unpricedToggleLabel', { provider: providerName }),
      );
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
        ? t('cost.detailLead', { amount: usdWithUnit(cost.totalUsd) })
        : t('cost.detailLeadUnpriced'),
    );
    // The denial answers "is this money I owe?". With no amount on screen there
    // is nothing to deny, and printing it anyway would imply a figure exists.
    detailDenial.hidden = !hasFigure;
    setText(detailDenial, t('cost.denial'));

    renderTable(slices);

    // ADR-002 rule 3 obliges the figure to say when its prices were current.
    // When main did not tell us, SAYING SO discharges that obligation; quietly
    // dropping the line would leave a priced figure with no provenance at all
    // and nothing on screen to reveal the gap.
    // Grok Build's amounts come from no list at all, so its line names the
    // source and states no date — which is not a gap in what we were told.
    const undated = Boolean(source?.undated);
    replaceChildrenWith(provenance, [
      el('span', {}, windowLabel(cost, Date.now())),
      el(
        'span',
        cost.pricesAsOf || undated ? {} : { class: 'cost__gap' },
        undated && source
          ? t(source.asOf)
          : cost.pricesAsOf
            ? source
              ? t(source.asOf, { date: priceDate(cost.pricesAsOf) })
              : t('cost.pricesAsOf', { date: priceDate(cost.pricesAsOf) })
            : noPriceTable(cost)
              ? t('cost.pricesNotPublished', { provider: providerName })
              : t('cost.pricesDateMissing'),
      ),
    ]);

    applyExpanded();
  }

  return { el: root, update };
}
