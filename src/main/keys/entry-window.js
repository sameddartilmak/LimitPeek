'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, session, BrowserWindow } = require('electron');

const log = require('../../core/log');
const { isKeyCapable } = require('../../core/keys/registry');
const { validateKey, validateUsername } = require('../../core/keys/validate');

/**
 * One window of its own: consent first, then one write (ADR-003 Amendment 5,
 * K1-K6, as revised by Amendment 9).
 *
 * THE ORDER IS THE CONTROL
 * ------------------------
 *  1. The window: its OWN in-memory session, sandboxed, context-isolated,
 *     devTools off when packaged, content protection on, no network, and
 *     destroyed on submit, on cancel, or when its time runs out (K2). Its first
 *     screen is the consent text with Cancel and Continue. Amendment 9 moved
 *     consent here from a native message box: the box and the page said the
 *     same things twice, in two different-looking windows. Declining still
 *     writes nothing, starts no poll and leaves the row exactly as it was (K1).
 *     The only thing it leaves behind is an in-memory session that disappears
 *     when the app exits.
 *  2. Only after Continue, a PENDING ENTRY: one-shot, provider fixed when the
 *     window opened, expiring five minutes after consent. Continue is accepted
 *     only from this window's main frame, so the panel cannot consent for the
 *     user. A submit with no pending entry, a second submit against the same
 *     one, or one that arrives after it expired, is refused. That is what makes
 *     the entry channel unusable as a general "store this key" call (K4).
 *
 * ONE FLOW AT A TIME
 * ------------------
 * The lock is taken SYNCHRONOUSLY, before the first `await`, so fifty IPC
 * messages arriving in one tick open one window. A second flow would mean two
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

/**
 * Each step gets this long, whatever the user does (K2): five minutes to read
 * and continue, then five minutes from consent to submit. So the window can
 * never live longer than ten minutes in total.
 */
const ENTRY_TTL_MS = 5 * 60 * 1000;

const ENTRY_WIDTH = 520;
/** Fits the consent screen, the longer step, at 100% scale; more text scrolls. */
const ENTRY_HEIGHT = 600;

/**
 * The page's own ground (`--ink-900`, dark theme) and body ink (`--ink-200`).
 * The title bar is hidden and Windows draws only its caption buttons over the
 * page, so these must match tokens.css or a seam shows along the top.
 */
const ENTRY_GROUND = '#0E1211';
const ENTRY_INK = '#C2CFCB';
const ENTRY_BAR_HEIGHT = 32;

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
    /**
     * The one flow: `{ providerId, win, timer, pending, submitting }`.
     * `pending` exists only after consent and is deleted the moment a submit is
     * accepted — one shot.
     */
    this._flow = null;
  }

  /** Is the entry window currently open? */
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
   * @param {{providerId:string, beforePrompt?:Function}} args
   * @returns {Promise<{ok:boolean, code?:string}>}
   */
  async start({ providerId, beforePrompt }) {
    // Synchronous guards first: every one of them must answer before the first
    // await, or fifty messages in one tick become fifty windows.
    if (this._flow) return { ok: false, code: 'busy' };
    if (!isKeyCapable(providerId)) return { ok: false, code: 'unknown-provider' };
    // Asked before the window opens: there is no point taking the user through a consent
    // screen for a store that cannot happen, and the row says so instead.
    if (!this.isSecureStorageAvailable()) return { ok: false, code: 'secure-storage-unavailable' };
    const page = this.entryPage || resolveEntryPage();
    if (!fs.existsSync(page)) {
      log.warn('key entry page is missing; the entry flow cannot be offered');
      return { ok: false, code: 'entry-unavailable' };
    }
    this._flow = { providerId, win: null, timer: null, pending: null, submitting: false };

    try {
      // Pins the panel, so it does not slide away while the window is open.
      if (typeof beforePrompt === 'function') beforePrompt();
      this._openWindow(page);
    } catch (err) {
      log.warn(`key entry window could not be opened: code=${(err && err.code) || 'UNKNOWN'}`);
      this.destroy('open-failed');
      return { ok: false, code: 'entry-unavailable' };
    }
    return { ok: true };
  }

  /**
   * The page's Continue button, the user's consent. Only after this does the
   * one-shot pending entry exist (K4), with five minutes starting now, and the
   * window's own lifetime is restarted to match.
   *
   * Takes no argument: the provider was fixed when the window opened, and
   * nothing the page sends can change it. A second Continue is answered `ok`
   * and changes nothing, so a double click neither fails nor adds time.
   *
   * @param {object} event
   * @param {number} [now]
   */
  consent(event, now) {
    if (!this.fromEntryWindow(event)) return { ok: false, code: 'rejected' };
    const flow = this._flow;
    if (flow.pending) return { ok: true };
    const at = Number.isFinite(now) ? now : Date.now();
    flow.pending = { providerId: flow.providerId, expiresAt: at + ENTRY_TTL_MS };
    this._armTimer();
    log.trace('keys.entry.consent', {});
    return { ok: true };
  }

  /** (Re)starts the window's lifetime; when it runs out the window goes. */
  _armTimer() {
    const flow = this._flow;
    if (flow.timer) clearTimeout(flow.timer);
    flow.timer = setTimeout(() => this.destroy('expired'), ENTRY_TTL_MS);
    if (flow.timer.unref) flow.timer.unref();
  }

  _openWindow(page) {
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
      backgroundColor: ENTRY_GROUND,
      // No Windows title bar: the page draws its own strip in the app's colours,
      // and Windows keeps only its real caption buttons on top of it, so close
      // still behaves like any other window's (Alt+F4 and snap included).
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: ENTRY_GROUND, symbolColor: ENTRY_INK, height: ENTRY_BAR_HEIGHT },
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
    // Above the panel, which is itself always-on-top: a consent screen the user
    // cannot see is one they cannot answer.
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

    // Five minutes to read and continue; consent() restarts it (K2).
    this._armTimer();

    win.loadFile(page);
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
      // A missing frame is refused too: Electron reports null for a frame that
      // has already gone, and consent and submit both rest on this check.
      if (!frame || frame !== wc.mainFrame) return false;
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
