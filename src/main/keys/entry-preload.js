'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * The key-entry window's preload (ADR-003 Amendment 5 K3, Amendment 8).
 *
 * WRITE-ONLY, AND THAT IS THE WHOLE DESIGN
 * ----------------------------------------
 * Five methods: ask what to render, consent, hand a key to main, cancel, open
 * the vendor's token page. There is NO getter — nothing here can read a stored key
 * back, not whole, not masked, not as a length — so no bug in the page, and no
 * script that somehow ran in it, can produce the secret. That is also why the
 * page never shows "a key is saved (•••• 1234)": there is no channel that could
 * answer it.
 *
 * Channel names are inlined rather than required from `src/shared/contract.js`:
 * a sandboxed preload has a restricted module system. `contract-mirror.test.js`
 * fails the build if a single character drifts from the contract.
 *
 * No clipboard, and no generic `invoke` passthrough: either would hand the page
 * more than the five things it needs (K6, ADR-001 security F8).
 */
const CH = {
  CONSENT: 'keys:consent',
  SUBMIT: 'keys:submit',
  CANCEL: 'keys:cancel',
  ENTRY_INFO: 'keys:entry-info',
  ENTRY_TOKEN_PAGE: 'keys:entry-token-page',
};

/** Only a real string may reach main; anything else becomes an empty one, which
 *  main's validator refuses. Never coerced with `String()`: stringifying a
 *  hostile object is work this process does on someone else's behalf. */
function asString(value) {
  return typeof value === 'string' ? value : '';
}

contextBridge.exposeInMainWorld('usageNotchKeyEntry', {
  /**
   * The provider id and the language main resolved, synchronously, so the page
   * renders in the right language on its first paint. Carries nothing about any
   * stored key.
   */
  entryInfo: () => {
    try {
      return ipcRenderer.sendSync(CH.ENTRY_INFO) || null;
    } catch {
      return null;
    }
  },

  /**
   * The consent screen's Continue. NO ARGUMENT: the provider was fixed when the
   * window opened. Only after this will main accept a submit, and only within
   * five minutes of it.
   *
   * @returns {Promise<{ok:boolean, code?:string}>}
   */
  consent: () => ipcRenderer.invoke(CH.CONSENT),

  /**
   * Hands the typed values to main. One call carries both, so there is no
   * half-pair state in main and no second channel that could be called alone.
   *
   * The answer is `{ok}` plus a fixed code from a closed set — never the value,
   * never its length, never a reason derived from it.
   *
   * @param {string} key
   * @param {string} username
   * @returns {Promise<{ok:boolean, code?:string}>}
   */
  submit: (key, username) => ipcRenderer.invoke(CH.SUBMIT, asString(key), asString(username)),

  /** Closes the window and changes nothing. */
  cancel: () => ipcRenderer.send(CH.CANCEL),

  /**
   * Opens the vendor's token page in the default browser. NO ARGUMENT: main
   * holds the URL as a literal and picks it from the flow's own provider, so
   * nothing this page sends can influence what is opened.
   */
  openTokenPage: () => ipcRenderer.invoke(CH.ENTRY_TOKEN_PAGE),
});
