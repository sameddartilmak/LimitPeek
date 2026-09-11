/**
 * The in-panel settings view: which providers exist as rows in the main panel,
 * a per-period usage summary, and the theme.
 *
 * ADDED vs. CONNECTED
 * -------------------
 * These are two different questions and the tools section answers only the
 * first.
 *
 *   enabled    the user ADDED the row. It is their choice to see the provider
 *              at all, and it is the only thing a switch here changes.
 *   connected  we actually have data for it. That is main's business, and it
 *              is offered on the row itself in the main panel, never here.
 *
 * So an added-but-unconnected provider still belongs in the main list, showing
 * its setup action ("Bu makinede bulunamadı", or Claude's bridge install).
 * Removing a provider here does not disconnect it and deletes nothing; it only
 * takes the row off the main list. The copy says exactly that, because a
 * switch labelled with a tool's name invites the reading "turn the tool off".
 *
 * WHY A VIEW AND NOT A SECOND WINDOW
 * ----------------------------------
 * One window keeps the tray anchor, the open/close lifecycle and the design
 * language. The panel is click-opened and pinnable now, so it is stable enough
 * to hold a form.
 *
 * THREE SECTIONS, ONE OPEN AT A TIME (ACCORDION)
 * ----------------------------------------------
 * The view holds three sections now — "Model Yönetimi" (which rows exist),
 * "Toplam Kullanım" (per-period notional cost) and "Görünüm" (the theme). They
 * are collapsible and mutually exclusive: opening one closes the others, so the
 * short hover panel never has to scroll through all three at once. Each header
 * is the accordion pattern from the ARIA practices — an <h3> wrapping a real
 * <button> with `aria-expanded` — so a screen-reader user both navigates by
 * heading AND operates the disclosure with the platform's own Space/Enter, and
 * the focus ring is the shared :focus-visible one.
 *
 * DEFAULT OPEN: "Model Yönetimi", the first section. It is the view's original
 * job and keeps the tab path (back control -> first provider switch) exactly as
 * it was; the other two start collapsed. Clicking the open header collapses it,
 * so "all closed" is reachable too — the invariant is at most one open, which
 * is what "opening one closes the others" means.
 *
 * WHY THE USAGE FIGURE IS A COST AND NOT A TOKEN TOTAL
 * ---------------------------------------------------
 * Summing the four token classes into one number is meaningless here (README,
 * ADR-001): cache reads are ~98% of raw volume and bill at 0.1x. So each period
 * is summarised by its NOTIONAL cost at published API prices, computed in main
 * (`src/core/history.js`) and sent resolved — the renderer does no arithmetic
 * on usage. It is framed exactly like the weekly cost block: never a bill, and
 * "en az $X" whenever the figure is a lower bound.
 */

import type {
  PeriodModelCost,
  PeriodUsage,
  ProviderSnapshot,
  ThemeChoice,
  UsageHistory,
} from '../../../shared/contract.js';
import { el, on, replaceChildrenWith, setAttr, setText, svg } from '../dom.js';
import { enabledOf, type PanelState } from '../store.js';
import { themeLabel } from '../theme.js';
import { dayRange, integer, priceDate, usd } from '../format.js';
import { providerMark } from './logo.js';

/** The id the header's settings button points `aria-controls` at. */
export const SETTINGS_VIEW_ID = 'settings-view';
const SETTINGS_TITLE_ID = 'settings-title';
const MODELS_HEADER_ID = 'settings-sec-models-h';
const MODELS_REGION_ID = 'settings-sec-models-r';
const USAGE_HEADER_ID = 'settings-sec-usage-h';
const USAGE_REGION_ID = 'settings-sec-usage-r';
const THEME_HEADER_ID = 'settings-sec-theme-h';
const THEME_REGION_ID = 'settings-sec-theme-r';
const SETTINGS_HELP_ID = 'settings-help';
const THEME_TITLE_ID = 'settings-theme-title';
const THEME_HELP_ID = 'settings-theme-help';

/** The grain the usage section is showing. */
type UsageGrain = 'week' | 'month';

/**
 * DEFAULT GRAIN: monthly. "Toplam Kullanım" reads first as a coarse overview —
 * a run of months is a year at a glance in a few rows — and the finer weekly
 * view is the drill-down the toggle offers.
 */
const DEFAULT_GRAIN: UsageGrain = 'month';

export interface SettingsContext {
  /** The user asked to add (`enabled: true`) or remove a provider. */
  onToggle(providerId: string, enabled: boolean): void;
  /** The user picked a theme. Optimistic; the app owns the revert. */
  onTheme(theme: ThemeChoice): void;
  /** Leave settings and go back to the usage list. */
  onBack(): void;
}

export interface SettingsHandle {
  el: HTMLElement;
  render(state: PanelState, providers: readonly ProviderSnapshot[]): void;
  /** Focus the way out. It is the first thing in the view, so tab order runs
   *  forwards from it into the list. */
  focusFirst(): void;
}

function backIcon(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', {
      d: 'M9.5 3.5L5 8l4.5 4.5',
      stroke: 'currentColor',
      'stroke-width': '1.4',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
}

/** The disclosure chevron. Points right when collapsed; CSS rotates it down
 *  when the header's `aria-expanded` is true, so the state has a visual carrier
 *  besides the region appearing. */
function chevronIcon(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', {
      d: 'M6 4l4 4-4 4',
      stroke: 'currentColor',
      'stroke-width': '1.4',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
}

/** "Bulundu, henüz bağlı değil." -> "bulundu, henüz bağlı değil" */
function asClause(detail: string): string {
  const trimmed = detail.trim().replace(/[.!]+$/, '');
  if (trimmed.length === 0) return '';
  return trimmed.charAt(0).toLocaleLowerCase('tr-TR') + trimmed.slice(1);
}

/**
 * One line stating both facts, in that order: where the row is, and what we
 * know about the tool. Keeping them in one sentence is what stops "Ana panelde
 * değil" being read as "not installed".
 */
function metaFor(provider: ProviderSnapshot, enabled: boolean): string {
  const where = enabled ? 'Ana panelde' : 'Ana panelde değil';
  const how = provider.connected
    ? 'bağlı'
    : asClause(provider.setupAction?.detail ?? '') || 'henüz bağlı değil';
  return where + ' · ' + how;
}

interface ItemHandle {
  el: HTMLLIElement;
  update(provider: ProviderSnapshot, state: PanelState, enabled: boolean): void;
}

function createItem(provider: ProviderSnapshot, ctx: SettingsContext): ItemHandle {
  const nameId = 'settings-name-' + provider.id;
  const metaId = 'settings-meta-' + provider.id;

  const mark = el('span', { class: 'settings__mark', 'aria-hidden': 'true' });
  mark.appendChild(providerMark(provider.id));

  const name = el('span', { class: 'settings__name', id: nameId }, provider.displayName);
  const meta = el('span', { class: 'settings__meta', id: metaId }, '');

  // A real switch, not a styled div: role="switch" + aria-checked is what a
  // screen reader announces and what Space/Enter already operate on a
  // <button>. The name comes from the provider, the state from aria-checked —
  // putting the state in the label too would have it read twice, differently.
  const control = el('button', {
    type: 'button',
    class: 'switch',
    role: 'switch',
    'aria-checked': 'false',
    'aria-labelledby': nameId,
    'aria-describedby': metaId,
  }) as HTMLButtonElement;
  control.appendChild(el('span', { class: 'switch__track', 'aria-hidden': 'true' }));

  const root = el(
    'li',
    { class: 'settings__item', role: 'listitem', 'data-provider': provider.id },
    mark,
    el('span', { class: 'settings__text' }, name, meta),
    control,
  ) as HTMLLIElement;

  on(control, 'click', () => {
    // Read the CURRENT rendered state, not a captured one: the item is updated
    // in place across snapshots and a closed-over boolean would go stale.
    ctx.onToggle(provider.id, control.getAttribute('aria-checked') !== 'true');
  });

  function update(next: ProviderSnapshot, state: PanelState, isEnabled: boolean): void {
    setText(name, next.displayName);
    const metaText = metaFor(next, isEnabled);
    setText(meta, metaText);
    setAttr(meta, 'title', metaText);
    setAttr(control, 'aria-checked', isEnabled ? 'true' : 'false');
    setAttr(root, 'data-enabled', isEnabled ? 'true' : 'false');
    setAttr(root, 'data-connected', next.connected ? 'true' : 'false');
    root.style.setProperty('--accent', next.accent);

    // In flight. The switch stays operable — a control that goes dead under
    // the pointer for one round trip is worse than one that accepts a second
    // press, and the app already lets the newest request win.
    const pending = state.enabledPending.includes(next.id);
    setAttr(control, 'aria-busy', pending ? 'true' : null);
    setAttr(root, 'data-pending', pending ? 'true' : null);

    // Main refused, so the switch went back. Held for a moment as an
    // attribute so the revert is SEEN and not only described in the notice.
    setAttr(root, 'data-revert', state.revertedId === next.id ? 'true' : null);
  }

  return { el: root, update };
}

/**
 * The theme control.
 *
 * NATIVE RADIOS, not three buttons with role="radio". A radio group has to
 * answer arrow keys, hold exactly one selection, expose a group name and take
 * a single tab stop with roving focus inside it. The platform does all four
 * for `<input type="radio">` in a `<fieldset>`; a hand-rolled version is four
 * more things that can regress silently, and this project already has enough
 * hand-rolled ARIA to keep honest. They are visually replaced, never hidden
 * with `display:none`, so focus still lands on a real control.
 *
 * The legend is visually hidden now (`u-sr`): the accordion header already
 * shows "Görünüm", and a second visible copy directly above the radios would
 * be a heading printed twice. The legend stays in the accessibility tree so the
 * radio group keeps a group name.
 *
 * `system` is a live binding, so its label says what it is currently resolving
 * to. Otherwise picking it looks like nothing happened on a machine whose OS
 * is already dark.
 */
interface ThemeHandleLocal {
  el: HTMLElement;
  update(state: PanelState): void;
}

function createThemeControl(ctx: SettingsContext): ThemeHandleLocal {
  const CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];

  const inputs = new Map<ThemeChoice, HTMLInputElement>();
  const options = el('div', { class: 'theme__opts' });

  for (const choice of CHOICES) {
    const id = 'theme-' + choice;
    const input = el('input', {
      type: 'radio',
      name: 'usage-notch-theme',
      id,
      value: choice,
      class: 'theme__radio',
    }) as HTMLInputElement;
    const label = el('label', { class: 'theme__opt', for: id }, themeLabel(choice));
    // `change` rather than `click`: it is the event that fires for the
    // keyboard path too, and arrow keys are how a radio group is actually
    // operated once focus is inside it.
    on(input, 'change', () => {
      if (input.checked) ctx.onTheme(choice);
    });
    inputs.set(choice, input);
    options.appendChild(input);
    options.appendChild(label);
  }

  const help = el('p', { class: 'theme__help', id: THEME_HELP_ID }, '');

  const root = el(
    'fieldset',
    { class: 'theme', 'aria-describedby': THEME_HELP_ID },
    el('legend', { class: 'u-sr', id: THEME_TITLE_ID }, 'Görünüm'),
    help,
    options,
  );

  function update(state: PanelState): void {
    for (const [choice, input] of inputs) {
      // The PROPERTY, not the attribute: the attribute is only the default and
      // would stop tracking the moment the user touched the group.
      const on_ = state.theme === choice;
      if (input.checked !== on_) input.checked = on_;
    }
    // In flight and reverted are stated on the group, not on one radio: main
    // refusing is a fact about the setting, not about the button pressed.
    setAttr(root, 'data-pending', state.themePending ? 'true' : null);
    setAttr(root, 'data-revert', state.themeReverted ? 'true' : null);
    setAttr(root, 'aria-busy', state.themePending ? 'true' : null);

    const resolved = document.documentElement.getAttribute('data-theme') === 'light'
      ? 'açık'
      : 'koyu';
    setText(
      help,
      state.theme === 'system'
        ? `Windows'un koyu/açık ayarı izleniyor — şu anda ${resolved}. ` +
            'Ayar değişince panel de değişir.'
        : 'Panelin rengi. Sistem seçilirse Windows ayarı izlenir.',
    );
  }

  return { el: root, update };
}

/**
 * The per-period usage section.
 *
 * Renders the resolved figures from `Snapshot.usageHistory` — it does no
 * arithmetic on usage. The one ratio it does compute is the bar length
 * (`costUsd / maxCost`), which is presentation scaling of already-resolved
 * dollar figures, exactly the shape the cost block's composition bar already
 * uses; the load-bearing numbers all arrive resolved from main.
 *
 * The grain toggle re-renders from the history already in hand, so switching
 * hafta/ay does not wait for the next snapshot.
 *
 * PER-MODEL BREAKDOWN
 * -------------------
 * Under each period sits a disclosure (collapsed by default) that expands to a
 * per-model list — which models were used in that period and how much each
 * cost. It reuses the cost block's disclosure idiom because the hover panel is
 * narrow: an always-open list under a dozen periods would be a scroll tunnel,
 * so the summary line just counts the models (no figure, like the quota block)
 * and the figures appear on expand. The per-model list is itself a bounded
 * scroller (`.usage__models` max-height + overflow), so a period with many
 * models scrolls WITHIN its disclosure instead of pushing the panel off screen.
 * Each model amount is framed exactly like the period amount — "en az" for a
 * floor, "fiyatlanamadı" for an unpriced model — never a bare "$0,00".
 */
interface UsageHandleLocal {
  el: HTMLElement;
  update(history: UsageHistory | null, hasData: boolean): void;
}

/** The amount cell's text, framed and honest. Never a bare "$0,00". */
function amountText(period: PeriodUsage): string {
  if (!period.hasUsage) return '—';
  if (period.costUsd > 0) return (period.isFloor ? 'en az ' : '') + usd(period.costUsd);
  // Usage happened, but none of it could be priced: say so rather than print a
  // zero that reads as "free".
  return period.unpricedModels.length > 0 ? 'fiyatlanamadı' : '—';
}

/**
 * One model's amount, framed the same way as the period's. A null cost is an
 * unpriced model — "fiyatlanamadı", never "$0,00", the ADR-002 rule-2 silent
 * zero this whole section refuses. A priced-but-zero figure (a model whose
 * events carried no billable tokens) reads "—" rather than a misleading "free".
 */
function modelAmountText(model: PeriodModelCost): string {
  if (model.costUsd === null) return 'fiyatlanamadı';
  if (model.costUsd > 0) return (model.isFloor ? 'en az ' : '') + usd(model.costUsd);
  return '—';
}

function createUsageSection(): UsageHandleLocal {
  let grain: UsageGrain = DEFAULT_GRAIN;
  let current: UsageHistory | null = null;
  let hasData = false;

  const intro = el(
    'p',
    { class: 'usage__intro' },
    'Yayımlanan API fiyatlarıyla dönem dönem yaklaşık maliyet. Bu bir fatura ' +
      'değildir — abonelik kapsamında bu tutar (ABD doları) ödenmez. Yalnızca ' +
      'yerel Claude Code transkriptlerinden hesaplanır.',
  );

  const GRAINS: ReadonlyArray<{ v: UsageGrain; label: string }> = [
    { v: 'month', label: 'Aylık' },
    { v: 'week', label: 'Haftalık' },
  ];
  const radios = new Map<UsageGrain, HTMLInputElement>();
  const toggle = el('div', { class: 'seg', role: 'group', 'aria-label': 'Dönem aralığı' });
  for (const g of GRAINS) {
    const id = 'usage-grain-' + g.v;
    const input = el('input', {
      type: 'radio',
      name: 'usage-grain',
      id,
      value: g.v,
      class: 'seg__radio',
    }) as HTMLInputElement;
    const label = el('label', { class: 'seg__opt', for: id }, g.label);
    on(input, 'change', () => {
      if (input.checked && grain !== g.v) {
        grain = g.v;
        renderList();
      }
    });
    radios.set(g.v, input);
    toggle.appendChild(input);
    toggle.appendChild(label);
  }

  const list = el('ul', { class: 'usage__list', role: 'list' });
  const empty = el('p', { class: 'usage__empty' }, '');
  const note = el('p', { class: 'usage__note' }, '');

  const root = el('div', { class: 'usage' }, intro, toggle, list, empty, note);

  function periodsFor(): PeriodUsage[] {
    if (!current) return [];
    return grain === 'week' ? current.weeks : current.months;
  }

  /**
   * One model's line inside a period's disclosure: its id and its framed cost.
   * The id is rendered verbatim through a text node (`el` never uses innerHTML),
   * so a model name decoded from a file cannot become markup.
   */
  function renderModelRow(model: PeriodModelCost): HTMLElement {
    const name = el('span', { class: 'usage__model-name' }, model.model);
    const amount = el('span', { class: 'usage__model-amount u-num' }, modelAmountText(model));
    const row = el('li', { class: 'usage__model', role: 'listitem' }, name, amount) as HTMLElement;
    setAttr(row, 'data-floor', model.isFloor ? 'true' : null);
    setAttr(row, 'data-unpriced', model.costUsd === null ? 'true' : null);
    return row;
  }

  /**
   * The per-model disclosure appended under a period row. Collapsed by default
   * so the panel stays short; the summary counts models and shows no figure
   * (the meter above the equivalent block owns the reading), and expanding
   * reveals the framed per-model amounts inside a bounded scroller.
   */
  function renderDisclosure(period: PeriodUsage, regionId: string): readonly HTMLElement[] {
    const chev = el('span', { class: 'usage__chev', 'aria-hidden': 'true' }, chevronIcon());
    const label = el('span', { class: 'usage__toggle-label' }, integer(period.byModel.length) + ' model');
    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'usage__toggle',
        'aria-expanded': 'false',
        'aria-controls': regionId,
        title: 'Modele göre dağılım',
      },
      label,
      chev,
    ) as HTMLButtonElement;

    const models = el(
      'ul',
      { class: 'usage__models', id: regionId, role: 'list' },
      ...period.byModel.map(renderModelRow),
    ) as HTMLElement;
    models.hidden = true;

    on(toggle, 'click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      setAttr(toggle, 'aria-expanded', open ? 'false' : 'true');
      models.hidden = open;
    });

    return [toggle, models];
  }

  function renderRow(period: PeriodUsage, maxCost: number, index: number): HTMLElement {
    const range = el('span', { class: 'usage__range' }, dayRange(period.startsAt, period.endsAt) || '—');
    const amount = el('span', { class: 'usage__amount u-num' }, amountText(period));
    const bar = el('span', { class: 'usage__bar', 'aria-hidden': 'true' });
    if (maxCost > 0 && period.costUsd > 0) {
      const fill = el('i', { class: 'usage__fill' });
      fill.style.setProperty('--w', (period.costUsd / maxCost).toFixed(4));
      bar.appendChild(fill);
    } else {
      bar.hidden = true;
    }
    const row = el('li', { class: 'usage__row', role: 'listitem' }, range, amount, bar) as HTMLElement;
    setAttr(row, 'data-empty', period.hasUsage ? null : 'true');
    setAttr(row, 'data-floor', period.isFloor ? 'true' : null);
    // Only a period with a per-model split gets a disclosure — an empty period
    // has nothing to break down. The region id is unique per grain+index so the
    // toggle's aria-controls resolves even with a duplicate period key.
    if (period.byModel.length > 0) {
      const regionId = `usage-models-${grain}-${index}`;
      for (const node of renderDisclosure(period, regionId)) row.appendChild(node);
    }
    return row;
  }

  function renderList(): void {
    for (const [v, input] of radios) {
      const on_ = grain === v;
      if (input.checked !== on_) input.checked = on_;
    }

    if (!hasData) {
      list.hidden = true;
      note.hidden = true;
      empty.hidden = false;
      setText(empty, 'Kullanım geçmişi yükleniyor…');
      return;
    }

    const periods = periodsFor();
    if (periods.length === 0) {
      list.hidden = true;
      note.hidden = true;
      empty.hidden = false;
      setText(empty, 'Henüz yerel kullanım kaydı bulunamadı.');
      return;
    }

    empty.hidden = true;
    list.hidden = false;
    const maxCost = periods.reduce((max, p) => (p.costUsd > max ? p.costUsd : max), 0);
    replaceChildrenWith(list, periods.map((p, i) => renderRow(p, maxCost, i)));

    note.hidden = false;
    setText(
      note,
      current && current.pricesAsOf
        ? `Fiyatlar ${priceDate(current.pricesAsOf)} tarihli listeye göre. ` +
            '“En az”, fiyatlanamayan kullanım toplama katılmadığı için alt sınır demektir.'
        : 'Fiyat listesinin tarihi bildirilmedi.',
    );
  }

  function update(history: UsageHistory | null, dataArrived: boolean): void {
    current = history;
    hasData = dataArrived;
    renderList();
  }

  return { el: root, update };
}

/* --------------------------------------------------------------- accordion */

interface AccordionSection {
  id: string;
  trigger: HTMLButtonElement;
  region: HTMLElement;
  el: HTMLElement;
}

/**
 * Builds one accordion section: an <h3> that wraps the toggle button, and a
 * labelled region. The heading carries the outline for screen-reader
 * navigation; the button carries the disclosure. `data-acc` is a stable hook
 * for tests and for the CSS chevron.
 */
function createAccordionSection(
  id: string,
  headerId: string,
  regionId: string,
  title: string,
  content: readonly HTMLElement[],
): AccordionSection {
  const trigger = el(
    'button',
    {
      type: 'button',
      class: 'acc__trigger',
      id: headerId,
      'aria-expanded': 'false',
      'aria-controls': regionId,
      'data-acc': id,
    },
    el('span', { class: 'acc__title' }, title),
    el('span', { class: 'acc__chev', 'aria-hidden': 'true' }, chevronIcon()),
  ) as HTMLButtonElement;

  const heading = el('h3', { class: 'acc__heading' }, trigger);
  const region = el(
    'div',
    { class: 'acc__region', id: regionId, role: 'region', 'aria-labelledby': headerId },
    ...content,
  );
  const section = el('div', { class: 'acc__section', 'data-acc-section': id }, heading, region);
  return { id, trigger, region, el: section };
}

/**
 * Wires the sections so at most one is open. Opening one closes the others;
 * clicking the open one collapses it. `aria-expanded` on the trigger and
 * `hidden` on the region are the two things kept in sync, and they are the two
 * a screen reader and a Tab key respectively depend on.
 */
function wireAccordion(sections: readonly AccordionSection[], defaultOpenId: string | null): void {
  const setOpen = (section: AccordionSection, open: boolean): void => {
    setAttr(section.trigger, 'aria-expanded', open ? 'true' : 'false');
    section.region.hidden = !open;
  };
  for (const section of sections) setOpen(section, section.id === defaultOpenId);
  for (const section of sections) {
    on(section.trigger, 'click', () => {
      const open = section.trigger.getAttribute('aria-expanded') === 'true';
      if (open) {
        setOpen(section, false);
      } else {
        for (const other of sections) setOpen(other, other.id === section.id);
      }
    });
  }
}

export function createSettings(ctx: SettingsContext): SettingsHandle {
  const items = new Map<string, ItemHandle>();

  const back = el('button', {
    type: 'button',
    class: 'iconbtn',
    'aria-label': 'Ayarlardan çık, kullanım listesine dön',
    title: 'Geri (Esc)',
  }) as HTMLButtonElement;
  back.appendChild(backIcon());
  on(back, 'click', () => ctx.onBack());

  const bar = el(
    'div',
    { class: 'settings__bar' },
    back,
    el('h2', { class: 'settings__title', id: SETTINGS_TITLE_ID }, 'Ayarlar'),
  );

  // --- "Model Yönetimi": which rows exist ---------------------------------
  const help = el(
    'p',
    { class: 'settings__help', id: SETTINGS_HELP_ID },
    'Ana panelde hangi araçların görüneceğini seçin. Kaldırılan araç yalnızca ' +
      'listeden çıkar — bağlantısı kesilmez, hiçbir veri silinmez.',
  );

  const list = el('ul', {
    class: 'settings__list',
    role: 'list',
    'aria-labelledby': MODELS_HEADER_ID,
    'aria-describedby': SETTINGS_HELP_ID,
  });

  // The models section's own three states. "Taranıyor" and "araç yok" are
  // different claims and must not share one blank panel.
  const status = el('p', { class: 'settings__status' }, '');
  status.hidden = true;

  const modelsSection = createAccordionSection(
    'models',
    MODELS_HEADER_ID,
    MODELS_REGION_ID,
    'Model Yönetimi',
    [help, list, status],
  );

  // --- "Toplam Kullanım": per-period notional cost ------------------------
  const usage = createUsageSection();
  const usageSection = createAccordionSection(
    'usage',
    USAGE_HEADER_ID,
    USAGE_REGION_ID,
    'Toplam Kullanım',
    [usage.el],
  );

  // --- "Görünüm": the theme ----------------------------------------------
  const theme = createThemeControl(ctx);
  const themeSection = createAccordionSection(
    'theme',
    THEME_HEADER_ID,
    THEME_REGION_ID,
    'Görünüm',
    [theme.el],
  );

  const sections = [modelsSection, usageSection, themeSection];
  // First section open; the tab path (back -> first switch) is unchanged.
  wireAccordion(sections, 'models');

  const acc = el('div', { class: 'acc' }, ...sections.map((s) => s.el));

  const root = el(
    'section',
    {
      class: 'settings',
      id: SETTINGS_VIEW_ID,
      role: 'group',
      'aria-labelledby': SETTINGS_TITLE_ID,
    },
    bar,
    acc,
  );
  root.hidden = true;

  /**
   * Reconciled by id in the order given, exactly like the main list: the
   * switch must keep focus across the 15s snapshot cadence.
   *
   * Runs BEFORE the empty/loading branches decide what to show, and runs even
   * for an empty array. Returning early instead left hidden switches in the
   * document after every provider went away — invisible, but still real
   * controls carrying stale names and stale aria-checked, which is what a
   * screen reader and a query selector both walk.
   */
  function syncItems(state: PanelState, providers: readonly ProviderSnapshot[]): void {
    let cursor = list.firstElementChild;
    for (const provider of providers) {
      // The shared predicate, never a restatement of it: this view and the
      // main list must agree about what "added" means, or the switch will
      // disagree with the row it controls.
      const enabled = enabledOf(state, provider);
      let item = items.get(provider.id);
      if (!item) {
        item = createItem(provider, ctx);
        items.set(provider.id, item);
      }
      item.update(provider, state, enabled);
      if (item.el === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        list.insertBefore(item.el, cursor);
      }
    }
    while (cursor) {
      const next = cursor.nextElementSibling;
      list.removeChild(cursor);
      cursor = next;
    }
    const alive = new Set<string>(providers.map((p) => p.id as string));
    for (const [id, item] of items) {
      if (!alive.has(id)) {
        item.el.remove();
        items.delete(id);
      }
    }
  }

  function render(state: PanelState, providers: readonly ProviderSnapshot[]): void {
    syncItems(state, providers);
    // Painted regardless of the models list's state: the theme control and the
    // usage section belong to the VIEW, not to the provider list, and a machine
    // with no recognised tools must still be able to pick a theme and see its
    // history.
    theme.update(state);
    usage.update(state.snapshot?.usageHistory ?? null, state.hasData);

    // Three states for the models list, told apart in words. "Still scanning"
    // and "this machine has nothing" are different claims.
    if (!state.hasData) {
      list.hidden = true;
      status.hidden = false;
      setText(status, 'Araçlar taranıyor…');
      setAttr(status, 'aria-busy', 'true');
      return;
    }
    setAttr(status, 'aria-busy', null);
    if (providers.length === 0) {
      list.hidden = true;
      status.hidden = false;
      setText(status, 'Bu makinede tanınan bir yapay zekâ aracı bulunamadı.');
      return;
    }
    list.hidden = false;
    status.hidden = true;
  }

  return {
    el: root,
    render,
    focusFirst(): void {
      back.focus({ preventScroll: true });
    },
  };
}
