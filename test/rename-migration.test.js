'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pinUserData, USER_DATA_FOLDER } = require('../src/main/packaging');
const {
  RUN_NAME, LEGACY_RUN_NAME, LEGACY_EXE, LOGIN_ARGS,
  migrateLegacyLoginItem, disabledByWindows, loginItemSettings,
} = require('../src/main/login-item');

/**
 * The on-disk rename "Usage Notch" -> "LimitPeek" (0.6.27).
 *
 * build.productName changed, so the exe, the uninstaller, the shortcuts, the
 * Programs entry and Electron's default login-item name changed with it. What
 * an installed copy keeps its data under must NOT change: userData, the install
 * folder, appId (the uninstall key an update looks for). And the two things the
 * old name leaves behind on an update — a Run value naming a removed exe, and
 * old-named shortcuts — are cleaned up. Nothing here touches the registry: the
 * login-item code runs over a fake `app` that keeps an in-memory Run key.
 */
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

const INSTDIR = path.join('C:', 'Users', 'u', 'AppData', 'Local', 'Programs', 'usage-notch');
const NEW_EXE = path.join(INSTDIR, 'LimitPeek.exe');
const OLD_EXE = path.join(INSTDIR, LEGACY_EXE);

/**
 * Electron's Windows login-item API over an in-memory HKCU Run key, as
 * measured on Electron 44 (shell/browser/browser_win.cc): launchItems lists the
 * values whose program equals `path` case-insensitively, where a program path
 * holding a space only matches a `path` given in quotes; `enabled` comes from
 * StartupApproved; openAtLogin:false deletes the value and its StartupApproved
 * twin; `enabled` defaults to true, which clears the StartupApproved "off" marker.
 */
function fakeApp(entries = {}, ownExe = NEW_EXE) {
  const run = new Map(Object.entries(entries));
  const calls = [];
  const stored = (p) => (p.includes(' ') ? `"${p}"` : p);
  return {
    run,
    calls,
    getLoginItemSettings({ path: exe, args }) {
      assert.deepEqual(args, LOGIN_ARGS);
      const launchItems = [...run]
        .filter(([, v]) => stored(v.path).toLowerCase() === exe.toLowerCase())
        .map(([name, v]) => ({ name, path: v.path, args: [], scope: 'user', enabled: v.enabled !== false }));
      return { openAtLogin: false, executableWillLaunchAtLogin: launchItems.some((i) => i.enabled), launchItems };
    },
    setLoginItemSettings(s) {
      calls.push(s);
      if (!s.openAtLogin) run.delete(s.name);
      else run.set(s.name, { path: ownExe, enabled: s.enabled !== false });
    },
  };
}
const quiet = { info() {}, warn() {} };

test.describe('userData stays %APPDATA%\\usage-notch after the rename', () => {
  test('it is pinned by name, not derived from the product name', () => {
    const set = [];
    const app = {
      commandLine: { hasSwitch: () => false },
      getPath: (k) => { assert.equal(k, 'appData'); return path.join('C:', 'Users', 'u', 'AppData', 'Roaming'); },
      setPath: (k, v) => set.push([k, v]),
    };
    pinUserData(app);
    assert.deepEqual(set, [['userData', path.join('C:', 'Users', 'u', 'AppData', 'Roaming', 'usage-notch')]]);
    assert.equal(USER_DATA_FOLDER, pkg.name, 'the folder every installed copy already uses is package.json "name"');
  });

  test('--user-data-dir still wins, so an audit run never lands in the real settings', () => {
    const set = [];
    pinUserData({
      commandLine: { hasSwitch: (s) => s === 'user-data-dir' },
      getPath: () => 'x',
      setPath: (k, v) => set.push([k, v]),
    });
    assert.deepEqual(set, []);
  });

  test('index.js pins it before the early exits and the single-instance lock', () => {
    const src = read('src/main/index.js');
    const pin = src.indexOf('pinUserData(app);');
    assert.ok(pin > 0, 'index.js no longer pins userData');
    for (const later of [
      "process.argv.includes('--cleanup-integrations')",
      "process.argv.includes('--uninstall-ask')",
      'app.requestSingleInstanceLock()',
      'security.applyAll();',
    ]) {
      const at = src.indexOf(later);
      assert.ok(at > pin, `${later} now runs before userData is pinned`);
    }
    // Only one place reads it, and that is after the pin too.
    assert.ok(src.indexOf("app.getPath('userData')") > pin);
  });

  test('the identity an update looks for did not move with the name', () => {
    assert.equal(pkg.name, 'usage-notch', 'install folder %LOCALAPPDATA%\\Programs\\usage-notch');
    assert.equal(pkg.build.appId, 'com.usagenotch.app', 'the uninstall key and AppUserModelID of every installed copy');
    assert.equal(pkg.build.productName, 'LimitPeek');
    assert.equal(pkg.productName, undefined, 'a top-level productName would become app.name, and with it the default userData');
  });
});

test.describe('the pre-0.6.27 login item moves to the new name', () => {
  test('the new name is the one the installer removes, and matches the product', () => {
    assert.equal(RUN_NAME, `electron.app.${pkg.build.productName}`);
    assert.equal(LEGACY_RUN_NAME, 'electron.app.Usage Notch');
  });

  test('an old value left by an update (old exe beside the new one) is removed, autostart carried by settings', () => {
    const app = fakeApp({ [LEGACY_RUN_NAME]: { path: OLD_EXE } });
    const r = migrateLegacyLoginItem({ app, execPath: NEW_EXE, log: quiet });
    assert.deepEqual(r, { migrated: true, disabled: false });
    assert.equal(app.run.has(LEGACY_RUN_NAME), false);
    app.setLoginItemSettings(loginItemSettings(true, { keepOff: r.disabled || disabledByWindows({ app, execPath: NEW_EXE }) }));
    assert.deepEqual([...app.run.keys()], [RUN_NAME]);
    assert.equal(app.run.get(RUN_NAME).enabled, true);
  });

  test('the value the new installer repointed at LimitPeek.exe is found too', () => {
    const app = fakeApp({ [LEGACY_RUN_NAME]: { path: NEW_EXE } });
    assert.deepEqual(migrateLegacyLoginItem({ app, execPath: NEW_EXE, log: quiet }), { migrated: true, disabled: false });
    assert.equal(app.run.size, 0);
  });

  test('a profile folder with a space in it (the exe path is stored quoted) is found as well', () => {
    const dir = path.join('C:', 'Users', 'Ayse Yilmaz', 'AppData', 'Local', 'Programs', 'usage-notch');
    const exe = path.join(dir, 'LimitPeek.exe');
    const app = fakeApp({ [LEGACY_RUN_NAME]: { path: path.join(dir, LEGACY_EXE), enabled: false } }, exe);
    assert.deepEqual(migrateLegacyLoginItem({ app, execPath: exe, log: quiet }), { migrated: true, disabled: true });
    app.setLoginItemSettings(loginItemSettings(true, { keepOff: true }));
    assert.equal(disabledByWindows({ app, execPath: exe }), true);
  });

  test('settings saying off wins: the old value goes and nothing new is written', () => {
    const app = fakeApp({ [LEGACY_RUN_NAME]: { path: OLD_EXE } });
    migrateLegacyLoginItem({ app, execPath: NEW_EXE, log: quiet });
    app.setLoginItemSettings(loginItemSettings(false));
    assert.equal(app.run.size, 0);
  });

  test('a value the user switched off in Task Manager stays off under the new name', () => {
    const app = fakeApp({ [LEGACY_RUN_NAME]: { path: OLD_EXE, enabled: false } });
    const r = migrateLegacyLoginItem({ app, execPath: NEW_EXE, log: quiet });
    assert.deepEqual(r, { migrated: true, disabled: true });
    app.setLoginItemSettings(loginItemSettings(true, { keepOff: r.disabled }));
    assert.equal(app.run.get(RUN_NAME).enabled, false);
  });

  test('a value pointing at ANOTHER copy (the installed app, while a dist build runs) is not touched', () => {
    const elsewhere = path.join('C:', 'repo', 'dist', 'win-unpacked', 'LimitPeek.exe');
    const app = fakeApp({ [LEGACY_RUN_NAME]: { path: OLD_EXE } });
    assert.deepEqual(migrateLegacyLoginItem({ app, execPath: elsewhere, log: quiet }), { migrated: false, disabled: false });
    assert.deepEqual(app.calls, []);
    assert.equal(app.run.has(LEGACY_RUN_NAME), true);
  });

  test('nothing to move: no write at all', () => {
    const app = fakeApp({ OneDrive: { path: 'C:\\OneDrive\\OneDrive.exe' } });
    assert.deepEqual(migrateLegacyLoginItem({ app, execPath: NEW_EXE, log: quiet }), { migrated: false, disabled: false });
    assert.deepEqual(app.calls, []);
  });

  test('a build still called Usage Notch never deletes its own value', () => {
    const app = fakeApp({ [LEGACY_RUN_NAME]: { path: OLD_EXE } });
    assert.deepEqual(migrateLegacyLoginItem({ app, execPath: OLD_EXE, log: quiet }), { migrated: false, disabled: false });
    assert.deepEqual(app.calls, []);
  });

  test('launch keeps a Task Manager "off" on the new name; the app\'s own switch turns it back on', () => {
    const app = fakeApp({ [RUN_NAME]: { path: NEW_EXE, enabled: false } });
    assert.equal(disabledByWindows({ app, execPath: NEW_EXE }), true);
    assert.equal(loginItemSettings(true, { keepOff: true }).enabled, false);
    // No `enabled` key means Electron's default, true: an explicit switch-on.
    assert.equal('enabled' in loginItemSettings(true), false);
    assert.deepEqual(loginItemSettings(false, { keepOff: true }), { openAtLogin: false, name: RUN_NAME, args: ['--hidden'] });
  });

  test('index.js migrates at launch only, and the switches still apply a plain value', () => {
    const src = read('src/main/index.js');
    assert.match(src, /applyAutostart\(settings\.autostart, \{ atBoot: true \}\);/);
    assert.match(src, /apply: applyAutostart,/);
    assert.match(src, /settings\.autostart = Boolean\(checked\);[\s\S]{0,120}applyAutostart\(settings\.autostart\);/);
    const fn = src.slice(src.indexOf('function applyAutostart'), src.indexOf('\n}\n', src.indexOf('function applyAutostart')));
    // Inside the packaged, non-Store branch: a dev run and a Store build return first.
    assert.ok(fn.indexOf('if (isStoreBuild()) return;') < fn.indexOf('migrateLegacyLoginItem('));
    assert.ok(fn.indexOf('if (!app.isPackaged)') < fn.indexOf('migrateLegacyLoginItem('));
    assert.match(fn, /app\.setLoginItemSettings\(loginItemSettings\(enabled, \{ keepOff \}\)\)/);
  });
});

test.describe('the installer cleans up what the old name leaves behind (build/installer.nsh)', () => {
  const nsh = read('build/installer.nsh').replace(/^\uFEFF/, '');
  const code = nsh.split('\n').filter((l) => !l.trimStart().startsWith(';')).join('\n');
  const macro = (name) => {
    const at = code.indexOf(`!macro ${name}\n`) >= 0 ? code.indexOf(`!macro ${name}\n`) : code.indexOf(`!macro ${name}\r\n`);
    return code.slice(at, code.indexOf('!macroend', at));
  };

  test('customInstall runs the rename cleanup, after writing UninstallString', () => {
    const install = macro('customInstall');
    const uninstallString = install.indexOf('UninstallString');
    assert.ok(uninstallString > 0);
    assert.ok(install.indexOf('!insertmacro renamedFromUsageNotch') > uninstallString);
  });

  test('the cleanup deletes the old-named Start menu and desktop shortcuts', () => {
    const install = macro('renamedFromUsageNotch');
    for (const lnk of ['$SMPROGRAMS\\Usage Notch.lnk', '$DESKTOP\\Usage Notch.lnk']) {
      const del = install.indexOf(`Delete "${lnk}"`);
      assert.ok(del > 0, `${lnk} is not deleted`);
      assert.ok(install.indexOf(`\${FileExists} "${lnk}"`) < del, `${lnk} is deleted unguarded`);
    }
    // Compiled out if the product is ever called that again, so the new
    // installer cannot delete the shortcuts it has just created.
    assert.match(install, /!if "\$\{SHORTCUT_NAME\}" != "Usage Notch"/);
    assert.doesNotMatch(install, /Delete "\$(SMPROGRAMS|DESKTOP)\\LimitPeek\.lnk"/);
  });

  test('the cleanup only repoints an existing old Run value inside $INSTDIR, and never creates one', () => {
    const install = macro('renamedFromUsageNotch');
    const writes = install.match(/WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run"[^\n]*/g) || [];
    assert.equal(writes.length, 1);
    assert.match(writes[0], /"electron\.app\.Usage Notch" '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --hidden'/);
    const guardEmpty = install.indexOf('${if} $R6 != ""');
    const guardDir = install.indexOf('${if} $R8 == "$INSTDIR\\"');
    assert.ok(guardEmpty > 0 && guardDir > guardEmpty && install.indexOf(writes[0]) > guardDir);
    assert.doesNotMatch(install, /StartupApproved/, "the user's Task Manager choice is the app's to carry over");
    assert.doesNotMatch(install, /\$R9/, 'the generated isUpdated macro clobbers $R9');
  });

  test('a real uninstall removes the login item under BOTH names, never during an update', () => {
    const un = macro('customUnInstall');
    const guard = un.indexOf('${ifNot} ${isUpdated}');
    for (const key of ['Run', 'Explorer\\StartupApproved\\Run']) {
      for (const name of [RUN_NAME, LEGACY_RUN_NAME]) {
        const line = `DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\${key}" "${name}"`;
        const at = un.indexOf(line);
        assert.ok(at > guard, `${line} is missing or outside the isUpdated guard`);
      }
    }
  });

  test('what the installer shows a person says LimitPeek', () => {
    const shown = code.split('\n').filter((l) => /^\s*(DetailPrint|MessageBox)/.test(l));
    assert.ok(shown.length >= 6);
    for (const line of shown) assert.doesNotMatch(line, /Usage Notch/, line.trim().slice(0, 80));
  });
});
