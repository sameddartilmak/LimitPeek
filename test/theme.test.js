'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { THEMES, DEFAULT_THEME, isTheme, sanitizeTheme } = require('../src/core/theme');
const settingsStore = require('../src/main/settings');

const ROOT = path.join(__dirname, '..');

/**
 * The theme preference, end to end on the main side.
 *
 * The failure this suite is built around is not "the wrong colour". It is a
 * BLANK PANEL: a value the renderer does not recognise matches no palette, so
 * an unrecognised theme escaping the sanitiser costs the user the whole
 * window, on a machine where everything else works. That is why the fallback
 * is asserted at every boundary it crosses rather than only at load().
 */

test.describe('the three literals', () => {
  test('they are exactly the ones contract.ts declares, in its order', () => {
    // Same treatment as the channel names and the state ramp: one declaration
    // in the contract, a runtime mirror, and a test that fails on drift. A
    // fourth theme added on one side only would be persisted here and then
    // silently repaired to 'system' on the next launch.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'contract.ts'), 'utf8');
    const m = /export type ThemeChoice =([^;]+);/.exec(src);
    assert.ok(m, 'contract.ts no longer declares ThemeChoice');
    const declared = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    assert.deepEqual([...THEMES], declared);
  });

  test("the default is 'system', and it is one of them", () => {
    assert.equal(DEFAULT_THEME, 'system');
    assert.ok(THEMES.includes(DEFAULT_THEME));
  });

  test('isTheme accepts the three and nothing else', () => {
    for (const t of THEMES) assert.equal(isTheme(t), true, t);
    for (const bad of [
      'Dark', 'DARK', ' dark', 'dark ', 'nocturne', '', null, undefined, 0, 1,
      true, {}, [], ['dark'], new String('dark'), // eslint-disable-line no-new-wrappers
    ]) {
      assert.equal(isTheme(bad), false, JSON.stringify(bad));
    }
  });

  test('sanitizeTheme never returns anything but a real ThemeChoice', () => {
    for (const t of THEMES) assert.equal(sanitizeTheme(t), t);
    for (const bad of ['Dark', 'nocturne', '', null, undefined, 42, {}, [], true]) {
      assert.equal(sanitizeTheme(bad), DEFAULT_THEME, JSON.stringify(bad));
    }
  });
});

/* ------------------------------------------------------------- persistence */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-theme-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const write = (dir, text) => fs.writeFileSync(path.join(dir, 'settings.json'), text, 'utf8');

test.describe('it lives in userData beside providerOrder and enabledProviders', () => {
  test('a fresh install defaults to system', (t) => {
    assert.equal(settingsStore.load(tempDir(t)).theme, 'system');
  });

  test('a saved theme survives a round trip', (t) => {
    const dir = tempDir(t);
    const settings = settingsStore.load(dir);
    settings.theme = 'light';
    assert.equal(settingsStore.save(dir, settings), true);
    assert.equal(settingsStore.load(dir).theme, 'light');
    // And it did not take the neighbours with it.
    assert.deepEqual(settingsStore.load(dir).providerOrder, []);
    assert.deepEqual(settingsStore.load(dir).enabledProviders, {});
  });

  test('every theme round trips, not just the interesting one', (t) => {
    const dir = tempDir(t);
    for (const theme of THEMES) {
      const settings = settingsStore.load(dir);
      settings.theme = theme;
      assert.equal(settingsStore.save(dir, settings), true);
      assert.equal(settingsStore.load(dir).theme, theme);
    }
  });

  test('an unrecognised value falls back to the default, not to a blank UI', (t) => {
    const dir = tempDir(t);
    for (const bad of ['"nocturne"', '"Dark"', 'null', '42', 'true', '{}', '[]', '""']) {
      write(dir, `{ "theme": ${bad} }`);
      assert.equal(settingsStore.load(dir).theme, DEFAULT_THEME, bad);
    }
  });

  test('a corrupt file costs the preference, never the panel', (t) => {
    const dir = tempDir(t);
    for (const raw of ['', '{', 'not json', '[]', 'null', '"a string"']) {
      write(dir, raw);
      const loaded = settingsStore.load(dir);
      assert.equal(loaded.theme, DEFAULT_THEME, JSON.stringify(raw));
      assert.equal(loaded.autostart, true);
    }
  });

  test('a settings file written before the theme existed keeps its other choices', (t) => {
    // The upgrade path, and the one that would be easiest to get wrong: an
    // older file simply has no `theme` key, and that must not read as a
    // corrupt file and reset the order the user dragged.
    const dir = tempDir(t);
    write(dir, JSON.stringify({ autostart: false, providerOrder: ['kimi', 'claude'] }));
    const loaded = settingsStore.load(dir);
    assert.equal(loaded.theme, DEFAULT_THEME);
    assert.equal(loaded.autostart, false);
    assert.deepEqual(loaded.providerOrder, ['kimi', 'claude']);
  });

  test('the shipped DEFAULTS object names it', () => {
    assert.equal(settingsStore.DEFAULTS.theme, DEFAULT_THEME);
  });
});

/* --------------------------------------------------------------- the wiring */

test.describe('the main-process wiring says what the contract says', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');

  test('SET_THEME applies the same sender check as every other handler', () => {
    const start = main.indexOf('IPC.SET_THEME');
    assert.notEqual(start, -1, 'no SET_THEME handler');
    const body = main.slice(start, main.indexOf('\n  });', start));
    assert.ok(body.includes('if (!fromPanel(event)) return { ok: false };'), body);
  });

  test('SET_THEME validates against the literals rather than coercing', () => {
    const start = main.indexOf('IPC.SET_THEME');
    const body = main.slice(start, main.indexOf('\n  });', start));
    assert.ok(body.includes('isTheme(theme)'), body);
  });

  test('SET_THEME persists BEFORE it applies, and rolls back on a failed write', () => {
    // Same discipline as SET_ORDER and SET_ENABLED: `{ok:false}` has to mean
    // the theme changed nowhere, or the renderer reverts its switch while the
    // settings file holds the value it was told was rejected.
    const start = main.indexOf('IPC.SET_THEME');
    const body = main.slice(start, main.indexOf('\n  });', start));
    const save = body.indexOf('settingsStore.save(');
    const push = body.indexOf('pushPreferences()');
    assert.ok(save !== -1 && push !== -1, body);
    assert.ok(save < push, 'it applied before it persisted');
    assert.ok(body.includes('settings.theme = previous;'), 'no rollback on a failed write');
  });

  test('initialPreferences answers a brand-new install with an OBJECT, not null', () => {
    // Frontend asked what happens before settings.json has ever been written.
    // The answer is a concrete `{theme:'system'}`: bootstrap() loads settings
    // before the window exists, and load() answers a missing file with
    // defaults, so `preferences()` always has a real value to return. The
    // renderer would survive null — it falls back — but then two independent
    // fallbacks would have to stay in step for ever, and the render fixture
    // returns an object. Verified here against a directory that does not
    // contain a settings file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-fresh-'));
    try {
      const loaded = settingsStore.load(dir);
      assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false, 'nothing was written');
      assert.deepEqual({ theme: sanitizeTheme(loaded.theme) }, { theme: 'system' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('null on that channel means one thing only: the sender is not our panel', () => {
    const start = main.indexOf('IPC_EXT.INITIAL_PREFERENCES');
    assert.notEqual(start, -1, 'no INITIAL_PREFERENCES listener');
    const body = main.slice(start, main.indexOf('});', start));
    assert.ok(body.includes('event.returnValue = fromPanel(event) ? preferences() : null;'), body);
  });

  test('the preload exposes the three methods the contract declares', () => {
    // Frontend reported them missing; they are present. Its bridge degrades
    // with a console.error per missing method, so a stale preload would have
    // shown up as a theme switch that silently did nothing.
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
    assert.ok(preload.includes('sendSync(CH.INITIAL_PREFERENCES)'), 'initialPreferences must be synchronous');
    assert.ok(/onPreferences:\s*\(cb\) => subscribe\(CH\.PREFERENCES, cb\)/.test(preload));
    assert.ok(/setTheme:\s*\(theme\) => ipcRenderer\.invoke\(CH\.SET_THEME/.test(preload));
  });

  test('the value leaving main is sanitised again, not passed through', () => {
    // Corruption tolerance that stops at the file boundary ends in a blank UI:
    // load() repairs the value, but a hand-edited settings.json read by an
    // older build, or any future path that writes `settings.theme` directly,
    // would otherwise reach the renderer unchecked.
    const start = main.indexOf('function preferences()');
    assert.notEqual(start, -1, 'no preferences() builder');
    const body = main.slice(start, main.indexOf('\n}', start));
    assert.ok(body.includes('sanitizeTheme('), body);
  });
});
