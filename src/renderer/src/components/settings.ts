/**
 * The in-panel settings view: which providers exist as rows in the main panel.
 *
 * ADDED vs. CONNECTED
 * -------------------
 * These are two different questions and this view answers only the first.
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
 * TWO SECTIONS NOW
 * ----------------
 * "Araçlar" (which rows exist) and "Görünüm" (the theme). The view heading is
 * therefore "Ayarlar" and each section carries its own h3 — a single h2 saying
 * "Araçlar" over a theme control would be a heading that lies about what it
 * covers, and headings are how a screen reader user navigates this view.
 *
 * The appearance section comes LAST in DOM order on purpose: it keeps the
 * existing tab path (back control -> first provider switch) exactly as it was.
 */

import type { ProviderSnapshot, ThemeChoice } from '../../../shared/contract.js';
import { el, on, setAttr, setText, svg } from '../dom.js';
import { enabledOf, type PanelState } from '../store.js';
import { themeLabel } from '../theme.js';
import { providerMark } from './logo.js';

/** The id the header's settings button points `aria-controls` at. */
export const SETTINGS_VIEW_ID = 'settings-view';
const SETTINGS_TITLE_ID = 'settings-title';
const TOOLS_TITLE_ID = 'settings-tools-title';
const SETTINGS_HELP_ID = 'settings-help';
const THEME_TITLE_ID = 'settings-theme-title';
const THEME_HELP_ID = 'settings-theme-help';

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
    el('legend', { class: 'settings__section', id: THEME_TITLE_ID }, 'Görünüm'),
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

  // The view holds two sections now, so "Araçlar" is a section heading rather
  // than the view's title. The list is labelled by THIS heading, not by the
  // view title, or a screen reader would announce the theme radios as part of
  // a list of tools.
  const toolsTitle = el('h3', { class: 'settings__section', id: TOOLS_TITLE_ID }, 'Araçlar');

  const help = el(
    'p',
    { class: 'settings__help', id: SETTINGS_HELP_ID },
    'Ana panelde hangi araçların görüneceğini seçin. Kaldırılan araç yalnızca ' +
      'listeden çıkar — bağlantısı kesilmez, hiçbir veri silinmez.',
  );

  const list = el('ul', {
    class: 'settings__list',
    role: 'list',
    'aria-labelledby': TOOLS_TITLE_ID,
    'aria-describedby': SETTINGS_HELP_ID,
  });

  // The view's own three states. "Taranıyor" and "araç yok" are different
  // claims and must not share one blank panel.
  const status = el('p', { class: 'settings__status' }, '');
  status.hidden = true;

  const theme = createThemeControl(ctx);

  const root = el(
    'section',
    {
      class: 'settings',
      id: SETTINGS_VIEW_ID,
      role: 'group',
      'aria-labelledby': SETTINGS_TITLE_ID,
    },
    bar,
    toolsTitle,
    help,
    list,
    status,
    // Last, so the tab path from the back control still runs into the provider
    // switches before it reaches anything new.
    theme.el,
  );
  root.hidden = true;

  /**
   * Reconciled by id in the order given, exactly like the main list: the
   * switch must keep focus across the 15s snapshot cadence.
   *
   * Runs BEFORE the empty/loading branches decide what to show, and runs even
   * for an empty array. Returning early instead left six hidden switches in
   * the document after every provider went away — invisible, but still real
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
    // Painted before the three list states return: the theme control belongs
    // to the VIEW, not to the provider list, and a machine with no recognised
    // tools must still be able to pick a theme. Returning early above it was
    // how the settings status branches used to strand everything below them.
    theme.update(state);

    // Three states, told apart in words. "Still scanning" and "this machine has
    // nothing" are different claims and must not share one blank form.
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
