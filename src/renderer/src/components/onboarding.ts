/**
 * The first-run introduction (owner, 2026-09-30): three short steps drawn in
 * the list area, shown once on a fresh install.
 *
 *   1  Welcome   what the app shows, and the privacy promise.
 *   2  Tools     the tools found on this machine, each with a switch that adds
 *                or removes its card, exactly like Settings → Tools.
 *   3  Connect   Claude Code's bridge when it is not in place (the same consent
 *                path the card's "Bağla" uses, drawn here), otherwise "ready".
 *
 * "Atla" on any step and "Başla" on the last one end it for good: both answer
 * the same stored question as the old first-run card (`setupCoachDismissed`).
 * A user who wants it back finds "Tanıtımı yeniden göster" in Settings → Genel.
 *
 * Nothing here decides what a tool reports; it only reads the snapshot.
 */

import type { ProviderSnapshot } from '../../../shared/contract.js';
import { el, on, replaceChildrenWith, setAttr, setText } from '../dom.js';
import { enabledOf, type PanelState } from '../store.js';
import { t } from '../i18n.js';
import { providerMark } from './logo.js';

export const ONBOARDING_STEPS = 3;

export interface OnboardingContext {
  onStep(step: number): void;
  /** "Atla" or "Başla": the introduction is over, remembered. */
  onDone(): void;
  onToggle(providerId: string, enabled: boolean): void;
  /** Step 3's "Bağla": the consent box is drawn in `consentHost`. */
  onConnect(providerId: string): void;
}

export interface OnboardingHandle {
  el: HTMLElement;
  /** Where the Claude consent box goes while this is on screen. */
  consentHost: HTMLElement;
  update(state: PanelState): void;
}

/** On screen: a fresh install that has not answered the introduction yet. */
export function onboardingActive(state: PanelState): boolean {
  return !state.setupCoachDismissed && state.view !== 'settings';
}

/**
 * Which tools this machine has. Claude Code always counts: it is the product's
 * first tool and its card is how it gets connected. Any other tool counts once
 * its reader found something (connected, or a non-passive row); a tool that
 * reports "not installed" never does.
 */
export function foundTools(providers: readonly ProviderSnapshot[]): {
  found: ProviderSnapshot[];
  missing: ProviderSnapshot[];
} {
  const found: ProviderSnapshot[] = [];
  const missing: ProviderSnapshot[] = [];
  for (const p of providers) {
    const here = p.id === 'claude'
      || (p.setupAction?.kind !== 'not-installed' && (p.connected || p.status !== 'passive'));
    (here ? found : missing).push(p);
  }
  return { found, missing };
}

/** Claude Code's bridge is not in place, so step 3 offers to connect it. */
function claudeToConnect(providers: readonly ProviderSnapshot[]): ProviderSnapshot | null {
  const claude = providers.find((p) => p.id === 'claude') ?? null;
  return claude && claude.setupAction?.kind === 'install-bridge' ? claude : null;
}

export function createOnboarding(ctx: OnboardingContext): OnboardingHandle {
  const progressText = el('span', { class: 'onb__count' }, '');
  const dots = el('span', { class: 'onb__dots', 'aria-hidden': 'true' });
  for (let i = 0; i < ONBOARDING_STEPS; i++) dots.appendChild(el('i', { class: 'onb__dot' }));

  // The heading takes focus on every step change, so a screen reader reads
  // the new step instead of staying on a button that moved.
  const title = el('h2', { class: 'onb__title', id: 'onb-title', tabindex: '-1' }, '');
  const body = el('div', { class: 'onb__body' });
  const consentHost = el('div', { class: 'onb__consent' });

  const skip = el('button', { type: 'button', class: 'btn onb__skip' }, t('onboarding.skip')) as HTMLButtonElement;
  const back = el('button', { type: 'button', class: 'btn' }, t('onboarding.back')) as HTMLButtonElement;
  const next = el('button', { type: 'button', class: 'btn btn--primary' }, '') as HTMLButtonElement;
  const actions = el('div', { class: 'onb__actions' }, skip, el('span', { class: 'onb__gap' }), back, next);

  const root = el(
    'section',
    { class: 'onb', 'aria-labelledby': 'onb-title' },
    el('div', { class: 'onb__progress' }, dots, progressText),
    title,
    body,
    consentHost,
    actions,
  );
  root.hidden = true;

  let step = 0;
  let lastStep = -1;
  let lastState: PanelState | null = null;

  on(skip, 'click', () => ctx.onDone());
  on(back, 'click', () => ctx.onStep(Math.max(0, step - 1)));
  on(next, 'click', () => {
    if (step < ONBOARDING_STEPS - 1) {
      ctx.onStep(step + 1);
      return;
    }
    const claude = lastState ? claudeToConnect(lastState.snapshot?.providers ?? []) : null;
    if (claude) ctx.onConnect(claude.id);
    else ctx.onDone();
  });

  function welcome(): HTMLElement[] {
    return [
      el('p', { class: 'onb__text' }, t('onboarding.welcome.text')),
      el(
        'div',
        { class: 'onb__promise' },
        el('span', { class: 'onb__lock', 'aria-hidden': 'true' }),
        el(
          'div',
          {},
          el('strong', { class: 'onb__promise-title' }, t('onboarding.welcome.privacyTitle')),
          el('p', { class: 'onb__promise-text' }, t('onboarding.welcome.privacy')),
        ),
      ),
    ];
  }

  // One row per tool, kept across updates: rebuilding a switch under the
  // keyboard would drop the focus the user just pressed it with.
  const toolRows = new Map<string, { li: HTMLElement; toggle: HTMLButtonElement }>();

  function toolRow(p: ProviderSnapshot): { li: HTMLElement; toggle: HTMLButtonElement } {
    const existing = toolRows.get(p.id);
    if (existing) return existing;
    const nameId = 'onb-tool-' + p.id;
    const toggle = el('button', {
      type: 'button',
      class: 'switch',
      role: 'switch',
      'aria-checked': 'false',
      'aria-labelledby': nameId,
    }) as HTMLButtonElement;
    toggle.appendChild(el('span', { class: 'switch__track', 'aria-hidden': 'true' }));
    on(toggle, 'click', () => ctx.onToggle(p.id, toggle.getAttribute('aria-checked') !== 'true'));
    const mark = el('span', { class: 'onb__mark', 'aria-hidden': 'true' });
    mark.appendChild(providerMark(p.id, true));
    const li = el(
      'li',
      { class: 'onb__tool', 'data-provider': p.id },
      mark,
      el('span', { class: 'onb__tool-name', id: nameId }, p.displayName),
      toggle,
    );
    const row = { li, toggle };
    toolRows.set(p.id, row);
    return row;
  }

  const toolText = el('p', { class: 'onb__text' }, '');
  const toolList = el('ul', { class: 'onb__tools', role: 'list' });
  const missingLine = el('p', { class: 'onb__missing' }, '');
  let toolSignature = '';

  function tools(state: PanelState): HTMLElement[] {
    if (!state.hasData) return [el('p', { class: 'onb__text', role: 'status' }, t('onboarding.tools.searching'))];
    const { found, missing } = foundTools(state.snapshot?.providers ?? []);
    setText(toolText, t('onboarding.tools.text'));
    const signature = found.map((p) => p.id).join(',');
    if (signature !== toolSignature) {
      toolSignature = signature;
      replaceChildrenWith(toolList, found.map((p) => toolRow(p).li));
    }
    for (const p of found) {
      const { li, toggle } = toolRow(p);
      const on_ = enabledOf(state, p);
      setAttr(toggle, 'aria-checked', on_ ? 'true' : 'false');
      setAttr(toggle, 'aria-busy', state.enabledPending.includes(p.id) ? 'true' : null);
      setAttr(li, 'data-enabled', on_ ? 'true' : 'false');
    }
    missingLine.hidden = missing.length === 0;
    setText(missingLine, missing.length === 0 ? '' : t('onboarding.tools.notFound', {
      names: missing.map((p) => p.displayName).join(', '),
    }));
    return [toolText, toolList, missingLine];
  }

  function finish(state: PanelState): HTMLElement[] {
    const claude = claudeToConnect(state.snapshot?.providers ?? []);
    if (claude) return [el('p', { class: 'onb__text' }, t('coach.text'))];
    return [el('p', { class: 'onb__text' }, t('onboarding.ready.text'))];
  }

  function update(state: PanelState): void {
    lastState = state;
    const active = onboardingActive(state);
    root.hidden = !active;
    if (!active) {
      lastStep = -1;
      return;
    }
    step = Math.min(Math.max(0, state.onboardingStep), ONBOARDING_STEPS - 1);
    const providers = state.snapshot?.providers ?? [];
    const claude = claudeToConnect(providers);
    const asking = state.consent?.origin === 'coach';

    setText(progressText, t('onboarding.progress', { step: step + 1, total: ONBOARDING_STEPS }));
    dots.childNodes.forEach((dot, i) => setAttr(dot as HTMLElement, 'data-on', i <= step ? 'true' : null));
    setAttr(root, 'data-step', String(step + 1));

    if (step === 0) setText(title, t('onboarding.welcome.title'));
    else if (step === 1) setText(title, t('onboarding.tools.title'));
    else setText(title, claude ? t('coach.title') : t('onboarding.ready.title'));

    // Re-parented only when the step changes; the tool rows update in place,
    // so a switch always shows the stored choice (the app reverts it when main
    // refuses) without losing focus.
    const content = step === 0 ? welcome() : step === 1 ? tools(state) : finish(state);
    const same = content.length === body.childNodes.length
      && content.every((node, i) => body.childNodes[i] === node);
    if (!same) replaceChildrenWith(body, content);

    // A failure message from the connect attempt, read where the user acted.
    if (step === 2 && state.coachMessage && !asking) {
      body.appendChild(el('p', { class: 'onb__message', role: 'status' }, state.coachMessage));
    }

    back.hidden = step === 0;
    skip.hidden = step === ONBOARDING_STEPS - 1 && !claude;
    setText(skip, step === ONBOARDING_STEPS - 1 ? t('coach.later') : t('onboarding.skip'));
    setText(
      next,
      step < ONBOARDING_STEPS - 1 ? t('onboarding.next') : claude ? t('coach.connect') : t('onboarding.finish'),
    );
    next.disabled = step === 2 && claude !== null && state.busy.includes(claude.id);
    // While the consent question is open it owns the answer, and its own
    // paragraphs replace the step's shorter text rather than repeat it.
    actions.hidden = asking;
    body.hidden = asking;

    if (step !== lastStep) {
      const first = lastStep === -1;
      lastStep = step;
      // Not on first paint: the panel's own focus rules apply there.
      if (!first) title.focus({ preventScroll: true });
    }
  }

  return { el: root, consentHost, update };
}
