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
 * printed as it is — no "en az", no cause lines (the owner's 2026-09-23 ruling).
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
import {
  compact,
  dayRange,
  lowerFirst,
  modelName,
  priceDateShort,
  tokens as tokenCount,
  usd,
} from '../format.js';
import { language as currentLanguage, t, type MessageKey } from '../i18n.js';
import { experimentalTag } from './experimental.js';
import { hasTokenCount, modelTokens, providersWithTokens, tokensFor } from '../tokens.js';
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
const AUTOSTART_NAME_ID = 'settings-autostart-name';
const AUTOSTART_HELP_ID = 'settings-autostart-help';

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
  /** The user flipped "start with Windows". Optimistic; the app owns the revert. */
  onAutostart(enabled: boolean): void;
  /** Leave settings and go back to the usage list. */
  onBack(): void;
  /**
   * Take our statusLine hook out of this tool's settings (Claude Code, agy).
   * Main asks natively before it writes anything.
   */
  onDisconnect(providerId: string): void;
  /**
   * The user told us which plan they are on, or picked "Belirtilmedi" (the
   * empty string) to clear it.
   * Persist-then-apply: the app writes through main and puts the control back
   * if main answers false, so the field can never hold a value that was not
   * stored (ADR-004's rule for theme and language, applied here).
   */
  onPlanLabel(providerId: string, label: string): void;
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
  // ADR-003 A6.4: the same calm pill as the panel row. The name stays the
  // switch's label on its own; the pill (with its hidden explanation) is read
  // as part of the item's text.
  const experimental = experimentalTag(provider);
  const title = el('span', { class: 'settings__titleline' }, name, experimental);

  // --- the plan the user says they are on ---------------------------------
  //
  // A NATIVE `<select>` over the plans we know for this tool — a closed list,
  // the owner's call (2026-09-23): the free-text field invited typos and made
  // the row's label something nobody chose from. Native for the same reasons
  // as the theme radios: keyboard handling, an accessible name and an
  // announced option list come with it.
  //
  // NOTHING IS PRESELECTED and no tool has a default: the first option is
  // "Belirtilmedi", the empty value. Filling in "Max 20x" would be a guess
  // with our name on it, and this value's whole justification is that it is
  // the USER'S statement — `planLabel` is "from app settings only. Never
  // inferred, never guessed".
  //
  // A tool we know no plans for (Kimi, Antigravity) gets NO control: a select
  // holding only "Belirtilmedi" asks a question it cannot take an answer to.
  // The one exception is a label already stored for such a tool — see
  // updatePlan() — which must stay clearable.
  const planId = 'settings-plan-' + provider.id;
  const planSelect = el('select', {
    id: planId,
    class: 'settings__plan-select',
    'aria-describedby': planId + '-hint',
  }) as HTMLSelectElement;
  const planBlock = el(
    'div',
    { class: 'settings__plan' },
    el('label', { class: 'settings__plan-label', for: planId }, t('settings.plan.label')),
    planSelect,
    el('p', { class: 'settings__plan-hint', id: planId + '-hint' }, t('settings.plan.hint')),
  );
  planBlock.hidden = true;

  // The way back from the setup's hook, offered only while main reports the
  // hook is in the tool's settings (ProviderSnapshot.hookInstalled). Main
  // raises the confirmation, so one button is enough here.
  const disconnect = el(
    'button',
    { type: 'button', class: 'settings__disconnect' },
    t('settings.disconnect'),
  ) as HTMLButtonElement;
  disconnect.hidden = true;
  on(disconnect, 'click', () => ctx.onDisconnect(provider.id));

  /**
   * Committed on `change`: one write per choice, the empty value clearing it.
   * Main still sanitises what arrives (it cannot tell a select from a file
   * someone edited by hand), and the control is put back from the SNAPSHOT —
   * `update()` below selects `planLabel` again — so a refused write shows the
   * stored value without a second copy of main's rules here. If main refuses
   * outright, the app reverts and says so.
   */
  let planCommitted = provider.planLabel ?? '';
  on(planSelect, 'change', () => {
    const value = planSelect.value;
    if (value === planCommitted) return;
    planCommitted = value;
    ctx.onPlanLabel(provider.id, value);
  });
  // Snapshots that landed while the select was focused were not applied (see
  // updatePlan); leaving it applies the latest, so a refused write still
  // shows the stored value once the keyboard lets go.
  let lastPlan: { next: ProviderSnapshot; state: PanelState } | null = null;
  on(planSelect, 'blur', () => {
    if (lastPlan) updatePlan(lastPlan.next, lastPlan.state);
  });

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
    el('span', { class: 'settings__text' }, title, meta, disconnect),
    control,
    // AFTER the switch, deliberately, and this is a keyboard decision rather
    // than a layout one. The switch decides whether the tool appears at all;
    // the plan is a detail of a tool you have already added, so it must not sit
    // between the section header and the switch on the way through. DOM order
    // IS tab order, so the only way to say that is to put it here — and the
    // item wraps it onto its own full-width line below (panel.css), which also
    // gives the field more room than the text column had.
    planBlock,
  ) as HTMLLIElement;

  on(control, 'click', () => {
    // Read the CURRENT rendered state, not a captured one: the item is updated
    // in place across snapshots and a closed-over boolean would go stale.
    ctx.onToggle(provider.id, control.getAttribute('aria-checked') !== 'true');
  });

  /**
   * The options, and the selection, from main's stored value.
   *
   * A stored label that is not one of this tool's plans — typed into the old
   * free-text field, or a plan since renamed — is kept as an extra option
   * after the known ones, so opening Settings never silently drops what the
   * user said. It lasts only while it is the stored value: once they pick
   * something else, the next snapshot rebuilds the list without it.
   *
   * Never rewritten while the select is focused: arrowing through a closed
   * select commits each step, and a snapshot for an earlier step landing
   * under the keyboard would pull the selection back.
   */
  function updatePlan(next: ProviderSnapshot, state: PanelState): void {
    lastPlan = { next, state };
    const stored = next.planLabel ?? '';
    const known = planChoices(next.id);
    const extra = stored !== '' && !known.includes(stored) ? stored : null;
    const values = extra === null ? known : [...known, extra];
    // No known plans and nothing stored: no control at all.
    planBlock.hidden = values.length === 0;
    // `setAttr`, not `dataset`: the DOM shim the node-level tests mount this
    // component on implements attributes, and a component that needs `dataset`
    // to render is a component those tests cannot reach.
    const signature = JSON.stringify(values);
    const focused = document.activeElement === planSelect;
    if (!focused && signature !== planSelect.getAttribute('data-of')) {
      setAttr(planSelect, 'data-of', signature);
      replaceChildrenWith(planSelect, [
        el('option', { value: '' }, t('settings.plan.placeholder')),
        ...values.map((value) => el('option', { value }, value)),
      ]);
    }
    if (!focused && planSelect.value !== stored) planSelect.value = stored;
    if (!focused) planCommitted = stored;
    setAttr(root, 'data-plan-reverted', state.planReverted === next.id ? 'true' : null);
    setAttr(planSelect, 'aria-busy', state.planPending.includes(next.id) ? 'true' : null);
  }

  function update(next: ProviderSnapshot, state: PanelState, isEnabled: boolean): void {
    setText(name, next.displayName);
    const metaText = metaFor(next, isEnabled);
    setText(meta, metaText);
    setAttr(meta, 'title', metaText);
    setAttr(control, 'aria-checked', isEnabled ? 'true' : 'false');
    setAttr(root, 'data-enabled', isEnabled ? 'true' : 'false');
    setAttr(root, 'data-connected', next.connected ? 'true' : 'false');
    root.style.setProperty('--accent', next.accent);
    disconnect.hidden = next.hookInstalled !== true;
    setAttr(disconnect, 'aria-label', t('settings.disconnectLabel', { provider: next.displayName }));

    // In flight. The switch stays operable — a control that goes dead under
    // the pointer for one round trip is worse than one that accepts a second
    // press, and the app already lets the newest request win.
    const pending = state.enabledPending.includes(next.id);
    setAttr(control, 'aria-busy', pending ? 'true' : null);
    setAttr(root, 'data-pending', pending ? 'true' : null);

    // Main refused, so the switch went back. Held for a moment as an
    // attribute so the revert is SEEN and not only described in the notice.
    setAttr(root, 'data-revert', state.revertedId === next.id ? 'true' : null);

    updatePlan(next, state);
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
 * "Start with Windows".
 *
 * The same `button[role=switch]` and the same item layout as the provider
 * switches above, for the same reasons (a switch is announced as one, and
 * Space/Enter already operate a button). The name comes from the label, the
 * state from aria-checked. It is the value the tray menu's checkbox shows:
 * main rebuilds that menu when this changes, and pushes PREFERENCES when the
 * menu changes it, so the two never disagree for longer than one round trip.
 */
interface AutostartHandleLocal {
  el: HTMLElement;
  update(state: PanelState): void;
}

function createAutostartControl(ctx: SettingsContext): AutostartHandleLocal {
  const name = el('span', { class: 'settings__name', id: AUTOSTART_NAME_ID }, t('settings.autostart.label'));
  const hint = el('span', { class: 'settings__meta', id: AUTOSTART_HELP_ID }, t('settings.autostart.help'));
  const control = el('button', {
    type: 'button',
    class: 'switch',
    role: 'switch',
    'aria-checked': 'false',
    'aria-labelledby': AUTOSTART_NAME_ID,
    'aria-describedby': AUTOSTART_HELP_ID,
  }) as HTMLButtonElement;
  control.appendChild(el('span', { class: 'switch__track', 'aria-hidden': 'true' }));

  const root = el(
    'div',
    { class: 'settings__item settings__item--autostart' },
    el('span', { class: 'settings__text' }, name, hint),
    control,
  );

  on(control, 'click', () => {
    // The rendered state, not a captured one, as the provider switch does.
    ctx.onAutostart(control.getAttribute('aria-checked') !== 'true');
  });

  function update(state: PanelState): void {
    // A Store package: Windows owns the setting, so the row only says where.
    control.hidden = state.autostartByWindows;
    setText(hint, t(state.autostartByWindows ? 'settings.autostart.byWindows' : 'settings.autostart.help'));
    setAttr(control, 'aria-checked', state.autostart ? 'true' : 'false');
    setAttr(root, 'data-enabled', state.autostart ? 'true' : 'false');
    // In flight, and refused: the provider switch's two attributes, so the
    // same CSS draws the wait and the revert flash.
    setAttr(control, 'aria-busy', state.autostartPending ? 'true' : null);
    setAttr(root, 'data-pending', state.autostartPending ? 'true' : null);
    setAttr(root, 'data-revert', state.autostartReverted ? 'true' : null);
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
 * ONE PERIOD AT A TIME (owner, 2026-09-28: "sayfalarca kullanım kısmı olacak").
 * Listing every period with its models grew by a screen per month of use. A
 * small bar chart of all the periods sits on top instead — one column each,
 * oldest left, height by cost — and only the chosen period is shown below it,
 * with ‹ › beside its dates. The section is the same height after a month of
 * use as after a year. The newest period is chosen until the user picks
 * another, and a pick survives the snapshot pushes that rebuild the section.
 *
 * Under the chosen period sits its per-model disclosure, OPEN by default now
 * that it is the only one on screen; closing it is remembered per period. The
 * summary line counts the models (no figure, like the quota block). The
 * per-model list is itself a bounded
 * scroller (`.usage__models` max-height + overflow), so a period with many
 * models scrolls WITHIN its disclosure instead of pushing the panel off screen.
 * Each model amount is framed exactly like the period amount — "fiyatlanamadı"
 * for an unpriced model — never a bare "$0,00".
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

/**
 * The price note under Toplam Kullanım, composed per tool (ADR-003 A6), in the
 * cost block's shape (ADR-004 A3: nobody reads a wall of text).
 *
 * One compact line per tool in `usageProviders` with its price source and date:
 * "Claude Code · 1 Ağu 2026 fiyatları", "Qwen Code · Alibaba Cloud Model
 * Studio, 28 Eyl 2026", "Grok Build · xAI'nin bildirdiği tutar", "Kimi · fiyat
 * yayımlamıyor". Nothing else: the "en az" lead and the
 * per-tool causes behind "Neden en az?" went with the floor marker.
 *
 * A date is stated only for a table that priced something in these figures
 * (`pricesAsOfByProvider`); the legacy `pricesAsOf` (always Claude's) is used
 * only when main sends no per-tool data at all — an older main.
 */
interface NoteModel {
  sources: { id: ProviderSnapshot['id']; text: string }[];
  /** No tool at all: the single "date not reported" line. */
  empty: boolean;
}

function noteModel(history: UsageHistory | null, known: readonly ProviderSnapshot[]): NoteModel {
  const byDate = history?.pricesAsOfByProvider ?? {};
  let tools: ProviderSnapshot['id'][] = history?.usageProviders ?? [];
  let legacy = false;
  if (tools.length === 0) {
    tools = Object.keys(byDate) as ProviderSnapshot['id'][];
    if (tools.length === 0 && history?.pricesAsOf) {
      tools = ['claude'];
      legacy = true;
    }
  }
  if (tools.length === 0) return { sources: [], empty: true };

  const nameOf = (id: ProviderSnapshot['id']): string =>
    known.find((p) => p.id === id)?.displayName || NOTE_TOOL_NAMES[id];

  const sources: NoteModel['sources'] = [];
  for (const id of tools) {
    const tool = nameOf(id);
    const date = legacy ? history?.pricesAsOf : byDate[id];
    // Kimi has no price table and Grok's amounts are xAI's own (contract:
    // neither is ever in pricesAsOfByProvider).
    const hasTable = !!date || (id !== 'kimi' && id !== 'grok');

    sources.push({
      id,
      text: id === 'grok'
        ? t('settings.usage.source.grok', { tool })
        : !hasTable
          ? t('settings.usage.source.none', { tool })
          : id === 'qwen'
            ? date
              ? t('settings.usage.source.qwen', { tool, date: priceDateShort(date) })
              : t('settings.usage.source.qwenNoDate', { tool })
            : date
              ? t('settings.usage.source.date', { tool, date: priceDateShort(date) })
              : t('settings.usage.source.dateMissing', { tool }),
    });
  }
  return { sources, empty: false };
}

/**
 * The plans we know each vendor sells: the options of the plan select.
 *
 * Not a default: nothing is preselected, and a tool with no entry here gets no
 * control. These go stale every time a vendor renames a tier; a stored label
 * that has fallen off this list is still offered while it is stored (see
 * updatePlan), so a stale list never silently rewrites what the user said.
 * Main does not validate against this list — it only sanitises.
 *
 * Not translated: they are product names, and "Max 20x" is "Max 20x" in every
 * language. Translating a plan name would invent a plan.
 */
const PLAN_CHOICES: Partial<Record<ProviderSnapshot['id'], readonly string[]>> = {
  claude: ['Pro', 'Max 5x', 'Max 20x'],
  codex: ['Plus', 'Pro', 'Business', 'Enterprise'],
  kimi: [],
  antigravity: [],
  // No plan list we could verify for either: no control, as for Kimi.
  qwen: [],
  grok: [],
};

function planChoices(id: ProviderSnapshot['id']): readonly string[] {
  return PLAN_CHOICES[id] ?? [];
}

/** Names for a tool the snapshot did not list (never expected; never a raw id). */
const NOTE_TOOL_NAMES: Record<ProviderSnapshot['id'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  qwen: 'Qwen Code',
  grok: 'Grok Build',
};


function joinList(items: readonly string[]): string {
  try {
    return new Intl.ListFormat(currentLanguage(), { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join('; ');
  }
}

/** The amount cell's text, framed and honest. Never a bare "$0,00". */
function amountText(period: PeriodUsage, pending: boolean): string {
  // While a tool is still being counted, an empty or zero period is not known
  // to be empty: that tool's usage in it has not been read. "—" would claim it.
  // A figure that IS present stays unqualified — pending is incomplete, and
  // the section's note says so.
  if (pending && (!period.hasUsage || period.costUsd <= 0)) return t('settings.amount.pending');
  if (period.costUsd > 0) return usd(period.costUsd);
  // Usage happened, but none of it could be priced: say so rather than print a
  // zero that reads as "free".
  if (period.hasUsage && period.unpricedModels.length > 0) return t('settings.amount.unpriced');
  // A floor with no figure: records in this period could not be read (A3.20).
  // "—" would claim the period is empty; the word says why there is no figure.
  if (isIncompleteAmount(period, pending)) return t('settings.amount.incomplete');
  return '—';
}

/** True when the amount cell reads "okunamadı" rather than a figure or "—". */
function isIncompleteAmount(period: PeriodUsage, pending: boolean): boolean {
  if (pending && (!period.hasUsage || period.costUsd <= 0)) return false;
  if (period.costUsd > 0) return false;
  if (period.hasUsage && period.unpricedModels.length > 0) return false;
  return period.isFloor;
}

/**
 * One model's amount, framed the same way as the period's. A null cost is an
 * unpriced model — "fiyatlanamadı", never "$0,00", the ADR-002 rule-2 silent
 * zero this whole section refuses. A priced-but-zero figure (a model whose
 * events carried no billable tokens) reads "—" rather than a misleading "free".
 */
function modelAmountText(model: PeriodModelCost): string {
  if (model.costUsd === null) return t('settings.amount.unpriced');
  if (model.costUsd > 0) return usd(model.costUsd);
  return '—';
}

/**
 * The four classes of one breakdown, as a title. The same four lines the panel
 * row uses, so `cacheRead` is stated as its own number everywhere it appears —
 * it is ~98% of raw volume and bills at 0.1x, and a figure folding it into the
 * others would be dominated by it and would say nothing.
 */
function tokensTitle(tk: NonNullable<ReturnType<typeof tokensFor>>): string {
  return [
    t('row.tokens.input', { value: compact(tk.input) }),
    t('row.tokens.output', { value: compact(tk.output) }),
    t('row.tokens.cacheWrite', { value: compact(tk.cacheWrite) }),
    t('row.tokens.cacheRead', { value: compact(tk.cacheRead) }),
  ].join(' · ');
}

/**
 * One model line's token count, printed as it is.
 *
 * A count is shown even when `costUsd` is null: the tokens were used whether
 * or not a price exists for them, and blanking the count to match the price
 * would hide real usage.
 *
 * Empty string ONLY when no count arrived (null). A count of zero prints as
 * zero — it is a measurement.
 */
function modelTokensText(model: PeriodModelCost): string {
  const tk = modelTokens(model);
  return tk ? tokenCount(tk.billable) : '';
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
  // one-directional. ADR-002's framing instead:
  // what this usage WOULD HAVE COST at published API prices. The data source
  // is a separate, per-provider sentence, so a second provider's history does
  // not require rewriting the claim.
  // ADR-003 A6 (review F1): the source sentence names the tools actually in
  // the history, so it stays true as tools are added. Updated on every render.
  const introSources = el('span', { class: 'usage__intro-sources' }, t('settings.usage.sources'));
  const intro = el('p', { class: 'usage__intro' }, `${t('settings.usage.intro')} `, introSources);

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

  // The period chooser: one column per period, oldest on the left. A group of
  // toggle buttons with a roving tab stop, so the chart is ONE stop in the tab
  // order and the arrow keys move along it.
  const chart = el('div', { class: 'usage__chart', role: 'group', 'aria-label': t('settings.usage.chart') });
  const list = el('ul', { class: 'usage__list', role: 'list' });
  const empty = el('p', { class: 'usage__empty' }, '');
  // --- the price note (ADR-003 A6, ADR-004 A3) -----------------------------
  // One line per tool naming its price source and date.
  const noteSources = el('ul', { class: 'usage__sources' });
  const note = el('div', { class: 'usage__note' }, noteSources);

  // Which per-period disclosures the user has CLOSED (they start open). The
  // section is rebuilt from scratch on every snapshot (every 15 s while the
  // panel is open), so a disclosure that kept its state only in its own DOM
  // node snapped back on the next push, under the user's cursor. Keyed by
  // grain + period key + start so it survives the rebuild and a new week
  // sliding in at the top (the periods' INDEX shifts then; the key does not).
  const closedPeriods = new Set<string>();
  const periodOpenKey = (period: PeriodUsage): string => `${grain}|${period.key}|${period.startsAt}`;
  // The period the user chose, per grain, by the same stable key. Absent: the
  // newest, which a new week or month then takes over. Choosing the newest
  // clears it, so "the current period" keeps following the calendar.
  const chosen = new Map<UsageGrain, string>();
  // The toggles of the CURRENT list, by the same key, so focus can move to a
  // replacement without querying the DOM (the node-level test shim does not
  // implement selectors, and a component those tests cannot mount is untested).
  let toggleByKey = new Map<string, HTMLElement>();
  // The chooser's controls of the current render, by role, for the same reason.
  let focusable: Partial<Record<'col' | 'prev' | 'next', HTMLElement>> = {};
  function renderNote(): void {
    const model = noteModel(current, known);
    replaceChildrenWith(
      noteSources,
      model.empty
        ? [el('li', { class: 'usage__source' }, t('settings.usage.noteNoDate'))]
        : model.sources.map((s) => el('li', { class: 'usage__source', 'data-provider': s.id }, s.text)),
    );
  }
  // ADR-002 A3.12. Above the list, not in the footnote: it changes what every
  // total below it means, and it must be read before them.
  const pendingNote = el('p', { class: 'usage__pending', role: 'status' }, '');
  pendingNote.hidden = true;
  // ADR-002 A3.20. Also above the list, for the same reason: it qualifies the
  // totals below it. Shown only when some tool had records it could not read.
  const incompleteNote = el('p', { class: 'usage__incomplete' }, '');
  incompleteNote.hidden = true;

  const root = el(
    'div',
    { class: 'usage' },
    intro,
    toggle,
    pendingNote,
    incompleteNote,
    chart,
    list,
    empty,
    note,
  );

  function periodsFor(): PeriodUsage[] {
    if (!current) return [];
    return grain === 'week' ? current.weeks : current.months;
  }

  /**
   * One model's line inside a period's disclosure: its id and its framed cost.
   * The id is rendered verbatim through a text node (`el` never uses innerHTML),
   * so a model name decoded from a file cannot become markup.
   */
  function renderModelRow(model: PeriodModelCost, period: PeriodUsage): HTMLElement {
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
    // The count sits BEFORE the money, in quieter ink: this section's headline
    // claim is the notional cost, and the count answers a different question
    // ("how many tokens did I use") that has a true answer of its own.
    const tokensText = modelTokensText(model);
    const tokensCell = el('span', { class: 'usage__model-tokens u-num' }, tokensText);
    const modelTk = modelTokens(model);
    if (modelTk && hasTokenCount(modelTk)) setAttr(tokensCell, 'title', tokensTitle(modelTk));
    tokensCell.hidden = tokensText === '';
    const row = el(
      'li',
      { class: 'usage__model', role: 'listitem' },
      mark,
      name,
      tokensCell,
      amount,
    ) as HTMLElement;
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
   *
   * The token subtotals are PASSED IN, not built here. They used to be built
   * inside, which tied them to `byModel` being non-empty — so a period with real
   * per-tool counts and an unusable model list rendered its cost and NO counts
   * at all, silently. Unreachable from main, but reachable through this
   * renderer's own boundary: `periodModelCost` drops an entry whose model name
   * or provider id fails validation, so a payload whose entries all fail loses
   * the figure this section exists to show — the exact opposite of the rule the
   * rest of this file follows, that one bad field must not delete something the
   * user could still have been shown truthfully.
   */
  function renderDisclosure(
    period: PeriodUsage,
    regionId: string,
    subtotals: HTMLElement | null,
  ): readonly HTMLElement[] {
    const openKey = periodOpenKey(period);
    const startOpen = !closedPeriods.has(openKey);
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
        'aria-expanded': startOpen ? 'true' : 'false',
        'aria-controls': regionId,
        'data-open-key': openKey,
        title: t('settings.models.breakdown'),
      },
      label,
      chev,
    ) as HTMLButtonElement;

    const models = el(
      'ul',
      { class: 'usage__models', id: regionId, role: 'list' },
      ...period.byModel.map((model) => renderModelRow(model, period)),
    ) as HTMLElement;
    models.hidden = !startOpen;

    if (subtotals) subtotals.hidden = !startOpen;

    on(toggle, 'click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      setAttr(toggle, 'aria-expanded', open ? 'false' : 'true');
      models.hidden = open;
      if (subtotals) subtotals.hidden = open;
      if (open) closedPeriods.add(openKey);
      else closedPeriods.delete(openKey);
    });
    toggleByKey.set(openKey, toggle);

    return subtotals ? [toggle, models, subtotals] : [toggle, models];
  }

  /**
   * The period's token counts, ONE PER TOOL.
   *
   * Read from `tokensByProvider` and never composed from the rows above it:
   * `byModel` is capped at 24 entries, so adding up what is shown can silently
   * fall short of the tool's real figure — which is exactly why main sends this
   * map. And it is never added ACROSS tools either. Dollars add because both
   * sides are USD at published rates; token counts do not, because each vendor
   * counts and bills its classes its own way and `cacheRead` sits in a
   * different proportion in each. A merged "tokens used this period" is the one
   * figure ADR-001 bans, so there is no total line here and no code path that
   * could produce one: `tokensFor()` can only ever return one tool's figure.
   *
   * Returns null when no tool has a count here, so an empty period grows no
   * empty heading.
   */
  function renderTokenSubtotals(period: PeriodUsage): HTMLElement | null {
    const ids = providersWithTokens(period, current?.usageProviders ?? []);
    if (ids.length === 0) return null;
    const rows = ids.map((id) => {
      const tk = tokensFor(period, id);
      const provider = known.find((p) => p.id === id) ?? null;
      const toolName = provider?.displayName || NOTE_TOOL_NAMES[id];
      const value = tk ? tokenCount(tk.billable) : '';
      const row = el(
        'li',
        { class: 'usage__tokens-row', role: 'listitem' },
        el('span', { class: 'usage__tokens-tool' }, toolName),
        el('span', { class: 'usage__tokens-count u-num' }, value),
      ) as HTMLElement;
      if (tk && hasTokenCount(tk)) setAttr(row, 'title', tokensTitle(tk));
      setAttr(row, 'data-provider', id);
      setAttr(row, 'data-connected', provider?.connected ? 'true' : 'false');
      return row;
    });
    return el('ul', { class: 'usage__tokens', role: 'list' }, ...rows) as HTMLElement;
  }

  /** One step button of the chooser; `older` points left. Hidden when there is nowhere to go. */
  function stepButton(older: boolean, target: number | null): HTMLElement {
    const label = t(older ? 'settings.usage.prev' : 'settings.usage.next');
    const btn = el(
      'button',
      {
        type: 'button',
        class: `usage__step usage__step--${older ? 'prev' : 'next'}`,
        'aria-label': label,
        title: label,
      },
      chevronIcon(),
    ) as HTMLElement;
    if (target === null) {
      // Kept in place (so the dates do not shift), but inert and invisible.
      setAttr(btn, 'disabled', '');
      setAttr(btn, 'aria-hidden', 'true');
      setAttr(btn, 'tabindex', '-1');
    } else {
      on(btn, 'click', () => choose(target, older ? 'prev' : 'next'));
      focusable[older ? 'prev' : 'next'] = btn;
    }
    return btn;
  }

  function renderRow(period: PeriodUsage, index: number, count: number): HTMLElement {
    const range = el('span', { class: 'usage__range' }, dayRange(period.startsAt, period.endsAt) || '—');
    const pending = pendingIds.length > 0;
    const amount = el('span', { class: 'usage__amount u-num' }, amountText(period, pending));
    // Periods run newest first, so "older" is the next index.
    const nav = el(
      'span',
      { class: 'usage__nav' },
      stepButton(true, index + 1 < count ? index + 1 : null),
      range,
      stepButton(false, index > 0 ? index - 1 : null),
    );
    const row = el('li', { class: 'usage__row', role: 'listitem' }, nav, amount) as HTMLElement;
    const incomplete = isIncompleteAmount(period, pending);
    setAttr(row, 'data-empty', period.hasUsage || pending || incomplete ? null : 'true');
    setAttr(row, 'data-incomplete', incomplete ? 'true' : null);
    setAttr(row, 'data-pending', pending && (!period.hasUsage || period.costUsd <= 0) ? 'true' : null);
    // Two independent things can hang under a period, and neither may gate the
    // other: the per-model split, and the per-tool token counts.
    //
    // Only a period with a per-model split gets a DISCLOSURE — an empty period
    // has nothing to break down, and a toggle reading "0 model" would be an
    // invitation to open nothing. The region id is unique per grain+index so the
    // toggle's aria-controls resolves even with a duplicate period key.
    //
    // The COUNTS are shown whenever they exist. With a model list they sit
    // inside the disclosure, under the rows they summarise; without one they
    // attach to the row directly and stay VISIBLE, because there is then nothing
    // to expand and they are the figure the user came for. Losing them because
    // the model list happened to be unusable would delete a true measurement
    // over an unrelated validation failure.
    const subtotals = renderTokenSubtotals(period);
    if (period.byModel.length > 0) {
      const regionId = `usage-models-${grain}-${index}`;
      for (const node of renderDisclosure(period, regionId, subtotals)) row.appendChild(node);
    } else if (subtotals) {
      row.appendChild(subtotals);
    }
    return row;
  }

  /** "Codex" / "Claude Code ve Codex", in the panel's language. */
  function pendingToolsText(): string {
    return toolsText(pendingIds);
  }

  function toolsText(ids: readonly string[]): string {
    const names = ids.map((id) => known.find((p) => p.id === id)?.displayName || id);
    try {
      return new Intl.ListFormat(currentLanguage(), { style: 'long', type: 'conjunction' }).format(names);
    } catch {
      return names.join(', ');
    }
  }

  function renderList(): void {
    const sourceTools = current?.usageProviders ?? [];
    setText(
      introSources,
      sourceTools.length > 0
        ? t('settings.usage.sourcesTools', {
            tools: joinList(
              sourceTools.map((id) => known.find((p) => p.id === id)?.displayName || NOTE_TOOL_NAMES[id]),
            ),
          })
        : t('settings.usage.sources'),
    );
    for (const [v, input] of radios) {
      const on_ = grain === v;
      if (input.checked !== on_) input.checked = on_;
    }

    pendingNote.hidden = pendingIds.length === 0;
    setText(pendingNote, pendingIds.length > 0 ? t('settings.usage.pending', { tools: pendingToolsText() }) : '');

    const incompleteIds = current?.incompleteProviders ?? [];
    incompleteNote.hidden = incompleteIds.length === 0;
    setText(
      incompleteNote,
      incompleteIds.length > 0 ? t('settings.usage.incomplete', { tools: toolsText(incompleteIds) }) : '',
    );

    if (!hasData) {
      chart.hidden = true;
      list.hidden = true;
      note.hidden = true;
      empty.hidden = false;
      setText(empty, t('settings.usage.loading'));
      return;
    }

    const periods = periodsFor();
    if (periods.length === 0) {
      chart.hidden = true;
      list.hidden = true;
      note.hidden = true;
      // "No records found" is a claim about the corpus; with a tool still
      // being read it is not yet true. The pending note above says what is.
      // Likewise with records known to be unread (A3.20): the incomplete note
      // above says why there is nothing to list.
      const unread = (current?.incompleteProviders ?? []).length > 0;
      empty.hidden = pendingIds.length > 0 || unread;
      setText(empty, pendingIds.length > 0 || unread ? '' : t('settings.usage.empty'));
      return;
    }

    empty.hidden = true;
    list.hidden = false;
    // The rebuild replaces every node, so a keyboard user sitting on a toggle
    // or on the chooser would lose focus on each push. Remember which control
    // held it and put focus back on its replacement.
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    let focusedKey: string | null = null;
    for (const [k, node] of toggleByKey) if (node === active) focusedKey = k;
    let focusedRole: keyof typeof focusable | null = null;
    for (const [role, node] of Object.entries(focusable)) if (node === active) focusedRole = role as keyof typeof focusable;
    renderPeriods(periods, focusedKey, focusedRole);

    note.hidden = false;
    renderNote();
  }

  /** The chosen period's index in `periods`: the user's pick, else the newest. */
  function chosenIndex(periods: readonly PeriodUsage[]): number {
    const want = chosen.get(grain);
    if (want === undefined) return 0;
    const i = periods.findIndex((p) => periodOpenKey(p) === want);
    return i < 0 ? 0 : i;
  }

  /** Choose period `index` of the current grain, keeping focus on the control that did it. */
  function choose(index: number, via: keyof typeof focusable): void {
    const periods = periodsFor();
    const target = periods[index];
    if (!target) return;
    if (index === 0) chosen.delete(grain);
    else chosen.set(grain, periodOpenKey(target));
    renderPeriods(periods, null, via);
  }

  /** A column's short label: the month's abbreviation, or a week's first day. */
  function columnLabel(period: PeriodUsage): string {
    const d = new Date(period.startsAt);
    if (Number.isNaN(d.getTime())) return '';
    if (grain === 'week') return String(d.getDate());
    try {
      return new Intl.DateTimeFormat(currentLanguage(), { month: 'short' }).format(d).replace(/\.$/, '');
    } catch {
      return String(d.getMonth() + 1);
    }
  }

  function renderPeriods(
    periods: readonly PeriodUsage[],
    focusedKey: string | null,
    focusedRole: keyof typeof focusable | null,
  ): void {
    const index = chosenIndex(periods);
    const pending = pendingIds.length > 0;
    const maxCost = periods.reduce((max, p) => (p.costUsd > max ? p.costUsd : max), 0);
    toggleByKey = new Map();
    focusable = {};

    // Forget periods of THIS grain that are no longer listed (a week that
    // rolled off the end); the other grain's entries are left alone.
    const listed = new Set(periods.map(periodOpenKey));
    for (const k of closedPeriods) if (k.startsWith(`${grain}|`) && !listed.has(k)) closedPeriods.delete(k);

    // Oldest on the left, like any timeline.
    const columns: HTMLElement[] = [];
    for (let i = periods.length - 1; i >= 0; i -= 1) {
      const p = periods[i];
      const selected = i === index;
      const range = dayRange(p.startsAt, p.endsAt) || '—';
      const name = t('settings.usage.column', { range, amount: amountText(p, pending) });
      const bar = el('span', { class: 'usage__col-bar' });
      bar.style.setProperty('--h', maxCost > 0 && p.costUsd > 0 ? (p.costUsd / maxCost).toFixed(4) : '0');
      const col = el(
        'button',
        {
          type: 'button',
          class: 'usage__col',
          'aria-pressed': selected ? 'true' : 'false',
          'aria-label': name,
          title: name,
          tabindex: selected ? '0' : '-1',
        },
        el('span', { class: 'usage__col-track', 'aria-hidden': 'true' }, bar),
        el('span', { class: 'usage__col-label', 'aria-hidden': 'true' }, columnLabel(p)),
      ) as HTMLElement;
      setAttr(col, 'data-empty', p.hasUsage && p.costUsd > 0 ? null : 'true');
      setAttr(col, 'data-incomplete', isIncompleteAmount(p, pending) ? 'true' : null);
      const at = i;
      on(col, 'click', () => choose(at, 'col'));
      on(col, 'keydown', (e) => {
        const key = e.key;
        // Left is older (a higher index), right is newer.
        const next = key === 'ArrowLeft' ? at + 1
          : key === 'ArrowRight' ? at - 1
            : key === 'Home' ? periods.length - 1
              : key === 'End' ? 0
                : null;
        if (next === null) return;
        e.preventDefault();
        if (next >= 0 && next < periods.length) choose(next, 'col');
      });
      if (selected) focusable.col = col;
      columns.push(col);
    }
    replaceChildrenWith(chart, columns);
    // One period: there is nothing to choose between.
    chart.hidden = periods.length < 2;

    replaceChildrenWith(list, [renderRow(periods[index], index, periods.length)]);

    if (focusedKey && toggleByKey.has(focusedKey)) toggleByKey.get(focusedKey)?.focus();
    else if (focusedRole) (focusable[focusedRole] ?? focusable.col)?.focus();
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
  // "Start with Windows" sits here too, last, for the same reason: it is the
  // one app-wide preference left, and it did not earn a section of its own.
  const theme = createThemeControl(ctx);
  const languageControl = createLanguageControl(ctx);
  const autostart = createAutostartControl(ctx);
  const themeSection = createAccordionSection(
    'theme',
    THEME_HEADER_ID,
    THEME_REGION_ID,
    t('settings.section.appearance'),
    [theme.el, languageControl.el, autostart.el],
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
    autostart.update(state);
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
