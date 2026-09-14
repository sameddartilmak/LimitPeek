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
 * classes are always visible, and only the table, the caveats and the
 * provenance are behind the toggle.
 *
 * The composition bar is deliberately NOT on the state ramp. The ramp means
 * "distance to a limit"; this is a share of a whole with no limit in it, and
 * borrowing the ramp would make a large cache-read share look like danger.
 */

import type { CostByClass, ModelCost, WeeklyCost } from '../../../shared/contract.js';
import { el, on, replaceChildrenWith, setAttr, setText } from '../dom.js';
import { compact, dayRange, integer, priceDate, share, usd, usdWithUnit } from '../format.js';

export interface CostHandle {
  el: HTMLElement;
  /** `degraded` is the row's effective status being 'stale' or 'error': the
   *  events behind the figure stop before the window does, so it is a floor. */
  update(cost: WeeklyCost | null, providerName: string, degraded?: boolean): void;
}

/**
 * DISPLAY classes. The price model splits a cache WRITE into 5-minute and
 * 1-hour tiers because they cost different multiples, but that split is a
 * pricing internal, not something the reader needs two rows for — so they are
 * shown as one "Önbellek yazma" line. Four rows read far more calmly than five,
 * and the total is identical (the two tiers are simply summed for display).
 */
type DisplayKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/** Fixed labels; order is by value at render time, largest first. */
const CLASS_LABEL: Record<DisplayKey, string> = {
  cacheRead: 'Önbellek okuma',
  output: 'Çıktı',
  cacheWrite: 'Önbellek yazma',
  input: 'Girdi',
};

const DISPLAY_KEYS: readonly DisplayKey[] = ['input', 'output', 'cacheWrite', 'cacheRead'];

/** `usage.speed` is a raw string from the transcript, so unknown values are
 *  shown verbatim rather than mapped to a guess. */
function speedLabel(speed: string): string {
  if (speed === 'standard') return 'standart';
  if (speed === 'fast') return 'hızlı';
  return speed;
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

/**
 * Anything excluded from the total, priced through a floor, or measured from a
 * feed that has stopped, makes the figure a lower bound. Every one of them is
 * one-way: an unpriced model adds cost that is missing, a 1-hour write charged
 * at 1.25x instead of 2x is undercharged, and a stale row's events stop before
 * the window does. None can make the true figure smaller.
 *
 * `degraded` is the row's own status. The meter above dims itself and the row
 * reports its own age when the data stops, but the cost block underneath was
 * still asserting a window ending today from events that may stop days
 * earlier. Putting that qualification in the NUMBER rather than in the
 * expanded caveat is deliberate: a caveat behind a disclosure most users never
 * open is not a caveat.
 */
function isFloor(cost: WeeklyCost, degraded: boolean): boolean {
  return (
    degraded ||
    cost.fallbackWriteEvents > 0 ||
    cost.unpricedModels.length > 0 ||
    unpricedRows(cost).length > 0
  );
}

/**
 * `windowAnchored` is not cosmetic: when true the window ends at the weekly
 * quota reset, which is in the FUTURE, so it is the current week in progress
 * and calling it "son 7 gün" would be wrong in both directions — wrong end,
 * wrong tense.
 */
function windowLabel(cost: WeeklyCost, now: number): string {
  const range = dayRange(cost.windowStart, cost.windowEnd);
  if (!cost.windowAnchored) return range ? `Son 7 gün · ${range}` : 'Son 7 gün';
  const end = Date.parse(cost.windowEnd);
  const ongoing = Number.isFinite(end) && now < end;
  const base = range ? `${range} kota haftası` : 'Bu kota haftası';
  return ongoing ? `${base} · sürüyor` : base;
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

  // --- expanded ----------------------------------------------------------
  const detailLead = el('p', { class: 'cost__lead' });
  const detailDenial = el('p', { class: 'cost__denial' });
  const table = el('div', { class: 'cost__table' });
  const caveats = el('div', { class: 'cost__caveats' });
  const provenance = el('div', { class: 'cost__prov' });
  const detail = el(
    'div',
    { class: 'cost__detail', id: detailId },
    detailLead,
    detailDenial,
    table,
    caveats,
    provenance,
  );
  detail.hidden = true;

  const root = el('div', { class: 'cost' }, toggle, bar, caption, detail);
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
            el('span', { class: 'cost__k' }, CLASS_LABEL[slice.key]),
            el('span', { class: 'cost__v u-num' }, usd(slice.usd)),
            el('span', { class: 'cost__p u-num' }, share(slice.fraction)),
            fill,
          );
        }),
    );
  }

  /**
   * The two caveats are separate sentences on purpose. They are different
   * failures: one is usage that is MISSING from the total, the other is usage
   * that is IN the total at too low a rate. Merging them into "some numbers
   * may be off" would lose which of the two is happening.
   */
  function renderCaveats(cost: WeeklyCost, allUnpriced: boolean, degraded: boolean): void {
    const nodes: HTMLElement[] = [];

    // Named from byModel, not from `unpricedModels`: that array is
    // de-duplicated by model and DROPS the speed (src/core/pricing.js:261), so
    // it would say "claude-opus-4-8 is unpriced" while a priced standard-speed
    // row for the same model sits in the table above. ADR-002 amendment 2 added
    // ModelCost.speed for exactly this contradiction.
    const rows = unpricedRows(cost);
    const names = rows.length > 0
      ? rows.map((row) => {
          const tokens = row.tokens ? ` · ${compact(row.tokens.billable)} token` : '';
          return `${row.model} · ${speedLabel(row.speed)}${tokens}`;
        })
      : cost.unpricedModels.slice();

    if (names.length > 0) {
      // "bir bölümü" is a lie when it is all of it, and that is exactly the
      // case where the user most needs to understand why no figure is shown.
      nodes.push(
        el(
          'p',
          { class: 'cost__caveat' },
          allUnpriced
            ? 'Bu haftaki kullanımın tamamı fiyat listesinde bulunamadı, ' +
              'bu yüzden bir tutar gösterilmiyor. Kullanılan modeller:'
            : 'Bu kullanımın bir bölümü fiyat listesinde bulunamadı ve toplama katılmadı:',
        ),
      );
      const list = el('ul', { class: 'cost__unpriced' });
      for (const name of names.slice(0, 8)) {
        list.appendChild(el('li', {}, name));
      }
      nodes.push(list);
    }

    // Guarded twice over: the caveat only exists when at least one event took
    // the fallback, and the proportion only when there is a denominator to
    // divide by. `cacheWriteEvents` is legitimately 0 for a window whose only
    // usage is output tokens, so this is a real path, not a paranoid one.
    if (cost.fallbackWriteEvents > 0) {
      const total = cost.cacheWriteEvents;
      const scope =
        total >= cost.fallbackWriteEvents && total > 0
          ? `${integer(cost.fallbackWriteEvents)} / ${integer(total)} önbellek yazma kaydında ` +
            `(${share(cost.fallbackWriteEvents / total)})`
          : `${integer(cost.fallbackWriteEvents)} önbellek yazma kaydında`;
      nodes.push(
        el(
          'p',
          { class: 'cost__caveat' },
          `${scope} TTL ayrımı yoktu. Hepsi 1,25× ile fiyatlandırıldı; 1 saatlik ` +
            'yazmalar gerçekte 2× olduğu için toplam bir alt sınır.',
        ),
      );
    }

    if (degraded) {
      nodes.push(
        el(
          'p',
          { class: 'cost__caveat' },
          'Bu araçtan gelen veriler güncel değil. Tutar yalnızca son okunabilen ' +
            'olayları kapsıyor, bu yüzden pencerenin tamamını anlatmıyor.',
        ),
      );
    }

    replaceChildrenWith(caveats, nodes);
    caveats.hidden = nodes.length === 0;
  }

  function update(cost: WeeklyCost | null, providerName: string, degraded = false): void {
    if (!cost) {
      root.hidden = true;
      return;
    }

    const { slices, sum } = slicesOf(cost.byClass);
    const rows = unpricedRows(cost);
    const hasCaveat =
      cost.fallbackWriteEvents > 0 || rows.length > 0 || cost.unpricedModels.length > 0;

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

    const floor = hasFigure && isFloor(cost, degraded);

    if (hasFigure) {
      const amount = floor ? `en az ${usd(cost.totalUsd)}` : usd(cost.totalUsd);
      setText(summary, `Yayımlanan API fiyatlarıyla ${amount} tutardı`);
      // The spoken name carries the whole frame plus the denial, because a
      // screen reader user gets the button label with no surrounding layout to
      // qualify it.
      setAttr(
        toggle,
        'aria-label',
        `${providerName}: bu haftaki kullanım, yayımlanan API fiyatlarıyla ` +
          `${floor ? 'en az ' : ''}${usdWithUnit(cost.totalUsd)} tutardı. ` +
          'Bu bir fatura değildir; abonelik kapsamında bu tutar ödenmez. ' +
          'Dökümü açmak için etkinleştirin.',
      );
    } else {
      // No number anywhere in this branch — not zero, not a bound. The user is
      // told that usage happened and that we could not price it, and the model
      // list below carries the token counts that prove the first half.
      setText(summary, 'Bu haftaki kullanım fiyat listesinde bulunamadı');
      setAttr(
        toggle,
        'aria-label',
        `${providerName}: bu haftaki kullanım yayımlanan fiyat listesinde bulunamadı, ` +
          'bu yüzden bir tutar hesaplanamıyor. Kullanılan modelleri görmek için etkinleştirin.',
      );
    }

    renderBar(slices);

    // The two largest classes, named. This is the line that turns the figure
    // from an assertion into an explanation, so it is never behind the toggle.
    const top = slices.filter((slice) => slice.usd > 0).slice(0, 2);
    setText(
      caption,
      top.map((slice) => `${CLASS_LABEL[slice.key]} ${share(slice.fraction)}`).join(' · '),
    );
    caption.hidden = top.length === 0;

    setText(
      detailLead,
      hasFigure
        ? `Yayımlanan API fiyatlarıyla ${floor ? 'en az ' : ''}${usdWithUnit(cost.totalUsd)}`
        : 'Bu kullanım için bir karşılık hesaplanamadı',
    );
    // The denial answers "is this money I owe?". With no amount on screen there
    // is nothing to deny, and printing it anyway would imply a figure exists.
    detailDenial.hidden = !hasFigure;
    setText(
      detailDenial,
      'Bu bir fatura değil: abonelik kapsamında bu tutar ödenmiyor. Aynı kullanımın ' +
        'API üzerinden karşılığıdır.',
    );

    renderTable(slices);
    renderCaveats(cost, !hasFigure, degraded);

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
          ? `Fiyatlar ${priceDate(cost.pricesAsOf)} tarihli listeye göre`
          : 'Fiyat listesinin tarihi bildirilmedi',
      ),
    ]);

    applyExpanded();
  }

  return { el: root, update };
}
