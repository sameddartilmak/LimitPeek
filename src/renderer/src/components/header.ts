/**
 * Header: the brand, the freshness marker, and the panel controls.
 *
 * THE LEAD READOUT IS GONE
 * ------------------------
 * It printed "5 sa %25 · Hafta %20" for the first added provider. It was added
 * to replace the tide rail's at-a-glance answer, and the user's verdict on it
 * was that it is redundant — correctly: the window blocks in the row directly
 * below carry BOTH of those figures, at a larger size, each next to its own bar
 * and its own countdown. Two surfaces printing one number can only ever agree
 * or be a bug, and this one added nothing to the agreement.
 *
 * The one thing the readout did that the rows do not is NAME the lead
 * provider — the row whose five-hour window drives the tray icon. That is not
 * lost: the lead is the first row, its grip carries `data-tray` (a dot on the
 * identity tile), its `title` says "Tepsi simgesi bu aracı gösteriyor", and
 * every grip is `aria-describedby` the reorder help, which states the rule in
 * words. The identity has a home in the list, so the header lets it go rather
 * than keeping a second surface honest for a fact stated three times already.
 *
 * THE FRESHNESS MARKER
 * --------------------
 * It used to be a pill reading "şimdi güncellendi" — the state it is in about
 * 95% of the time. A status that spends its life saying "fine" in prime header
 * space trains the eye to skip it, which is precisely backwards: the states
 * that matter are the ones where the panel is showing values it can no longer
 * answer for. And the dot and the words carried the same signal twice.
 *
 * So it escalates instead of announcing:
 *
 *   live      a 6px calm dot, NO words. The answer to "is this current" is
 *             still there — in the dot, in the tooltip, and in the screen
 *             reader status — it just does not occupy a line to say "yes".
 *   pending   dot pulses, words return: the first scan has not landed.
 *   aging     dot turns watch, words return with the age. Past the cadence
 *             main guarantees, so the silence is now worth a sentence.
 *   stale     a FILLED block on the ember ground with the state named. The
 *             row list dims at the same moment (shouldDegrade in store.ts);
 *             this is the part that says why.
 *   offline   the same filled treatment, different words. Same consequence
 *             for the user — what is on screen is not current — so it is the
 *             same alarm rather than a competing second one.
 *
 * A refresh in flight pulses the dot at ANY level and never adds words: the
 * footer's Yenile button already says "Yenileniyor", and a second copy of that
 * sentence in the header is the redundancy this change exists to remove.
 */

import { el, on, setAttr, setText, svg } from '../dom.js';
import { ago, agoSpoken, clockTime } from '../format.js';
import { t } from '../i18n.js';
import { freshnessOf, type Freshness, type PanelState } from '../store.js';
import { SETTINGS_VIEW_ID } from './settings.js';

/**
 * Pin copy. It describes the PROMISE — "stays on screen" — because that is
 * what the two modes actually differ on. The earlier wording talked about the
 * panel being "open", which was true of both states and told the user nothing
 * about the one that closes the moment the pointer leaves.
 */
// Functions, not constants: the words are read in the language current at
// paint time, and a language change rebuilds the panel (app.ts).
const PIN_LABEL_OFF = (): string => t('header.pin.labelOff');
const PIN_LABEL_ON = (): string => t('header.pin.labelOn');
const PIN_TITLE_OFF = (): string => t('header.pin.titleOff');
const PIN_TITLE_ON = (): string => t('header.pin.titleOn');

export interface HeaderContext {
  onPinToggle(pinned: boolean): void;
  onClose(): void;
  /** Swap between the usage list and the in-panel settings view. */
  onSettingsToggle(): void;
}

export interface HeaderHandle {
  el: HTMLElement;
  update(state: PanelState, now: number): void;
  tick(state: PanelState, now: number): void;
  pinButton: HTMLButtonElement;
  settingsButton: HTMLButtonElement;
}

/**
 * The pin glyph, plus the ONE handle the state change needs.
 *
 * Pinned draws the pin driven straight in; unpinned tilts it out of the board.
 * That tilt is a second, colour-free carrier for a distinction the user must
 * not get wrong: pinned means the panel survives blur and app switching, and
 * unpinned means it closes as soon as the pointer leaves it. The inverted
 * ground in CSS is the third.
 */
function pinIcon(): { root: SVGElement; body: SVGElement } {
  const body = svg('path', {
    d: 'M6 1.5h4l-.5 4 2 2.5H4.5l2-2.5-.5-4Z M8 8v6.5',
    stroke: 'currentColor',
    'stroke-width': '1.3',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  const root = svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    body,
  );
  return { root, body };
}

/**
 * Settings. Two fader rails with a knob each, rather than a cogwheel: at the
 * 14px this button actually renders, a six-tooth cog turns into a blob, while
 * two broken rails keep their silhouette. The rails are drawn with a gap
 * around each knob so no stroke crosses another.
 */
function settingsIcon(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', {
      d: 'M2.6 5.2H4.9 M9.1 5.2H13.4 M2.6 10.8H7.9 M12.1 10.8H13.4',
      stroke: 'currentColor',
      'stroke-width': '1.3',
      'stroke-linecap': 'round',
    }),
    svg('circle', {
      cx: 7, cy: 5.2, r: 1.8,
      stroke: 'currentColor',
      'stroke-width': '1.3',
    }),
    svg('circle', {
      cx: 10, cy: 10.8, r: 1.8,
      stroke: 'currentColor',
      'stroke-width': '1.3',
    }),
  );
}

function closeIcon(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', {
      d: 'M4 4l8 8M12 4l-8 8',
      stroke: 'currentColor',
      'stroke-width': '1.4',
      'stroke-linecap': 'round',
    }),
  );
}

/**
 * The visible words, per level. Empty string means "say nothing" — the quiet
 * state, where the dot and the tooltip carry the whole answer.
 */
function freshnessText(level: Freshness, ageMs: number): string {
  switch (level) {
    case 'live':
      return '';
    case 'pending':
      return t('header.fresh.pending');
    case 'aging':
      return ago(ageMs);
    case 'stale':
      return t('header.fresh.stale', { age: ago(ageMs) });
    case 'offline':
    default:
      return t('header.fresh.offline');
  }
}

/**
 * The exact answer, on hover, at every level. This is the surface that makes
 * the quiet state defensible: "is what I am looking at current" is always
 * answerable, it just is not shouted while the answer is yes.
 */
function freshnessTitle(level: Freshness, ageMs: number, generatedAt: string | null): string {
  if (level === 'offline') return t('header.fresh.titleOffline');
  if (level === 'pending' || !generatedAt) return t('header.fresh.titlePending');
  const stamp = t('header.fresh.stamp', { time: clockTime(generatedAt), ago: agoSpoken(ageMs) });
  if (level === 'live') return t('header.fresh.titleLive', { stamp });
  if (level === 'aging') return t('header.fresh.titleAging', { stamp });
  return t('header.fresh.titleStale', { stamp });
}

/**
 * What a screen reader hears, written ONLY when the level changes.
 *
 * It is a `role="status"` region, so anything written to it is announced. The
 * visible text updates every minute ("2 dk önce" -> "3 dk önce"), and mirroring
 * that here would interrupt the user sixty times an hour to tell them nothing
 * changed. The wording is therefore level-generic and carries no figure.
 */
function freshnessSpoken(level: Freshness, refreshing: boolean): string {
  const base =
    level === 'offline'
      ? t('header.fresh.titleOffline')
      : level === 'pending'
        ? t('header.spoken.pending')
        : level === 'aging'
          ? t('header.spoken.aging')
          : level === 'stale'
            ? t('header.spoken.stale')
            : t('header.spoken.live');
  return refreshing ? t('header.spoken.refreshing', { base }) : base;
}

export function createHeader(ctx: HeaderContext): HeaderHandle {
  // The dot is the only thing drawn at the quiet level, so it is the element
  // that carries the state colour. The words are a SECOND, louder carrier that
  // appears only when there is something to say — never a restatement of the
  // dot, which is what the old chip did.
  const freshDot = el('i', { class: 'fresh__dot', 'aria-hidden': 'true' });
  const freshText = el('span', { class: 'fresh__text', 'aria-hidden': 'true' }, '');
  const freshSpoken = el('span', {
    class: 'u-sr fresh__status',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });
  const fresh = el(
    'div',
    { class: 'fresh', 'data-fresh': 'offline' },
    freshDot,
    freshText,
    freshSpoken,
  );

  // The settings button is a view switch inside this dialog, so it is
  // described with aria-expanded/aria-controls rather than aria-pressed:
  // `pressed` is the pin's vocabulary here, and two adjacent icon buttons
  // meaning different things by the same attribute is how a toggle bar starts
  // lying.
  const settingsButton = el('button', {
    type: 'button',
    class: 'iconbtn iconbtn--settings',
    'aria-expanded': 'false',
    'aria-controls': SETTINGS_VIEW_ID,
    'aria-label': t('header.settings'),
    title: t('header.settingsTitle'),
  }) as HTMLButtonElement;
  settingsButton.appendChild(settingsIcon());

  const pin = pinIcon();
  const pinButton = el('button', {
    type: 'button',
    class: 'iconbtn iconbtn--pin',
    'aria-pressed': 'false',
    'aria-label': PIN_LABEL_OFF(),
    title: PIN_TITLE_OFF(),
  }) as HTMLButtonElement;
  pinButton.appendChild(pin.root);

  const closeButton = el('button', {
    type: 'button',
    class: 'iconbtn',
    'aria-label': t('header.close'),
    title: t('header.closeTitle'),
  }) as HTMLButtonElement;
  closeButton.appendChild(closeIcon());

  // The product, not a section name: the app's own tile beside its name. The
  // name is not translated (it is a product name), and the tile is decorative
  // — the h1's accessible name is the words alone. Painted from CSS (panel.css
  // .hdr__logo) like the provider marks, so no markup is built from an asset.
  const top = el(
    'div',
    { class: 'hdr__top' },
    el(
      'h1',
      { class: 'hdr__title' },
      el('span', { class: 'hdr__logo', 'aria-hidden': 'true' }),
      'Usage Notch',
    ),
    el('span', { class: 'hdr__spacer' }),
    fresh,
    el('div', { class: 'hdr__actions' }, settingsButton, pinButton, closeButton),
  );

  const root = el('header', { class: 'hdr panel__band' }, top);
  root.style.setProperty('--band-delay', '0ms');

  on(pinButton, 'click', () => {
    const next = pinButton.getAttribute('aria-pressed') !== 'true';
    ctx.onPinToggle(next);
  });
  on(closeButton, 'click', () => ctx.onClose());
  on(settingsButton, 'click', () => ctx.onSettingsToggle());

  /** Last announced (level, refreshing) pair, so the 1Hz tick stays silent. */
  let lastSpokenKey = '';

  function paintFreshness(state: PanelState, now: number): void {
    const generatedAt = state.snapshot?.generatedAt ?? null;
    const { level, ageMs } = freshnessOf(generatedAt, state.bridgeAvailable, now);

    setAttr(fresh, 'data-fresh', level);
    // Orthogonal to the level on purpose: a refresh in flight does not make
    // stale data fresh, and saying "live" while the request is still out would
    // be the lie. It only pulses the dot.
    setAttr(fresh, 'data-busy', state.refreshing ? 'true' : null);
    setText(freshText, freshnessText(level, ageMs));
    setAttr(fresh, 'title', freshnessTitle(level, ageMs, generatedAt));

    const key = `${level}|${state.refreshing}`;
    if (key !== lastSpokenKey) {
      lastSpokenKey = key;
      setText(freshSpoken, freshnessSpoken(level, state.refreshing));
    }
  }

  function paint(state: PanelState, now: number): void {
    paintFreshness(state, now);

    // The pin states what it PROMISES, not what it does to focus. Pinned: the
    // panel survives blur, app switching and anything else happening on the
    // desktop. Unpinned: it lives only while the pointer is over it.
    setAttr(pinButton, 'aria-pressed', state.pinned ? 'true' : 'false');
    setAttr(pinButton, 'aria-label', state.pinned ? PIN_LABEL_ON() : PIN_LABEL_OFF());
    setAttr(pinButton, 'title', state.pinned ? PIN_TITLE_ON() : PIN_TITLE_OFF());
    // Upright when pinned, tilted out of the board when not.
    setAttr(pin.body, 'transform', state.pinned ? null : 'rotate(38 8 9)');

    const inSettings = state.view === 'settings';
    setAttr(settingsButton, 'aria-expanded', inSettings ? 'true' : 'false');
    setAttr(settingsButton, 'aria-label', inSettings ? t('header.settingsClose') : t('header.settings'));
    setAttr(
      settingsButton,
      'title',
      inSettings ? t('header.settingsCloseTitle') : t('header.settingsTitle'),
    );
  }

  return {
    el: root,
    update: paint,
    tick: paint,
    pinButton,
    settingsButton,
  };
}
