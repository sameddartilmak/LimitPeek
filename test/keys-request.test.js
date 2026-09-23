'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fakeElectron = require('./helpers/fake-keys-electron');

const electron = fakeElectron.install();
const log = require('../src/core/log');
const security = require('../src/main/security');
const secretStore = require('../src/main/keys/secret-store');
const keyedNet = require('../src/main/keys/keyed-net');
const { KeyService } = require('../src/main/keys/service');
const { IPC, IPC_KEY_ENTRY } = require('../src/shared/contract');

log.setTrace(false);

/**
 * The keyed request and the service around it (ADR-003 Amendment 5,
 * K13-K17, K20, K22, K25).
 *
 * HERMETIC. No socket is opened: `electron.net` is a fake that scripts replies,
 * so the assertions are about what this app WOULD put on the wire — the session,
 * the options, the single header the key appears in — and about what it does with
 * every answer. The one thing a fake cannot prove is that Chromium honours
 * `redirect:'error'`; that is asserted as an OPTION on the request, and the 3xx
 * case is scripted both as the transport error Electron produces and as a raw
 * status, so the mapping holds either way.
 */

const KEY = `github_pat_${'K'.repeat(72)}`;
const USERNAME = 'octocat';
const URL_EXPECTED = `https://api.github.com/users/${USERNAME}/settings/billing/ai_credit/usage`;
const NOW = Date.parse('2026-09-22T12:00:00Z');

const GOOD_BODY = JSON.stringify({
  usageItems: [
    { grossQuantity: 8, includedQuantity: 6, billedQuantity: 2 },
    { grossQuantity: 2, includedQuantity: 2, billedQuantity: 0 },
  ],
});

let root;
let previousLocalAppData;
let lines;

function beginLogCapture() {
  lines = [];
  log.setSink((level, message) => lines.push(`${level} ${message}`));
}

test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-keyed-'));
  previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  electron.state.encryptionAvailable = true;
  electron.requestLog.length = 0;
  electron.netScript.length = 0;
  electron.openedExternally.length = 0;
  electron.dialogCalls.length = 0;
  // A fresh process: no `session-created` listeners from a previous test, no
  // sessions carrying a previous test's filter or proxy mode.
  electron.resetProcess();
  secretStore._resetForTests();
  keyedNet._resetForTests();
  beginLogCapture();
});

test.afterEach(() => {
  log.setSink(null);
  if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocalAppData;
  fs.rmSync(root, { recursive: true, force: true });
});

function storeKey() {
  const result = secretStore.store({ provider: 'copilot', key: KEY, username: USERNAME, now: NOW });
  assert.equal(result.ok, true);
  return result;
}

function service(options = {}) {
  const changes = [];
  const svc = new KeyService({
    isEnabled: () => options.enabled !== false,
    onChange: () => changes.push(1),
    getLocale: () => ({ resolvedLanguage: 'tr', formatLocale: 'tr-TR' }),
    entryPage: options.entryPage || null,
  });
  svc.changes = changes;
  return svc;
}

/* ------------------------------------------------------- sessions (K22/K14a) */

test('every session created in this process is hardened (security F3, K22)', () => {
  security.applyProcessHardening();
  const sess = electron.fake.session.fromPartition('some-other-window');
  assert.notEqual(sess.webRequest.beforeRequest, null, 'a session with no filter is a session with no block');
  assert.equal(sess.decide({ url: 'https://example.com/x' }).cancel, true);
  assert.equal(sess.decide({ url: 'https://api.github.com/x' }).cancel, true);
  assert.equal(sess.decide({ url: 'file:///C:/app/index.html' }).cancel, false);
  assert.equal(sess.permissionCheckHandler(), false);
});

test('defaultSession\u2019s block-all listener is never re-registered by session-created (K14a)', () => {
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

/* ------------------------------------------------- proxy auto-discovery (F11) */

/**
 * ADR-001 Amendment 2026-09-22. What these tests can and cannot prove is the
 * whole point of writing them down:
 *
 * They prove that the control is REQUESTED — the process-global switch is
 * appended before `ready`, and every session this app creates is put on an
 * explicit DIRECT mode before it can carry a request. They CANNOT prove the
 * property. WPAD comes out of Chromium's NetworkService child, over DNS and a
 * loopback fetch that are not URLRequests, and no in-process test can see it:
 * every test in this repository passed while the packaged app was resolving
 * `wpad`. Only the OS-level audit (`scripts/zero-socket-audit.ps1`, ETW) can say
 * the traffic is gone, and it is the gate — not this file.
 */
test('proxy auto-discovery is refused process wide, before ready (ADR-001 A2026-09-22)', () => {
  electron.switches.length = 0;
  security.applyProcessHardening();
  assert.ok(electron.switches.includes('no-proxy-server'), 'the measured control must be appended');
  // A command-line switch is only honoured before `ready`, which is why it lives
  // in the function `applyAll()` calls at require time rather than in the
  // whenReady callback beside the default session's hardening.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'security.js'), 'utf8');
  const processHardening = src.slice(src.indexOf('function applyProcessHardening'));
  assert.ok(processHardening.includes("appendSwitch('no-proxy-server')"));
  const applyAll = src.slice(src.indexOf('function applyAll'));
  assert.ok(
    applyAll.indexOf('applyProcessHardening()') < applyAll.indexOf('whenReady'),
    'the switch must be appended before whenReady, not inside it',
  );
});

test('every session the app creates is put on DIRECT before it can carry a request', () => {
  security.applyProcessHardening();
  security.applySessionHardening(electron.defaultSession);
  assert.deepEqual(electron.defaultSession.proxyConfigs, [{ mode: 'direct' }]);

  // The key-entry window's session, created through `session-created`.
  const entry = electron.fake.session.fromPartition('usage-notch-key-entry');
  // The keyed session, created through the exemption — exempt from the FILTER,
  // never from the proxy mode.
  const keyed = security.createExemptSession(security.EXEMPT_PARTITION);

  for (const sess of [electron.defaultSession, entry, keyed]) {
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

test('setting the proxy mode leaves K14 and K14a exactly as they were', async () => {
  security.applyProcessHardening();
  security.applySessionHardening(electron.defaultSession);
  const blockAll = electron.defaultSession.webRequest.beforeRequest;
  storeKey();

  const keyed = keyedNet.ensureSession();
  assert.deepEqual(keyed.proxyConfigs, [{ mode: 'direct' }]);
  // The keyed session's ONE listener is still the allowlist, not the block-all.
  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  const pending = keyedNet.requestCreditUsage({
    providerId: 'copilot', readSecret: () => secretStore.open('copilot'), now: NOW,
  });
  assert.equal(keyed.decide({ url: URL_EXPECTED, method: 'GET' }).cancel, false);
  assert.equal(keyed.decide({ url: 'file:///C:/app/index.html' }).cancel, true);
  await pending;
  // And defaultSession's block-all listener is the same object it was.
  assert.equal(electron.defaultSession.webRequest.beforeRequest, blockAll);
  assert.equal(electron.defaultSession.decide({ url: 'https://api.github.com/' }).cancel, true);
});

test('a session left with no proxy mode cannot happen through this module', () => {
  // The two ways a session comes into being in this app both set the mode; a
  // session created any OTHER way is caught by `session-created`, which is
  // registered before ready.
  security.applyProcessHardening();
  const stray = electron.fake.session.fromPartition('some-future-window');
  assert.deepEqual(stray.proxyConfigs, [{ mode: 'direct' }]);
  // A session object without setProxy (an older Electron) degrades to "no mode
  // requested" rather than throwing and taking the rest of the hardening with it.
  const ancient = { webRequest: { onBeforeRequest() {}, onHeadersReceived() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  assert.doesNotThrow(() => security.applySessionHardening(ancient));
  assert.doesNotThrow(() => security.setDirectProxy(null));
});

test('only the keyed partition may skip the block-all filter (review F1)', () => {
  security.applyProcessHardening();
  // The one allowed partition is the one the request module uses, and the string
  // exists as a literal in exactly one place.
  assert.equal(security.EXEMPT_PARTITION, keyedNet.PARTITION);
  for (const partition of [
    'persist:usage-notch-keyed',
    'usage-notch-key-entry',
    'usage-notch-keyed2',
    'USAGE-NOTCH-KEYED',
    '',
    undefined,
    null,
    'anything',
  ]) {
    assert.throws(
      () => security.createExemptSession(partition),
      /only the keyed request session/,
      String(partition),
    );
  }
  // A refused call creates nothing, so there is no unfiltered session left behind.
  assert.equal(electron.createdSessions.length, 0);
  // The error names no partition: a future caller's value cannot reach a log.
  try {
    security.createExemptSession('some-window');
  } catch (err) {
    assert.equal(err.message.includes('some-window'), false);
  }
  // And the allowed one still works, and is exempt.
  const keyed = security.createExemptSession(security.EXEMPT_PARTITION);
  assert.equal(keyed.webRequest.beforeRequest, null, 'no block-all listener was installed');
});

test('a file: URL with a remote authority is cancelled on every hardened session (review F5)', () => {
  security.applyProcessHardening();
  const sess = electron.fake.session.fromPartition('usage-notch-key-entry');
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
  // A genuinely local file still loads: the entry page itself is one.
  for (const url of ['file:///C:/app/key-entry.html', 'file:///C:/app/dist/key-entry.js']) {
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

test('the keyed session carries ONE allowlist, and the default session still blocks GitHub (K14/K25)', async () => {
  security.applyProcessHardening();
  security.applySessionHardening(electron.defaultSession);
  storeKey();

  const keyed = keyedNet.ensureSession();
  assert.equal(keyed.partition, keyedNet.PARTITION);
  assert.equal(keyed.partition.startsWith('persist:'), false, 'the keyed session is in memory');
  // Not the block-all filter: the exemption in security.js kept it off, so the
  // two listeners never had to race over which was registered last.
  assert.equal(keyed.decide({ url: 'file:///C:/app/index.html' }).cancel, true);

  // Nothing in flight: everything is cancelled, including the one URL we allow.
  assert.equal(keyed.decide({ url: URL_EXPECTED, method: 'GET' }).cancel, true);

  // While the request is in flight the exact URL is allowed and nothing else is.
  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  const pending = keyedNet.requestCreditUsage({
    providerId: 'copilot',
    readSecret: () => secretStore.open('copilot'),
    now: NOW,
  });
  assert.equal(keyed.decide({ url: URL_EXPECTED, method: 'GET' }).cancel, false);
  assert.equal(keyed.decide({ url: URL_EXPECTED, method: 'POST' }).cancel, true);
  assert.equal(keyed.decide({ url: 'https://api.github.com.evil.com/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }).cancel, true);
  assert.equal(keyed.decide({ url: URL_EXPECTED, method: 'GET', webContentsId: 3 }).cancel, true);
  await pending;

  // THE F11 RESTATEMENT: a stored key opens one host on ONE session. The app's
  // global block is untouched, so the panel still cannot reach GitHub.
  assert.equal(electron.defaultSession.decide({ url: 'https://api.github.com/users/octocat/settings/billing/ai_credit/usage' }).cancel, true);
  assert.equal(electron.defaultSession.decide({ url: 'https://api.github.com/' }).cancel, true);

  // And after the request, the keyed session is closed again.
  assert.equal(keyed.decide({ url: URL_EXPECTED, method: 'GET' }).cancel, true);
});

test('no session exists until a key does (K13)', () => {
  assert.equal(electron.createdSessions.length, 0, 'requiring the module creates nothing');
  const svc = service();
  svc.load();
  assert.equal(electron.createdSessions.length, 0, 'loading with no key creates nothing');
  assert.equal(svc.polling, false, 'and no timer');
  svc.stop();
});

/* ---------------------------------------------------------- the request */

test('the one request: right session, right options, key only in Authorization (K15/K17)', async () => {
  storeKey();
  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  const result = await keyedNet.requestCreditUsage({
    providerId: 'copilot',
    readSecret: () => secretStore.open('copilot'),
    now: NOW,
  });
  assert.equal(result.keyState, 'stored');
  assert.equal(result.requests, 1);
  assert.equal(result.usage.grossCredits, 10);
  assert.equal(result.usage.includedCredits, 8);
  assert.equal(result.usage.billedCredits, 2);

  assert.equal(electron.requestLog.length, 1);
  const { options, headers } = electron.requestLog[0];
  assert.equal(options.url, URL_EXPECTED);
  assert.equal(options.method, 'GET');
  assert.equal(options.session, keyedNet.ensureSession());
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.useSessionCookies, false);
  assert.equal(options.cache, 'no-store');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers['User-Agent'], 'UsageNotch');
  assert.equal(headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(headers.Accept, 'application/vnd.github+json');
  // The key is in ONE place. Not the URL, not a query, not another header.
  assert.equal(options.url.includes(KEY), false);
  const otherHeaders = Object.entries(headers).filter(([name]) => name !== 'Authorization');
  for (const [name, value] of otherHeaders) {
    assert.equal(String(value).includes(KEY), false, name);
  }
});

test('a stubbed 3xx is unreachable, with exactly ONE request', async () => {
  storeKey();
  // What Electron produces for a redirect under `redirect:'error'`.
  electron.netScript.push({ error: { code: 'ERR_UNEXPECTED_REDIRECT', message: `redirect to https://evil.com?k=${KEY}` } });
  const asError = await keyedNet.requestCreditUsage({
    providerId: 'copilot', readSecret: () => secretStore.open('copilot'), now: NOW,
  });
  assert.equal(asError.keyState, 'unreachable');
  assert.equal(asError.requests, 1);
  assert.equal(electron.requestLog.length, 1, 'a redirect is never followed');

  // And as a raw status, in case it ever surfaces as a response.
  electron.requestLog.length = 0;
  electron.netScript.length = 0;
  electron.netScript.push({ statusCode: 302, headers: { location: 'https://evil.com/' }, body: '' });
  const asStatus = await keyedNet.requestCreditUsage({
    providerId: 'copilot', readSecret: () => secretStore.open('copilot'), now: NOW,
  });
  assert.equal(asStatus.keyState, 'unreachable');
  assert.equal(electron.requestLog.length, 1);
  // Neither the redirect target nor the error message reached the log (K19).
  const text = lines.join('\n');
  assert.equal(text.includes('evil.com'), false);
  assert.equal(text.includes(KEY), false);
});

test('a body past 256 KiB is abandoned rather than parsed', async () => {
  storeKey();
  const huge = 'x'.repeat(keyedNet.MAX_BODY_BYTES + 1);
  electron.netScript.push({ statusCode: 200, body: [huge] });
  const result = await keyedNet.requestCreditUsage({
    providerId: 'copilot', readSecret: () => secretStore.open('copilot'), now: NOW,
  });
  assert.equal(result.keyState, 'unreachable');
  assert.equal(keyedNet.MAX_BODY_BYTES, 256 * 1024);
});

test('a reply that never arrives is abandoned at the 15 second limit', async (t) => {
  storeKey();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  electron.netScript.push({ silent: true });
  const pending = keyedNet.requestCreditUsage({
    providerId: 'copilot', readSecret: () => secretStore.open('copilot'), now: NOW,
  });
  t.mock.timers.tick(keyedNet.TIMEOUT_MS);
  const result = await pending;
  assert.equal(result.keyState, 'unreachable');
  assert.equal(keyedNet.TIMEOUT_MS, 15 * 1000);
});

test('a proxy asking for credentials gets none and the request ends', async () => {
  storeKey();
  electron.netScript.push({ login: true });
  const result = await keyedNet.requestCreditUsage({
    providerId: 'copilot', readSecret: () => secretStore.open('copilot'), now: NOW,
  });
  assert.equal(result.keyState, 'unreachable');
});

test('only one request per provider can be in flight (K16)', async () => {
  storeKey();
  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  const first = keyedNet.requestCreditUsage({
    providerId: 'copilot', readSecret: () => secretStore.open('copilot'), now: NOW,
  });
  const second = await keyedNet.requestCreditUsage({
    providerId: 'copilot', readSecret: () => secretStore.open('copilot'), now: NOW,
  });
  assert.equal(second.keyState, 'busy');
  assert.equal(second.requests, 0);
  await first;
  assert.equal(electron.requestLog.length, 1);
});

test('with no key stored, nothing is sent and nothing is decrypted', async () => {
  const result = await keyedNet.requestCreditUsage({
    providerId: 'copilot', readSecret: () => secretStore.open('copilot'), now: NOW,
  });
  assert.equal(result.keyState, 'none');
  assert.equal(result.requests, 0);
  assert.equal(electron.requestLog.length, 0);
});

test('a record whose username no longer passes the shape check sends nothing', async () => {
  storeKey();
  const result = await keyedNet.requestCreditUsage({
    providerId: 'copilot',
    readSecret: () => ({ ok: true, key: KEY, username: 'not a login' }),
    now: NOW,
  });
  assert.equal(result.keyState, 'unreadable');
  assert.equal(electron.requestLog.length, 0);
});

/* ------------------------------------------------------------ the service */

test('a 200 fills the snapshot fields; a 401 stops polling for good (K16)', async () => {
  storeKey();
  const svc = service();
  svc.load();
  assert.equal(svc.polling, true, 'a stored key on an enabled provider is polled');

  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  assert.equal(await svc.poll(NOW), 1);
  let input = svc.snapshotInput(NOW);
  assert.equal(input.copilot.keyState, 'stored');
  assert.equal(input.copilot.keyStoredAt, '2026-09-22T12:00:00.000Z');
  assert.deepEqual(Object.keys(input.copilot.creditUsage).sort(), [
    'billedCredits', 'fetchedAt', 'grossCredits', 'includedCredits', 'periodEnd', 'periodStart',
  ]);

  // Inside the floor, a thousand refreshes make no further request.
  electron.requestLog.length = 0;
  for (let i = 0; i < 1000; i += 1) await svc.poll(NOW + i);
  assert.equal(electron.requestLog.length, 0);

  // A 401 at the next slot stops it, and 48 hours of asking changes nothing.
  electron.netScript.length = 0;
  electron.netScript.push({ statusCode: 401, body: '{"message":"Bad credentials"}' });
  const at = NOW + 16 * 60 * 1000;
  assert.equal(await svc.poll(at), 1);
  input = svc.snapshotInput(at);
  assert.equal(input.copilot.keyState, 'key-rejected');
  electron.requestLog.length = 0;
  for (let i = 0; i < 1000; i += 1) await svc.poll(at + Math.round((48 * 3600 * 1000 * i) / 1000));
  assert.equal(electron.requestLog.length, 0, 'a rejected key is never retried');
  // The provider's own words never reach the state.
  assert.equal(JSON.stringify(input).includes('Bad credentials'), false);
  svc.stop();
});

test('a key echoed in the reply body and headers never reaches a log, the snapshot or IPC', async () => {
  storeKey();
  const svc = service();
  svc.load();
  electron.netScript.push({
    statusCode: 200,
    headers: { 'x-echo': KEY, 'set-cookie': `token=${KEY}` },
    body: JSON.stringify({ usageItems: [{ grossQuantity: 1, includedQuantity: 1, billedQuantity: 0 }], echo: KEY }),
  });
  await svc.poll(NOW);

  const input = svc.snapshotInput(NOW);
  assert.equal(JSON.stringify(input).includes(KEY), false, 'the snapshot fields');
  assert.equal(JSON.stringify(input).includes('x-echo'), false);
  assert.equal(lines.join('\n').includes(KEY), false, 'the log');

  // …and every IPC reply the panel can obtain carries nothing either: the key
  // channels answer {ok} only, and there is no getter at all (K3).
  const ipcMain = electron.fake.ipcMain;
  const panelEvent = { sender: 'panel' };
  svc.registerIpc(ipcMain, (event) => event === panelEvent);
  const replies = [
    await ipcMain.invoke(IPC.KEY_REMOVE, panelEvent, 'copilot'),
    await ipcMain.invoke(IPC.KEY_TOKEN_PAGE, panelEvent, 'copilot'),
  ];
  for (const reply of replies) {
    assert.deepEqual(Object.keys(reply), ['ok']);
    assert.equal(JSON.stringify(reply).includes(KEY), false);
  }
  svc.stop();
});

test('the IPC surface answers {ok} and nothing else, and only to the panel (K3)', async () => {
  storeKey();
  const svc = service({ entryPage: __filename });
  svc.load();
  const ipcMain = electron.fake.ipcMain;
  const panelEvent = { sender: 'panel' };
  svc.registerIpc(ipcMain, (event) => event === panelEvent);

  // From anything that is not our panel: refused, and no window opens.
  const before = electron.windows.length;
  assert.deepEqual(await ipcMain.invoke(IPC.KEY_ENTRY, { sender: 'stranger' }, 'copilot'), { ok: false });
  assert.equal(electron.windows.length, before);
  // From the panel, the key window opens: the answer is {ok} and nothing more.
  const entry = await ipcMain.invoke(IPC.KEY_ENTRY, panelEvent, 'copilot');
  assert.deepEqual(entry, { ok: true });
  assert.equal(electron.windows.length, before + 1);
  assert.deepEqual(await ipcMain.invoke(IPC.KEY_ENTRY, panelEvent, 'gemini'), { ok: false });
  assert.deepEqual(await ipcMain.invoke(IPC.KEY_TOKEN_PAGE, { sender: 'stranger' }), { ok: false });
  assert.deepEqual(await ipcMain.invoke(IPC.KEY_REMOVE, { sender: 'stranger' }, 'copilot'), { ok: false });
  assert.equal(secretStore.read('copilot').state, 'stored', 'a stranger cannot delete the key either');

  // The panel's token-page button opens the one hard-coded URL.
  assert.deepEqual(await ipcMain.invoke(IPC.KEY_TOKEN_PAGE, panelEvent, 'copilot'), { ok: true });
  assert.deepEqual(electron.openedExternally, ['https://github.com/settings/personal-access-tokens/new']);
  // A provider that is not key-capable is refused, and opens nothing.
  assert.deepEqual(await ipcMain.invoke(IPC.KEY_TOKEN_PAGE, panelEvent, 'gemini'), { ok: false });
  assert.equal(electron.openedExternally.length, 1);

  // The entry window's channels refuse a panel sender outright.
  assert.deepEqual(await ipcMain.invoke(IPC_KEY_ENTRY.SUBMIT, panelEvent, KEY, USERNAME), { ok: false, code: 'rejected' });
  assert.equal(ipcMain.send(IPC_KEY_ENTRY.ENTRY_INFO, { sender: 'panel', returnValue: undefined }), null);
  // Nor can the panel press Continue for the user (Amendment 9).
  assert.deepEqual(await ipcMain.invoke(IPC_KEY_ENTRY.CONSENT, panelEvent), { ok: false, code: 'rejected' });
  svc.entry.destroy('test-teardown');
  svc.stop();
});

test('declining consent through the real IPC path writes no file and starts nothing (K1)', async () => {
  const svc = service({ entryPage: __filename });
  svc.load();
  const ipcMain = electron.fake.ipcMain;
  const panelEvent = { sender: 'panel' };
  svc.registerIpc(ipcMain, (event) => event === panelEvent);

  assert.deepEqual(await ipcMain.invoke(IPC.KEY_ENTRY, panelEvent, 'copilot'), { ok: true });
  const win = electron.windows[electron.windows.length - 1];
  // Cancel on the consent screen, sent by the key window itself.
  ipcMain.send(IPC_KEY_ENTRY.CANCEL, { sender: win.webContents, senderFrame: win.webContents.mainFrame });
  assert.equal(win.isDestroyed(), true);
  assert.equal(electron.dialogCalls.length, 0, 'no OS message box any more');
  assert.equal(fs.existsSync(path.join(root, 'UsageNotch', 'secrets')), false, 'no directory, let alone a file');
  assert.ok(electron.createdSessions.every((s) => !s.partition.startsWith('persist:')), 'only in-memory sessions');
  assert.equal(svc.polling, false, 'no timer');
  assert.equal(svc.snapshotInput(NOW).copilot.keyState, 'none');
  svc.stop();
});

test('with DPAPI unavailable the row says so, and nothing is written (K7)', async () => {
  electron.state.encryptionAvailable = false;
  const svc = service({ entryPage: __filename });
  svc.load();
  const ipcMain = electron.fake.ipcMain;
  const panelEvent = { sender: 'panel' };
  svc.registerIpc(ipcMain, (event) => event === panelEvent);

  assert.deepEqual(await ipcMain.invoke(IPC.KEY_ENTRY, panelEvent, 'copilot'), { ok: false });
  assert.equal(electron.dialogCalls.length, 0, 'no consent is asked for a store that cannot happen');
  assert.equal(svc.snapshotInput(NOW).copilot.keyState, 'secure-storage-unavailable');
  assert.equal(fs.existsSync(path.join(root, 'UsageNotch', 'secrets')), false);
  svc.stop();
});

test('removal deletes the file, cancels the timer, aborts the socket and drops the figure (K20)', async () => {
  storeKey();
  const svc = service();
  svc.load();
  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  await svc.poll(NOW);
  assert.ok(svc.snapshotInput(NOW).copilot.creditUsage, 'there is a figure to drop');
  assert.equal(svc.polling, true);
  const keyed = keyedNet.ensureSession();
  const closedBefore = keyed.closedConnections;
  const authBefore = keyed.clearedAuthCache;

  assert.deepEqual(svc.removeKey('copilot'), { ok: true });

  assert.equal(fs.existsSync(path.join(root, 'UsageNotch', 'secrets', 'copilot.json')), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'UsageNotch', 'secrets')), []);
  assert.equal(svc.polling, false, 'no timer survives the removal');
  assert.equal(keyed.closedConnections, closedBefore + 1);
  assert.equal(keyed.clearedAuthCache, authBefore + 1);
  const input = svc.snapshotInput(NOW);
  assert.equal(input.copilot.keyState, 'none');
  assert.equal(input.copilot.keyStoredAt, null);
  assert.equal(input.copilot.creditUsage, null);

  // And a request after removal sends nothing at all.
  electron.requestLog.length = 0;
  assert.equal(await svc.poll(NOW + 60 * 60 * 1000), 0);
  assert.equal(electron.requestLog.length, 0);
  svc.stop();
});

test('removing a key while a request is in flight aborts it and leaves nothing wedged (K20)', async () => {
  storeKey();
  const svc = service();
  svc.load();
  // A reply that never comes: the request is still open when the user removes.
  electron.netScript.push({ silent: true });
  const pending = svc.poll(NOW);
  // The poll awaits the request, so the abort has to be what ends it.
  await new Promise((resolve) => process.nextTick(resolve));
  assert.equal(keyedNet.isInFlight(), true);

  svc.removeKey('copilot');
  await pending;
  assert.equal(keyedNet.isInFlight(), false, 'nothing is left in flight');
  assert.equal(svc.snapshotInput(NOW).copilot.keyState, 'none', 'and the removal is not overwritten by the abort');

  // The next request is possible: `inFlight` was not left set for ever.
  storeKey();
  svc.load();
  electron.netScript.length = 0;
  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  assert.equal(await svc.poll(NOW + 60 * 60 * 1000), 1);
  svc.stop();
});

test('polling stops while the provider is disabled, and resumes when it is re-enabled', async () => {
  storeKey();
  let enabled = false;
  const svc = new KeyService({
    isEnabled: () => enabled,
    onChange: () => {},
    getLocale: () => ({ resolvedLanguage: 'tr', formatLocale: 'tr-TR' }),
  });
  svc.load();
  assert.equal(svc.polling, false);
  assert.equal(await svc.poll(NOW), 0);
  assert.equal(electron.requestLog.length, 0);

  enabled = true;
  svc.enablementChanged();
  assert.equal(svc.polling, true);
  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  assert.equal(await svc.poll(NOW), 1);
  svc.stop();
  assert.equal(svc.polling, false);
});

test('a figure whose month has ended is dropped, however fresh the reading was', async () => {
  storeKey();
  const svc = service();
  svc.load();
  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  await svc.poll(NOW);
  assert.ok(svc.snapshotInput(NOW).copilot.creditUsage);
  // 1 October, 00:00 UTC: the September figure is now provably about a dead
  // period (ADR-001 A2 state 3, unconditional).
  assert.equal(svc.snapshotInput(Date.parse('2026-10-01T00:00:00Z')).copilot.creditUsage, null);
  svc.stop();
});

test('a rate limit honours Retry-After inside the clamp and makes no request before it', async () => {
  storeKey();
  const svc = service();
  svc.load();
  electron.netScript.push({ statusCode: 429, headers: { 'retry-after': '3600' }, body: '' });
  assert.equal(await svc.poll(NOW), 1);
  assert.equal(svc.snapshotInput(NOW).copilot.keyState, 'rate-limited');
  electron.requestLog.length = 0;
  electron.netScript.length = 0;
  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  assert.equal(await svc.poll(NOW + 59 * 60 * 1000), 0);
  assert.equal(await svc.poll(NOW + 61 * 60 * 1000), 1);
  svc.stop();
});

test('a 200 we cannot validate produces no figure and says not-available', async () => {
  storeKey();
  const svc = service();
  svc.load();
  electron.netScript.push({ statusCode: 200, body: '{"usageItems":[{"credits":12}]}' });
  await svc.poll(NOW);
  const input = svc.snapshotInput(NOW);
  assert.equal(input.copilot.keyState, 'not-available');
  assert.equal(input.copilot.creditUsage, null);

  electron.netScript.length = 0;
  electron.netScript.push({ statusCode: 200, body: 'not json at all' });
  await svc.poll(NOW + 20 * 60 * 1000);
  assert.equal(svc.snapshotInput(NOW).copilot.keyState, 'not-available');
  svc.stop();
});

test('GitHub’s primary rate limit is a 403 with no Retry-After, and is not a permission problem (review F2)', async () => {
  storeKey();
  const svc = service();
  svc.load();
  electron.netScript.push({
    statusCode: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000' },
    body: '{"message":"API rate limit exceeded for user ID 1."}',
  });
  await svc.poll(NOW);
  assert.equal(svc.snapshotInput(NOW).copilot.keyState, 'rate-limited');
  // A rate limit waits; it does not tell the user to go and fix a scope.
  electron.requestLog.length = 0;
  electron.netScript.length = 0;
  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  assert.equal(await svc.poll(NOW + 60 * 1000), 0);
  assert.equal(await svc.poll(NOW + 16 * 60 * 1000), 1);
  assert.equal(lines.join('\n').includes('rate limit exceeded'), false);
  svc.stop();
});

test('403 is a permission problem, 404 is "no such figure"', async () => {
  storeKey();
  const svc = service();
  svc.load();
  electron.netScript.push({ statusCode: 403, body: '{"message":"Resource not accessible by personal access token"}' });
  await svc.poll(NOW);
  assert.equal(svc.snapshotInput(NOW).copilot.keyState, 'key-lacks-permission');
  electron.netScript.length = 0;
  electron.netScript.push({ statusCode: 404, body: '{"message":"Not Found"}' });
  await svc.poll(NOW + 20 * 60 * 1000);
  assert.equal(svc.snapshotInput(NOW).copilot.keyState, 'not-available');
  assert.equal(lines.join('\n').includes('Not Found'), false);
  assert.equal(lines.join('\n').includes('personal access token'), false);
  svc.stop();
});

test('the 15-minute floor survives a restart (K16)', async () => {
  storeKey();
  const first = service();
  first.load();
  electron.netScript.push({ statusCode: 200, body: GOOD_BODY });
  assert.equal(await first.poll(NOW), 1);
  first.stop();

  // A new process, the same disk.
  electron.requestLog.length = 0;
  const second = service();
  second.load();
  assert.equal(await second.poll(NOW + 60 * 1000), 0, 'quitting and reopening buys no request');
  assert.equal(await second.poll(NOW + 16 * 60 * 1000), 1);
  second.stop();
});

test.after(() => electron.restore());
