'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TRAY_VIEWS, DEFAULT_TRAY_VIEW, isTrayView, sanitizeTrayView } = require('../src/core/tray-view');
const { createSetTrayViewHandler } = require('../src/main/tray-view-ipc');
const { createPreferences } = require('../src/main/language-ipc');
const settingsStore = require('../src/main/settings');
const { formatModule } = require('./helpers/load-format');

const ROOT = path.join(__dirname, '..');

/**
 * Settings → Genel → Görünüm: "Tepsi simgesi" (default) or "Görev çubuğu
 * şeridi". The value, its sanitising at every boundary, and the handler
 * index.js registers, over recorded fakes.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-trayview-'));
}

test.describe('the value', () => {
  test('two literals, tray by default', () => {
    assert.deepEqual(TRAY_VIEWS, ['tray', 'strip']);
    assert.equal(DEFAULT_TRAY_VIEW, 'tray');
    assert.equal(isTrayView('strip'), true);
    for (const bad of ['Strip', 'taskbar', '', null, undefined, 1, true, {}, ['strip']]) {
      assert.equal(isTrayView(bad), false, JSON.stringify(bad));
      assert.equal(sanitizeTrayView(bad), 'tray', JSON.stringify(bad));
    }
  });

  test('settings: a new file and an old file (no key) both read as the tray icon', () => {
    assert.equal(settingsStore.DEFAULTS.trayView, 'tray');
    assert.equal(settingsStore.load(tmpDir()).trayView, 'tray');
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autostart: false }));
    assert.equal(settingsStore.load(dir).trayView, 'tray');
  });

  test('settings: "strip" survives a round trip; a typo or a future value is the tray icon', () => {
    const dir = tmpDir();
    const s = settingsStore.load(dir);
    s.trayView = 'strip';
    assert.equal(settingsStore.save(dir, s), true);
    assert.equal(settingsStore.load(dir).trayView, 'strip');
    for (const bad of ['STRIP', 'widget', 7, null]) {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ trayView: bad }));
      assert.equal(settingsStore.load(dir).trayView, 'tray', JSON.stringify(bad));
    }
  });

  test('preferences carry the view re-sanitised, and stripAvailable only false when it really failed', () => {
    const base = { currentLocale: () => ({ language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' }), readOs: () => ({}) };
    const p = (settings, stripAvailable) => createPreferences({ ...base, getSettings: () => settings, stripAvailable })();
    assert.equal(p({ trayView: 'strip' }).trayView, 'strip');
    assert.equal(p({ trayView: 'weird' }).trayView, 'tray');
    assert.equal(p(null).trayView, 'tray');
    assert.equal(p({}, () => true).stripAvailable, true);
    assert.equal(p({}, () => false).stripAvailable, false);
    assert.equal(p({}, () => 'no').stripAvailable, true);
    assert.equal(createPreferences({ ...base, getSettings: () => ({}) })().stripAvailable, true, 'not tried yet');
    const noRoom = (fn) => createPreferences({ ...base, getSettings: () => ({}), stripNoRoom: fn })().stripNoRoom;
    assert.equal(noRoom(() => true), true);
    assert.equal(noRoom(() => 'yes'), false, 'only a real true');
    assert.equal(createPreferences({ ...base, getSettings: () => ({}) })().stripNoRoom, false);
  });
});

test.describe('SET_TRAY_VIEW', () => {
  function rig({ fromPanel = true, saves = [], stored = 'tray', applyThrows = false } = {}) {
    const calls = [];
    const warnings = [];
    const settings = { theme: 'dark', trayView: stored };
    let n = 0;
    const handler = createSetTrayViewHandler({
      fromPanel: () => fromPanel,
      getSettings: () => settings,
      save: (s) => { calls.push(`persist:${s.trayView}`); const ok = saves[n] !== false; n += 1; return ok; },
      apply: (view) => { calls.push(`apply:${view}`); if (applyThrows) throw Object.assign(new Error('x'), { code: 'EAPPLY' }); },
      push: () => calls.push('push'),
      log: { warn: (m) => warnings.push(m) },
    });
    return { handler, calls, warnings, settings };
  }

  test('persist, apply, push, in that order', () => {
    const r = rig();
    assert.deepEqual(r.handler({}, 'strip'), { ok: true });
    assert.deepEqual(r.calls, ['persist:strip', 'apply:strip', 'push']);
    assert.equal(r.settings.trayView, 'strip');
  });

  test('anything but the two literals, or a sender that is not the panel, changes nothing', () => {
    for (const bad of ['STRIP', '', null, 1, true, {}]) {
      const r = rig();
      assert.deepEqual(r.handler({}, bad), { ok: false }, JSON.stringify(bad));
      assert.deepEqual(r.calls, []);
    }
    const r = rig({ fromPanel: false });
    assert.deepEqual(r.handler({}, 'strip'), { ok: false });
    assert.deepEqual(r.calls, []);
  });

  test('a failed write puts the value back and applies and pushes nothing', () => {
    const r = rig({ saves: [false] });
    assert.deepEqual(r.handler({}, 'strip'), { ok: false });
    assert.deepEqual(r.calls, ['persist:strip']);
    assert.equal(r.settings.trayView, 'tray');
    assert.ok(r.warnings.some((w) => w.includes('could not be persisted')));
  });

  test('an apply that throws is logged, and the stored choice still stands', () => {
    const r = rig({ applyThrows: true });
    assert.deepEqual(r.handler({}, 'strip'), { ok: true });
    assert.deepEqual(r.calls, ['persist:strip', 'apply:strip', 'push']);
    assert.ok(r.warnings.some((w) => w.includes('EAPPLY')));
  });

  test('index.js registers this handler once, and the preload passes a string over its own channel', () => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(main.includes('ipcMain.handle(IPC.SET_TRAY_VIEW, createSetTrayViewHandler({ fromPanel, getSettings: () => settings, save: (s) => settingsStore.save(userDataDir(), s), apply: applyTrayView, push: pushPreferences, log, }))'));
    assert.equal(main.split('IPC.SET_TRAY_VIEW').length - 1, 1);
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
    assert.match(preload, /setTrayView: \(view\) => ipcRenderer\.invoke\(CH\.SET_TRAY_VIEW, String\(view\)\)/);
    assert.ok(preload.includes("SET_TRAY_VIEW: 'prefs:set-tray-view'"));
  });
});

test.describe('the renderer gate (sanitizePreferences)', () => {
  const loader = formatModule();
  let s = null;
  test.before(async () => {
    await loader.load();
    s = await loader.sanitize();
  });
  test.after(() => loader.cleanup());

  const GOOD = { theme: 'dark', language: 'en', resolvedLanguage: 'en', formatLocale: 'en-GB', autostart: true, autostartByWindows: false, setupCoachDismissed: true };

  test('the two fields pass through, and a bad or missing one is the safe default', () => {
    assert.equal(s.sanitizePreferences({ ...GOOD, trayView: 'strip', stripAvailable: false }).trayView, 'strip');
    assert.equal(s.sanitizePreferences({ ...GOOD, trayView: 'strip', stripAvailable: false }).stripAvailable, false);
    const old = s.sanitizePreferences(GOOD);
    assert.equal(old.trayView, 'tray', 'a main from before the strip');
    assert.equal(old.stripAvailable, true);
    for (const bad of ['STRIP', 1, null, {}]) {
      assert.equal(s.sanitizePreferences({ ...GOOD, trayView: bad }).trayView, 'tray', JSON.stringify(bad));
    }
    assert.equal(s.sanitizePreferences({ ...GOOD, stripAvailable: 'no' }).stripAvailable, true, 'only a real false');
    assert.equal(s.sanitizePreferences({ ...GOOD, stripNoRoom: true }).stripNoRoom, true);
    assert.equal(s.sanitizePreferences({ ...GOOD, stripNoRoom: 1 }).stripNoRoom, false, 'only a real true');
    assert.equal(s.sanitizePreferences(GOOD).stripNoRoom, false);
  });
});
