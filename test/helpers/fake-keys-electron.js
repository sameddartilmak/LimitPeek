'use strict';
const { EventEmitter } = require('node:events');

/**
 * A stand-in for the `electron` surface the optional-key modules use, so every
 * K condition in ADR-003 Amendment 5 can be exercised under plain `node --test`
 * (ADR-003 A5: "hermetic, no real network").
 *
 * It deliberately reproduces three behaviours of the real thing, because the
 * security properties under test depend on them:
 *
 *  1. `session.fromPartition()` emits `session-created` SYNCHRONOUSLY, before it
 *     returns. That is what makes the exemption in `main/security.js` the only
 *     workable shape, and a fake that emitted it later would let a broken
 *     implementation pass.
 *  2. `webRequest.onBeforeRequest` keeps only the LAST listener per session.
 *     This is the trap Amendment 5 names; a fake that collected listeners would
 *     hide exactly the bug the tests exist to catch.
 *  3. `safeStorage.encryptString()` really transforms the bytes, so "no file
 *     contains the key in any encoding" is a statement about the store's
 *     behaviour rather than about a fake that happens to pass the plaintext
 *     through. It is NOT DPAPI: the real thing is only reachable inside
 *     Electron, and what these tests own is the code around it.
 */

/* ------------------------------------------------------------ safeStorage */

const CIPHER_TAG = Buffer.from('FAKEDPAPI');
/** A transform, not encryption: enough that the plaintext is not in the file. */
function xorBytes(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i += 1) out[i] = buf[i] ^ 0x5a;
  return out;
}

/* --------------------------------------------------------------- sessions */

class FakeWebRequest {
  constructor() {
    /** The ONE listener Electron keeps, per event. */
    this.beforeRequest = null;
    this.headersReceived = null;
  }

  onBeforeRequest(listener) {
    // Electron replaces, it does not add. See the header comment.
    this.beforeRequest = listener;
  }

  onHeadersReceived(listener) {
    this.headersReceived = listener;
  }
}

class FakeSession {
  constructor(partition) {
    this.partition = partition;
    this.webRequest = new FakeWebRequest();
    this.permissionRequestHandler = null;
    this.permissionCheckHandler = null;
    this.devicePermissionHandler = null;
    this.closedConnections = 0;
    this.clearedAuthCache = 0;
    /**
     * Every `setProxy()` config, in order (ADR-001 Amendment 2026-09-22). Empty
     * means this session was left on whatever proxy configuration Chromium
     * decided for itself, which is how WPAD got out of the packaged app.
     */
    this.proxyConfigs = [];
    /** `setProxy` and `decide` calls interleaved, so a test can prove order. */
    this.events = [];
  }

  setPermissionRequestHandler(fn) { this.permissionRequestHandler = fn; }
  setPermissionCheckHandler(fn) { this.permissionCheckHandler = fn; }
  setDevicePermissionHandler(fn) { this.devicePermissionHandler = fn; }
  setProxy(config) {
    this.proxyConfigs.push(config);
    this.events.push(`setProxy:${config && config.mode}`);
    return Promise.resolve();
  }

  closeAllConnections() { this.closedConnections += 1; return Promise.resolve(); }
  clearAuthCache() { this.clearedAuthCache += 1; return Promise.resolve(); }

  /** Asks this session's filter about a request, the way Chromium would. */
  decide(details) {
    this.events.push('request');
    const listener = this.webRequest.beforeRequest;
    if (!listener) return { cancel: false, filtered: false };
    let answer = null;
    listener(details, (response) => { answer = response; });
    return { cancel: Boolean(answer && answer.cancel), filtered: true };
  }
}

/* ------------------------------------------------------------------- net */

class FakeClientRequest extends EventEmitter {
  constructor(options, script, log) {
    super();
    this.options = options;
    this.script = script;
    this.log = log;
    this.headers = {};
    this.aborted = false;
    this.ended = false;
  }

  setHeader(name, value) { this.headers[name] = value; }
  removeHeader(name) { delete this.headers[name]; }

  abort() { this.aborted = true; }

  end() {
    this.ended = true;
    this.log.push({ options: this.options, headers: { ...this.headers } });
    process.nextTick(() => this._respond());
  }

  _respond() {
    if (this.aborted) return;
    const s = this.script || {};
    if (s.silent) return;
    if (s.login) {
      this.emit('login', { isProxy: true }, () => {});
      return;
    }
    if (s.error) {
      const err = new Error(s.error.message || 'network failure');
      err.code = s.error.code || 'ERR_FAILED';
      this.emit('error', err);
      return;
    }
    const response = new EventEmitter();
    response.statusCode = s.statusCode === undefined ? 200 : s.statusCode;
    response.headers = s.headers || {};
    this.emit('response', response);
    process.nextTick(() => {
      if (this.aborted) return;
      const body = s.body === undefined ? '' : s.body;
      const chunks = Array.isArray(body) ? body : [body];
      for (const chunk of chunks) {
        if (this.aborted) return;
        response.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      if (!this.aborted) response.emit('end');
    });
  }
}

/* --------------------------------------------------------------- windows */

class FakeMainFrame {
  constructor() { this.routingId = 1; }
}

class FakeBrowserWindow {
  constructor(options) {
    this.options = options || {};
    this.destroyed = false;
    this.shown = false;
    this.focused = false;
    this.contentProtection = null;
    this.alwaysOnTop = null;
    this.loadedFiles = [];
    this.menuSet = false;
    this.listeners = new Map();
    const mainFrame = new FakeMainFrame();
    const wcListeners = new Map();
    this.webContents = {
      mainFrame,
      isDestroyed: () => this.destroyed,
      on(event, handler) {
        if (!wcListeners.has(event)) wcListeners.set(event, []);
        wcListeners.get(event).push(handler);
      },
      emit(event, ...args) {
        for (const handler of wcListeners.get(event) || []) handler(...args);
      },
      send() {},
    };
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return this;
  }

  once(event, handler) { return this.on(event, handler); }

  emit(event, ...args) {
    for (const handler of this.listeners.get(event) || []) handler(...args);
  }

  setMenu() { this.menuSet = true; }
  setContentProtection(on) { this.contentProtection = on; }
  setAlwaysOnTop(on, level) { this.alwaysOnTop = { on, level }; }
  loadFile(file) { this.loadedFiles.push(file); }
  show() { this.shown = true; }
  focus() { this.focused = true; }
  isDestroyed() { return this.destroyed; }
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
}

/* ------------------------------------------------------------------ ipc */

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
    this.listeners = new Map();
  }

  handle(channel, fn) { this.handlers.set(channel, fn); }
  on(channel, fn) { this.listeners.set(channel, fn); }

  /** Drives an `invoke` handler. `event` is whatever the test wants to claim. */
  invoke(channel, event, ...args) {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn(event, ...args);
  }

  /** Drives a `send` listener. Returns `event.returnValue` for the sync ones. */
  send(channel, event, ...args) {
    const fn = this.listeners.get(channel);
    if (!fn) throw new Error(`no listener for ${channel}`);
    fn(event, ...args);
    return event.returnValue;
  }
}

/* --------------------------------------------------------------- install */

/**
 * @param {object} [options]
 * @param {boolean} [options.encryptionAvailable]
 * @param {boolean} [options.isPackaged]
 * @returns the fake, plus the knobs the tests turn
 */
function install(options = {}) {
  const appEvents = new EventEmitter();
  appEvents.setMaxListeners(0);
  const sessions = new Map();
  const createdSessions = [];
  const defaultSession = new FakeSession('');
  const windows = [];
  const dialogCalls = [];
  const dialogAnswers = [];
  const openedExternally = [];
  const requestLog = [];
  const netScript = [];
  /** Command-line switches, in order. Some controls can only live here. */
  const switches = [];

  const state = {
    encryptionAvailable: options.encryptionAvailable !== false,
    isPackaged: options.isPackaged === true,
  };

  const fake = {
    app: {
      get isPackaged() { return state.isPackaged; },
      getPath: () => process.cwd(),
      getVersion: () => '0.0.0-test',
      on: (event, handler) => { appEvents.on(event, handler); return fake.app; },
      commandLine: { appendSwitch(name, value) { switches.push(value === undefined ? name : `${name}=${value}`); } },
      whenReady: () => Promise.resolve(),
      emit: (event, ...args) => appEvents.emit(event, ...args),
    },
    session: {
      get defaultSession() { return defaultSession; },
      fromPartition(partition) {
        if (sessions.has(partition)) return sessions.get(partition);
        const sess = new FakeSession(partition);
        sessions.set(partition, sess);
        createdSessions.push(sess);
        // Synchronously, like Electron. See the header comment.
        appEvents.emit('session-created', sess);
        return sess;
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => state.encryptionAvailable === true,
      encryptString(plain) {
        if (!state.encryptionAvailable) throw new Error('encryption unavailable');
        return Buffer.concat([CIPHER_TAG, xorBytes(Buffer.from(String(plain), 'utf8'))]);
      },
      decryptString(buf) {
        if (!state.encryptionAvailable) throw new Error('encryption unavailable');
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        if (!b.subarray(0, CIPHER_TAG.length).equals(CIPHER_TAG)) throw new Error('not our ciphertext');
        return xorBytes(b.subarray(CIPHER_TAG.length)).toString('utf8');
      },
    },
    net: {
      request(requestOptions) {
        const script = netScript.length > 1 ? netScript.shift() : (netScript[0] || {});
        return new FakeClientRequest(requestOptions, script, requestLog);
      },
    },
    dialog: {
      showMessageBox(parent, config) {
        dialogCalls.push({ parent, config });
        const answer = dialogAnswers.length > 1 ? dialogAnswers.shift() : dialogAnswers[0];
        return Promise.resolve({ response: answer === undefined ? 0 : answer });
      },
      showErrorBox() {},
    },
    shell: {
      openExternal(url) {
        openedExternally.push(url);
        return Promise.resolve();
      },
    },
    BrowserWindow: class extends FakeBrowserWindow {
      constructor(opts) { super(opts); windows.push(this); }
    },
    ipcMain: new FakeIpcMain(),
    nativeTheme: { shouldUseDarkColors: true, on() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getAllDisplays: () => [], getDisplayNearestPoint: () => null },
  };

  const id = require.resolve('electron');
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: fake, children: [], paths: [] };

  return {
    fake,
    state,
    sessions,
    createdSessions,
    defaultSession,
    windows,
    dialogCalls,
    /** Queue of `response` indexes a native message box returns, in order. The key flow no longer raises one (Amendment 9); its tests assert `dialogCalls` stays empty. */
    dialogAnswers,
    openedExternally,
    /** Every request that reached `end()`: its options and its headers. */
    requestLog,
    /** Queue of scripted replies; the last one repeats. */
    netScript,
    /** Command-line switches appended, in order. */
    switches,
    /**
     * Forgets every `app.on(...)` listener and every session created so far.
     *
     * The real process calls `applyProcessHardening()` once; a test file calls it
     * per test, and without this each call would leave another `session-created`
     * listener behind — so the third test would see a session hardened three
     * times and read that as a bug in the code rather than in the harness.
     */
    resetProcess() {
      appEvents.removeAllListeners();
      sessions.clear();
      createdSessions.length = 0;
      switches.length = 0;
      defaultSession.proxyConfigs.length = 0;
      defaultSession.events.length = 0;
      defaultSession.webRequest.beforeRequest = null;
      defaultSession.webRequest.headersReceived = null;
    },
    restore() {
      if (previous) require.cache[id] = previous;
      else delete require.cache[id];
    },
  };
}

module.exports = { install, FakeSession, FakeBrowserWindow };
