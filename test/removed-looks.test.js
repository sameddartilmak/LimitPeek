'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPreferences } = require('../src/main/language-ipc');
const settingsStore = require('../src/main/settings');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/**
 * Two looks the panel no longer has, gone end to end so nothing half-wired
 * stays behind:
 *   - "Gösterge: Çubuk / Halka" (removed 2026-10-22, with the old layouts);
 *   - "Düzen: Sade liste / Halka kutuları" (removed 2026-11-02: the owner
 *     dropped the ring tiles, and one list is not a choice). The list is
 *     simply the panel now (styles/list.css).
 * A settings file written before either still loads, and the keys it carries
 * are dropped on the next save.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-looks-'));
}

const PREFS = {
  currentLocale: () => ({ language: 'tr', resolvedLanguage: 'tr', formatLocale: 'tr-TR' }),
  readOs: () => ({}),
};

test('no module, no channel, no preload method, no preference type for either', () => {
  for (const gone of [['src', 'core', 'gauge.js'], ['src', 'main', 'gauge-ipc.js'], ['src', 'core', 'layout.js'], ['src', 'main', 'layout-ipc.js']]) {
    assert.equal(fs.existsSync(path.join(ROOT, ...gone)), false, gone.join('/'));
  }
  for (const file of [['src', 'shared', 'contract.ts'], ['src', 'shared', 'contract.js'], ['src', 'main', 'preload.js'], ['src', 'main', 'index.js']]) {
    assert.doesNotMatch(read(...file), /SET_GAUGE|setGauge|prefs:set-gauge|SET_LAYOUT|setLayout|prefs:set-layout/, file.join('/'));
  }
  assert.doesNotMatch(read('src', 'shared', 'contract.ts'), /export type (Gauge|Layout)\b|^\s*(gauge: Gauge|layout: Layout);/m);
});

test('an old settings file that still says "gauge" or "layout" loads without them, and saves without them', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ gauge: 'ring', layout: 'tiles', theme: 'light' }));
  const s = settingsStore.load(dir);
  assert.equal('gauge' in s, false);
  assert.equal('layout' in s, false);
  assert.equal(s.theme, 'light', 'the rest of the file is untouched');
  assert.equal(settingsStore.save(dir, s), true);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal('gauge' in written, false);
  assert.equal('layout' in written, false);
  for (const key of ['gauge', 'layout']) assert.equal(key in settingsStore.DEFAULTS, false, key);
});

test('the preferences carry neither, whatever the settings say', () => {
  const p = createPreferences({ ...PREFS, getSettings: () => ({ gauge: 'ring', layout: 'halka' }) })();
  assert.equal('gauge' in p, false);
  assert.equal('layout' in p, false);
});

test('the renderer writes no html[data-gauge] or html[data-layout], and styles nothing by them', () => {
  const app = read('src', 'renderer', 'src', 'app.ts');
  assert.doesNotMatch(app, /dataset\.(gauge|layout)\s*=/);
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'renderer', 'styles'))) {
    assert.doesNotMatch(read('src', 'renderer', 'styles', f), /data-(gauge|layout)/, f);
  }
  for (const gone of ['layouts.css', 'layout-sade.css', 'layout-halka.css']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'src', 'renderer', 'styles', gone)), false, gone);
  }
});
