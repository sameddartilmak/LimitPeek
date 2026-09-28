'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fakeElectron = require('./helpers/fake-security-electron');

const electron = fakeElectron.install();
const security = require('../src/main/security');

/**
 * The hardening in `main/security.js`, RUN against a fake electron rather than
 * grepped for. A source-string check cannot notice a guard that was deleted
 * while the string it looks for survives elsewhere in the file; these can.
 *
 * Hermetic: no socket is opened and no real session exists.
 */

test.beforeEach(() => electron.resetProcess());
test.after(() => electron.restore());

/* ----------------------------------------------------------------- sessions */

test('every session created in this process is hardened', () => {
  security.applyProcessHardening();
  const sess = electron.fake.session.fromPartition('some-other-window');
  assert.notEqual(sess.webRequest.beforeRequest, null, 'a session with no filter is a session with no block');
  assert.equal(sess.decide({ url: 'https://example.com/x' }).cancel, true);
  assert.equal(sess.decide({ url: 'https://api.github.com/x' }).cancel, true);
  assert.equal(sess.decide({ url: 'file:///C:/app/index.html' }).cancel, false);
  assert.equal(sess.permissionCheckHandler(), false);
});

test('defaultSession\u2019s block-all listener is never re-registered by session-created', () => {
  security.applyProcessHardening();
  // The default session is hardened ONCE, from applyAll(); a `session-created`
  // for it must do nothing, because Electron keeps only the last listener and
  // re-registering is the shape of the edit that removes the global block.
  electron.fake.app.emit('session-created', electron.defaultSession);
  assert.equal(electron.defaultSession.webRequest.beforeRequest, null);

  // Hardened explicitly, as bootstrap does.
  security.applySessionHardening(electron.defaultSession);
  const listener = electron.defaultSession.webRequest.beforeRequest;
  electron.fake.app.emit('session-created', electron.defaultSession);
  assert.equal(electron.defaultSession.webRequest.beforeRequest, listener, 'the listener object is untouched');
});

/* --------------------------------------------------- proxy auto-discovery */

/**
 * ADR-001 Amendment 2026-09-22. These prove the control is REQUESTED — the
 * process-global switch is appended before `ready`, and every session is put
 * on an explicit DIRECT mode before it can carry a request. They cannot prove
 * the property: WPAD comes out of Chromium's NetworkService over channels no
 * in-process test sees. `scripts/zero-socket-audit.ps1` is the gate for that.
 */
test('proxy auto-discovery is refused process wide, before ready', () => {
  security.applyProcessHardening();
  assert.ok(electron.switches.includes('no-proxy-server'), 'the measured control must be appended');
  // A command-line switch is only honoured before `ready`, which is why it lives
  // in the function `applyAll()` calls at require time rather than in the
  // whenReady callback beside the default session's hardening.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'security.js'), 'utf8');
  const applyAll = src.slice(src.indexOf('function applyAll'));
  assert.ok(
    applyAll.indexOf('applyProcessHardening()') < applyAll.indexOf('whenReady'),
    'the switch must be appended before whenReady, not inside it',
  );
});

test('every session the app creates is put on DIRECT before it can carry a request', () => {
  security.applyProcessHardening();
  security.applySessionHardening(electron.defaultSession);
  const other = electron.fake.session.fromPartition('some-window');

  for (const sess of [electron.defaultSession, other]) {
    assert.deepEqual(sess.proxyConfigs, [{ mode: 'direct' }], sess.partition);
    // ORDER, not just presence: the mode is set before the session answers its
    // first request, because proxy resolution is what the filter cannot see.
    assert.equal(sess.events[0], 'setProxy:direct', sess.partition);
    sess.decide({ url: 'file:///C:/app/index.html' });
    assert.deepEqual(sess.events.filter((e) => e.startsWith('setProxy')), ['setProxy:direct']);
  }
  // No session is left on the system proxy, and none is asked twice.
  assert.equal(electron.createdSessions.every((s) => s.proxyConfigs.length === 1), true);
});

test('a session left with no proxy mode cannot happen through this module', () => {
  security.applyProcessHardening();
  const stray = electron.fake.session.fromPartition('some-future-window');
  assert.deepEqual(stray.proxyConfigs, [{ mode: 'direct' }]);
  // A session object without setProxy (an older Electron) degrades to "no mode
  // requested" rather than throwing and taking the rest of the hardening with it.
  const ancient = { webRequest: { onBeforeRequest() {}, onHeadersReceived() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  assert.doesNotThrow(() => security.applySessionHardening(ancient));
  assert.doesNotThrow(() => security.setDirectProxy(null));
});

/* ------------------------------------------------------------- file: URLs */

test('a file: URL with a remote authority is cancelled on every hardened session', () => {
  security.applyProcessHardening();
  const sess = electron.fake.session.fromPartition('some-window');
  const cases = [
    'file://server/share/x.html',
    'file://SERVER/share/x.html',
    'FILE://server/share/x.html',
    'file:////server/share/x.html',
    'file://127.0.0.1/c$/x.html',
    'file://user@server/share/x.html',
  ];
  for (const url of cases) {
    assert.equal(security.isAllowed(url), false, url);
    assert.equal(sess.decide({ url }).cancel, true, url);
  }
  // A genuinely local file still loads: the panel page itself is one.
  for (const url of ['file:///C:/app/index.html', 'file:///C:/app/dist/main.js']) {
    assert.equal(security.isAllowed(url), true, url);
    assert.equal(sess.decide({ url }).cancel, false, url);
  }
  // The other allowed schemes are unaffected, and a non-string is refused.
  assert.equal(security.isAllowed('data:text/css,body{}'), true);
  assert.equal(security.isAllowed('devtools://devtools/bundled/x.js'), true);
  assert.equal(security.isAllowed('https://api.github.com/'), false);
  assert.equal(security.isAllowed(undefined), false);
  assert.equal(security.isAllowed(12), false);
});
