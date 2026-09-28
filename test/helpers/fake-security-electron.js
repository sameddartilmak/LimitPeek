'use strict';
const { EventEmitter } = require('node:events');

/**
 * A stand-in for the `electron` surface `main/security.js` uses, so the
 * hardening can be RUN under plain `node --test` rather than only grepped for.
 *
 * It reproduces two behaviours of the real thing, because the properties under
 * test depend on them:
 *
 *  1. `session.fromPartition()` emits `session-created` SYNCHRONOUSLY, before it
 *     returns. A fake that emitted it later would let a session that carries a
 *     request before it is hardened pass.
 *  2. `webRequest.onBeforeRequest` keeps only the LAST listener per session.
 *     Re-registering is the shape of the edit that removes the global block; a
 *     fake that collected listeners would hide it.
 */

class FakeWebRequest {
  constructor() {
    /** The ONE listener Electron keeps, per event. */
    this.beforeRequest = null;
    this.headersReceived = null;
  }

  onBeforeRequest(listener) { this.beforeRequest = listener; }
  onHeadersReceived(listener) { this.headersReceived = listener; }
}

class FakeSession {
  constructor(partition) {
    this.partition = partition;
    this.webRequest = new FakeWebRequest();
    this.permissionRequestHandler = null;
    this.permissionCheckHandler = null;
    this.devicePermissionHandler = null;
    /** Every `setProxy()` config, in order. Empty: left on Chromium's own choice. */
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

function install() {
  const appEvents = new EventEmitter();
  appEvents.setMaxListeners(0);
  const sessions = new Map();
  const createdSessions = [];
  const defaultSession = new FakeSession('');
  /** Command-line switches, in order. Some controls can only live here. */
  const switches = [];

  const fake = {
    app: {
      on: (event, handler) => { appEvents.on(event, handler); return fake.app; },
      commandLine: { appendSwitch(name, value) { switches.push(value === undefined ? name : `${name}=${value}`); } },
      whenReady: () => Promise.resolve(),
      emit: (event, ...args) => appEvents.emit(event, ...args),
      configureHostResolver() {},
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
  };

  const id = require.resolve('electron');
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: fake, children: [], paths: [] };

  return {
    fake,
    createdSessions,
    defaultSession,
    switches,
    /**
     * Forgets every `app.on(...)` listener and every session created so far. The
     * real process hardens once; a test file does it per test, and without this
     * each call would leave another `session-created` listener behind.
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

module.exports = { install, FakeSession };
