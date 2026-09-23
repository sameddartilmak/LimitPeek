'use strict';
/**
 * The key-entry window's preload, as the render suite sees it (ADR-003 A8).
 *
 * It mirrors what backend's real preload exposes — `entryInfo`, `consent`,
 * `submit`, `cancel`, `openTokenPage` — and NOTHING else: there is no getter, so a check
 * cannot accidentally prove the page can read a key back.
 *
 * `__entryProbe` is the test's own channel. It records what the page handed to
 * `submit()` so a check can assert the value LEFT the page exactly once and
 * never appeared in the DOM; it lives beside the API, never inside it.
 */
const { contextBridge } = require('electron');

/**
 * The language main resolved. Taken from the loaded URL's query, because a
 * reload re-runs this preload from scratch: the suite loads the page again with
 * `?lang=en` instead of mutating state that a reload would throw away.
 */
const LANG = (() => {
  try {
    return new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'tr';
  } catch {
    return 'tr';
  }
})();
let info = {
  provider: 'copilot',
  language: LANG,
  formatLocale: LANG === 'en' ? 'en-US' : 'tr-TR',
};
/** What the next submit() answers. `{ok:true}` means main accepted it. */
let answer = { ok: true };
/** What the next consent() answers. */
let consentAnswer = { ok: true };
const calls = { submit: [], cancel: 0, openTokenPage: 0, consent: 0 };

contextBridge.exposeInMainWorld('usageNotchKeyEntry', {
  entryInfo: () => ({ ...info }),
  consent: async () => {
    calls.consent += 1;
    return { ...consentAnswer };
  },
  submit: async (key, username) => {
    calls.submit.push({ key: String(key), username: String(username || '') });
    return { ...answer };
  },
  cancel: () => {
    calls.cancel += 1;
  },
  openTokenPage: () => {
    calls.openTokenPage += 1;
  },
});

contextBridge.exposeInMainWorld('__entryProbe', {
  calls: () => JSON.parse(JSON.stringify(calls)),
  setAnswer: (next) => {
    answer = { ...next };
  },
  setConsentAnswer: (next) => {
    consentAnswer = { ...next };
  },
  setInfo: (next) => {
    info = { ...info, ...next };
  },
});
