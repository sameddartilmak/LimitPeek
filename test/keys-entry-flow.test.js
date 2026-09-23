'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fakeElectron = require('./helpers/fake-keys-electron');

const electron = fakeElectron.install();
const log = require('../src/core/log');
const { EntryFlow, ENTRY_PARTITION, ENTRY_TTL_MS } = require('../src/main/keys/entry-window');

log.setTrace(false);

/**
 * Consent and the entry window (ADR-003 Amendment 5, K1-K4).
 *
 * The ORDER is what is under test here, not the pixels. Amendment 5 requires
 * that declining writes nothing and starts nothing, that one flow can be open at
 * a time, that a submit is accepted only from the entry window's own main frame
 * against a one-shot pending entry, and that the window cannot outlive five
 * minutes. Every one of those is an ordering property, and ordering is where this
 * class of bug lives.
 */

const KEY = `github_pat_${'Q'.repeat(64)}`;
const USERNAME = 'octocat';

let page;
let stored;
let flow;

function makeFlow(options = {}) {
  stored = [];
  return new EntryFlow({
    onSubmit: (args) => {
      stored.push(args);
      return options.storeResult || { ok: true };
    },
    isSecureStorageAvailable: () => options.available !== false,
    getLocale: () => options.locale || { resolvedLanguage: 'en', formatLocale: 'en-GB' },
    openTokenPage: (id) => { (options.tokenPages || []).push(id); return { ok: true }; },
    entryPage: options.page === undefined ? page : options.page,
    // The catalogs are the frontend lane's; the flow only has to ASK for the
    // right keys, which the returned key string makes visible.
    t: (key) => key,
  });
}

/** The IPC event the entry window's page would produce. */
function eventFrom(win) {
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
}

test.before(() => {
  page = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-entry-')), 'key-entry.html');
  fs.writeFileSync(page, '<!doctype html><html><body></body></html>');
});

test.beforeEach(() => {
  electron.windows.length = 0;
  electron.createdSessions.length = 0;
  electron.dialogCalls.length = 0;
  electron.dialogAnswers.length = 0;
  electron.openedExternally.length = 0;
});

test.afterEach(() => {
  if (flow) flow.destroy('test-teardown');
  flow = null;
});

test('declining consent writes nothing, creates no session and starts no timer (K1)', async () => {
  flow = makeFlow();
  electron.dialogAnswers.push(0);
  const result = await flow.start({ providerId: 'copilot', now: 1000 });
  assert.deepEqual(result, { ok: false, code: 'declined' });
  assert.equal(electron.dialogCalls.length, 1);
  assert.equal(electron.windows.length, 0, 'no window');
  assert.equal(electron.createdSessions.length, 0, 'no session');
  assert.equal(flow.busy, false, 'no flow is left open');
  assert.equal(stored.length, 0, 'nothing was stored');
  // And a submit afterwards has nothing to attach to.
  assert.deepEqual(flow.submit({}, KEY, USERNAME, 1000), { ok: false, code: 'rejected' });
});

test('fifty parallel requests raise exactly ONE dialog (K1)', async () => {
  flow = makeFlow();
  electron.dialogAnswers.push(0);
  const results = await Promise.all(
    Array.from({ length: 50 }, () => flow.start({ providerId: 'copilot', now: 1000 })),
  );
  assert.equal(electron.dialogCalls.length, 1);
  assert.equal(results.filter((r) => r.code === 'busy').length, 49);
  assert.equal(results.filter((r) => r.code === 'declined').length, 1);
});

test('the consent dialog states what ADR-003 requires it to state', async () => {
  flow = makeFlow();
  electron.dialogAnswers.push(0);
  await flow.start({ providerId: 'copilot', now: 1000 });
  const { config } = electron.dialogCalls[0];
  assert.equal(config.type, 'question');
  // Cancel is the DEFAULT answer: consent must be taken, never slipped past.
  assert.equal(config.defaultId, 0);
  assert.equal(config.cancelId, 0);
  assert.equal(config.noLink, true);
  assert.deepEqual(config.buttons, ['dialog.cancel', 'dialog.keys.consent.confirm']);
  for (const key of [
    'dialog.keys.consent.what',
    'dialog.keys.consent.host',
    'dialog.keys.consent.storage',
    'dialog.keys.consent.selfPaid',
    'dialog.keys.consent.remove',
  ]) {
    assert.ok(config.detail.includes(key), `the detail must carry ${key}`);
  }
});

test('an accepted consent opens one hardened, content-protected window on its own session (K2)', async () => {
  flow = makeFlow();
  electron.dialogAnswers.push(1);
  const result = await flow.start({ providerId: 'copilot', now: 1000 });
  assert.deepEqual(result, { ok: true });

  assert.equal(electron.createdSessions.length, 1);
  assert.equal(electron.createdSessions[0].partition, ENTRY_PARTITION);
  // NOT `persist:`-prefixed: in memory, gone with the process.
  assert.equal(ENTRY_PARTITION.startsWith('persist:'), false);

  assert.equal(electron.windows.length, 1);
  const win = electron.windows[0];
  assert.equal(win.contentProtection, true);
  assert.deepEqual(win.loadedFiles, [page]);
  const wp = win.options.webPreferences;
  assert.equal(wp.sandbox, true);
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.nodeIntegrationInSubFrames, false);
  assert.equal(wp.webviewTag, false);
  assert.equal(wp.webSecurity, true);
  assert.equal(wp.session, electron.createdSessions[0]);
  assert.ok(wp.preload.endsWith(path.join('keys', 'entry-preload.js')));
});

test('devTools are off in a packaged build and on in a dev run', async () => {
  electron.state.isPackaged = true;
  flow = makeFlow();
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  assert.equal(electron.windows[0].options.webPreferences.devTools, false);
  flow.destroy('done');
  electron.state.isPackaged = false;

  electron.windows.length = 0;
  flow = makeFlow();
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  assert.equal(electron.windows[0].options.webPreferences.devTools, true);
});

test('a submit from the PANEL is rejected, and stores nothing (K4)', async () => {
  flow = makeFlow();
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  const entryWin = electron.windows[0];

  // Another window in the same process, i.e. the panel.
  const panel = new electron.fake.BrowserWindow({});
  assert.deepEqual(flow.submit(eventFrom(panel), KEY, USERNAME, 1000), { ok: false, code: 'rejected' });
  // A message claiming our sender but a foreign frame.
  assert.deepEqual(
    flow.submit({ sender: entryWin.webContents, senderFrame: { routingId: 99 } }, KEY, USERNAME, 1000),
    { ok: false, code: 'rejected' },
  );
  // No sender at all.
  assert.deepEqual(flow.submit({}, KEY, USERNAME, 1000), { ok: false, code: 'rejected' });
  assert.deepEqual(flow.submit(null, KEY, USERNAME, 1000), { ok: false, code: 'rejected' });
  assert.equal(stored.length, 0);
  assert.equal(entryWin.isDestroyed(), false, 'a refused submit does not close the window');
});

test('a submit is one-shot: the replay after a successful store is rejected (K4)', async () => {
  flow = makeFlow();
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  const win = electron.windows[0];
  const event = eventFrom(win);

  assert.deepEqual(flow.submit(event, KEY, USERNAME, 1000), { ok: true });
  assert.deepEqual(stored, [{ provider: 'copilot', key: KEY, username: USERNAME }]);
  assert.equal(win.isDestroyed(), true, 'the window is destroyed on submit');
  assert.equal(flow.busy, false);

  // The replay: same event, same values.
  assert.deepEqual(flow.submit(event, KEY, USERNAME, 1000), { ok: false, code: 'rejected' });
  assert.equal(stored.length, 1);
});

test('a submit past the five-minute expiry is refused and ends the flow (K2/K4)', async () => {
  flow = makeFlow();
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  const win = electron.windows[0];
  const event = eventFrom(win);

  assert.deepEqual(flow.submit(event, KEY, USERNAME, 1000 + ENTRY_TTL_MS + 1), { ok: false, code: 'expired' });
  assert.equal(stored.length, 0);
  assert.equal(win.isDestroyed(), true);
  assert.equal(flow.busy, false);
  assert.equal(ENTRY_TTL_MS, 5 * 60 * 1000);
});

test('a second submit while one is in flight is refused', async () => {
  let reentrant = null;
  flow = new EntryFlow({
    onSubmit: (args) => {
      // Re-enters the way a second IPC message would if main were re-entrant.
      reentrant = flow.submit(eventFrom(electron.windows[0]), KEY, USERNAME, 1000);
      return { ok: true, echoed: args.provider };
    },
    isSecureStorageAvailable: () => true,
    getLocale: () => ({ resolvedLanguage: 'tr', formatLocale: 'tr-TR' }),
    entryPage: page,
    t: (key) => key,
  });
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  assert.deepEqual(flow.submit(eventFrom(electron.windows[0]), KEY, USERNAME, 1000), { ok: true });
  assert.deepEqual(reentrant, { ok: false, code: 'busy' });
});

test('a failed store keeps the pending entry alive so the user can correct it', async () => {
  flow = makeFlow({ storeResult: { ok: false, code: 'store-failed' } });
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  const event = eventFrom(electron.windows[0]);
  assert.deepEqual(flow.submit(event, KEY, USERNAME, 1000), { ok: false, code: 'store-failed' });
  assert.equal(electron.windows[0].isDestroyed(), false);
  // The same pending entry is still there, so a retry is possible.
  assert.deepEqual(flow.submit(event, KEY, USERNAME, 1000), { ok: false, code: 'store-failed' });
  assert.equal(stored.length, 2);
});

test('an invalid key or username never reaches the store, and the code is fixed (K5)', async () => {
  flow = makeFlow();
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  const event = eventFrom(electron.windows[0]);
  assert.deepEqual(flow.submit(event, 'ghp_' + 'x'.repeat(40), USERNAME, 1000), { ok: false, code: 'wrong-token-type' });
  assert.deepEqual(flow.submit(event, 'sk-' + 'x'.repeat(40), USERNAME, 1000), { ok: false, code: 'wrong-provider' });
  assert.deepEqual(flow.submit(event, 'nonsense', USERNAME, 1000), { ok: false, code: 'invalid' });
  assert.deepEqual(flow.submit(event, KEY, 'not a login', 1000), { ok: false, code: 'invalid-username' });
  assert.deepEqual(flow.submit(event, KEY, '', 1000), { ok: false, code: 'invalid-username' });
  assert.equal(stored.length, 0);
  // The window stays open: the page prints the sentence and the user retries.
  assert.equal(electron.windows[0].isDestroyed(), false);
});

test('cancel closes the window and changes nothing; a foreign cancel is ignored', async () => {
  flow = makeFlow();
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  const win = electron.windows[0];
  const panel = new electron.fake.BrowserWindow({});
  assert.deepEqual(flow.cancel(eventFrom(panel)), { ok: false });
  assert.equal(win.isDestroyed(), false);
  assert.deepEqual(flow.cancel(eventFrom(win)), { ok: true });
  assert.equal(win.isDestroyed(), true);
  assert.equal(stored.length, 0);
  assert.equal(flow.busy, false);
});

test('entryInfo carries the provider and the resolved language, and nothing else', async () => {
  flow = makeFlow({ locale: { resolvedLanguage: 'en', formatLocale: 'en-GB' } });
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  const info = flow.entryInfo(eventFrom(electron.windows[0]));
  assert.deepEqual(info, { provider: 'copilot', language: 'en', formatLocale: 'en-GB' });
  // No getter: nothing on this surface says anything about a stored key.
  assert.equal(JSON.stringify(info).includes('github_pat'), false);
  const panel = new electron.fake.BrowserWindow({});
  assert.equal(flow.entryInfo(eventFrom(panel)), null);
  assert.equal(flow.entryInfo({}), null);
});

test('the page’s token-page button opens the flow’s own provider, with no argument (A8 addendum)', async () => {
  const tokenPages = [];
  flow = makeFlow({ tokenPages });
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  assert.deepEqual(flow.openTokenPage(eventFrom(electron.windows[0])), { ok: true });
  assert.deepEqual(tokenPages, ['copilot']);
  const panel = new electron.fake.BrowserWindow({});
  assert.deepEqual(flow.openTokenPage(eventFrom(panel)), { ok: false });
  assert.deepEqual(tokenPages, ['copilot']);
});

test('with DPAPI unavailable there is no consent dialog at all (K7)', async () => {
  flow = makeFlow({ available: false });
  const result = await flow.start({ providerId: 'copilot', now: 1000 });
  assert.deepEqual(result, { ok: false, code: 'secure-storage-unavailable' });
  assert.equal(electron.dialogCalls.length, 0);
  assert.equal(electron.windows.length, 0);
  assert.equal(flow.busy, false);
});

test('a provider that is not key-capable never raises a dialog (K24)', async () => {
  flow = makeFlow();
  for (const id of ['gemini', 'kimi', 'claude', '', null, '__proto__']) {
    assert.deepEqual(await flow.start({ providerId: id, now: 1000 }), { ok: false, code: 'unknown-provider' });
  }
  assert.equal(electron.dialogCalls.length, 0);
});

test('a missing entry page refuses the flow rather than improvising a page', async () => {
  flow = makeFlow({ page: path.join(os.tmpdir(), 'usage-notch-no-such-page.html') });
  const result = await flow.start({ providerId: 'copilot', now: 1000 });
  assert.deepEqual(result, { ok: false, code: 'entry-unavailable' });
  assert.equal(electron.dialogCalls.length, 0);
  assert.equal(electron.windows.length, 0);
});

test('the OS close button ends the flow exactly as cancel does', async () => {
  flow = makeFlow();
  electron.dialogAnswers.push(1);
  await flow.start({ providerId: 'copilot', now: 1000 });
  electron.windows[0].emit('closed');
  assert.equal(flow.busy, false);
  assert.equal(stored.length, 0);
});

test.after(() => electron.restore());
