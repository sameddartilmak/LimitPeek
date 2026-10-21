'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { formatModule } = require('./helpers/load-format');

/**
 * The renderer's IPC input gate for PREFERENCES (`sanitizePreferences` in
 * `src/renderer/src/sanitize.ts`), language half. ADR-004.
 *
 * Main resolves the language and the format locale; the renderer applies what
 * it is pushed. But the push crosses a process boundary, and the payload may
 * come from an older preload or a hand-damaged settings file, so the gate
 * COERCES the three language fields rather than trusting them — and never
 * refuses a good theme because a language field was bad. Loaded from SOURCE,
 * like the format suites, so a stale dist cannot make this pass.
 */

const loader = formatModule();
let s = null;

test.before(async () => {
  await loader.load();
  s = await loader.sanitize();
});
test.after(() => loader.cleanup());

/** Runs `body` with `navigator.language` set to `tag` (or absent). */
function withNavigatorLanguage(tag, body) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: tag === undefined ? undefined : { language: tag },
    configurable: true,
    writable: true,
  });
  try {
    body();
  } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete globalThis.navigator;
  }
}

const GOOD = { theme: 'dark', language: 'en', resolvedLanguage: 'en', formatLocale: 'en-GB', autostart: true, autostartByWindows: false, setupCoachDismissed: false, trayView: 'tray', stripAvailable: true, stripNoRoom: false, gauge: 'bar', reduceTransparency: false, systemReducedTransparency: false };

test.describe('sanitizePreferences: the language fields', () => {
  test('a well-formed payload passes through unchanged', () => {
    assert.deepEqual(s.sanitizePreferences(GOOD), GOOD);
  });

  test('the theme is still the gate: no usable theme, no preferences', () => {
    assert.equal(s.sanitizePreferences({ ...GOOD, theme: 'nocturne' }), null);
    assert.equal(s.sanitizePreferences(null), null);
    assert.equal(s.sanitizePreferences('en'), null);
  });

  test("an invalid language choice becomes 'system' and does not cost the theme", () => {
    for (const bad of ['de', 'EN', 'tr-TR', '', null, 42, {}, ['en']]) {
      const out = s.sanitizePreferences({ ...GOOD, language: bad });
      assert.ok(out, JSON.stringify(bad));
      assert.equal(out.language, 'system', JSON.stringify(bad));
      assert.equal(out.theme, 'dark', JSON.stringify(bad));
    }
    const absent = s.sanitizePreferences({ theme: 'light', resolvedLanguage: 'tr', formatLocale: 'tr-TR' });
    assert.equal(absent.language, 'system');
  });

  test('an unusable format locale becomes the default for the resolved language', () => {
    for (const bad of ['not a locale!!', '', null, 7, 'x'.repeat(40)]) {
      assert.equal(s.sanitizePreferences({ ...GOOD, formatLocale: bad }).formatLocale, 'en-US', JSON.stringify(bad));
      assert.equal(
        s.sanitizePreferences({ ...GOOD, language: 'tr', resolvedLanguage: 'tr', formatLocale: bad }).formatLocale,
        'tr-TR',
        JSON.stringify(bad),
      );
    }
  });

  test('a missing or invalid resolvedLanguage follows an explicit choice', () => {
    for (const bad of [undefined, 'system', 'de', null]) {
      assert.equal(s.sanitizePreferences({ theme: 'dark', language: 'tr', resolvedLanguage: bad }).resolvedLanguage, 'tr');
      assert.equal(s.sanitizePreferences({ theme: 'dark', language: 'en', resolvedLanguage: bad }).resolvedLanguage, 'en');
    }
  });

  test("a missing resolvedLanguage under 'system' uses fallbackLanguage on navigator.language", () => {
    withNavigatorLanguage('tr-TR', () => {
      const out = s.sanitizePreferences({ theme: 'dark', language: 'system' });
      assert.equal(out.resolvedLanguage, 'tr');
      assert.equal(out.formatLocale, 'tr-TR');
    });
    withNavigatorLanguage('en-GB', () => {
      const out = s.sanitizePreferences({ theme: 'dark', language: 'system' });
      assert.equal(out.resolvedLanguage, 'en');
      assert.equal(out.formatLocale, 'en-US', 'the renderer never picks a region on its own');
    });
    withNavigatorLanguage(undefined, () => {
      assert.equal(s.sanitizePreferences({ theme: 'dark', language: 'system' }).resolvedLanguage, 'en');
    });
  });
});

test.describe('fallbackLanguage: tr* is the primary subtag, as in main', () => {
  test("'tr', 'tr-TR', 'tr-CY' and 'tr_TR' are Turkish", () => {
    for (const tag of ['tr', 'tr-TR', 'tr-CY', 'tr_TR', 'TR-tr']) {
      assert.equal(s.fallbackLanguage(tag), 'tr', tag);
    }
  });

  test("'trv' (Taroko), 'tru' and everything else are English", () => {
    for (const tag of ['trv', 'tru-TR', 'en-US', 'de', '', undefined, null, 42]) {
      assert.equal(s.fallbackLanguage(tag), 'en', String(tag));
    }
  });
});

test.describe('sanitizePreferences: autostart', () => {
  test('a real boolean passes through, false included', () => {
    assert.equal(s.sanitizePreferences({ ...GOOD, autostart: false }).autostart, false);
    assert.equal(s.sanitizePreferences({ ...GOOD, autostart: true }).autostart, true);
  });

  test('absent or not a boolean is the shipped default, true, and costs nothing else', () => {
    // Coerced like the language fields, never a gate like the theme: refusing
    // the payload would throw away a good theme for a switch's sake. And never
    // by truthiness: 'false' is a truthy string.
    for (const bad of [undefined, null, 'false', 'true', 0, 1, {}, []]) {
      const out = s.sanitizePreferences({ ...GOOD, autostart: bad });
      assert.ok(out, JSON.stringify(bad));
      assert.equal(out.autostart, true, JSON.stringify(bad));
      assert.equal(out.theme, 'dark', JSON.stringify(bad));
    }
  });
});
