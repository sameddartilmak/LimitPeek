'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTooltip, tooltipParts, TOOLTIP_MAX, COUNTDOWN_FLOOR_MS, RESETTING, NO_PERCENT,
  FIVE_LABEL, WEEK_LABEL, REMAINING,
} = require('../src/core/tray-tooltip');
const { stateForPercentage } = require('../src/core/tray-spec');

/**
 * The tooltip is the FOURTH surface printing this number, after the panel
 * meter, the panel's text and the donut. Everything below is about it not
 * contradicting the other three, and about it fitting in a buffer the shell
 * truncates silently.
 */

const NOW = Date.parse('2026-09-08T12:00:00.000Z');

function row(over = {}) {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    accent: '#C96442',
    enabled: true,
    connected: true,
    status: 'ok',
    fiveHour: {
      usedPercentage: 61.6,
      certainty: 'known',
      resetsAt: new Date(NOW + 2 * 3600e3 + 14 * 60e3).toISOString(),
    },
    sevenDay: { usedPercentage: 41.2, certainty: 'known', resetsAt: null },
    ...over,
  };
}

const snap = (providers) => ({ generatedAt: new Date(NOW).toISOString(), providers });

/* ------------------------------------------------------------- content */

test.describe('what the tooltip says', () => {
  test('provider, 5h figure, its countdown, and the weekly figure', () => {
    const text = buildTooltip(snap([row()]), NOW);
    assert.deepEqual(text.split('\n'), [
      'LimitPeek — Claude Code',
      '5 saatlik limit: %62 (2 sa 14 dk kaldı)',
      'Haftalık limit: %41',
    ]);
  });

  test('one idea per line: no separator packs two facts onto one', () => {
    // The user reported the tooltip as hard to read. A native tooltip has no
    // weight, colour or alignment, so the line break is the only structure
    // available and ` · ` was spending it. Every line is now one label and one
    // value, which is what makes the numbers scannable down a single column.
    const text = buildTooltip(snap([row()]), NOW);
    assert.equal(text.includes(' · '), false, text);
    for (const line of text.split('\n').slice(1)) {
      assert.equal(line.split(': ').length, 2, `two facts on one line: ${line}`);
    }
  });

  test('no cryptic abbreviation survives on either label', () => {
    const text = buildTooltip(snap([row()]), NOW);
    assert.equal(/(^|\s)5sa:/.test(text), false, text);
    assert.equal(/(^|\s)Hafta:/.test(text), false, text);
  });

  test('four facts ride on three lines, because a fourth line does not fit', () => {
    // The countdown is a parenthetical on the figure it qualifies rather than
    // a line of its own, which is what buys the room for the weekly window.
    assert.equal(buildTooltip(snap([row()]), NOW).split('\n').length, 3);
  });

  test('the countdown drops a zero minor unit, exactly like the panel row', () => {
    const at = new Date(NOW + 3 * 3600e3).toISOString();
    const text = buildTooltip(snap([row({ fiveHour: { usedPercentage: 10, certainty: 'known', resetsAt: at } })]), NOW);
    assert.ok(text.includes(`(3 sa ${REMAINING})`), text);
    assert.equal(text.includes('0 dk'), false, text);
  });

  test('inside the horizon, BOTH the countdown and the number are withheld', () => {
    // The tooltip has no clock: it is written on a snapshot and read whenever
    // the user hovers, up to a full idle sweep later. "48 sn" would be false by
    // the time it was read ("0 dk" is no better) — and so would the percentage
    // it framed, which is the more damaging half.
    const at = new Date(NOW + 45_000).toISOString();
    const text = buildTooltip(snap([row({ fiveHour: { usedPercentage: 98, certainty: 'known', resetsAt: at } })]), NOW);
    assert.ok(text.includes(`${FIVE_LABEL}: ${RESETTING}`), text);
    assert.equal(text.includes('%98'), false, text);
    assert.equal(text.includes(REMAINING), false, text);
    assert.equal(text.includes('sn'), false, text);
  });

  test('the floor matches the cadence that makes the string stale', () => {
    const collector = require('../src/core/collector');
    assert.equal(COUNTDOWN_FLOOR_MS, collector.SWEEP_IDLE_MS);
  });

  test('one second above the floor, the countdown is back', () => {
    const at = new Date(NOW + COUNTDOWN_FLOOR_MS + 1000).toISOString();
    const text = buildTooltip(snap([row({ fiveHour: { usedPercentage: 98, certainty: 'known', resetsAt: at } })]), NOW);
    assert.ok(text.includes(REMAINING), text);
  });

  test('a reset already in the past states the reset, not the old figure', () => {
    const at = new Date(NOW - 60e3).toISOString();
    const text = buildTooltip(snap([row({ fiveHour: { usedPercentage: 10, certainty: 'known', resetsAt: at } })]), NOW);
    assert.ok(text.includes(`${FIVE_LABEL}: ${RESETTING}`), text);
    assert.equal(text.includes('%10'), false, 'the window it described no longer exists');
    assert.equal(text.includes(REMAINING), false, 'and it has no time left to state');
  });

  test('the weekly window gets the identical treatment', () => {
    // It resets far more rarely, which makes it easier to forget and no less
    // wrong when it happens.
    const at = new Date(NOW - 60e3).toISOString();
    const text = buildTooltip(snap([row({ sevenDay: { usedPercentage: 41, certainty: 'known', resetsAt: at } })]), NOW);
    assert.ok(text.includes(`${WEEK_LABEL}: ${RESETTING}`), text);
    assert.equal(text.includes('%41'), false, text);
    assert.ok(text.includes(`${FIVE_LABEL}: %62`), 'and the other window is untouched');
  });

  test('a window with no resetsAt at all keeps its figure', () => {
    // That combination only reaches us from a FRESH capture (snapshot.js),
    // where the reading is true and there is simply no reset instant to reason
    // about. Blanking it would delete a good number over a missing field.
    const text = buildTooltip(snap([row({ fiveHour: { usedPercentage: 33, certainty: 'known', resetsAt: null } })]), NOW);
    assert.ok(text.includes(`${FIVE_LABEL}: %33`), text);
    assert.equal(text.includes(REMAINING), false, 'and no empty countdown beside it');
  });

  test('an unparsable resetsAt costs the countdown, not the percentage', () => {
    for (const bad of ['', 'yesterday', null, undefined, 42, {}]) {
      const text = buildTooltip(snap([row({ fiveHour: { usedPercentage: 10, certainty: 'known', resetsAt: bad } })]), NOW);
      assert.ok(text.includes(`${FIVE_LABEL}: %10`), `${JSON.stringify(bad)} -> ${text}`);
      assert.equal(text.includes('NaN'), false);
      assert.equal(text.includes('Invalid'), false);
    }
  });
});

/* -------------------------------------------------- the honesty rule */

test.describe('it refuses to print a percentage it cannot defend', () => {
  test("certainty 'unknown' says so in words", () => {
    const text = buildTooltip(snap([row({ fiveHour: { usedPercentage: 61, certainty: 'unknown', resetsAt: null } })]), NOW);
    assert.ok(text.includes(`${FIVE_LABEL}: ${NO_PERCENT}`), text);
    assert.equal(/%\d/.test(text.split('\n')[1]), false, 'no number may survive on that line');
  });

  test('a null window, a null percentage and a disconnected provider all read alike', () => {
    for (const over of [
      { fiveHour: null },
      { fiveHour: { usedPercentage: null, certainty: 'known', resetsAt: null } },
      { connected: false },
    ]) {
      const text = buildTooltip(snap([row(over)]), NOW);
      assert.ok(text.includes(`${FIVE_LABEL}: ${NO_PERCENT}`), `${JSON.stringify(over)} -> ${text}`);
    }
  });

  test('the weekly line gets the same treatment, independently of the 5h one', () => {
    const text = buildTooltip(snap([row({ sevenDay: null })]), NOW);
    assert.ok(text.includes(`${FIVE_LABEL}: %62`), text);
    assert.ok(text.includes(`${WEEK_LABEL}: ${NO_PERCENT}`), text);
  });

  test('nothing added to the panel names no provider at all', () => {
    // The icon is drawing the no-data ring; naming a provider here would
    // describe a row that is not on screen anywhere.
    const text = buildTooltip(snap([row({ enabled: false })]), NOW);
    assert.deepEqual(text.split('\n'), ['LimitPeek', 'Panelde sağlayıcı yok']);
    assert.equal(text.includes('Claude'), false);
  });

  test('an empty or malformed snapshot is a sentence, not a throw', () => {
    for (const bad of [null, undefined, {}, { providers: [] }, { providers: null }, { providers: [null] }]) {
      const text = buildTooltip(bad, NOW);
      assert.ok(text.length > 0 && !text.includes('undefined'), JSON.stringify(bad));
    }
  });

  test('a provider with no displayName is not printed as "undefined"', () => {
    const text = buildTooltip(snap([row({ displayName: '' })]), NOW);
    assert.equal(text.includes('undefined'), false, text);
  });
});

/* ------------------------------------------------- agreement with the rest */

test.describe('it cannot contradict the panel or the donut', () => {
  test('the value is ROUNDED, tr-TR, and never carries a fractional digit', () => {
    for (const [pct, shown] of [[61.6, '%62'], [61.4, '%61'], [0.4, '%0'], [99.5, '%100'], [100, '%100']]) {
      const text = buildTooltip(snap([row({ fiveHour: { usedPercentage: pct, certainty: 'known', resetsAt: null } })]), NOW);
      assert.ok(text.includes(`${FIVE_LABEL}: ${shown}`), `${pct} -> ${text}`);
      assert.equal(/,\d/.test(text), false, `${pct} printed a fractional digit`);
    }
  });

  test('it rounds the same way the state ramp steps', () => {
    // 61.6 rounds to 62, and 62 is 'watch'. If the tooltip printed %61 the
    // icon would be amber-ramped next to a number below the threshold.
    const text = buildTooltip(snap([row()]), NOW);
    assert.ok(text.includes('%62'));
    assert.equal(stateForPercentage(61.6), 'watch');
  });

  test('an out-of-range percentage is REJECTED, exactly as the renderer rejects it', () => {
    // Clamping 140 to 100 would print a confident "%100" out of a value that
    // proves the producer is wrong, while the panel — whose sanitiser rejects
    // it — shows no meter at all. Two surfaces, one number, one rule.
    for (const bad of [140, 100.5, -1, -0.5]) {
      const text = buildTooltip(snap([row({ fiveHour: { usedPercentage: bad, certainty: 'known', resetsAt: null } })]), NOW);
      assert.ok(text.includes(`${FIVE_LABEL}: ${NO_PERCENT}`), `${bad} -> ${text}`);
    }
    // The endpoints themselves are legitimate and must survive.
    for (const [ok, shown] of [[0, '%0'], [100, '%100']]) {
      const text = buildTooltip(snap([row({ fiveHour: { usedPercentage: ok, certainty: 'known', resetsAt: null } })]), NOW);
      assert.ok(text.includes(`${FIVE_LABEL}: ${shown}`), `${ok} -> ${text}`);
    }
  });
});

/* ------------------------------------------------------------- the budget */

test.describe('it fits in a buffer the shell truncates silently', () => {
  test('every realistic tooltip is inside the budget', () => {
    // Worst case on each axis at once: the longest display name, both windows
    // at three digits, and a multi-day countdown.
    const worst = row({
      displayName: 'Antigravity',
      fiveHour: { usedPercentage: 100, certainty: 'known', resetsAt: new Date(NOW + 3 * 86400e3 + 3600e3).toISOString() },
      sevenDay: { usedPercentage: 100, certainty: 'known', resetsAt: null },
    });
    const text = buildTooltip(snap([worst]), NOW);
    assert.ok(text.length <= TOOLTIP_MAX, `${text.length} chars: ${JSON.stringify(text)}`);
    assert.ok(text.length <= 127, 'and inside NOTIFYICONDATAW.szTip either way');
  });

  test('the budget holds in BOTH languages, for every state a line can be in (ADR-004)', () => {
    // English is usually shorter, not always: "not reported" and "resetting"
    // are words, not abbreviations. Every combination of the longest name,
    // each line state and the widest countdown is measured in tr-TR, en-US
    // and en-GB, and must fit WITHOUT dropping a line — the ladder is a
    // guarantee against a pathological name, not a routine path.
    const i18n = require('../src/core/i18n');
    const widest = new Date(NOW + 6 * 86400e3 + 23 * 3600e3).toISOString();
    const states = [
      { usedPercentage: 100, certainty: 'known', resetsAt: widest },
      { usedPercentage: null, certainty: 'unknown', resetsAt: null },
      { usedPercentage: null, certainty: 'unknown', resetsAt: null, absence: 'not-supplied' },
      { usedPercentage: 100, certainty: 'known', resetsAt: new Date(NOW - 1000).toISOString() },
    ];
    try {
      for (const [language, locale] of [['tr', 'tr-TR'], ['en', 'en-US'], ['en', 'en-GB']]) {
        i18n.setLocale(language, locale);
        for (const fiveHour of states) {
          for (const sevenDay of states) {
            const text = buildTooltip(snap([row({ displayName: 'Antigravity', fiveHour, sevenDay })]), NOW);
            assert.ok(text.length <= TOOLTIP_MAX, `${locale} ${text.length} chars: ${JSON.stringify(text)}`);
            assert.equal(text.split('\n').length, 3, `${locale}: a line was dropped: ${JSON.stringify(text)}`);
          }
        }
      }
    } finally {
      i18n.setLocale('tr', 'tr-TR');
    }
  });

  test('an English tooltip is English throughout, with the sign after the number', () => {
    const i18n = require('../src/core/i18n');
    i18n.setLocale('en', 'en-US');
    try {
      const text = buildTooltip(snap([row({
        sevenDay: { usedPercentage: null, certainty: 'unknown', resetsAt: null, absence: 'not-supplied' },
      })]), NOW);
      assert.equal(text, 'LimitPeek — Claude Code\n5-hour limit: 62% (2h 14m left)\nWeekly limit: not reported');
      assert.doesNotMatch(text, /[çğıöşüÇĞİÖŞÜ]|kaldı|sa |dk/);
      const empty = buildTooltip(snap([]), NOW);
      assert.equal(empty, 'LimitPeek\nNo providers in the panel');
    } finally {
      i18n.setLocale('tr', 'tr-TR');
    }
  });

  test('the weekly line is dropped first, not the 5h figure', () => {
    // 50 characters of provider name: enough that all three lines cannot fit,
    // not enough to threaten the five-hour line or the countdown riding on it.
    const s = snap([row({ displayName: 'x'.repeat(50) })]);
    const parts = tooltipParts(s, NOW);
    const text = buildTooltip(s, NOW);
    assert.ok(text.length <= TOOLTIP_MAX, `${text.length}`);
    assert.equal(text, `${parts.head}\n${parts.five}`,
      'it drops whole lines, it does not slice them');
    assert.ok(text.includes(`${FIVE_LABEL}: %62`), 'the headline figure must be the last to go');
    assert.ok(text.includes(`(2 sa 14 dk ${REMAINING})`), text);
    assert.equal(text.includes(WEEK_LABEL), false, 'the weekly line is the least important');
  });

  test('then the five-hour line whole — never a mid-word cut', () => {
    // A countdown is no longer separable from the figure it frames, so the
    // ladder drops the pair together rather than keeping a bare percentage
    // that has lost the horizon it was true over.
    const s = snap([row({ displayName: 'y'.repeat(70) })]);
    const parts = tooltipParts(s, NOW);
    const text = buildTooltip(s, NOW);
    assert.ok(text.length <= TOOLTIP_MAX, `${text.length}`);
    assert.equal(text, parts.head, 'it drops whole lines, it does not slice them');
    assert.equal(text.includes(REMAINING), false, 'the countdown left with its figure');
    assert.equal(text.includes(FIVE_LABEL), false, text);
  });

  test('an absurd provider name is cut, but only as a last resort', () => {
    const text = buildTooltip(snap([row({ displayName: 'z'.repeat(400) })]), NOW);
    assert.ok(text.length <= TOOLTIP_MAX, `${text.length}`);
    assert.equal(text.includes('\n'), false, 'nothing else could fit beside it');
  });

  test('the budget is measured in UTF-16 units, which is what szTip counts', () => {
    // Turkish letters are single units; the check exists so a future emoji or
    // a surrogate pair is counted the way the shell counts it.
    const text = buildTooltip(snap([row()]), NOW);
    assert.equal(text.length, [...text].length, 'no surrogate pairs in this string');
    assert.ok(TOOLTIP_MAX <= 127, 'the budget must stay inside WCHAR szTip[128]');
  });
});
