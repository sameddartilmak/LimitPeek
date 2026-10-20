'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  runUninstallPrompt, parseAnswer, exitCodeFor, promptText, EXIT,
} = require('../src/main/uninstall-prompt');

/**
 * Windows "Kaldır" runs the real uninstaller silently with --ask; its
 * customUnInit starts the app's own question and reads the answer from the
 * exit code (owner, 2026-10-01). The entry keeps naming the uninstaller: an
 * update reads it to find the old one, and 0.6.11 broke every update by
 * pointing it at the app.
 */

test.describe('the answer the page sends back', () => {
  test('remove / cancel, with the keep choice', () => {
    assert.deepEqual(parseAnswer('usage-notch-uninstall:remove:delete'), { action: 'remove', keepData: false });
    assert.deepEqual(parseAnswer('usage-notch-uninstall:remove:keep'), { action: 'remove', keepData: true });
    assert.deepEqual(parseAnswer('usage-notch-uninstall:cancel:delete'), { action: 'cancel', keepData: false });
  });

  test('anything else is not an answer (the page\'s own title, a stray value)', () => {
    for (const t of ['LimitPeek', '', null, 'usage-notch-uninstall:format-c', 'other:remove:delete']) {
      assert.equal(parseAnswer(t), null, String(t));
    }
  });

  test('the exit codes the uninstaller reads: 0 delete, 1 keep, 2 cancel', () => {
    assert.deepEqual(EXIT, { REMOVE_DELETE: 0, REMOVE_KEEP: 1, CANCEL: 2 });
    assert.equal(exitCodeFor({ action: 'remove', keepData: false }), 0);
    assert.equal(exitCodeFor({ action: 'remove', keepData: true }), 1);
    assert.equal(exitCodeFor({ action: 'cancel', keepData: false }), 2);
    assert.equal(exitCodeFor(null), 2, 'a closed window is a cancel');
  });
});

test.describe('the window', () => {
  class FakeWindow extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.destroyed = false; FakeWindow.last = this; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    show() {}
    loadFile(file, opts) { this.file = file; this.hash = opts.hash; }
  }
  const t = (key) => `[${key}]`;
  const log = { info() {}, warn() {} };
  const rig = () => {
    const done = runUninstallPrompt({ BrowserWindow: FakeWindow, t, lang: 'tr', theme: 'dark', log });
    return { win: FakeWindow.last, done };
  };
  const answer = (win, title) => win.emit('page-title-updated', { preventDefault() {} }, title);

  test('a frameless, sandboxed page with the translated words in its hash, and no way to run anything', async () => {
    const r = rig();
    assert.equal(r.win.opts.frame, false);
    assert.equal(r.win.opts.webPreferences.sandbox, true);
    assert.equal(r.win.opts.webPreferences.nodeIntegration, false);
    assert.equal(r.win.opts.webPreferences.spellcheck, false);
    assert.equal(r.win.opts.webPreferences.preload, undefined, 'no preload, no IPC');
    assert.match(r.win.file, /uninstall[\\/]prompt\.html$/);
    const sent = JSON.parse(decodeURIComponent(r.win.hash));
    assert.equal(sent.text.title, '[uninstall.title]');
    assert.equal(sent.text.items.length, 3);
    answer(r.win, 'usage-notch-uninstall:cancel:delete');
    assert.equal(await r.done, 2);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'uninstall-prompt.js'), 'utf8');
    assert.doesNotMatch(src, /child_process|spawn\(/, 'the uninstaller is the one that acts; the app only answers');
  });

  test('"Kaldır" answers 0, with "keep" 1, closing the window 2', async () => {
    let r = rig(); answer(r.win, 'usage-notch-uninstall:remove:delete'); assert.equal(await r.done, 0);
    r = rig(); answer(r.win, 'usage-notch-uninstall:remove:keep'); assert.equal(await r.done, 1);
    r = rig(); r.win.emit('closed'); assert.equal(await r.done, 2);
    assert.equal(r.win.destroyed, true);
  });
});

test.describe('the installer wiring (build/installer.nsh)', () => {
  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  const macro = (name) => nsh.slice(nsh.indexOf(`!macro ${name}`), nsh.indexOf('!macroend', nsh.indexOf(`!macro ${name}`)));

  test('Windows "Kaldır" still names the UNINSTALLER (updates read it), silently, with --ask', () => {
    const install = macro('customInstall');
    assert.match(install, /UninstallString '"\$INSTDIR\\\$\{UNINSTALL_FILENAME\}" \/currentuser \/S --ask'/);
    assert.doesNotMatch(install, /APP_EXECUTABLE_FILENAME/, 'pointing the entry at the app broke every update (0.6.11)');
    assert.doesNotMatch(install, /QuietUninstallString/);
  });

  test('the question is asked only for --ask, never on an update; cancel quits and brings the app back', () => {
    const init = macro('customUnInit');
    assert.match(init, /\$\{GetOptions\} \$R6 "--ask"/);
    assert.match(init, /\$\{andIfNot\} \$\{isUpdated\}/);
    assert.match(init, /ExecWait '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --uninstall-ask' \$R8/);
    const cancel = init.slice(init.indexOf('$R8 == "2"'));
    assert.ok(cancel.indexOf('Exec ') < cancel.indexOf('Quit'), 'cancel restarts the app, then quits');
    assert.match(init, /\$R8 == "0"[\s\S]*StrCpy \$usageNotchDeleteData "1"/);
  });

  test('the data goes LAST, after the bridge cleanup has read claude-chain.json, and never on an update', () => {
    const un = macro('customUnInstall');
    const guard = un.indexOf('${ifNot} ${isUpdated}');
    const cleanup = un.indexOf('--cleanup-integrations');
    const appData = un.indexOf('"$APPDATA\\usage-notch"');
    const local = un.lastIndexOf('"$LOCALAPPDATA\\UsageNotch"');
    assert.ok(guard >= 0 && cleanup > guard, 'cleanup inside the real-uninstall branch');
    assert.ok(appData > cleanup && local > cleanup, 'deleting userData before the cleanup would lose the user\'s own status line');
  });

  test('the file keeps its UTF-8 BOM (NSIS needs it for the Turkish text)', () => {
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });
});

test.describe('the words', () => {
  test('every prompt string exists in tr, en and zh', () => {
    for (const lang of ['tr', 'en', 'zh']) {
      const cat = require(`../src/shared/i18n/${lang}/main.json`);
      const t = (key) => { assert.ok(typeof cat[key] === 'string' && cat[key].length > 0, `${lang}: ${key}`); return cat[key]; };
      promptText(t);
      t('uninstall.windowTitle');
    }
  });

  test('the Turkish copy says what is never touched', () => {
    const tr = require('../src/shared/i18n/tr/main.json');
    assert.match(tr['uninstall.untouched'], /dokunulmaz/);
    assert.match(tr['uninstall.item.data'], /kullanım geçmişiniz/);
  });
});

test.describe('the window speaks the stored language and theme', () => {
  const { promptLook } = require('../src/main/uninstall-prompt');
  const i18n = require('../src/core/i18n');
  test('stored choices win; "system" follows the OS', () => {
    assert.deepEqual(promptLook({ language: 'en', theme: 'light' }, { preferredLanguages: ['tr'] }, true), { lang: 'en', theme: 'light' });
    assert.equal(i18n.t('uninstall.remove'), 'Uninstall');
    assert.deepEqual(promptLook({ language: 'system', theme: 'system' }, { preferredLanguages: ['zh-CN'] }, true), { lang: 'zh', theme: 'dark' });
    assert.deepEqual(promptLook(null, { preferredLanguages: ['tr-TR'] }, false), { lang: 'tr', theme: 'light' });
    i18n.setLocale('tr', 'tr-TR');
  });
});
