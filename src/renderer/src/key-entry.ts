/**
 * The key-entry page (ADR-003 Amendment 5 + Amendment 8, Phase B).
 *
 * WHAT THIS PAGE IS
 * -----------------
 * A short-lived window of its own, loaded from a local file, that collects a
 * GitHub username and a fine-grained personal access token and hands them to
 * main through its own preload. It is the ONLY surface in this app where a
 * secret is typed, and it is built so that:
 *
 *   - nothing here can reach the network. The CSP in key-entry.html says
 *     `connect-src 'none'`; main makes the one allowed request itself, on a
 *     dedicated session with an exact host allowlist (K5, F11).
 *   - the page NEVER echoes what was typed. Not on success, not in an error,
 *     not as a length, not as a mask (K23). The error line is chosen from a
 *     fixed set of codes main returns, so a message cannot leak a value even
 *     if main's own words changed.
 *   - there is no getter. The preload exposes `entryInfo`, `consent`,
 *     `submit`, `cancel` and `openTokenPage`, and nothing that reads a stored
 *     key back (K3).
 *   - declining is free: Esc and Cancel both close the window and change
 *     nothing at all.
 *
 * TWO STEPS IN ONE WINDOW (Amendment 9)
 * -------------------------------------
 * The first screen is the consent. It is the point of the page, not
 * decoration: what is sent, to which single host, how often, what is kept,
 * what the encryption does and does NOT protect against, and that removing the
 * local copy is not revocation. There are no fields yet. Only Continue, which
 * main accepts from this window alone, replaces the consent with the
 * least-privilege instruction and the two fields. Cancel has focus on the first
 * screen, as it did in the native box it replaced, so Enter never consents by
 * accident.
 */

import { el, on, setAttr, setText } from './dom.js';
import { language as currentLanguage, setLocale, t, type MessageKey } from './i18n.js';
import type { LanguageChoice } from '../../shared/contract.js';

/** GitHub's own shape for a login. Checked here AND again in main (K21). */
const USERNAME = /^[A-Za-z0-9-]{1,39}$/;

/** The codes main answers with. Anything else prints the generic failure. */
const ERROR_TEXT: Record<string, MessageKey> = {
  'wrong-token-type': 'keyEntry.error.wrongTokenType',
  'wrong-provider': 'keyEntry.error.wrongProvider',
  invalid: 'keyEntry.error.invalid',
  'invalid-username': 'keyEntry.error.invalidUsername',
  'unknown-provider': 'keyEntry.error.wrongProvider',
  'secure-storage-unavailable': 'keyEntry.error.secureStorage',
  'store-failed': 'keyEntry.error.storeFailed',
  'no-entry': 'keyEntry.error.noEntry',
  expired: 'keyEntry.error.expired',
  rejected: 'keyEntry.error.rejected',
  busy: 'keyEntry.error.busy',
};

interface EntryInfo {
  provider: string;
  language: LanguageChoice | 'tr' | 'en';
  formatLocale?: string;
}

interface EntryApi {
  entryInfo(): EntryInfo | null;
  /** The consent screen's Continue. No argument; main fixed the provider. */
  consent(): Promise<{ ok: boolean; code?: string }> | { ok: boolean; code?: string };
  /**
   * Hands the typed values to main, write-only. The token is the first
   * argument (A8's `submit(key)`); the username follows it, because main
   * validates its shape again (K21) and builds the request path from it.
   */
  submit(key: string, username?: string): Promise<{ ok: boolean; code?: string }> | { ok: boolean; code?: string };
  cancel(): void;
  /** Opens GitHub's token page in the default browser. No argument, no reply
   *  this page depends on: the window stays open and keeps what was typed. */
  openTokenPage?(): void;
}

function api(): EntryApi | null {
  try {
    const candidate = (globalThis as { usageNotchKeyEntry?: unknown }).usageNotchKeyEntry;
    return candidate && typeof candidate === 'object' ? (candidate as EntryApi) : null;
  } catch {
    return null;
  }
}

/** One paragraph of the consent text. */
function para(key: MessageKey, extra?: string): HTMLElement {
  return el('p', extra ? { class: extra } : {}, t(key));
}

function main(): void {
  const bridge = api();
  const info = bridge?.entryInfo?.() ?? null;
  // Main resolved the language; the page never guesses it from the OS.
  const language = info?.language === 'en' ? 'en' : 'tr';
  setLocale(language, info?.formatLocale || (language === 'en' ? 'en-US' : 'tr-TR'));
  document.documentElement.setAttribute('lang', currentLanguage());
  document.title = t('keyEntry.title');

  const root = document.getElementById('key-entry');
  if (!root) return;

  // The window has no Windows title bar. This strip stands in for it: the
  // window can be dragged by it, and Windows draws its own close button over
  // its right end.
  const bar = el('header', { class: 'entry__bar' }, el('span', { class: 'entry__bar-name' }, 'Usage Notch'));
  const heading = el('h1', { class: 'entry__title' }, t('keyEntry.title'));

  // --- step 1: what this costs the user, before any field ----------------
  const facts = el(
    'div',
    { class: 'entry__facts' },
    para('keyEntry.optional', 'entry__lead'),
    para('keyEntry.what'),
    para('keyEntry.frequency'),
    // Before any effort is spent: this app never uses a system proxy, so on a
    // network that requires one the request cannot complete at all. Said HERE
    // rather than only in the row's failure state, because by then the user has
    // already created a credential that can never return a number. Conditional,
    // and about OUR limit — it does not diagnose the reader's network.
    para('keyEntry.proxy'),
    para('keyEntry.kept'),
    para('keyEntry.storage'),
    para('keyEntry.selfPaid'),
    para('keyEntry.removeNote'),
  );

  const consentError = el('p', { class: 'entry__error', role: 'alert' });
  consentError.hidden = true;
  const decline = el('button', { type: 'button', class: 'entry__cancel' }, t('keyEntry.cancel')) as HTMLButtonElement;
  const proceed = el('button', { type: 'button', class: 'entry__primary' }, t('keyEntry.continue')) as HTMLButtonElement;
  const consentStep = el(
    'section',
    { class: 'entry__step entry__step--consent' },
    facts,
    consentError,
    el('div', { class: 'entry__actions' }, decline, proceed),
    el('p', { class: 'entry__hint entry__esc' }, t('keyEntry.escHint')),
  );

  // --- step 2: how to create a least-privilege key, with the way to do it -
  // The instruction and the button are one step, so the user does not have to
  // hold the instruction in their head while hunting for the page.
  const createHint = el('p', { class: 'entry__create-text', id: 'entry-create' }, t('keyEntry.leastPrivilege'));
  const createButton = el(
    'button',
    { type: 'button', class: 'entry__secondary', 'aria-describedby': 'entry-create' },
    t('keyEntry.createOnGitHub'),
  ) as HTMLButtonElement;
  const createBack = el('p', { class: 'entry__create-back' }, t('keyEntry.pasteWhenBack'));
  createBack.hidden = true;
  const create = el('section', { class: 'entry__create' }, createHint, createButton, createBack);
  on(createButton, 'click', () => {
    // The window stays open and every field keeps its value: the user is
    // coming back with a key to paste.
    createBack.hidden = false;
    bridge?.openTokenPage?.();
  });

  // --- the two fields ----------------------------------------------------
  const userInput = el('input', {
    id: 'entry-user',
    class: 'entry__input',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    inputmode: 'text',
    pattern: '[A-Za-z0-9-]{1,39}',
    maxlength: '39',
    'aria-describedby': 'entry-user-hint',
  }) as HTMLInputElement;
  const userField = el(
    'div',
    { class: 'entry__field' },
    el('label', { class: 'entry__label', for: 'entry-user' }, t('keyEntry.usernameLabel')),
    userInput,
    el('p', { class: 'entry__hint', id: 'entry-user-hint' }, t('keyEntry.usernameHint')),
  );

  // type=password with no reveal toggle: a toggle is a rendered secret, which
  // K23 forbids. Paste is NOT blocked — blocking it pushes users to retype a
  // long token, or to park it somewhere worse.
  const keyInput = el('input', {
    id: 'entry-key',
    class: 'entry__input',
    type: 'password',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    'aria-describedby': 'entry-key-hint',
  }) as HTMLInputElement;
  const keyField = el(
    'div',
    { class: 'entry__field' },
    el('label', { class: 'entry__label', for: 'entry-key' }, t('keyEntry.keyLabel')),
    keyInput,
    el('p', { class: 'entry__hint', id: 'entry-key-hint' }, t('keyEntry.keyHint')),
  );

  // --- the error line ----------------------------------------------------
  // A live region, so a keyboard user hears the refusal without hunting for
  // it. It only ever holds one of the fixed sentences above.
  const error = el('p', { class: 'entry__error', role: 'alert' });
  error.hidden = true;

  const save = el('button', { type: 'submit', class: 'entry__primary' }, t('keyEntry.save')) as HTMLButtonElement;
  const cancel = el('button', { type: 'button', class: 'entry__cancel' }, t('keyEntry.cancel')) as HTMLButtonElement;
  const actions = el('div', { class: 'entry__actions' }, cancel, save);
  const escHint = el('p', { class: 'entry__hint entry__esc' }, t('keyEntry.escHint'));

  const form = el('form', { class: 'entry__form', novalidate: 'novalidate' }, userField, keyField, error, actions, escHint) as HTMLFormElement;

  function fail(key: MessageKey): void {
    setText(error, t(key));
    error.hidden = false;
  }

  let busy = false;
  async function trySubmit(): Promise<void> {
    if (busy) return;
    error.hidden = true;
    const user = userInput.value.trim();
    const secret = keyInput.value;
    if (user === '' || secret === '') {
      fail('keyEntry.error.empty');
      (user === '' ? userInput : keyInput).focus();
      return;
    }
    if (!USERNAME.test(user)) {
      fail('keyEntry.error.usernameShape');
      userInput.focus();
      return;
    }
    if (!bridge || typeof bridge.submit !== 'function') {
      fail('keyEntry.error.unknown');
      return;
    }
    busy = true;
    setAttr(save, 'aria-busy', 'true');
    save.disabled = true;
    try {
      // One write-only call carries both values, so there is no second call
      // that could be made on its own with half the pair.
      const result = await bridge.submit(secret, user);
      if (result && result.ok === true) return; // main closes the window
      const code = result && typeof result.code === 'string' ? result.code : '';
      fail(ERROR_TEXT[code] ?? 'keyEntry.error.unknown');
      keyInput.focus();
      keyInput.select();
    } catch {
      fail('keyEntry.error.unknown');
    } finally {
      busy = false;
      setAttr(save, 'aria-busy', null);
      save.disabled = false;
    }
  }

  on(form, 'submit', (event) => {
    event.preventDefault();
    void trySubmit();
  });
  on(cancel, 'click', () => bridge?.cancel?.());
  // Esc cancels from anywhere on the page, including inside a field.
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      bridge?.cancel?.();
    }
  });

  const formStep = el('section', { class: 'entry__step entry__step--form' }, create, form);

  let consenting = false;
  async function tryConsent(): Promise<void> {
    if (consenting) return;
    consentError.hidden = true;
    if (!bridge || typeof bridge.consent !== 'function') {
      setText(consentError, t('keyEntry.error.unknown'));
      consentError.hidden = false;
      return;
    }
    consenting = true;
    setAttr(proceed, 'aria-busy', 'true');
    proceed.disabled = true;
    try {
      const result = await bridge.consent();
      if (result && result.ok === true) {
        // The consent has been read and given. It is replaced, not kept above
        // the fields: the window stays short, and the facts were the step before.
        consentStep.replaceWith(formStep);
        // Focus moves to the first field: this step exists to be typed into.
        userInput.focus();
        return;
      }
      const code = result && typeof result.code === 'string' ? result.code : '';
      setText(consentError, t(ERROR_TEXT[code] ?? 'keyEntry.error.unknown'));
      consentError.hidden = false;
    } catch {
      setText(consentError, t('keyEntry.error.unknown'));
      consentError.hidden = false;
    } finally {
      consenting = false;
      setAttr(proceed, 'aria-busy', null);
      proceed.disabled = false;
    }
  }
  on(proceed, 'click', () => { void tryConsent(); });
  on(decline, 'click', () => bridge?.cancel?.());

  // Outside the centred column, so it spans the window edge to edge.
  root.before(bar);
  root.appendChild(heading);
  root.appendChild(consentStep);
  setAttr(root, 'aria-busy', null);

  // Cancel has focus, as it had in the native box this replaced: Enter on
  // arrival declines, and consent always takes a deliberate choice.
  decline.focus();
}

main();
