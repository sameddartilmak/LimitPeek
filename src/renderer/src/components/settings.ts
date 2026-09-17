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
 * job, and it keeps the provider switches one tab stop away (back control ->
 * its header -> first provider switch); the other two start collapsed. Clicking the open header collapses it,
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
  LanguageChoice,
  PeriodModelCost,
  PeriodUsage,
  ProviderSnapshot,
  ThemeChoice,
  UsageHistory,
} from '../../../shared/contract.js';
import { el, on, replaceChildrenWith, setAttr, setText, svg } from '../dom.js';
import { enabledOf, type PanelState } from '../store.js';
import { themeLabel } from '../theme.js';
import { pendingUsageOf } from '../sanitize.js';
import { atLeast, dayRange, lowerFirst, modelName, multiplier, priceDate, usd } from '../format.js';
import { language as currentLanguage, t } from '../i18n.js';
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
const LANGUAGE_TITLE_ID = 'settings-language-title';
const LANGUAGE_HELP_ID = 'settings-language-help';

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
  /**
   * The user picked a language. NOT optimistic: main re-resolves and pushes,
   * and the app rebuilds the panel from that push (ADR-004).
   */
  onLanguage(language: LanguageChoice): void;
  /** Leave settings and go back to the usage list. */
  onBack(): void;
}

export interface SettingsHandle {
  el: HTMLElement;
  render(state: PanelState, providers: readonly ProviderSnapshot[]): void;
  /** Focus the way out. It is the first thing in the view, so tab order runs
   *  forwards from it into the list. */
  focusFirst(): void;
  /**
   * Open the appearance section and focus the checked language radio. Called
   * after a language change rebuilds the panel, so the keyboard user lands
   * back on the control they just operated instead of on <body>.
   */
  focusLanguage(): void;
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

/**
 * "Bulundu, henüz bağlı değil." -> "bulundu, henüz bağlı değil".
 *
 * Lower-cased in the RESOLVED language (ADR-004 A1.7). It used a fixed
 * 'tr-TR', which maps "I" to the dotless "ı": an English detail "It is…" would
 * have been printed "ıt is…".
 */
function asClause(detail: string): string {
  const trimmed = detail.trim().replace(/[.!]+$/, '');
  if (trimmed.length === 0) return '';
  return lowerFirst(trimmed);
}

/**
 * One line stating both facts, in that order: where the row is, and what we
 * know about the tool. Keeping them in one sentence is what stops "Ana panelde
 * değil" being read as "not installed".
 */
function metaFor(provider: ProviderSnapshot, enabled: boolean): string {
  const where = enabled ? t('settings.where.enabled') : t('settings.where.notEnabled');
  const how = provider.connected
    ? t('settings.connected')
    : asClause(provider.setupAction?.detail ?? '') || t('settings.notConnected');
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
    el('legend', { class: 'u-sr', id: THEME_TITLE_ID }, t('settings.theme.legend')),
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
      ? t('theme.resolvedLight')
      : t('theme.resolvedDark');
    setText(
      help,
      state.theme === 'system'
        ? t('settings.theme.helpSystem', { resolved })
        : t('settings.theme.help'),
    );
  }

  return { el: root, update };
}

/**
 * The language control. Same native-radio fieldset as the theme, for the same
 * reasons, and the same CSS (`.theme`): two identical controls one above the
 * other should look identical.
 *
 * The option labels are ENDONYMS — "Türkçe" and "English" in both languages —
 * because a user who cannot read the current language has to be able to find
 * their own. Only "Sistem"/"System" follows the language.
 *
 * NOT OPTIMISTIC. The radio moves on the gesture (it is a native radio), but
 * nothing else does: the words on screen change only when main pushes the
 * newly resolved language, because main also rewrites the tray tooltip, the
 * menu and the setup text, and a panel that switched ahead of main could show
 * one language beside a tooltip in the other.
 */
interface LanguageHandleLocal {
  el: HTMLElement;
  update(state: PanelState): void;
  focusChecked(): void;
}

function createLanguageControl(ctx: SettingsContext): LanguageHandleLocal {
  const CHOICES: ReadonlyArray<{ v: LanguageChoice; label: string }> = [
    { v: 'tr', label: t('language.endonym.tr') },
    { v: 'en', label: t('language.endonym.en') },
    { v: 'system', label: t('language.system') },
  ];

  const inputs = new Map<LanguageChoice, HTMLInputElement>();
  const options = el('div', { class: 'theme__opts' });

  for (const choice of CHOICES) {
    const id = 'language-' + choice.v;
    const input = el('input', {
      type: 'radio',
      name: 'usage-notch-language',
      id,
      value: choice.v,
      class: 'theme__radio',
    }) as HTMLInputElement;
    // The endonym is also marked with its own language, so a screen reader
    // reading an English panel pronounces "Türkçe" as Turkish.
    const langAttr = choice.v === 'system' ? {} : { lang: choice.v };
    const label = el('label', { class: 'theme__opt', for: id, ...langAttr }, choice.label);
    on(input, 'change', () => {
      if (input.checked) ctx.onLanguage(choice.v);
    });
    inputs.set(choice.v, input);
    options.appendChild(input);
    options.appendChild(label);
  }

  const help = el('p', { class: 'theme__help', id: LANGUAGE_HELP_ID }, '');

  const root = el(
    'fieldset',
    { class: 'theme theme--language', 'aria-describedby': LANGUAGE_HELP_ID },
    el('legend', { class: 'u-sr', id: LANGUAGE_TITLE_ID }, t('settings.language.legend')),
    help,
    options,
  );

  function update(state: PanelState): void {
    for (const [choice, input] of inputs) {
      const on_ = state.language === choice;
      if (input.checked !== on_) input.checked = on_;
    }
    setAttr(root, 'data-pending', state.languagePending ? 'true' : null);
    setAttr(root, 'data-revert', state.languageReverted ? 'true' : null);
    setAttr(root, 'aria-busy', state.languagePending ? 'true' : null);

    const resolvedName =
      currentLanguage() === 'tr' ? t('language.name.tr') : t('language.name.en');
    setText(
      help,
      state.language === 'system'
        ? t('settings.language.helpSystem', { language: resolvedName })
        : t('settings.language.help'),
    );
  }

  function focusChecked(): void {
    const target =
      [...inputs.values()].find((input) => input.checked) ?? inputs.get('system') ?? null;
    target?.focus({ preventScroll: true });
  }

  return { el: root, update, focusChecked };
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
  update(
    history: UsageHistory | null,
    hasData: boolean,
    providers: readonly ProviderSnapshot[],
    pending: readonly string[],
  ): void;
}

/** The amount cell's text, framed and honest. Never a bare "$0,00". */
function amountText(period: PeriodUsage, pending: boolean): string {
  // While a tool is still being counted, an empty or zero period is not known
  // to be empty: that tool's usage in it has not been read. "—" would claim it.
  // A figure that IS present stays unqualified — pending is not a floor ("en
  // az"), it is incomplete, and the section's note says so.
  if (pending && (!period.hasUsage || period.costUsd <= 0)) return t('settings.amount.pending');
  if (!period.hasUsage) return '—';
  if (period.costUsd > 0) return period.isFloor ? atLeast(usd(period.costUsd)) : usd(period.costUsd);
  // Usage happened, but none of it could be priced: say so rather than print a
  // zero that reads as "free".
  return period.unpricedModels.length > 0 ? t('settings.amount.unpriced') : '—';
}

/**
 * One model's amount, framed the same way as the period's. A null cost is an
 * unpriced model — "fiyatlanamadı", never "$0,00", the ADR-002 rule-2 silent
 * zero this whole section refuses. A priced-but-zero figure (a model whose
 * events carried no billable tokens) reads "—" rather than a misleading "free".
 */
function modelAmountText(model: PeriodModelCost): string {
  if (model.costUsd === null) return t('settings.amount.unpriced');
  if (model.costUsd > 0) return model.isFloor ? atLeast(usd(model.costUsd)) : usd(model.costUsd);
  return '—';
}

function createUsageSection(): UsageHandleLocal {
  let grain: UsageGrain = DEFAULT_GRAIN;
  let current: UsageHistory | null = null;
  let hasData = false;
  /** The snapshot's providers, for each model row's mark and tool name. */
  let known: readonly ProviderSnapshot[] = [];
  /** Tools whose first usage scan has not answered (Snapshot.pendingUsage). */
  let pendingIds: readonly string[] = [];

  // "yaklaşık maliyet" (approximate cost) is gone (ADR-004 A1.6): "approximate"
  // claims error in both directions beside figures whose only known error is
  // one-directional, which is why they say "en az". ADR-002's framing instead:
  // what this usage WOULD HAVE COST at published API prices. The data source
  // is a separate, per-provider sentence, so a second provider's history does
  // not require rewriting the claim.
  const intro = el(
    'p',
    { class: 'usage__intro' },
    `${t('settings.usage.intro')} ${t('settings.usage.sources')}`,
  );

  const GRAINS: ReadonlyArray<{ v: UsageGrain; label: string }> = [
    { v: 'month', label: t('settings.grain.month') },
    { v: 'week', label: t('settings.grain.week') },
  ];
  const radios = new Map<UsageGrain, HTMLInputElement>();
  const toggle = el('div', { class: 'seg', role: 'group', 'aria-label': t('settings.grain.legend') });
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
  // ADR-002 A3.12. Above the list, not in the footnote: it changes what every
  // total below it means, and it must be read before them.
  const pendingNote = el('p', { class: 'usage__pending', role: 'status' }, '');
  pendingNote.hidden = true;

  const root = el('div', { class: 'usage' }, intro, toggle, pendingNote, list, empty, note);

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
    // Which tool the model belongs to: the list mixes Claude Code and Codex.
    // The brand mark says it to the eye, with the same connected/grey rule as
    // the settings rows (keyed off `data-connected` on this row). The mark is
    // decorative, so the tool is ALSO named in text for a screen reader —
    // "Codex model: gpt-5 …" — and never left to the picture alone.
    const provider = known.find((p) => p.id === model.provider) ?? null;
    const toolName = provider?.displayName || model.provider;
    const toolLabel = t('settings.usage.modelOf', { tool: toolName });
    // `title` for the pointer: the mark alone is a picture to someone who does
    // not know the logo. The name's own title is the full id, which ellipsizes.
    const mark = el('span', { class: 'usage__model-mark', 'aria-hidden': 'true', title: toolLabel });
    mark.appendChild(providerMark(model.provider));
    const name = el(
      'span',
      // An unresolved model is named as unresolved in the title too, never
      // as a model called "unknown".
      { class: 'usage__model-name', title: modelName(model.model) },
      el('span', { class: 'u-sr' }, `${toolLabel}: `),
      modelName(model.model),
    );
    const amount = el('span', { class: 'usage__model-amount u-num' }, modelAmountText(model));
    const row = el(
      'li',
      { class: 'usage__model', role: 'listitem' },
      mark,
      name,
      amount,
    ) as HTMLElement;
    setAttr(row, 'data-floor', model.isFloor ? 'true' : null);
    setAttr(row, 'data-unpriced', model.costUsd === null ? 'true' : null);
    setAttr(row, 'data-provider', model.provider);
    setAttr(row, 'data-connected', provider?.connected ? 'true' : 'false');
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
    const label = el(
      'span',
      { class: 'usage__toggle-label' },
      t('quota.models', { count: period.byModel.length }),
    );
    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'usage__toggle',
        'aria-expanded': 'false',
        'aria-controls': regionId,
        title: t('settings.models.breakdown'),
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
    const pending = pendingIds.length > 0;
    const amount = el('span', { class: 'usage__amount u-num' }, amountText(period, pending));
    const bar = el('span', { class: 'usage__bar', 'aria-hidden': 'true' });
    if (maxCost > 0 && period.costUsd > 0) {
      const fill = el('i', { class: 'usage__fill' });
      fill.style.setProperty('--w', (period.costUsd / maxCost).toFixed(4));
      bar.appendChild(fill);
    } else {
      bar.hidden = true;
    }
    const row = el('li', { class: 'usage__row', role: 'listitem' }, range, amount, bar) as HTMLElement;
    setAttr(row, 'data-empty', period.hasUsage || pending ? null : 'true');
    setAttr(row, 'data-pending', pending && (!period.hasUsage || period.costUsd <= 0) ? 'true' : null);
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

  /** "Codex" / "Claude Code ve Codex", in the panel's language. */
  function pendingToolsText(): string {
    const names = pendingIds.map((id) => known.find((p) => p.id === id)?.displayName || id);
    try {
      return new Intl.ListFormat(currentLanguage(), { style: 'long', type: 'conjunction' }).format(names);
    } catch {
      return names.join(', ');
    }
  }

  function renderList(): void {
    for (const [v, input] of radios) {
      const on_ = grain === v;
      if (input.checked !== on_) input.checked = on_;
    }

    pendingNote.hidden = pendingIds.length === 0;
    setText(pendingNote, pendingIds.length > 0 ? t('settings.usage.pending', { tools: pendingToolsText() }) : '');

    if (!hasData) {
      list.hidden = true;
      note.hidden = true;
      empty.hidden = false;
      setText(empty, t('settings.usage.loading'));
      return;
    }

    const periods = periodsFor();
    if (periods.length === 0) {
      list.hidden = true;
      note.hidden = true;
      // "No records found" is a claim about the corpus; with a tool still
      // being read it is not yet true. The pending note above says what is.
      empty.hidden = pendingIds.length > 0;
      setText(empty, pendingIds.length > 0 ? '' : t('settings.usage.empty'));
      return;
    }

    empty.hidden = true;
    list.hidden = false;
    const maxCost = periods.reduce((max, p) => (p.costUsd > max ? p.costUsd : max), 0);
    replaceChildrenWith(list, periods.map((p, i) => renderRow(p, maxCost, i)));

    note.hidden = false;
    // Each vendor's table has its own date. When Codex prices are in the
    // figures, both dates are stated; a single date would be false for one.
    //
    // `pricesAsOfByProvider` lists a table only when it priced something in
    // these figures, so a Codex-only history deliberately has no Claude date.
    // The legacy `pricesAsOf` (always Claude's) is used ONLY when the map is
    // absent or empty — an older main — never to fill a gap the map left on
    // purpose, or a Codex-only user would read a date for a table that priced
    // nothing.
    const byProvider = current ? current.pricesAsOfByProvider : undefined;
    const hasMap = !!byProvider && Object.keys(byProvider).length > 0;
    const claudeDate = hasMap ? byProvider?.claude : current?.pricesAsOf;
    const codexDate = hasMap ? byProvider?.codex : undefined;
    // Every note names every floor cause of the tools it covers: unpriced usage
    // (both), Claude's missing TTL split priced at the 1.25x floor (same facts
    // as cost.caveat.ttl), and Codex's unrecorded cache writes.
    const ttl = { low: multiplier(1.25), high: multiplier(2) };
    setText(
      note,
      claudeDate && codexDate
        ? t('settings.usage.noteByProvider', {
            claude: priceDate(claudeDate),
            codex: priceDate(codexDate),
            ...ttl,
          })
        : codexDate
          ? t('settings.usage.noteCodexOnly', { codex: priceDate(codexDate) })
          : claudeDate
            ? t('settings.usage.note', { date: priceDate(claudeDate), ...ttl })
            : t('settings.usage.noteNoDate'),
    );
  }

  function update(
    history: UsageHistory | null,
    dataArrived: boolean,
    providers: readonly ProviderSnapshot[],
    pending: readonly string[],
  ): void {
    current = history;
    hasData = dataArrived;
    known = providers;
    pendingIds = pending;
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
function wireAccordion(
  sections: readonly AccordionSection[],
  defaultOpenId: string | null,
): (id: string) => void {
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
  // Programmatic open, with the same one-open invariant as a click.
  return (id: string) => {
    for (const other of sections) setOpen(other, other.id === id);
  };
}

export function createSettings(ctx: SettingsContext): SettingsHandle {
  const items = new Map<string, ItemHandle>();

  const back = el('button', {
    type: 'button',
    class: 'iconbtn',
    'aria-label': t('settings.back'),
    title: t('settings.backTitle'),
  }) as HTMLButtonElement;
  back.appendChild(backIcon());
  on(back, 'click', () => ctx.onBack());

  const bar = el(
    'div',
    { class: 'settings__bar' },
    back,
    el('h2', { class: 'settings__title', id: SETTINGS_TITLE_ID }, t('header.settings')),
  );

  // --- "Model Yönetimi": which rows exist ---------------------------------
  const help = el(
    'p',
    { class: 'settings__help', id: SETTINGS_HELP_ID },
    t('settings.models.help'),
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
    t('settings.section.models'),
    [help, list, status],
  );

  // --- "Toplam Kullanım": per-period notional cost ------------------------
  const usage = createUsageSection();
  const usageSection = createAccordionSection(
    'usage',
    USAGE_HEADER_ID,
    USAGE_REGION_ID,
    t('settings.section.usage'),
    [usage.el],
  );

  // --- "Görünüm ve dil": the theme and the language ---------------------
  // One section for both: they are the two preferences about how the panel
  // presents itself, and a fourth accordion section would push the list down
  // in a 360px panel. The id stays 'theme' so existing hooks keep working.
  const theme = createThemeControl(ctx);
  const languageControl = createLanguageControl(ctx);
  const themeSection = createAccordionSection(
    'theme',
    THEME_HEADER_ID,
    THEME_REGION_ID,
    t('settings.section.appearance'),
    [theme.el, languageControl.el],
  );

  const sections = [modelsSection, usageSection, themeSection];
  // First section open. The tab path is back -> "Model Yönetimi" header ->
  // first switch: each section header is a real button and a tab stop.
  const openSection = wireAccordion(sections, 'models');

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
    languageControl.update(state);
    // The FULL snapshot list, not the added subset: a model row names its tool
    // even when that tool's row was removed from the main panel.
    usage.update(
      state.snapshot?.usageHistory ?? null,
      state.hasData,
      state.snapshot?.providers ?? providers,
      pendingUsageOf(state.snapshot),
    );

    // Three states for the models list, told apart in words. "Still scanning"
    // and "this machine has nothing" are different claims.
    if (!state.hasData) {
      list.hidden = true;
      status.hidden = false;
      setText(status, t('settings.scanning'));
      setAttr(status, 'aria-busy', 'true');
      return;
    }
    setAttr(status, 'aria-busy', null);
    if (providers.length === 0) {
      list.hidden = true;
      status.hidden = false;
      setText(status, t('providers.noneFound'));
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
    focusLanguage(): void {
      openSection('theme');
      languageControl.focusChecked();
    },
  };
}
