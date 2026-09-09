'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');


/**
 * Boundary coverage for `src/renderer/src/format.ts`.
 *
 * This file exists because three threshold defects shipped and were fixed by
 * hand with no test left behind: "0 dk önce", "1 sa 0 dk kaldı" and
 * "0 sn kaldı". Every one of them lives on an off-by-one at a unit boundary,
 * so the whole class is pinned here: 0, sub-second, exactly one minute / hour /
 * day, a zero minor unit, negative, NaN and Infinity.
 *
 * The TypeScript SOURCE is loaded, not `dist/`, so a stale build cannot make
 * these pass against code the developer already changed. `format.ts` now has
 * one import (STATE_THRESHOLDS from the contract), so the loading is done by
 * test/helpers/load-format.js — still from source, still no dependency.
 */
const { formatModule } = require('./helpers/load-format');

let f;
const mod = formatModule();
test.before(async () => { f = await mod.load(); });
test.after(() => mod.cleanup());

const SEC = 1000;
const MIN = 60 * SEC;
const HR = 60 * MIN;
const DAY = 24 * HR;

// --------------------------------------------------------------- countdown

test.describe('countdown boundaries', () => {
  test('below one second is not a duration at all', () => {
    for (const ms of [0, 1, 999]) {
      assert.equal(f.countdown(ms), 'sıfırlanıyor', `${ms}ms`);
      assert.equal(f.countdownRemaining(ms), 'sıfırlanıyor', `${ms}ms`);
    }
  });

  test('regression: the zero countdown never reads "0 sn kaldı"', () => {
    for (const ms of [0, 1, 999, -1, -HR, NaN]) {
      assert.doesNotMatch(f.countdownRemaining(ms), /^0 /, `${ms}ms`);
      assert.doesNotMatch(f.countdownRemaining(ms), /0 sn/, `${ms}ms`);
    }
  });

  test('"kaldı" is never appended to the reset word', () => {
    assert.equal(f.countdownRemaining(0), 'sıfırlanıyor');
    assert.doesNotMatch(f.countdownRemaining(0), /kaldı/);
    assert.equal(f.countdownRemaining(SEC), '1 sn kaldı');
  });

  test('exactly one second is the first real duration', () => {
    assert.equal(f.countdown(SEC), '1 sn');
    assert.equal(f.countdown(SEC - 1), 'sıfırlanıyor');
  });

  test('seconds roll to minutes at exactly 60 s, not at 59', () => {
    assert.equal(f.countdown(59 * SEC), '59 sn');
    assert.equal(f.countdown(MIN - 1), '59 sn');
    assert.equal(f.countdown(MIN), '1 dk');
  });

  test('minutes roll to hours at exactly 60 min', () => {
    assert.equal(f.countdown(59 * MIN), '59 dk');
    assert.equal(f.countdown(HR - 1), '59 dk');
    assert.equal(f.countdown(HR), '1 sa');
  });

  test('regression: a whole hour never reads "1 sa 0 dk"', () => {
    for (const h of [1, 2, 5, 23, 47]) {
      assert.equal(f.countdown(h * HR), `${h} sa`);
      assert.doesNotMatch(f.countdown(h * HR), /0 dk/, `${h}h`);
      assert.doesNotMatch(f.countdownRemaining(h * HR), /0 dk/, `${h}h`);
      assert.doesNotMatch(f.countdownSpoken(h * HR), /0 dakika/, `${h}h`);
    }
  });

  test('a non-zero minute component is kept', () => {
    assert.equal(f.countdown(HR + MIN), '1 sa 1 dk');
    assert.equal(f.countdown(2 * HR + 14 * MIN), '2 sa 14 dk');
  });

  test('seconds are dropped once there is a minute to show', () => {
    assert.equal(f.countdown(MIN + 30 * SEC), '1 dk');
    assert.equal(f.countdown(HR + MIN + 59 * SEC), '1 sa 1 dk');
  });

  test('days only appear from 48 hours, and a whole day drops the hour', () => {
    assert.equal(f.countdown(47 * HR), '47 sa');
    assert.equal(f.countdown(2 * DAY), '2 gün');
    assert.doesNotMatch(f.countdown(2 * DAY), /0 sa/);
    assert.equal(f.countdown(2 * DAY + HR), '2 gün 1 sa');
    assert.equal(f.countdown(7 * DAY), '7 gün');
  });

  test('negative, NaN and Infinity all degrade to the reset word, never to a number', () => {
    for (const ms of [-1, -MIN, -DAY, NaN, Infinity, -Infinity]) {
      assert.equal(f.countdown(ms), 'sıfırlanıyor', String(ms));
      assert.equal(f.countdownRemaining(ms), 'sıfırlanıyor', String(ms));
      assert.equal(f.countdownSpoken(ms), 'şu anda sıfırlanıyor', String(ms));
    }
  });
});

// ------------------------------------------------- countdown, screen reader

test.describe('spoken countdown spells its units out', () => {
  test('abbreviations never leak into the spoken string', () => {
    for (const ms of [SEC, MIN, HR, HR + MIN, 2 * DAY, 2 * DAY + HR]) {
      const spoken = f.countdownSpoken(ms);
      assert.doesNotMatch(spoken, /\bsn\b/, spoken);
      assert.doesNotMatch(spoken, /\bdk\b/, spoken);
      assert.doesNotMatch(spoken, /\bsa\b/, spoken);
    }
  });

  test('it crosses the same boundaries as the short form', () => {
    assert.equal(f.countdownSpoken(SEC), '1 saniye');
    assert.equal(f.countdownSpoken(MIN - 1), '59 saniye');
    assert.equal(f.countdownSpoken(MIN), '1 dakika');
    assert.equal(f.countdownSpoken(HR - 1), '59 dakika');
    assert.equal(f.countdownSpoken(HR), '1 saat');
    assert.equal(f.countdownSpoken(HR + MIN), '1 saat 1 dakika');
    assert.equal(f.countdownSpoken(2 * DAY), '2 gün');
    assert.equal(f.countdownSpoken(2 * DAY + HR), '2 gün 1 saat');
  });

  test('the seconds branch reads the seconds, not the whole elapsed count', () => {
    // Guards the `totalSec % 60` in the fallback: a value that is under a
    // minute must speak its own seconds and nothing larger.
    assert.equal(f.countdownSpoken(45 * SEC), '45 saniye');
  });
});

// --------------------------------------------------------------------- ago

test.describe('ago boundaries', () => {
  test('regression: a sub-minute age never reads "0 dk önce"', () => {
    for (const ms of [0, 1, SEC, MIN - 1, -1, -HR, NaN, Infinity]) {
      assert.equal(f.ago(ms), 'şimdi', String(ms));
      assert.doesNotMatch(f.ago(ms), /0 dk/, String(ms));
      assert.equal(f.agoSpoken(ms), 'az önce', String(ms));
    }
  });

  test('one whole minute is the first counted age', () => {
    assert.equal(f.ago(MIN), '1 dk önce');
    assert.equal(f.agoSpoken(MIN), '1 dakika önce');
  });

  test('minutes give way to hours at exactly 60 minutes', () => {
    assert.equal(f.ago(59 * MIN), '59 dk önce');
    assert.equal(f.ago(HR - 1), '59 dk önce');
    assert.equal(f.ago(HR), '1 sa önce');
  });

  test('hours give way to days at exactly 24 hours', () => {
    assert.equal(f.ago(23 * HR), '23 sa önce');
    assert.equal(f.ago(DAY - 1), '23 sa önce');
    assert.equal(f.ago(DAY), '1 gün önce');
    assert.equal(f.agoSpoken(DAY), '1 gün önce');
  });

  test('an age past a minute is never a bare "şimdi"', () => {
    assert.notEqual(f.ago(MIN), 'şimdi');
    assert.notEqual(f.ago(90 * MIN), 'şimdi');
  });
});

// ---------------------------------------------------------- Turkish numbers

test.describe('Turkish number formatting', () => {
  test('thousands are separated with a dot, never a comma', () => {
    assert.equal(f.integer(1000), '1.000');
    assert.equal(f.integer(1234567), '1.234.567');
    assert.doesNotMatch(f.integer(1234567), /,/);
  });

  test('the decimal separator in compact form is a comma, never a point', () => {
    // NBSP (U+00A0) between the number and the unit is what Intl emits, and it
    // is wanted: the figure must never wrap away from its unit.
    assert.equal(f.compact(1_240_000), '1,2 Mn');
    assert.doesNotMatch(f.compact(1_240_000), /\./);
    assert.equal(f.compact(1500), '1,5 B');
  });

  test('compact keeps small values whole', () => {
    assert.equal(f.compact(0), '0');
    assert.equal(f.compact(999), '999');
    assert.equal(f.compact(1000), '1 B');
  });

  test('the percent sign precedes the number', () => {
    assert.equal(f.percent(62), '%62');
    assert.equal(f.percent(0), '%0');
    assert.equal(f.percent(100), '%100');
    assert.doesNotMatch(f.percent(62), /62%/);
  });

  test('a percentage is rounded to a whole number, never shown with a separator', () => {
    assert.equal(f.percent(62.4), '%62');
    assert.equal(f.percent(62.5), '%63');
    assert.equal(f.percent(99.6), '%100');
  });

  test('the spoken percentage says "yüzde" first, matching the visual order', () => {
    assert.equal(f.percentSpoken(62), 'yüzde 62');
    assert.equal(f.percentSpoken(0), 'yüzde 0');
  });

  test('token and burn-rate suffixes are Turkish and unit-suffixed', () => {
    assert.equal(f.tokens(0), '0 token');
    assert.equal(f.tokens(1_240_000), '1,2 Mn token');
    assert.equal(f.burnRate(1500), '1,5 B token/sa');
  });

  test('the since-capture delta is signed and never a percentage', () => {
    const s = f.sinceCapture(1500);
    assert.match(s, /^o zamandan beri \+/);
    assert.match(s, /token$/);
    assert.doesNotMatch(s, /%/);
  });
});

// -------------------------------------------------------- Turkish casing

test.describe('Turkish casing', () => {
  test('a leading dotted i becomes İ, not I', () => {
    assert.equal(f.monogramLetter('istanbul'), 'İ');
    assert.notEqual(f.monogramLetter('istanbul'), 'I');
  });

  test('a leading dotless ı becomes I', () => {
    assert.equal(f.monogramLetter('ırmak'), 'I');
  });

  test('an empty or blank name yields a placeholder, never an exception', () => {
    assert.equal(f.monogramLetter(''), '?');
    assert.equal(f.monogramLetter('   '), '?');
  });

  test('an astral first character is not split into half a surrogate pair', () => {
    assert.equal(Array.from(f.monogramLetter('😀 Kimi')).length, 1);
  });
});

// -------------------------------------------------------------- state ramp

test.describe('state ramp thresholds', () => {
  test('each step begins at its threshold, measured on the DISPLAYED value', () => {
    // Was asserted on the raw value (stateFor(59.9) === 'calm'), which is the
    // bug code-reviewer F9 found: percent() prints Math.round(), so 59,9 shows
    // "%60" and colouring it 'calm' contradicts the label. The ramp now reads
    // the same rounded number the user reads.
    assert.equal(f.stateFor(0), 'calm');
    assert.equal(f.stateFor(59.4), 'calm');
    assert.equal(f.stateFor(59.5), 'watch');
    assert.equal(f.stateFor(60), 'watch');
    assert.equal(f.stateFor(84.4), 'watch');
    assert.equal(f.stateFor(84.5), 'ember');
    assert.equal(f.stateFor(85), 'ember');
    assert.equal(f.stateFor(99.4), 'ember');
    assert.equal(f.stateFor(99.5), 'spent');
    assert.equal(f.stateFor(100), 'spent');
  });

  test('the colour never contradicts the printed label', () => {
    // The property that matters, stated directly: whatever percent() prints,
    // stateFor() must have graded. A "%100" that is not 'spent' reads as a bug
    // in a product whose whole claim is that the figure shown is exactly true.
    for (let v = 0; v <= 100; v += 0.1) {
      const value = Math.round(v * 10) / 10;
      assert.equal(
        f.stateFor(value),
        f.stateFor(Math.round(value)),
        `${f.percent(value)} at raw ${value}`,
      );
    }
    assert.equal(f.percent(99.6), '%100');
    assert.equal(f.stateFor(99.6), 'spent');
    assert.equal(f.percent(84.6), '%85');
    assert.equal(f.stateFor(84.6), 'ember');
  });

  test('a percentage past 100 stays spent rather than wrapping', () => {
    assert.equal(f.stateFor(120), 'spent');
  });
});

// ------------------------------------------------------------ small guards

test.describe('numeric guards', () => {
  test('clamp01 pins to the unit interval and turns NaN into 0, not a wide bar', () => {
    assert.equal(f.clamp01(-1), 0);
    assert.equal(f.clamp01(0), 0);
    assert.equal(f.clamp01(0.5), 0.5);
    assert.equal(f.clamp01(1), 1);
    assert.equal(f.clamp01(2), 1);
    assert.equal(f.clamp01(NaN), 0);
    assert.equal(f.clamp01(Infinity), 0);
  });

  test('parseInstant returns null rather than NaN for anything unparseable', () => {
    for (const bad of [null, undefined, '', 'not a date', 42, {}]) {
      assert.equal(f.parseInstant(bad), null, JSON.stringify(bad));
    }
    assert.equal(f.parseInstant('2026-09-08T12:00:00.000Z'), Date.parse('2026-09-08T12:00:00.000Z'));
  });
});
