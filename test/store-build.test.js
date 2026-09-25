'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isStoreBuild, bridgeDirFor } = require('../src/main/packaging');
const { createPreferences } = require('../src/main/language-ipc');

/**
 * A Microsoft Store (MSIX) package redirects a fresh userData and HKCU into a
 * private per-package copy (measured on an MSIX build, 2026-09-25). The two
 * things this app writes for OTHER programs to use — the bridge script and the
 * login item — must therefore not live there in a Store build.
 */
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test.describe('the Store build is detected from the package identity only', () => {
  test('process.windowsStore === true and nothing else', () => {
    assert.equal(isStoreBuild({ windowsStore: true }), true);
    for (const v of [false, undefined, 'true', 1, null]) assert.equal(isStoreBuild({ windowsStore: v }), false, String(v));
    assert.equal(isStoreBuild(null), false);
  });
});

test.describe('where the bridge script lives', () => {
  const userData = path.join('C:', 'Users', 'u', 'AppData', 'Roaming', 'usage-notch');
  const home = path.join('C:', 'Users', 'u');

  test('an NSIS build keeps it in userData, where existing users are already wired', () => {
    assert.equal(bridgeDirFor({ store: false, userData, home }), path.join(userData, 'bridge'));
  });

  test('a Store build keeps it under the home directory, which MSIX does not redirect', () => {
    const dir = bridgeDirFor({ store: true, userData, home });
    assert.equal(dir, path.join(home, '.usage-notch', 'bridge'));
    assert.equal(dir.toLowerCase().includes('appdata'), false);
  });

  test('bridge-install.js asks packaging.js, and the launch refresh does not create the home folder unasked', () => {
    assert.match(read('src/main/bridge-install.js'), /bridgeDirFor\(\{ store: isStoreBuild\(\), userData: app\.getPath\('userData'\) \}\)/);
    const index = read('src/main/index.js').replace(/\s+/g, ' ');
    assert.ok(index.includes("const bridgeWired = !isStoreBuild() || fs.existsSync(path.dirname(bridgeInstallPath()));"));
  });
});

test.describe('start with Windows in a Store build', () => {
  test('preferences() says Windows owns it, and only when the build says so', () => {
    const base = { getSettings: () => ({ theme: 'dark', language: 'en', autostart: true }), currentLocale: () => null, readOs: () => ({}) };
    assert.equal(createPreferences(base)().autostartByWindows, false, 'defaults to false');
    assert.equal(createPreferences({ ...base, storeBuild: () => true })().autostartByWindows, true);
    assert.equal(createPreferences({ ...base, storeBuild: () => 'yes' })().autostartByWindows, false);
  });

  test('main never writes the Run key from a Store build, and the tray has no checkbox there', () => {
    const index = read('src/main/index.js').replace(/\s+/g, ' ');
    const apply = index.slice(index.indexOf('function applyAutostart'), index.indexOf('app.setLoginItemSettings'));
    assert.ok(apply.includes('if (isStoreBuild()) return;'), 'the early return precedes setLoginItemSettings');
    assert.ok(index.includes('autostartByWindows: isStoreBuild(),'));
    assert.match(read('src/main/tray.js'), /const autostartItems = autostartByWindows \? \[\] :/);
  });

  test('the package declares a StartupTask that runs the app executable', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.build.appx.customExtensionsPath, 'build/appx-extensions.xml');
    const xml = read('build/appx-extensions.xml');
    assert.match(xml, /Category="windows\.startupTask"/);
    assert.match(xml, /Executable="app\\Usage Notch\.exe"/);
    assert.match(xml, /TaskId="UsageNotchStartup" Enabled="true"/);
  });

  test('the settings row names where the setting lives, in both languages', () => {
    const tr = JSON.parse(read('src/shared/i18n/tr/renderer.json'))['settings.autostart.byWindows'];
    const en = JSON.parse(read('src/shared/i18n/en/renderer.json'))['settings.autostart.byWindows'];
    assert.match(tr, /Başlangıç/);
    assert.match(en, /Startup/);
    assert.match(read('src/renderer/src/components/settings.ts'), /control\.hidden = state\.autostartByWindows;/);
  });
});
