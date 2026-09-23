'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, session, BrowserWindow } = require('electron');

const log = require('../../core/log');
const i18n = require('../../core/i18n');
const { isKeyCapable } = require('../../core/keys/registry');
const { validateKey, validateUsername } = require('../../core/keys/validate');

/**
 * Consent, then a window of its own, then one write (ADR-003 Amendment 5,
 * K1-K6).
 *
 * THE ORDER IS THE CONTROL
 * ------------------------
 *  1. A NATIVE dialog in main, raised from the Copilot row. Not a page, not a
 *     toast: the user has to answer an OS-level question before anything at all
 *     happens. Declining writes nothing, creates no session, starts no timer
 *     and leaves the row exactly as it was (K1).
 *  2. Only then a PENDING ENTRY: one-shot, provider fixed at consent, expiring
 *     five minutes later. A submit with no pending entry, a second submit
 *     against the same one, or one that arrives after it expired, is refused.
 *     That is what makes the entry channel unusable as a general "store this
 *     key" call (K4).
 *  3. Only then the window: its OWN in-memory session, sandboxed,
 *     context-isolated, devTools off when packaged, content protection on, and
 *     destroyed on submit, on cancel, or when the five minutes run out (K2).
 *
 * ONE FLOW AT A TIME
 * ------------------
 * The lock is taken SYNCHRONOUSLY, before the first `await`, so fifty IPC
 * messages arriving in one tick produce one dialog. A second flow would mean two
 * pending entries and two windows, and a submit could then be attributed to the
 * wrong one.
 *
 * NO CLIPBOARD, ANYWHERE
 * ----------------------
 * Neither this file nor any preload touches Electron's `clipboard` (K6). The
 * user pastes into a field with the OS's own paste; nothing in this process
 * reads, writes or clears the clipboard, so there is no code path that could
 * copy a key back out of it or leave one in it.
 */

/**
 * The entry window's session. NOT `persist:`-prefixed, so it is in memory only
 * and dies with the process; it also gets the standard block-all request filter
 * through `session-created` (security.js), which is why a page on it cannot
 * reach the network even though it is the one page that holds a secret.
 */
const ENTRY_PARTITION = 'usage-notch-key-entry';

/** The window cannot outlive this, whatever the user does (K2). */
const ENTRY_TTL_MS = 5 * 60 * 1000;

const ENTRY_WIDTH = 560;
const ENTRY_HEIGHT = 760;

/**
 * The page is the frontend lane's (`src/renderer/key-entry.html`). If it is
 * absent — an unbuilt tree, or a packaged build that forgot to include it — the
 * flow REFUSES rather than falling back to a page written here: a consent screen
 * is the product's words, and an improvised English-only stand-in on the one
 * screen where a secret is typed would be worse than no feature.
 */
function resolveEntryPage() {
  return path.join(__dirname, '..', '..', 'renderer', 'key-entry.html');
}

class EntryFlow {
  /**
   * @param {object} options
   * @param {(result:{provider:string,key:string,username:string}) => {ok:boolean, code?:string}} options.onSubmit
   *   Stores the secret. Returns the fixed code the page prints. Called at most
   *   once per pending entry.
   * @param {() => boolean} options.isSecureStorageAvailable
   * @param {() => {resolvedLanguage:string, formatLocale:string}} options.getLocale
   * @param {(providerId:string) => {ok:boolean}} options.openTokenPage
   * @param {string} [options.entryPage] test seam only
   */
  constructor(options) {
    this.onSubmit = options.onSubmit;
    this.isSecureStorageAvailable = options.isSecureStorageAvailable;
    this.getLocale = options.getLocale || (() => ({ resolvedLanguage: 'tr', formatLocale: 'tr-TR' }));
    this.openTokenPageFor = options.openTokenPage || (() => ({ ok: false }));
    this.entryPage = options.entryPage || null;
    this.t = options.t || i18n.t;
    /**
     * The one flow: `{ providerId, win, timer, pending, submitting }`.
     * `pending` exists only after consent and is deleted the moment a submit is
     * accepted — one shot.
     */
    this._flow = null;
  }

  /** Is a flow (consent or window) currently open? */
  get busy() {
    return this._flow !== null;
  }

  /**
   * The provider of the open flow, or null. Used by the entry window's own
   * `openTokenPage()`, which takes no argument precisely so that nothing the
   * page sends can choose a URL.
   */
  get providerId() {
    return this._flow ? this._flow.providerId : null;
  }

  /**
   * @param {{providerId:string, parentWindow?:object, now?:number,
   *          beforePrompt?:Function}} args
   * @returns {Promise<{ok:boolean, code?:string}>}
   */
  async start({ providerId, parentWindow, now, beforePrompt }) {
    // Synchronous guards first: every one of them must answer before the first
    // await, or fifty messages in one tick become fifty dialogs.
    if (this._flow) return { ok: false, code: 'busy' };
    if (!isKeyCapable(providerId)) return { ok: false, code: 'unknown-provider' };
    // Asked BEFORE consent: there is no point taking the user through a consent
    // screen for a store that cannot happen, and the row says so instead.
    if (!this.isSecureStorageAvailable()) return { ok: false, code: 'secure-storage-unavailable' };
    const page = this.entryPage || resolveEntryPage();
    if (!fs.existsSync(page)) {
      log.warn('key entry page is missing; the entry flow cannot be offered');
      return { ok: false, code: 'entry-unavailable' };
    }
    this._flow = { providerId, win: null, timer: null, pending: null, submitting: false };

    let consented = false;
    try {
      if (typeof beforePrompt === 'function') beforePrompt();
      consented = await this._consent(providerId, parentWindow);
    } catch (err) {
      log.warn(`key consent dialog failed: code=${(err && err.code) || 'UNKNOWN'}`);
      consented = false;
    }
    if (!consented) {
      // Nothing was written, nothing was created, nothing was scheduled.
      this._flow = null;
      return { ok: false, code: 'declined' };
    }
    // The one-shot pending entry, created AT CONSENT (K4).
    const startedAt = Number.isFinite(now) ? now : Date.now();
    this._flow.pending = { providerId, expiresAt: startedAt + ENTRY_TTL_MS };

    try {
      this._openWindow(page, parentWindow);
    } catch (err) {
      log.warn(`key entry window could not be opened: code=${(err && err.code) || 'UNKNOWN'}`);
      this.destroy('open-failed');
      return { ok: false, code: 'entry-unavailable' };
    }
    return { ok: true };
  }

  /**
   * The consent dialog. Its text is the product's (ADR-004: strings live in the
   * catalogs, not here), and ADR-003 fixes what it has to say: what the key is
   * used for, the single host it is sent to, how it is stored and what that does
   * NOT protect against, that this works only for self-paid plans, and how to
   * remove it. Two buttons, cancel is the default answer.
   */
  async _consent(providerId, parentWindow) {
    const t = this.t;
    const choice = await dialog.showMessageBox(parentWindow || undefined, {
      type: 'question',
      buttons: [t('dialog.cancel'), t('dialog.keys.consent.confirm')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: t('dialog.keys.consent.title'),
      message: t('dialog.keys.consent.message'),
      detail: [
        t('dialog.keys.consent.what'),
        t('dialog.keys.consent.host'),
        t('dialog.keys.consent.storage'),
        t('dialog.keys.consent.selfPaid'),
        t('dialog.keys.consent.remove'),
      ].join('\n\n'),
    });
    return choice && choice.response === 1;
  }

  _openWindow(page, parentWindow) {
    const flow = this._flow;
    // Its own session. In memory, hardened by `session-created`, and shared with
    // nothing: the panel's session, the keyed request session and this one are
    // three different objects.
    const sess = session.fromPartition(ENTRY_PARTITION);

    const win = new BrowserWindow({
      width: ENTRY_WIDTH,
      height: ENTRY_HEIGHT,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      center: true,
      title: 'Usage Notch',
      backgroundColor: '#101014',
      icon: path.join(__dirname, '..', '..', '..', 'assets', 'app-icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'entry-preload.js'),
        session: sess,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        spellcheck: false,
        enableWebSQL: false,
        // No devTools in a packaged build: the one window where a secret is
        // typed must not carry a console that can read its own DOM.
        devTools: !app.isPackaged,
        backgroundThrottling: false,
      },
    });
    flow.win = win;
    win.setMenu(null);
    // Keeps the window out of screen captures and recordings (K2). Best effort
    // by nature — it is a Windows compositor flag — so it is applied and then
    // never relied on as the only protection.
    try {
      win.setContentProtection(true);
    } catch (err) {
      log.warn(`content protection could not be applied: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    // Above the panel, which is itself always-on-top: a consent window the user
    // cannot see is a consent window they cannot answer.
    try {
      win.setAlwaysOnTop(true, 'modal-panel');
    } catch { /* not fatal */ }

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    win.on('closed', () => {
      // Covers the OS close button and anything else that ends the window
      // without going through cancel().
      if (this._flow && this._flow.win === win) this.destroy('closed');
    });
    const wc = win.webContents;
    wc.on('preload-error', () => log.warn('key entry preload failed'));
    wc.on('did-fail-load', (_event, code, _desc, _url, isMainFrame) => {
      if (isMainFrame) log.warn(`key entry page failed to load: code=${code}`);
    });

    flow.timer = setTimeout(() => this.destroy('expired'), ENTRY_TTL_MS);
    if (flow.timer.unref) flow.timer.unref();

    win.loadFile(page);
    if (parentWindow) { /* deliberately not a modal child: see the class comment */ }
  }

  /**
   * Is this IPC message from the entry window's MAIN FRAME?
   *
   * Both halves matter. `event.sender` rules out every other window in the
   * process — the panel cannot submit (K4) — and the frame check rules out a
   * subframe of the entry page itself. The page loads no frames, which is
   * exactly why a message from one would not be the user.
   */
  fromEntryWindow(event) {
    const flow = this._flow;
    if (!flow || !flow.win || flow.win.isDestroyed()) return false;
    const wc = flow.win.webContents;
    if (!event || event.sender !== wc) return false;
    try {
      const frame = event.senderFrame;
      if (frame && wc.mainFrame && frame !== wc.mainFrame) return false;
    } catch {
      // A frame that has already gone cannot be the live main frame.
      return false;
    }
    return true;
  }

  /** What the page needs to render itself: the provider and the language. */
  entryInfo(event) {
    if (!this.fromEntryWindow(event)) return null;
    const locale = this.getLocale() || {};
    return {
      provider: this._flow.providerId,
      language: locale.resolvedLanguage === 'en' ? 'en' : 'tr',
      formatLocale: typeof locale.formatLocale === 'string' ? locale.formatLocale : undefined,
    };
  }

  /**
   * The write. Validated here, stored by `onSubmit`, and never echoed: the
   * return value is `{ok}` plus a code from a closed set.
   *
   * @param {object} event
   * @param {unknown} key
   * @param {unknown} username
   * @param {number} [now]
   */
  submit(event, key, username, now) {
    if (!this.fromEntryWindow(event)) return { ok: false, code: 'rejected' };
    const flow = this._flow;
    // One at a time. Two submits in flight would race two stores over one file.
    if (flow.submitting) return { ok: false, code: 'busy' };
    const pending = flow.pending;
    if (!pending) return { ok: false, code: 'no-entry' };
    const at = Number.isFinite(now) ? now : Date.now();
    if (at > pending.expiresAt) {
      this.destroy('expired');
      return { ok: false, code: 'expired' };
    }

    // The provider is the one fixed at consent. Nothing the page sends can
    // change it, because the page never sends one.
    const providerId = pending.providerId;
    const keyResult = validateKey(providerId, key);
    if (!keyResult.ok) return { ok: false, code: keyResult.code };
    const userResult = validateUsername(providerId, username);
    if (!userResult.ok) return { ok: false, code: userResult.code };

    flow.submitting = true;
    let stored;
    try {
      stored = this.onSubmit({ provider: providerId, key: keyResult.key, username: userResult.username });
    } catch (err) {
      flow.submitting = false;
      log.warn(`key could not be stored: code=${(err && err.code) || 'UNKNOWN'}`);
      return { ok: false, code: 'store-failed' };
    }
    if (!stored || stored.ok !== true) {
      // A failed store leaves the pending entry alive so the user can correct
      // and retry inside the same five minutes.
      flow.submitting = false;
      return { ok: false, code: (stored && stored.code) || 'store-failed' };
    }
    // One shot: consumed before the window goes away, so a replayed message
    // cannot find it even if the window outlives this call by a tick.
    flow.pending = null;
    this.destroy('stored');
    return { ok: true };
  }

  cancel(event) {
    if (!this.fromEntryWindow(event)) return { ok: false };
    this.destroy('cancelled');
    return { ok: true };
  }

  /** The page's "create a token on GitHub" button. No argument, by design. */
  openTokenPage(event) {
    if (!this.fromEntryWindow(event)) return { ok: false };
    const pending = this._flow.pending;
    if (!pending) return { ok: false };
    return this.openTokenPageFor(pending.providerId);
  }

  /**
   * Ends the flow: the pending entry is dropped, the timer cleared and the
   * window destroyed. Safe to call twice, and called from the window's own
   * 'closed' handler, so it must not re-enter.
   */
  destroy(reason) {
    const flow = this._flow;
    if (!flow) return;
    this._flow = null;
    if (flow.timer) clearTimeout(flow.timer);
    flow.pending = null;
    const win = flow.win;
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch (err) {
        log.warn(`key entry window could not be destroyed: code=${(err && err.code) || 'UNKNOWN'}`);
      }
    }
    log.trace('keys.entry.end', { reason });
  }
}

module.exports = { EntryFlow, ENTRY_PARTITION, ENTRY_TTL_MS, resolveEntryPage };
