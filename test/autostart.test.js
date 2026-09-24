'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_AUTOSTART, sanitizeAutostart, createSetAutostartHandler,
} = require('../src/main/autostart-ipc');
const { createPreferences } = require('../src/main/language-ipc');
const settingsStore = require('../src/main/settings');

const ROOT = path.join(__dirname, '..');

/**
 * "Start with Windows" in the settings screen, main side.
 *
 * Built like the theme and language suites. The handler is the one index.js
 * registers (autostart-ipc.js), driven here over recorded fakes, so what is
 * tested is what runs. The login item itself is never touched: `apply` is a
 * recorder, and no test here can register a Run key on this machine.
 */

/** Source with comments removed, strings kept (the same lexer as language.test.js). */
function codeOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** A handler over recorded fakes. `calls` is the order things happened in. */
function rig({ fromPanel = true, saves = [], stored = true, applyThrows = false, menuThrows = false } = {}) {
  const calls = [];
  const warnings = [];
  const settings = { theme: 'dark', language: 'tr', autostart: stored };
  let saveN = 0;
  const handler = createSetAutostartHandler({
    fromPanel: () => fromPanel,
    getSettings: () => settings,
    save: (s) => {
      calls.push(`persist:${s.autostart}`);
      const ok = saves[saveN++];
      return ok === undefined ? true : ok;
    },
    apply: (enabled) => {
      calls.push(`apply:${enabled}`);
      if (applyThrows) throw Object.assign(new Error('apply'), { code: 'EAPPLY' });
    },
    rebuildTrayMenu: () => {
      calls.push(`menu:${settings.autostart}`);
      if (menuThrows) throw Object.assign(new Error('menu'), { code: 'EMENU' });
    },
    push: () => calls.push(`preferences:${settings.autostart}`),
    log: { warn: (m) => warnings.push(m) },
  });
  return { handler, calls, settings, warnings };
}

test.describe('the SET_AUTOSTART handler', () => {
  test('order: persist, apply the login item, rebuild the tray menu, push PREFERENCES', () => {
    const r = rig({ stored: true });
    assert.deepEqual(r.handler({}, false), { ok: true });
    assert.equal(r.settings.autostart, false);
    assert.deepEqual(r.calls, ['persist:false', 'apply:false', 'menu:false', 'preferences:false']);
  });

  test('a message from anything but our panel is refused and touches nothing', () => {
    const r = rig({ fromPanel: false, stored: true });
    assert.deepEqual(r.handler({}, false), { ok: false });
    assert.equal(r.settings.autostart, true);
    assert.deepEqual(r.calls, []);
  });

  test('anything that is not a real boolean is refused, not coerced', () => {
    // `Boolean('false')` is true: a coercing handler would turn autostart ON
    // for a message that said the opposite.
    for (const bad of ['false', 'true', 0, 1, null, undefined, {}, [], [false], new Boolean(false)]) { // eslint-disable-line no-new-wrappers
      const r = rig({ stored: true });
      assert.deepEqual(r.handler({}, bad), { ok: false }, String(bad));
      assert.equal(r.settings.autostart, true, String(bad));
      assert.deepEqual(r.calls, [], String(bad));
    }
  });

  test('a failed write rolls back in memory and applies, rebuilds and pushes nothing', () => {
    const r = rig({ stored: true, saves: [false] });
    assert.deepEqual(r.handler({}, false), { ok: false });
    assert.equal(r.settings.autostart, true, 'the rejected value stayed in memory');
    assert.deepEqual(r.calls, ['persist:false']);
    assert.ok(r.warnings.some((w) => w.includes('nothing changed')), r.warnings.join('|'));
  });

  test('the apply side is best effort: a throw is logged and the persisted value still stands', () => {
    // The file is the truth the next launch re-applies; rolling it back over a
    // failed login-item write would make the switch lie about the file.
    const r = rig({ stored: false, applyThrows: true, menuThrows: true });
    assert.deepEqual(r.handler({}, true), { ok: true });
    assert.equal(r.settings.autostart, true);
    assert.deepEqual(r.calls, ['persist:true', 'apply:true', 'menu:true', 'preferences:true']);
    assert.ok(r.warnings.some((w) => w.includes('EAPPLY')), r.warnings.join('|'));
    assert.ok(r.warnings.some((w) => w.includes('EMENU')), r.warnings.join('|'));
  });
});

test.describe('the value main hands the renderer', () => {
  const LOCALE = { language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' };
  const prefs = (settings) => createPreferences({
    getSettings: () => settings, currentLocale: () => LOCALE, readOs: () => ({}),
  })();

  test('preferences() carries autostart, false included', () => {
    assert.equal(prefs({ theme: 'dark', autostart: false }).autostart, false);
    assert.equal(prefs({ theme: 'dark', autostart: true }).autostart, true);
  });

  test('re-sanitised on the way out: anything but a boolean leaves main as the default', () => {
    for (const bad of [undefined, null, 'false', 0, 1, {}]) {
      assert.equal(prefs({ theme: 'dark', autostart: bad }).autostart, true, String(bad));
    }
    assert.equal(prefs(null).autostart, true);
  });

  test("the default is settings.js's own, so a fresh install and the switch agree", () => {
    assert.equal(DEFAULT_AUTOSTART, true);
    assert.equal(settingsStore.DEFAULTS.autostart, DEFAULT_AUTOSTART);
    assert.equal(sanitizeAutostart(false), false);
    assert.equal(sanitizeAutostart('no'), DEFAULT_AUTOSTART);
  });
});

test.describe('what can only be read off index.js (it requires electron), comments stripped', () => {
  const code = codeOf(path.join(ROOT, 'src', 'main', 'index.js')).replace(/\s+/g, ' ');

  test('index.js registers the tested handler once, with the real dependencies', () => {
    const needle = 'ipcMain.handle(IPC.SET_AUTOSTART, createSetAutostartHandler({ fromPanel, getSettings: () => settings, save: (s) => settingsStore.save(userDataDir(), s), apply: applyAutostart, rebuildTrayMenu: () => { if (tray) tray.setMenu(trayMenuOptions()); }, push: pushPreferences, log, }))';
    assert.ok(code.includes(needle), `index.js no longer wires: ${needle}`);
    assert.equal(code.split('IPC.SET_AUTOSTART').length - 1, 1, 'SET_AUTOSTART is registered more than once');
  });

  test("the tray menu's checkbox pushes PREFERENCES, so an open settings screen follows it", () => {
    const start = code.indexOf('onToggleAutostart:');
    assert.notEqual(start, -1, 'no tray toggle');
    const body = code.slice(start, code.indexOf('onQuit:', start));
    const save = body.indexOf('settingsStore.save(');
    const push = body.indexOf('pushPreferences()');
    assert.ok(save !== -1 && push !== -1 && save < push, body);
  });

  test('the preload passes a real boolean over its own channel', () => {
    const preload = codeOf(path.join(ROOT, 'src', 'main', 'preload.js'));
    assert.ok(/setAutostart:\s*\(enabled\) => ipcRenderer\.invoke\(CH\.SET_AUTOSTART, enabled === true\)/.test(preload));
    assert.ok(preload.includes("SET_AUTOSTART: 'prefs:set-autostart'"));
  });
});
