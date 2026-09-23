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
 * Consent and the entry window (ADR-003 Amendment 5, K1-K4; Amendment 9).
 *
 * The ORDER is what is under test here, not the pixels. Amendment 5 requires
 * that declining writes nothing and starts nothing, that one flow can be open at
 * a time, that a submit is accepted only from the entry window's own main frame
 * against a one-shot pending entry, and that the window cannot outlive five
 * minutes without consent or ten with it. Every one of those is an ordering
 * property, and ordering is where this class of bug lives.
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
  });
}

/** The IPC event the entry window's page would produce. */
function eventFrom(win) {
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
}

/** Opens the window and presses Continue, as the user would. */
async function openAndConsent(f, now = 1000) {
  const result = await f.start({ providerId: 'copilot' });
  const win = electron.windows[electron.windows.length - 1];
  if (result.ok) f.consent(eventFrom(win), now);
  return result;
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

test('the window opens with no native dialog, and takes no key before Continue (A9, K4)', async () => {
  flow = makeFlow();
  const result = await flow.start({ providerId: 'copilot' });
  assert.deepEqual(result, { ok: true });
  assert.equal(electron.dialogCalls.length, 0, 'no OS message box any more');
  assert.equal(electron.windows.length, 1);
  const event = eventFrom(electron.windows[0]);
  // The consent screen is showing: nothing can be stored or opened yet.
  assert.deepEqual(flow.submit(event, KEY, USERNAME, 1000), { ok: false, code: 'no-entry' });
  assert.deepEqual(flow.openTokenPage(event), { ok: false });
  assert.equal(stored.length, 0);
  assert.equal(electron.windows[0].isDestroyed(), false);
});

test('declining on the consent screen writes nothing and leaves nothing running (K1)', async () => {
  flow = makeFlow();
  await flow.start({ providerId: 'copilot' });
  const win = electron.windows[0];
  assert.deepEqual(flow.cancel(eventFrom(win)), { ok: true });
  assert.equal(win.isDestroyed(), true, 'the window is gone');
  assert.equal(flow.busy, false, 'no flow is left open');
  assert.equal(stored.length, 0, 'nothing was stored');
  // What remains is the in-memory session, which dies with the process.
  assert.equal(win.options.webPreferences.session.partition, ENTRY_PARTITION);
  assert.equal(ENTRY_PARTITION.startsWith('persist:'), false);
  // And a submit afterwards has nothing to attach to.
  assert.deepEqual(flow.submit(eventFrom(win), KEY, USERNAME, 1000), { ok: false, code: 'rejected' });
});

test('fifty parallel requests open exactly ONE window (K1)', async () => {
  flow = makeFlow();
  const results = await Promise.all(
    Array.from({ length: 50 }, () => flow.start({ providerId: 'copilot' })),
  );
  assert.equal(electron.windows.length, 1);
  assert.equal(results.filter((r) => r.code === 'busy').length, 49);
  assert.equal(results.filter((r) => r.ok === true).length, 1);
});

test('Continue is accepted only from the entry window, and a second one adds no time (A9, K4)', async () => {
  flow = makeFlow();
  await flow.start({ providerId: 'copilot' });
  const win = electron.windows[0];
  const panel = new electron.fake.BrowserWindow({});
  // The panel cannot consent for the user, and neither can a foreign frame.
  assert.deepEqual(flow.consent(eventFrom(panel), 1000), { ok: false, code: 'rejected' });
  assert.deepEqual(flow.consent({ sender: win.webContents, senderFrame: { routingId: 99 } }, 1000), { ok: false, code: 'rejected' });
  assert.deepEqual(flow.consent(null, 1000), { ok: false, code: 'rejected' });
  assert.deepEqual(flow.submit(eventFrom(win), KEY, USERNAME, 1000), { ok: false, code: 'no-entry' });

  const event = eventFrom(win);
  assert.deepEqual(flow.consent(event, 1000), { ok: true });
  // A double click: answered ok, and the five minutes still run from the first.
  assert.deepEqual(flow.consent(event, 200000), { ok: true });
  assert.deepEqual(flow.submit(event, KEY, USERNAME, 1000 + ENTRY_TTL_MS + 1), { ok: false, code: 'expired' });
  assert.equal(stored.length, 0);
});

test('a message whose sending frame is gone is refused (K4)', async () => {
  flow = makeFlow();
  await flow.start({ providerId: 'copilot' });
  const win = electron.windows[0];
  assert.deepEqual(flow.consent({ sender: win.webContents, senderFrame: null }, 1000), { ok: false, code: 'rejected' });
  assert.deepEqual(flow.consent({ sender: win.webContents }, 1000), { ok: false, code: 'rejected' });
  flow.consent(eventFrom(win), 1000);
  assert.deepEqual(flow.submit({ sender: win.webContents, senderFrame: null }, KEY, USERNAME, 1000), { ok: false, code: 'rejected' });
  assert.equal(stored.length, 0);
});

test('the window closes five minutes after opening without consent, and ten at most with it (K2)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const MIN = 60 * 1000;

  // No consent: gone at five minutes.
  flow = makeFlow();
  await flow.start({ providerId: 'copilot' });
  const first = electron.windows[0];
  t.mock.timers.tick(5 * MIN - 1);
  assert.equal(first.isDestroyed(), false);
  t.mock.timers.tick(1);
  assert.equal(first.isDestroyed(), true);
  assert.equal(flow.busy, false);

  // Consent at four minutes restarts the clock once; a second Continue does not.
  await flow.start({ providerId: 'copilot' });
  const second = electron.windows[electron.windows.length - 1];
  t.mock.timers.tick(4 * MIN);
  assert.deepEqual(flow.consent(eventFrom(second), 4 * MIN), { ok: true });
  t.mock.timers.tick(4 * MIN);
  assert.deepEqual(flow.consent(eventFrom(second), 8 * MIN), { ok: true });
  t.mock.timers.tick(1 * MIN - 1);
  assert.equal(second.isDestroyed(), false, 'still open just under nine minutes');
  t.mock.timers.tick(1);
  assert.equal(second.isDestroyed(), true, 'closed five minutes after the FIRST consent');
  assert.equal(flow.busy, false);
});

test('the window has no Windows title bar, and its caption buttons match the page (A9)', async () => {
  flow = makeFlow();
  await flow.start({ providerId: 'copilot' });
  const { options } = electron.windows[0];
  assert.equal(options.titleBarStyle, 'hidden');
  // The overlay's ground is the page's own --ink-900 (dark theme), or a seam shows.
  const tokens = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');
  const ink900 = tokens.match(/--ink-900:\s*(#[0-9A-Fa-f]{6})/)[1];
  assert.equal(options.titleBarOverlay.color.toLowerCase(), ink900.toLowerCase());
  assert.equal(options.backgroundColor.toLowerCase(), ink900.toLowerCase());
  assert.equal(options.titleBarOverlay.height, 32);
});

test('an accepted consent runs in one hardened, content-protected window on its own session (K2)', async () => {
  flow = makeFlow();
  const result = await openAndConsent(flow);
  assert.deepEqual(result, { ok: true });

  assert.equal(electron.windows.length, 1);
  const win = electron.windows[0];
  // Its own partition, NOT `persist:`-prefixed: in memory, gone with the process.
  assert.equal(win.options.webPreferences.session.partition, ENTRY_PARTITION);
  assert.equal(ENTRY_PARTITION.startsWith('persist:'), false);
  assert.equal(win.contentProtection, true);
  assert.deepEqual(win.loadedFiles, [page]);
  const wp = win.options.webPreferences;
  assert.equal(wp.sandbox, true);
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.nodeIntegrationInSubFrames, false);
  assert.equal(wp.webviewTag, false);
  assert.equal(wp.webSecurity, true);
  assert.ok(wp.preload.endsWith(path.join('keys', 'entry-preload.js')));
});

test('devTools are off in a packaged build and on in a dev run', async () => {
  electron.state.isPackaged = true;
  flow = makeFlow();
  await openAndConsent(flow);
  assert.equal(electron.windows[0].options.webPreferences.devTools, false);
  flow.destroy('done');
  electron.state.isPackaged = false;

  electron.windows.length = 0;
  flow = makeFlow();
  await openAndConsent(flow);
  assert.equal(electron.windows[0].options.webPreferences.devTools, true);
});

test('a submit from the PANEL is rejected, and stores nothing (K4)', async () => {
  flow = makeFlow();
  await openAndConsent(flow);
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
  await openAndConsent(flow);
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
  await openAndConsent(flow);
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
  });
  await openAndConsent(flow);
  assert.deepEqual(flow.submit(eventFrom(electron.windows[0]), KEY, USERNAME, 1000), { ok: true });
  assert.deepEqual(reentrant, { ok: false, code: 'busy' });
});

test('a failed store keeps the pending entry alive so the user can correct it', async () => {
  flow = makeFlow({ storeResult: { ok: false, code: 'store-failed' } });
  await openAndConsent(flow);
  const event = eventFrom(electron.windows[0]);
  assert.deepEqual(flow.submit(event, KEY, USERNAME, 1000), { ok: false, code: 'store-failed' });
  assert.equal(electron.windows[0].isDestroyed(), false);
  // The same pending entry is still there, so a retry is possible.
  assert.deepEqual(flow.submit(event, KEY, USERNAME, 1000), { ok: false, code: 'store-failed' });
  assert.equal(stored.length, 2);
});

test('an invalid key or username never reaches the store, and the code is fixed (K5)', async () => {
  flow = makeFlow();
  await openAndConsent(flow);
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
  await openAndConsent(flow);
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
  await openAndConsent(flow);
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
  await openAndConsent(flow);
  assert.deepEqual(flow.openTokenPage(eventFrom(electron.windows[0])), { ok: true });
  assert.deepEqual(tokenPages, ['copilot']);
  const panel = new electron.fake.BrowserWindow({});
  assert.deepEqual(flow.openTokenPage(eventFrom(panel)), { ok: false });
  assert.deepEqual(tokenPages, ['copilot']);
});

test('with DPAPI unavailable no window opens at all (K7)', async () => {
  flow = makeFlow({ available: false });
  const result = await flow.start({ providerId: 'copilot' });
  assert.deepEqual(result, { ok: false, code: 'secure-storage-unavailable' });
  assert.equal(electron.dialogCalls.length, 0);
  assert.equal(electron.windows.length, 0);
  assert.equal(flow.busy, false);
});

test('a provider that is not key-capable never opens a window (K24)', async () => {
  flow = makeFlow();
  for (const id of ['gemini', 'kimi', 'claude', '', null, '__proto__']) {
    assert.deepEqual(await flow.start({ providerId: id }), { ok: false, code: 'unknown-provider' });
  }
  assert.equal(electron.dialogCalls.length, 0);
});

test('a missing entry page refuses the flow rather than improvising a page', async () => {
  flow = makeFlow({ page: path.join(os.tmpdir(), 'usage-notch-no-such-page.html') });
  const result = await flow.start({ providerId: 'copilot' });
  assert.deepEqual(result, { ok: false, code: 'entry-unavailable' });
  assert.equal(electron.dialogCalls.length, 0);
  assert.equal(electron.windows.length, 0);
});

test('the OS close button ends the flow exactly as cancel does', async () => {
  flow = makeFlow();
  await openAndConsent(flow);
  electron.windows[0].emit('closed');
  assert.equal(flow.busy, false);
  assert.equal(stored.length, 0);
});

test.after(() => electron.restore());
