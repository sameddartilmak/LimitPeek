/**
 * The key block on a provider row (ADR-003 Amendment 8, Phase B).
 *
 * THREE THINGS IT MAY SHOW, AND NOTHING ELSE
 * ------------------------------------------
 *   1. no key stored:  one calm, optional offer to add one. Never a warning,
 *      never a badge, never a figure — everything else on the row works
 *      without a key, and this is an extra, not a prerequisite (K2).
 *   2. a key stored and a reading present: credits used this month, the
 *      included part, the billed part, and the instant of the reading.
 *   3. anything else: one short fixed sentence for the state code, and for the
 *      two states a new key would fix, a way to open the token page.
 *
 * NO PERCENTAGE, NO BAR, NO RING. GitHub sends no allowance, so there is no
 * denominator; see keys.ts. This file deliberately has no state-ramp attribute
 * and no fill element, so a later "just add a bar" cannot be done by CSS
 * alone.
 *
 * NOTHING ABOUT THE SECRET ITSELF (K23): the block never renders a key, a
 * length or a mask, and the renderer cannot read one.
 */

import type { ProviderSnapshot } from '../../../shared/contract.js';
import { el, on, setAttr, setText } from '../dom.js';
import { asOf, integer } from '../format.js';
import { t } from '../i18n.js';
import { keyFieldsOf, keyStateSentence, offersTokenPage } from '../keys.js';

export interface KeyBlockContext {
  /** Ask main to open the key-entry window (IPC `keys:request-entry`). */
  onAddKey(providerId: string): void;
  /** Ask main to open GitHub's token page in the default browser. */
  onOpenTokenPage(providerId: string): void;
  /** Ask main to read the figure now. Resolves to whether main asked. */
  onRefreshKey(providerId: string): Promise<boolean>;
}

/**
 * How long the refresh button stays disabled after a press. Main refuses a
 * second request inside a minute anyway (`schedule.mayStartManual`); this only
 * keeps the button from looking pressable when it would do nothing.
 */
const REFRESH_COOLDOWN_MS = 60 * 1000;

/** The states in which a request can bring a figure: a key that works. */
const REFRESHABLE = new Set(['stored', 'unreachable']);

export interface KeyBlockHandle {
  el: HTMLElement;
  update(provider: ProviderSnapshot): void;
}

export function createKeyBlock(providerId: string, ctx: KeyBlockContext): KeyBlockHandle {
  // The offer. A button, not a link: it asks main to open a window.
  const add = el(
    'button',
    { type: 'button', class: 'key__add' },
    t('key.add'),
  ) as HTMLButtonElement;
  on(add, 'click', () => ctx.onAddKey(providerId));

  const figure = el('p', { class: 'key__figure' });
  const split = el('p', { class: 'key__split' });
  const asOfLine = el('p', { class: 'key__asof' });
  const sentence = el('p', { class: 'key__state' });
  const tokenPage = el(
    'button',
    { type: 'button', class: 'key__token' },
    t('key.openTokenPage'),
  ) as HTMLButtonElement;
  on(tokenPage, 'click', () => ctx.onOpenTokenPage(providerId));

  const refresh = el(
    'button',
    { type: 'button', class: 'key__refresh' },
    t('key.refresh'),
  ) as HTMLButtonElement;
  let cooldown: ReturnType<typeof setTimeout> | null = null;
  on(refresh, 'click', () => {
    if (cooldown !== null) return;
    refresh.disabled = true;
    setText(refresh, t('key.refreshing'));
    setAttr(refresh, 'title', null);
    cooldown = setTimeout(() => {
      cooldown = null;
      refresh.disabled = false;
      setAttr(refresh, 'title', null);
    }, REFRESH_COOLDOWN_MS);
    void ctx.onRefreshKey(providerId).then(() => {
      setText(refresh, t('key.refresh'));
      if (cooldown !== null) setAttr(refresh, 'title', t('key.refreshWait'));
    });
  });

  // The age of the reading and the way to renew it, on one line.
  const when = el('div', { class: 'key__when' }, asOfLine, refresh);

  const root = el('div', { class: 'key' }, add, figure, split, sentence, when, tokenPage);
  root.hidden = true;

  function update(provider: ProviderSnapshot): void {
    const keys = keyFieldsOf(provider);
    if (!keys.keyCapable) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    setAttr(root, 'data-key-state', keys.keyState);

    const none = keys.keyState === 'none';
    // When the row's own "Add" button already opens the key window, a second
    // offer under the name would be the same action twice.
    add.hidden = !none || provider.setupAction?.kind === 'add-api-key';
    setAttr(add, 'title', none ? t('key.addDetail') : null);
    setAttr(add, 'aria-label', none ? t('key.addLabel', { provider: provider.displayName }) : null);

    // ADR-001's stale-but-true rule (Phase B ruling): main KEEPS the last true
    // reading through an error state, with the `fetchedAt` it was read at, and
    // drops it when its month ends. So the figure is shown whenever there is
    // one — dimmed, with its age, and WITH the error sentence beside it. What
    // is never done is presenting it as current: the age line and the sentence
    // are both part of the figure, not decoration next to it.
    const usage = keys.creditUsage;
    const hasFigure = usage !== null;
    const stale = hasFigure && keys.keyState !== 'stored';
    setAttr(root, 'data-stale', stale ? 'true' : null);
    figure.hidden = !hasFigure;
    // "Plan kapsamında 0 · faturalanan 0" under "0 AI kredisi" repeats the zero
    // twice more; the split only says something once either side is non-zero.
    split.hidden = !hasFigure || (usage.includedCredits === 0 && usage.billedCredits === 0);
    asOfLine.hidden = !hasFigure;
    if (usage) {
      setText(figure, t('key.credits.used', { count: usage.grossCredits, credits: integer(usage.grossCredits) }));
      setText(
        split,
        t('key.credits.split', {
          included: integer(usage.includedCredits),
          billed: integer(usage.billedCredits),
        }),
      );
      // The same "as of" the panel uses for every figure that was true at an
      // instant rather than now.
      setText(asOfLine, asOf(usage.fetchedAt));
    }

    // One fixed sentence per state code, never the provider's own words (K19).
    // A figure does NOT silence it: a kept reading with an error state needs
    // both, or the row would read as a current figure.
    const key = hasFigure && keys.keyState === 'stored' ? null : keyStateSentence(keys.keyState);
    sentence.hidden = key === null;
    if (key) setText(sentence, t(key));
    // 'unreachable' is the one state whose cause is a choice WE made: the app
    // resolves DIRECT and never uses a system proxy, so behind one this figure
    // can never arrive. The sentence itself names that cause in both languages
    // — the row is a glance surface and ADR-004 A3 caps it at one short line —
    // and the full consequence ("removing the key will not change that") is
    // rendered as visible text in Settings, beside the Remove button. This
    // title is the hover shortcut to it, never the only place it exists.
    setAttr(sentence, 'title', keys.keyState === 'unreachable' ? t('key.unreachable.cause') : null);

    refresh.hidden = !provider.enabled || !REFRESHABLE.has(keys.keyState);
    setAttr(refresh, 'aria-label', refresh.hidden ? null : t('key.refreshLabel', { provider: provider.displayName }));
    when.hidden = asOfLine.hidden && refresh.hidden;

    // Only where a new key is the fix, and only with a key stored.
    tokenPage.hidden = !offersTokenPage(keys.keyState);
    setAttr(tokenPage, 'title', tokenPage.hidden ? null : t('key.openTokenPageDetail'));
  }

  return { el: root, update };
}
