/**
 * What "Öne çıkan" and "Kutucuklar" add to the panel (Görünüm → Düzen). The
 * cards themselves are NOT forked: every layout draws the same row component
 * (row.ts, with its meter, states, details, tooltips and meters' aria), and
 * the layouts are its CSS (styles/layout-focus.css, layout-tiles.css) plus
 * the three small things here:
 *
 *   pickHero    which tool "Öne çıkan" puts on top, and by which window;
 *   sheet back  the way back from a tool's details, which outside the list
 *               are a sheet over the other tools rather than a card that grew;
 *   quick tiles "Kutucuklar"'s Tema / Şerit / Ayarlar / Yenile under the grid.
 */

import type { Layout, ProviderSnapshot, ThemeChoice } from '../../../shared/contract.js';
import { el, on, setAttr, setText, svg } from '../dom.js';
import { clockTime } from '../format.js';
import { t } from '../i18n.js';
import type { PanelState } from '../store.js';
import { themeLabel } from '../theme.js';
import { isDrawable } from './meter.js';
import { captureExpired } from './row.js';

export type LeadWindow = '5h' | '7d';

export interface Hero {
  id: string;
  /** The window that put it on top: its figure is the large one. */
  lead: LeadWindow;
}

/**
 * The connected tool closest to its limit: the highest figure of any of its
 * windows, compared on the same value the meter prints. Ties keep the user's
 * order (only a strictly higher figure takes the place), and on a tie inside
 * one tool the five-hour window leads, as everywhere else.
 *
 * A window is counted only where the meter would draw it: not 'unknown', a
 * finite figure, and not a capture whose window rolled over (row.ts crosses
 * that boundary on the tick, so this must too). A tool that is not connected,
 * still loading or without any such window cannot be the hero, so a machine
 * with nothing to measure yet has no hero and every tool is a row.
 */
export function pickHero(providers: readonly ProviderSnapshot[], now: number): Hero | null {
  let best: Hero | null = null;
  let bestValue = -Infinity;
  for (const p of providers) {
    if (!p.connected || p.status === 'passive' || p.status === 'loading') continue;
    const five = isDrawable(p.fiveHour) && !captureExpired(p.fiveHour, now) ? (p.fiveHour.usedPercentage as number) : null;
    const week = isDrawable(p.sevenDay) && !captureExpired(p.sevenDay, now) ? (p.sevenDay.usedPercentage as number) : null;
    if (five === null && week === null) continue;
    const lead: LeadWindow = week !== null && (five === null || week > five) ? '7d' : '5h';
    const value = Math.round((lead === '5h' ? five : week) as number);
    if (value > bestValue) {
      best = { id: p.id, lead };
      bestValue = value;
    }
  }
  return best;
}

/** Is this layout one where a tool's details are a sheet over the others? */
export function detailsAreSheet(layout: Layout): boolean {
  return layout !== 'list';
}

function backIcon(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', {
      d: 'M10 4l-4 4 4 4',
      stroke: 'currentColor',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
}

/**
 * "‹ Tüm araçlar": shown above a tool's details while they are a sheet. The
 * card's own "Ayrıntıları gizle" and Esc do the same; this one is where the
 * eye looks for a way back, at the top.
 */
export function createSheetBack(onBack: () => void): HTMLButtonElement {
  const button = el(
    'button',
    { type: 'button', class: 'sheet-back', 'aria-label': t('layout.sheet.backLabel') },
    backIcon(),
    el('span', { class: 'sheet-back__label' }, t('layout.sheet.back')),
  ) as HTMLButtonElement;
  on(button, 'click', () => onBack());
  button.hidden = true;
  return button;
}

// ------------------------------------------------------------ quick tiles

export interface QuickTilesContext {
  onTheme(theme: ThemeChoice): void;
  onTrayView(view: 'tray' | 'strip'): void;
  onSettings(): void;
  onRefresh(): void;
}

export interface QuickTilesHandle {
  el: HTMLElement;
  /** The refresh, for the panel's one painter of every refresh control. */
  refreshButton: HTMLButtonElement;
  refreshLabel: HTMLElement;
  update(state: PanelState): void;
}

/** Light, then dark, then the system's, then light again. */
const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { light: 'dark', dark: 'system', system: 'light' };

function glyph(d: string): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { d, stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  );
}

const GLYPHS = {
  theme: 'M8 2.5a5.5 5.5 0 1 0 0 11V2.5ZM8 2.5a5.5 5.5 0 0 1 0 11',
  strip: 'M2 10.5h12M3.5 12.5h9a1.5 1.5 0 0 0 1.5-1.5V5a1.5 1.5 0 0 0-1.5-1.5h-9A1.5 1.5 0 0 0 2 5v6a1.5 1.5 0 0 0 1.5 1.5Z',
  settings: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.55M13.25 2.5v2.75H10.5',
};

function quickTile(kind: keyof typeof GLYPHS, name: string): { button: HTMLButtonElement; value: HTMLElement; name: HTMLElement } {
  const value = el('span', { class: 'quick__value' }, '');
  const label = el('span', { class: 'quick__name' }, name);
  const button = el(
    'button',
    { type: 'button', class: `quick quick--${kind}` },
    el('span', { class: 'quick__icon', 'aria-hidden': 'true' }, glyph(GLYPHS[kind])),
    el('span', { class: 'quick__text' }, label, value),
  ) as HTMLButtonElement;
  return { button, value, name: label };
}

/**
 * Under the tiles: the four things the owner reaches for most, one press
 * each. Each is a real button whose name says what it does and where it
 * stands; the theme and the strip go through the app's own optimistic
 * setters (applyTheme, applyTrayView), so a refusal reverts here exactly as
 * it does in Settings. "Yenile" is THE refresh while the tiles are shown:
 * the footer's own button and last-scan line step aside, and the panel paints
 * this one with the same rules (panel.ts paintRefresh).
 */
export function createQuickTiles(ctx: QuickTilesContext): QuickTilesHandle {
  const theme = quickTile('theme', t('layout.quick.theme'));
  const strip = quickTile('strip', t('layout.quick.strip'));
  const settings = quickTile('settings', t('header.settings'));
  const refresh = quickTile('refresh', t('panel.refresh'));
  refresh.button.classList.add('quick--busyable');

  let current: PanelState | null = null;
  on(theme.button, 'click', () => {
    if (current) ctx.onTheme(NEXT_THEME[current.theme]);
  });
  on(strip.button, 'click', () => {
    if (current) ctx.onTrayView(current.trayView === 'strip' ? 'tray' : 'strip');
  });
  on(settings.button, 'click', () => ctx.onSettings());
  on(refresh.button, 'click', () => ctx.onRefresh());

  setAttr(theme.button, 'title', t('layout.quick.themeTitle'));
  setAttr(strip.button, 'title', t('layout.quick.stripTitle'));
  setAttr(settings.button, 'title', t('header.settingsTitle'));
  settings.value.hidden = true;

  const root = el(
    'div',
    { class: 'quicks', role: 'group', 'aria-label': t('layout.quick.label') },
    theme.button,
    strip.button,
    settings.button,
    refresh.button,
  );
  root.hidden = true;

  function update(state: PanelState): void {
    current = state;
    const themeName = themeLabel(state.theme);
    setText(theme.value, themeName);
    setAttr(theme.button, 'aria-label', t('layout.quick.themeLabel', { value: themeName }));
    setAttr(theme.button, 'data-pending', state.themePending ? 'true' : null);

    // A toggle: pressed while the strip is the chosen view. When main could
    // not show it here, the value says so instead of "Açık".
    const on_ = state.trayView === 'strip';
    setAttr(strip.button, 'aria-pressed', on_ ? 'true' : 'false');
    setAttr(strip.button, 'aria-label', t('layout.quick.stripLabel'));
    setAttr(strip.button, 'data-on', on_ ? 'true' : null);
    setAttr(strip.button, 'data-pending', state.trayViewPending ? 'true' : null);
    setText(strip.value, on_
      ? (state.stripAvailable && !state.stripNoRoom ? t('layout.quick.on') : t('layout.quick.unavailable'))
      : t('layout.quick.off'));

    const generatedAt = state.snapshot?.generatedAt ?? null;
    setText(refresh.value, generatedAt ? clockTime(generatedAt) : '');
    refresh.value.hidden = !generatedAt;
  }

  return { el: root, refreshButton: refresh.button, refreshLabel: refresh.name, update };
}
