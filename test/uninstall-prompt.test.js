'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  runUninstallPrompt, uninstallerPath, uninstallerArgs, parseAnswer, promptText,
} = require('../src/main/uninstall-prompt');

/**
 * Windows "Kaldır" opens the app's own question (owner, 2026-10-01) instead of
 * electron-builder's system message box; its "Kaldır" starts the uninstaller
 * silently, deleting the app's data unless the user asked to keep it.
 */

test.describe('the answer the page sends back', () => {
  test('remove / cancel, with the keep choice', () => {
    assert.deepEqual(parseAnswer('usage-notch-uninstall:remove:delete'), { action: 'remove', keepData: false });
    assert.deepEqual(parseAnswer('usage-notch-uninstall:remove:keep'), { action: 'remove', keepData: true });
    assert.deepEqual(parseAnswer('usage-notch-uninstall:cancel:delete'), { action: 'cancel', keepData: false });
  });

  test('anything else is not an answer (the page\'s own title, a stray value)', () => {
    for (const t of ['Usage Notch', '', null, 'usage-notch-uninstall:format-c', 'other:remove:delete']) {
      assert.equal(parseAnswer(t), null, String(t));
    }
  });
});

test.describe('the uninstaller it starts', () => {
  test('next to the app, silent and per-user; data goes unless kept', () => {
    assert.equal(uninstallerPath('C:\\x\\Usage Notch.exe'), path.join('C:\\x', 'Uninstall Usage Notch.exe'));
    assert.deepEqual(uninstallerArgs(false), ['/S', '/currentuser', '--delete-app-data']);
    assert.deepEqual(uninstallerArgs(true), ['/S', '/currentuser']);
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

  function rig() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-uninst-'));
    const exePath = path.join(dir, 'Usage Notch.exe');
    fs.writeFileSync(path.join(dir, 'Uninstall Usage Notch.exe'), '');
    const spawned = [];
    const spawnFn = (exe, args, opts) => { spawned.push({ exe, args, opts }); return { unref() {} }; };
    const done = runUninstallPrompt({ BrowserWindow: FakeWindow, t, lang: 'tr', theme: 'dark', exePath, log, spawnFn });
    return { win: FakeWindow.last, spawned, done, dir };
  }
  const answer = (win, title) => win.emit('page-title-updated', { preventDefault() {} }, title);

  test('a frameless, sandboxed page with the translated words in its hash', async () => {
    const r = rig();
    assert.equal(r.win.opts.frame, false);
    assert.equal(r.win.opts.webPreferences.sandbox, true);
    assert.equal(r.win.opts.webPreferences.nodeIntegration, false);
    assert.equal(r.win.opts.webPreferences.preload, undefined, 'no preload, no IPC');
    assert.match(r.win.file, /uninstall[\\/]prompt\.html$/);
    const sent = JSON.parse(decodeURIComponent(r.win.hash));
    assert.equal(sent.text.title, '[uninstall.title]');
    assert.equal(sent.text.items.length, 3);
    answer(r.win, 'usage-notch-uninstall:cancel:delete');
    await r.done;
  });

  test('"Vazgeç" starts nothing', async () => {
    const r = rig();
    answer(r.win, 'usage-notch-uninstall:cancel:delete');
    await r.done;
    assert.deepEqual(r.spawned, []);
    assert.equal(r.win.destroyed, true);
  });

  test('"Kaldır" starts the uninstaller silently, deleting data by default', async () => {
    const r = rig();
    answer(r.win, 'usage-notch-uninstall:remove:delete');
    await r.done;
    assert.equal(r.spawned.length, 1);
    assert.equal(r.spawned[0].exe, path.join(r.dir, 'Uninstall Usage Notch.exe'));
    assert.deepEqual(r.spawned[0].args, ['/S', '/currentuser', '--delete-app-data']);
    assert.equal(r.spawned[0].opts.detached, true);
  });

  test('"keep" leaves the data flag off', async () => {
    const r = rig();
    answer(r.win, 'usage-notch-uninstall:remove:keep');
    await r.done;
    assert.deepEqual(r.spawned[0].args, ['/S', '/currentuser']);
  });

  test('closing the window is a cancel', async () => {
    const r = rig();
    r.win.emit('closed');
    await r.done;
    assert.deepEqual(r.spawned, []);
  });
});

test.describe('the installer wiring (build/installer.nsh)', () => {
  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');

  test('Windows "Kaldır" is pointed at the app\'s question; the quiet path is left alone', () => {
    const install = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macroend', nsh.indexOf('!macro customInstall')));
    assert.match(install, /WriteRegStr SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" UninstallString '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --uninstall'/);
    assert.doesNotMatch(install, /QuietUninstallString/);
  });

  test('the captures folder goes only when data deletion was asked for, and never on an update', () => {
    const un = nsh.slice(nsh.indexOf('!macro customUnInstall'));
    const guard = un.indexOf('${ifNot} ${isUpdated}');
    const flag = un.indexOf('"--delete-app-data"');
    const rm = un.indexOf('RMDir /r "$LOCALAPPDATA\\UsageNotch"');
    assert.ok(guard >= 0 && flag > guard && rm > flag, 'order: isUpdated guard, then the flag, then the removal');
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
