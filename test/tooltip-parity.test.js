'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { formatModule } = require('./helpers/load-format');
const mainI18n = require('../src/core/i18n');
const {
  buildTooltip, tooltipParts, countdown, formatPercent, COUNTDOWN_FLOOR_MS,
} = require('../src/core/tray-tooltip');
const words = require('../src/core/tray-tooltip');

/**
 * The tooltip against the surface it duplicates.
 *
 * `tray-tooltip.js` restates two of the renderer's formatting rules rather than
 * importing them, because `format.ts` is TypeScript owned by the other lane and
 * cannot be `require`d from the main process. The file says the duplication is
 * "deliberate and narrow: same units, same dropped-zero rule, same catalog
 * keys" — which is a claim about two copies of a rule staying identical, and
 * the only thing that can hold that claim is a test that runs both.
 *
 * ADR-004: both surfaces now speak the language main resolved, so every
 * comparison runs in each locale main can hand out — tr-TR, en-US and en-GB —
 * with BOTH `t()` implementations switched together, as `index.js` and the
 * PREFERENCES push switch them at runtime.
 */

const fmt = formatModule();
let format = null;
let rendererI18n = null;

test.before(async () => {
  format = await fmt.load();
  rendererI18n = await fmt.i18n();
});
test.after(() => {
  mainI18n.setLocale('tr', 'tr-TR');
  fmt.cleanup();
});

const LOCALES = [['tr', 'tr-TR'], ['en', 'en-US'], ['en', 'en-GB']];

/** Runs `body` with main and renderer on the same locale, then restores Turkish. */
function inBoth(language, locale, body) {
  mainI18n.setLocale(language, locale);
  rendererI18n.setLocale(language, locale);
  try {
    body();
  } finally {
    mainI18n.setLocale('tr', 'tr-TR');
    rendererI18n.setLocale('tr', 'tr-TR');
  }
}

/* --------------------------------------------------------- the percentage */

test.describe('the tooltip and the panel row print one number', () => {
  test('every percentage the core can produce formats identically on both surfaces', () => {
    // `percentage()` in ratelimits.js rejects anything outside 0..100, so this
    // is the whole domain, walked at a finer step than the rounding boundary.
    for (const [language, locale] of LOCALES) {
      inBoth(language, locale, () => {
        for (let v = 0; v <= 1000; v++) {
          const value = v / 10;
          assert.equal(formatPercent(value), format.percent(value),
            `${locale}: ${value} formatted differently in the tooltip and the row`);
        }
      });
    }
  });

  test('the sign sits where the language puts it', () => {
    assert.equal(formatPercent(62), '%62');
    inBoth('en', 'en-US', () => assert.equal(formatPercent(62), '62%'));
  });

  test('the half-way values round the same way, so neither surface steps first', () => {
    for (const [language, locale] of LOCALES) {
      inBoth(language, locale, () => {
        for (const value of [0.5, 1.5, 49.5, 50.5, 61.5, 84.5, 85.5, 99.5]) {
          assert.equal(formatPercent(value), format.percent(value), `${locale}: ${value}`);
        }
      });
    }
  });
});

/* ---------------------------------------------------------- the countdown */

test.describe('the tooltip and the panel row say the same duration', () => {
  test('the two countdown implementations agree across every unit boundary', () => {
    const cases = [
      0, 1, 999, 1000, 1001, 59_000, 59_999, 60_000, 61_000,
      3_599_000, 3_600_000, 3_600_999, 3_660_000, 7_140_000,
      47 * 3600e3, 48 * 3600e3, 48 * 3600e3 + 1, 71 * 3600e3, 72 * 3600e3,
      6 * 24 * 3600e3, 30 * 24 * 3600e3, 1234 * 24 * 3600e3,
    ];
    for (const [language, locale] of LOCALES) {
      inBoth(language, locale, () => {
        for (const ms of cases) {
          assert.equal(countdown(ms), format.countdown(ms), `${locale}: ${ms} ms`);
        }
      });
    }
  });

  test('they agree on a dense sweep of the first two days, not only on the edges', () => {
    for (const [language, locale] of LOCALES) {
      inBoth(language, locale, () => {
        for (let ms = 0; ms <= 50 * 3600e3; ms += 997_000) {
          assert.equal(countdown(ms), format.countdown(ms), `${locale}: ${ms} ms`);
        }
      });
    }
  });

  test('the parenthetical the tooltip prints is the one the row prints', () => {
    // The row builds "X kaldı" / "X left" through countdownRemaining(); the
    // tooltip puts that same string in its parenthesis.
    for (const [language, locale] of LOCALES) {
      inBoth(language, locale, () => {
        for (const ms of [COUNTDOWN_FLOOR_MS + 1000, 2 * 3600e3, 49 * 3600e3]) {
          const resetsAt = new Date(NOW + ms).toISOString();
          const five = tooltipParts(snap([provider({ usedPercentage: 40, certainty: 'known', resetsAt })]), NOW).five;
          assert.ok(five.endsWith(`(${format.countdownRemaining(ms)})`), `${locale}: ${five}`);
        }
      });
    }
  });

  test('below a second both refuse to print a duration at all', () => {
    // The tooltip never reaches this — the floor stops it a minute earlier —
    // but the shared word matters if the floor is ever lowered.
    assert.equal(countdown(0), 'sıfırlanıyor');
    assert.equal(format.countdown(0), 'sıfırlanıyor');
    inBoth('en', 'en-US', () => {
      assert.equal(countdown(0), 'resetting');
      assert.equal(format.countdown(0), 'resetting');
    });
  });
});

/* ------------------------------------------- what happens between snapshots */

const NOW = Date.parse('2026-09-08T12:00:00.000Z');

function provider(fiveHour) {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    accent: '#C96442',
    enabled: true,
    connected: true,
    status: 'ok',
    fiveHour,
    sevenDay: null,
  };
}

const snap = (providers) => ({ generatedAt: new Date(NOW).toISOString(), providers });

test.describe('the tooltip has no clock of its own', () => {
  test('the countdown ages out, which is the half that was designed', () => {
    const s = snap([provider({
      usedPercentage: 98,
      certainty: 'known',
      resetsAt: new Date(NOW + COUNTDOWN_FLOOR_MS + 5000).toISOString(),
    })]);
    assert.ok(buildTooltip(s, NOW).includes(words.REMAINING), 'stated while it is defensible');
    assert.equal(buildTooltip(s, NOW + 10_000).includes(words.REMAINING), false,
      'and withdrawn once it is inside the floor');
  });

  test('the percentage ages out with it — the half that was missing', () => {
    // `windowFrom()` in snapshot.js turns a rolled-over window into 'unknown',
    // but only when a snapshot is BUILT. The tooltip is written once per emit
    // and read whenever the user hovers, so between two idle sweeps it kept
    // printing a figure for a window that had already reset — the same "a
    // capture can outlive its window" shape the panel solves with its 1 Hz
    // clock and `captureExpired()`, on the one surface that has no clock.
    // The tooltip made that staleness argument for its countdown and then
    // ignored it for the number beside it.
    const resetsAt = new Date(NOW + COUNTDOWN_FLOOR_MS + 1000).toISOString();
    const s = snap([provider({ usedPercentage: 98, certainty: 'known', resetsAt })]);

    const atWrite = buildTooltip(s, NOW);
    assert.ok(atWrite.includes(`${words.FIVE_LABEL}: %98`), atWrite);

    // Long past the reset. Neither the countdown nor the number it framed.
    const wayLater = buildTooltip(s, NOW + 6 * 3600e3);
    assert.equal(wayLater.includes('%98'), false, wayLater);
    assert.equal(wayLater.includes(words.REMAINING), false, wayLater);
    assert.ok(wayLater.includes(`${words.FIVE_LABEL}: ${words.RESETTING}`), wayLater);
  });

  test('a figure written one second before its own floor is withheld, and says why', () => {
    // The worst case the emit cadence allows: the window it describes resets
    // within the same sweep that wrote the string. Stating 98% there is a
    // claim that expires before it is read.
    const resetsAt = new Date(NOW + COUNTDOWN_FLOOR_MS - 1000).toISOString();
    const parts = tooltipParts(snap([provider({
      usedPercentage: 98, certainty: 'known', resetsAt,
    })]), NOW);
    assert.equal(parts.five, `${words.FIVE_LABEL}: ${words.RESETTING}`);
    assert.equal(parts.five.includes(words.REMAINING), false,
      'and no countdown parenthetical under a withheld figure');
  });

  test('the line is never simply absent, which would read as the tooltip breaking', () => {
    // An absence that looks like an absence of data is the collision this
    // project keeps finding, so the resetting state is SAID.
    const resetsAt = new Date(NOW - 3600e3).toISOString();
    const text = buildTooltip(snap([provider({ usedPercentage: 98, certainty: 'known', resetsAt })]), NOW);
    assert.equal(text.split('\n').length, 3, text);
    assert.ok(text.includes(`${words.FIVE_LABEL}: `), text);
  });

  test('"resetting" and "unknown" are different sentences', () => {
    // We know exactly why there is no figure, and the reason is the one the
    // user is most likely hovering to ask about.
    const resetting = buildTooltip(snap([provider({
      usedPercentage: 98, certainty: 'known', resetsAt: new Date(NOW - 1000).toISOString(),
    })]), NOW);
    const unknown = buildTooltip(snap([provider({
      usedPercentage: null, certainty: 'unknown', resetsAt: null,
    })]), NOW);
    assert.ok(resetting.includes(words.RESETTING), resetting);
    assert.ok(unknown.includes(words.NO_PERCENT), unknown);
    assert.notEqual(resetting, unknown);
  });

  test('an unknown window is the one state that cannot go stale', () => {
    // The honest form carries no number, so no amount of time makes it false.
    const s = snap([provider({ usedPercentage: null, certainty: 'unknown', resetsAt: null })]);
    assert.equal(buildTooltip(s, NOW), buildTooltip(s, NOW + 30 * 24 * 3600e3));
  });
});
