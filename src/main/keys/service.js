'use strict';
const log = require('../../core/log');
const { IPC, IPC_KEY_ENTRY } = require('../../shared/contract');
const { KEY_CAPABLE_IDS, isKeyCapable, soleKeyCapableId } = require('../../core/keys/registry');
const schedule = require('../../core/keys/schedule');
const { toContractShape } = require('../../core/keys/credits');
const secretStore = require('./secret-store');
const keyedNet = require('./keyed-net');
const { EntryFlow } = require('./entry-window');
const { openTokenPage } = require('./token-page');

/**
 * The optional-key service (ADR-003 Amendment 5 + Amendment 8, Phase B).
 *
 * It owns four things and delegates everything else:
 *   - the per-provider key STATE the snapshot carries (`keyState`,
 *     `keyStoredAt`, `creditUsage`), and nothing else about a key;
 *   - the IPC surface, with a sender check on every channel;
 *   - the poll, which decides only WHEN to ask (`core/keys/schedule.js` decides
 *     whether it is allowed to);
 *   - teardown on removal and on quit.
 *
 * It holds no key. There is no field on this object, no cache and no closure
 * anywhere in this file that a decrypted key is assigned to: the request
 * function is handed a `readSecret` callback and decrypts inside itself,
 * immediately before the request (K17).
 *
 * WHY A FIGURE SURVIVES AN ERROR, AND WHEN IT DOES NOT
 * ---------------------------------------------------
 * ADR-001 Amendment 2, applied to credits. A credit reading is a true statement
 * about a month, it carries its own `fetchedAt`, and consumption inside a month
 * only rises — so keeping it beside an 'unreachable' state is honest, and the
 * renderer dims it and prints its age. But the instant the PERIOD it describes
 * has ended, the figure is provably about a dead month and is dropped
 * unconditionally, exactly as a rolled-over window is.
 */

/** How often the poll wakes up. The 15-minute floor lives in the schedule. */
const TICK_MS = 60 * 1000;

class KeyService {
  /**
   * @param {object} options
   * @param {(id:string) => boolean} options.isEnabled  the user's own switch
   * @param {() => void} options.onChange  called when the snapshot fields move
   * @param {() => {resolvedLanguage:string, formatLocale:string}} options.getLocale
   * @param {() => void} [options.beforePrompt]  pins the panel before the key window opens
   */
  constructor(options = {}) {
    this.isEnabled = options.isEnabled || (() => false);
    this.onChange = options.onChange || (() => {});
    this.getLocale = options.getLocale || (() => ({ resolvedLanguage: 'tr', formatLocale: 'tr-TR' }));
    this.beforePrompt = options.beforePrompt || (() => {});
    this._tick = null;
    this._stopped = false;
    /** id -> { keyState, keyStoredAt, creditUsage, schedule, hasKey } */
    this._states = Object.create(null);
    for (const id of KEY_CAPABLE_IDS) {
      this._states[id] = {
        keyState: 'none',
        keyStoredAt: null,
        creditUsage: null,
        schedule: schedule.emptyState(),
        hasKey: false,
      };
    }
    this.entry = new EntryFlow({
      onSubmit: (args) => this._store(args),
      isSecureStorageAvailable: () => secretStore.isAvailable(),
      getLocale: () => this.getLocale(),
      openTokenPage: (id) => openTokenPage(id),
      entryPage: options.entryPage || null,
    });
  }

  /**
   * Reads what is on disk. Called at startup, and after any change to a record.
   * Never decrypts: `keyState` and `keyStoredAt` come from the record's
   * envelope, which is why they are available without touching DPAPI.
   */
  load() {
    for (const id of KEY_CAPABLE_IDS) {
      const state = this._states[id];
      const read = secretStore.read(id);
      state.hasKey = read.state !== 'none';
      state.keyState = read.state;
      state.keyStoredAt = read.storedAt;
      state.schedule = schedule.sanitizeState(secretStore.readSchedule(id));
      if (!state.hasKey) {
        state.creditUsage = null;
        state.schedule = schedule.emptyState();
      }
    }
    this._arm();
    return this;
  }

  /** The `keys` input `core/snapshot.js` reads. Plain data, copied per call. */
  snapshotInput(now = Date.now()) {
    const out = Object.create(null);
    for (const id of KEY_CAPABLE_IDS) {
      const state = this._states[id];
      this._expireFigure(id, now);
      out[id] = {
        keyState: state.keyState,
        keyStoredAt: state.keyStoredAt,
        creditUsage: state.creditUsage ? { ...state.creditUsage } : null,
      };
    }
    return out;
  }

  /**
   * A figure whose period has ended is dropped, unconditionally and before it is
   * read (ADR-001 Amendment 2 state 3, and its clarification: rollover outranks
   * freshness). "Credits used this month" about last month is a false statement
   * however recently it was fetched.
   */
  _expireFigure(id, now) {
    const state = this._states[id];
    const usage = state.creditUsage;
    if (!usage) return;
    const endMs = Date.parse(usage.periodEnd);
    if (Number.isFinite(endMs) && now >= endMs) state.creditUsage = null;
  }

  /* ------------------------------------------------------------------ ipc */

  /**
   * @param {object} ipcMain
   * @param {(event:object) => boolean} fromPanel  the same check every other
   *   channel in this app uses: the message came from OUR panel window.
   */
  registerIpc(ipcMain, fromPanel) {
    ipcMain.handle(IPC.KEY_ENTRY, async (event, providerId) => {
      if (!fromPanel(event)) return { ok: false };
      const id = typeof providerId === 'string' && providerId !== '' ? providerId : soleKeyCapableId();
      if (!isKeyCapable(id)) return { ok: false };
      const result = await this.entry.start({ providerId: id, beforePrompt: this.beforePrompt });
      // The one refusal the row has to be able to explain. Everything else is a
      // duplicate ('busy') or an install problem, neither of which changes what
      // the row can offer. Declining now happens later, inside the window.
      if (!result.ok && result.code === 'secure-storage-unavailable') {
        this._states[id].keyState = 'secure-storage-unavailable';
        this.onChange();
      }
      return { ok: result.ok === true };
    });

    ipcMain.handle(IPC.KEY_REMOVE, (event, providerId) => {
      if (!fromPanel(event)) return { ok: false };
      const id = typeof providerId === 'string' && providerId !== '' ? providerId : soleKeyCapableId();
      if (!isKeyCapable(id)) return { ok: false };
      return this.removeKey(id);
    });

    // The panel's "open the token page" affordance, for the two states a new key
    // fixes. The argument only ever SELECTS a hard-coded branch; it never
    // reaches a URL (see token-page.js).
    ipcMain.handle(IPC.KEY_TOKEN_PAGE, (event, providerId) => {
      if (!fromPanel(event)) return { ok: false };
      const id = typeof providerId === 'string' && providerId !== '' ? providerId : soleKeyCapableId();
      if (!isKeyCapable(id)) return { ok: false };
      return openTokenPage(id);
    });

    /* --- the entry window's own channels. Sender-checked by the flow. --- */

    ipcMain.handle(IPC_KEY_ENTRY.CONSENT, (event) => this.entry.consent(event, Date.now()));
    ipcMain.handle(IPC_KEY_ENTRY.SUBMIT, (event, key, username) => this.entry.submit(event, key, username, Date.now()));
    ipcMain.on(IPC_KEY_ENTRY.CANCEL, (event) => { this.entry.cancel(event); });
    // Synchronous. `returnValue` is set on EVERY path including rejection: an
    // ipcMain listener that returns without setting it blocks the caller for
    // ever, and here that would be a consent page that never paints.
    ipcMain.on(IPC_KEY_ENTRY.ENTRY_INFO, (event) => {
      event.returnValue = this.entry.entryInfo(event);
    });
    ipcMain.handle(IPC_KEY_ENTRY.ENTRY_TOKEN_PAGE, (event) => this.entry.openTokenPage(event));
  }

  /* ---------------------------------------------------------------- store */

  /**
   * The store, called by the entry flow with an already-validated pair.
   * Returns the fixed code the page prints; nothing about the value.
   */
  _store({ provider, key, username }) {
    const result = secretStore.store({ provider, key, username, now: Date.now() });
    if (!result.ok) {
      if (result.code === 'secure-storage-unavailable') {
        this._states[provider].keyState = 'secure-storage-unavailable';
        this.onChange();
      }
      return result;
    }
    const state = this._states[provider];
    state.hasKey = true;
    state.keyState = 'stored';
    state.keyStoredAt = result.storedAt;
    // A NEW key may belong to a different account, so the old figure is dropped
    // rather than kept beside it.
    state.creditUsage = null;
    // A fresh schedule: a replaced key clears a 401 stop and is read at once,
    // because the user is standing in front of the app waiting to see it work.
    state.schedule = schedule.emptyState();
    secretStore.writeSchedule(provider, state.schedule);
    this._arm();
    this.onChange();
    // Deliberately not awaited: the page is waiting for `{ok}`, and the first
    // reading is worth a rebuild of its own when it lands.
    void this.poll(Date.now());
    return { ok: true };
  }

  /**
   * Removal (K20): the file and any temporary beside it, the schedule, every
   * timer, anything in flight, every socket and cached credential the keyed
   * session owns, and the cached figure.
   */
  removeKey(providerId) {
    if (!isKeyCapable(providerId)) return { ok: false };
    const removed = secretStore.remove(providerId);
    const state = this._states[providerId];
    state.hasKey = false;
    state.keyState = 'none';
    state.keyStoredAt = null;
    state.creditUsage = null;
    state.schedule = schedule.emptyState();
    // Aborts the request in flight, closes the connections and clears the auth
    // cache. Done even when the delete failed: a key we are trying to remove
    // must stop being used either way.
    keyedNet.teardown();
    this._arm();
    this.onChange();
    return { ok: removed.ok === true };
  }

  /* ----------------------------------------------------------------- poll */

  /**
   * Starts the tick when at least one provider has a key AND is enabled; stops
   * it otherwise. A timer that exists while nothing can be polled is a timer
   * that will eventually be given a reason to fire.
   */
  _arm() {
    if (this._stopped) return;
    const wanted = KEY_CAPABLE_IDS.some((id) => this._states[id].hasKey && this.isEnabled(id));
    if (wanted && !this._tick) {
      this._tick = setInterval(() => { void this.poll(Date.now()); }, TICK_MS);
      // Never keeps the process alive on its own.
      if (this._tick.unref) this._tick.unref();
    } else if (!wanted && this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }
  }

  /** The user toggled a provider on or off. */
  enablementChanged() {
    this._arm();
  }

  /**
   * One pass. Makes at most one request per provider, and only when the schedule
   * allows it — so a thousand refreshes inside fifteen minutes make one request,
   * and a rejected key makes none at all.
   *
   * @returns {Promise<number>} how many requests were actually made
   */
  async poll(now = Date.now()) {
    if (this._stopped) return 0;
    let made = 0;
    for (const id of KEY_CAPABLE_IDS) {
      const state = this._states[id];
      const conditions = {
        enabled: this.isEnabled(id) === true,
        hasKey: state.hasKey === true,
        inFlight: keyedNet.isInFlight(),
      };
      if (!schedule.mayStart(state.schedule, now, conditions)) continue;

      // The slot is spent BEFORE the request is sent and persisted immediately,
      // so a crash mid-flight cannot buy a second start (K16).
      state.schedule = schedule.afterStart(state.schedule, now);
      secretStore.writeSchedule(id, state.schedule);

      let result;
      try {
        result = await keyedNet.requestCreditUsage({
          providerId: id,
          // Decrypted inside the request function, immediately before the
          // request, and never returned to this scope (K17).
          readSecret: () => secretStore.open(id),
          now,
        });
      } catch (err) {
        // Nothing in the request path is expected to throw; a throw here must
        // not take the poll (or the snapshot) with it.
        log.warn(`keyed request threw: code=${(err && err.code) || 'UNKNOWN'}`);
        result = { keyState: 'unreachable', usage: null, retryAfterMs: null, requests: 0 };
      }
      made += Number.isFinite(result.requests) ? result.requests : 0;
      // ONE instant for the whole pass, the same one `mayStart` and `afterStart`
      // used. Reading the clock again here would put the start and its outcome on
      // two different timelines, and the 15-minute floor is the difference
      // between them — a floor measured against a clock read after the reply is
      // a floor that moves with the reply's latency.
      this._applyResult(id, result, now);
    }
    return made;
  }

  _applyResult(id, result, now) {
    const state = this._states[id];
    const code = result.keyState;
    if (code === 'busy') return;
    // The key was REMOVED while this request was in flight, and removal aborted
    // it. Applying the abort's outcome would put 'unreachable' over the 'none'
    // the user just asked for — and `writeSchedule` below would re-create the
    // schedule file inside the directory removal had just emptied. A request
    // whose key is gone describes nothing about the current state.
    if (!state.hasKey) return;
    if (code === 'none') {
      // The record vanished under us (a manual delete, another instance).
      this.load();
      this.onChange();
      return;
    }
    if (code === 'stored' && result.usage) {
      state.keyState = 'stored';
      state.creditUsage = toContractShape(result.usage);
      state.schedule = schedule.afterOutcome(state.schedule, { kind: 'ok' }, now);
    } else {
      state.keyState = code;
      const kind = code === 'key-rejected'
        ? 'stop'
        : (code === 'rate-limited' ? 'rate-limited' : 'fail');
      state.schedule = schedule.afterOutcome(
        state.schedule,
        { kind, retryAfterMs: result.retryAfterMs === undefined ? null : result.retryAfterMs },
        now,
      );
    }
    secretStore.writeSchedule(id, state.schedule);
    this.onChange();
  }

  /** Quit: no timer, no socket, no window, no pending entry. */
  stop() {
    this._stopped = true;
    if (this._tick) clearInterval(this._tick);
    this._tick = null;
    this.entry.destroy('stopped');
    keyedNet.teardown();
  }

  /** Diagnostics for tests: is the poll timer armed? */
  get polling() {
    return this._tick !== null;
  }
}

module.exports = { KeyService, TICK_MS };
