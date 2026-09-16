'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

/**
 * The tray context menu speaks the CURRENT language every time it is built
 * (ADR-004: "An English user must not meet a Turkish tooltip" — nor menu).
 *
 * `applyLanguage()` in main/index.js rebuilds the menu through
 * `TrayController.setMenu` after a language change. That only helps if
 * `setMenu` reads the catalog when it is CALLED: labels captured once at module
 * load would survive every rebuild in the launch language. This drives the real
 * `src/main/tray.js` in plain Node with `electron` stubbed to record the
 * template handed to `Menu.buildFromTemplate`.
 */

const built = [];
const electronStub = {
  Menu: { buildFromTemplate: (template) => { built.push(template); return { template }; } },
  Tray: class {},
  nativeImage: { createFromPath: () => ({}) },
  app: { getVersion: () => '0.0.0-test' },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

// Loaded AFTER the stub is in place, and with main's t() on Turkish, the
// language every launch starts in before refreshLocale() runs.
const i18n = require('../src/core/i18n');
i18n.setLocale('tr', 'tr-TR');
const { TrayController } = require('../src/main/tray');

test.after(() => {
  Module._load = originalLoad;
  i18n.setLocale('tr', 'tr-TR');
});

/** A controller with only the Electron tray it needs for setMenu. */
function controller() {
  const c = Object.create(TrayController.prototype);
  c.tray = { setContextMenu: (menu) => { c.menu = menu; } };
  return c;
}

const OPTIONS = { autostart: true, onToggleAutostart() {}, onQuit() {} };

/** The user-facing labels of the last built menu, version line excluded. */
function labels(c) {
  return c.menu.template
    .filter((item) => item.type !== 'separator' && item.enabled !== false)
    .map((item) => item.label);
}

test('setMenu reads the catalog when called, so a rebuild follows a language change', () => {
  const c = controller();
  try {
    i18n.setLocale('en', 'en-US');
    c.setMenu(OPTIONS);
    const english = labels(c);
    assert.deepEqual(english, [i18n.t('tray.menu.autostart'), i18n.t('tray.menu.quit')]);
    assert.deepEqual(english, ['Start with Windows', 'Quit']);

    i18n.setLocale('tr', 'tr-TR');
    c.setMenu(OPTIONS);
    const turkish = labels(c);
    assert.deepEqual(turkish, [i18n.t('tray.menu.autostart'), i18n.t('tray.menu.quit')]);
    assert.notDeepEqual(turkish, english, 'the rebuilt menu is still in the old language');

    i18n.setLocale('en', 'en-US');
    c.setMenu(OPTIONS);
    assert.deepEqual(labels(c), english, 'and back again');
  } finally {
    i18n.setLocale('tr', 'tr-TR');
  }
});

test('the English menu carries no Turkish', () => {
  const c = controller();
  try {
    i18n.setLocale('en', 'en-US');
    c.setMenu(OPTIONS);
    for (const label of labels(c)) assert.doesNotMatch(label, /[çğıöşüÇĞİÖŞÜ]/, label);
  } finally {
    i18n.setLocale('tr', 'tr-TR');
  }
});

test('the checkbox still reflects autostart and the handlers are wired', () => {
  const c = controller();
  let toggled = null;
  let quit = false;
  c.setMenu({ autostart: false, onToggleAutostart: (v) => { toggled = v; }, onQuit: () => { quit = true; } });
  const box = c.menu.template.find((item) => item.type === 'checkbox');
  assert.equal(box.checked, false);
  box.click({ checked: true });
  assert.equal(toggled, true);
  c.menu.template[c.menu.template.length - 1].click();
  assert.equal(quit, true);
});
