'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { retainClaudeFigures } = require('../src/core/ratelimits');
const { buildSnapshot } = require('../src/core/snapshot');
const { Collector } = require('../src/core/collector');
const log = require('../src/core/log');

/**
 * The bridge (`bridge/claude-statusline.mjs`) copies Claude Code's statusline
 * payload verbatim, so when Claude Code omits `rate_limits.<window>.
 * used_percentage` for a render — a reset-tail, or a gap between reports — a
 * FRESH capture carries `{ usedPercentage: null, resetsAtMs: <future> }` for a
 * window that has NOT reset. Left alone the reader/snapshot reads that as
 * `awaiting-report` ("yeni veri bekleniyor") and discards a still-true figure.
 *
 * The fix retains the last VALID figure per window while that window is current
 * and unchanged. These tests fix the rule at both levels: the pure reconciler
 * (`retainClaudeFigures`) and the collector that owns the held state across
 * rebuilds.
 */

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function reading(over) {
  return {
    state: 'fresh',
    capturedAt: new Date(NOW).toISOString(),
    capturedAtMs: NOW,
    ageMs: 0,
    fiveHour: null,
    sevenDay: null,
    ...over,
  };
}

function claudeOf(snapshot) {
  return snapshot.providers.find((p) => p.id === 'claude');
}

// --------------------------------------------------------- the pure reconciler

test.describe('retainClaudeFigures holds the last valid figure per window', () => {
  test('a real reading becomes the held figure, verbatim', () => {
    const out = retainClaudeFigures(
      reading({ fiveHour: { usedPercentage: 1, resetsAtMs: NOW + HOUR } }),
      null,
      NOW,
    );
    assert.equal(out.rateLimits.fiveHour.usedPercentage, 1);
    assert.deepEqual(out.retained.fiveHour, { resetsAtMs: NOW + HOUR, usedPercentage: 1 });
  });

  test('a transient null on the SAME current window keeps the held figure', () => {
    const held = { fiveHour: { resetsAtMs: NOW + HOUR, usedPercentage: 1 }, sevenDay: null };
    const out = retainClaudeFigures(
      reading({ fiveHour: { usedPercentage: null, resetsAtMs: NOW + HOUR } }),
      held,
      NOW,
    );
    assert.equal(out.rateLimits.fiveHour.usedPercentage, 1, 'the figure is retained');
    assert.equal(out.rateLimits.fiveHour.resetsAtMs, NOW + HOUR, 'against its own window');
    assert.deepEqual(out.retained.fiveHour, { resetsAtMs: NOW + HOUR, usedPercentage: 1 });
  });

  test('a null after the reset instant CHANGED does not retain — a genuine renewal', () => {
    const held = { fiveHour: { resetsAtMs: NOW + HOUR, usedPercentage: 1 }, sevenDay: null };
    const out = retainClaudeFigures(
      reading({ fiveHour: { usedPercentage: null, resetsAtMs: NOW + 2 * HOUR } }),
      held,
      NOW,
    );
    assert.equal(out.rateLimits.fiveHour.usedPercentage, null, 'a new window has no figure yet');
    assert.equal(out.retained.fiveHour, null, 'and the old figure is dropped, not carried into the new window');
  });

  test('a null on a rolled-over window (instant already passed) does not retain', () => {
    const held = { fiveHour: { resetsAtMs: NOW - 1, usedPercentage: 1 }, sevenDay: null };
    const out = retainClaudeFigures(
      reading({ fiveHour: { usedPercentage: null, resetsAtMs: NOW - 1 } }),
      held,
      NOW,
    );
    assert.equal(out.rateLimits.fiveHour.usedPercentage, null);
    assert.equal(out.retained.fiveHour, null);
  });

  test('a null with no reset instant at all is never retained', () => {
    const held = { fiveHour: { resetsAtMs: null, usedPercentage: 5 }, sevenDay: null };
    const out = retainClaudeFigures(
      reading({ fiveHour: { usedPercentage: null, resetsAtMs: null } }),
      held,
      NOW,
    );
    assert.equal(out.rateLimits.fiveHour.usedPercentage, null, 'no window identity to anchor to');
    assert.equal(out.retained.fiveHour, null);
  });

  test('a capture with no window at all leaves the held figure untouched', () => {
    // A missing / invalid / absent capture tells us nothing about the window;
    // holding the figure is safe because the read guard only ever resurfaces it
    // once a later reading proves the window is the same and still current.
    const held = { fiveHour: { resetsAtMs: NOW + HOUR, usedPercentage: 1 }, sevenDay: null };
    const out = retainClaudeFigures(reading({ state: 'missing', fiveHour: null }), held, NOW);
    assert.deepEqual(out.retained.fiveHour, { resetsAtMs: NOW + HOUR, usedPercentage: 1 });
    assert.equal(out.rateLimits.fiveHour, null);
  });

  test('the two windows are reconciled independently', () => {
    const held = { fiveHour: { resetsAtMs: NOW + HOUR, usedPercentage: 1 }, sevenDay: null };
    const out = retainClaudeFigures(
      reading({
        fiveHour: { usedPercentage: null, resetsAtMs: NOW + HOUR },       // retains
        sevenDay: { usedPercentage: 40, resetsAtMs: NOW + 3 * 24 * HOUR }, // fresh number
      }),
      held,
      NOW,
    );
    assert.equal(out.rateLimits.fiveHour.usedPercentage, 1);
    assert.equal(out.rateLimits.sevenDay.usedPercentage, 40);
    assert.deepEqual(out.retained.sevenDay, { resetsAtMs: NOW + 3 * 24 * HOUR, usedPercentage: 40 });
  });
});

// ------------------------------------------------- retention through the snapshot

test.describe('the retained figure reads as a live, honest number', () => {
  test('a retained figure is shown as known, not as awaiting-report', () => {
    const held = { fiveHour: { resetsAtMs: NOW + HOUR, usedPercentage: 1 }, sevenDay: null };
    const { rateLimits } = retainClaudeFigures(
      reading({ fiveHour: { usedPercentage: null, resetsAtMs: NOW + HOUR } }),
      held,
      NOW,
    );
    const c = claudeOf(buildSnapshot({ now: NOW, events: [], rateLimits, scanOk: true }));
    assert.equal(c.fiveHour.usedPercentage, 1);
    assert.equal(c.fiveHour.certainty, 'known');
    assert.equal(c.fiveHour.absence, null, 'the window is live, so there is no absence to state');
  });

  test('without a same-window held figure the renewal still says awaiting-report', () => {
    const held = { fiveHour: { resetsAtMs: NOW + HOUR, usedPercentage: 1 }, sevenDay: null };
    const { rateLimits } = retainClaudeFigures(
      reading({ fiveHour: { usedPercentage: null, resetsAtMs: NOW + 2 * HOUR } }),
      held,
      NOW,
    );
    const c = claudeOf(buildSnapshot({ now: NOW, events: [], rateLimits, scanOk: true }));
    assert.equal(c.fiveHour.usedPercentage, null);
    assert.equal(c.fiveHour.absence, 'awaiting-report', 'a genuine renewal is untouched by retention');
  });
});

// -------------------------------------------------- the collector owns the state

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-retain-'));
}

function collectorFor(dir) {
  return new Collector({
    userDataDir: dir,
    projectsRoot: path.join(dir, 'projects'),
    rateLimitsFile: path.join(dir, 'claude-rate-limits.json'),
    rateLimitsDir: dir,
    antigravityQuotaFile: path.join(dir, 'antigravity-quota.json'),
    // An empty dir, so the IDE reader resolves no install and reads nothing off
    // the developer's own machine.
    ideAppDataDir: path.join(dir, 'ide'),
  });
}

/** A fresh Claude capture on disk. `five` is written verbatim as the payload's
 *  five-hour block; `resets_at` is epoch SECONDS, as Claude Code states it. */
function writeClaude(dir, five) {
  fs.writeFileSync(path.join(dir, 'claude-rate-limits.json'), JSON.stringify({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    present: true,
    fiveHour: five,
    sevenDay: { usedPercentage: 10, resetsAt: Math.floor((Date.now() + 3 * 24 * HOUR) / 1000) },
  }));
}

test.describe('the collector retains across rebuilds and resets on a window change', () => {
  test('a transient null after a real reading keeps the figure', () => {
    const dir = tmpdir();
    const futureSec = Math.floor((Date.now() + HOUR) / 1000);
    const c = collectorFor(dir);

    writeClaude(dir, { usedPercentage: 1, resetsAt: futureSec });
    c.rebuild();
    assert.equal(claudeOf(c.snapshot).fiveHour.usedPercentage, 1, 'the real reading');

    // Same window (same resets_at), no percentage this render.
    writeClaude(dir, { resetsAt: futureSec });
    c.rebuild();
    const held = claudeOf(c.snapshot).fiveHour;
    assert.equal(held.usedPercentage, 1, 'retained across the transient null');
    assert.equal(held.absence, null);
  });

  test('a null after the window changes shows the renewal, and retention resets', () => {
    const dir = tmpdir();
    const futureSec = Math.floor((Date.now() + HOUR) / 1000);
    const c = collectorFor(dir);

    writeClaude(dir, { usedPercentage: 1, resetsAt: futureSec });
    c.rebuild();

    // A NEW window: different resets_at, no figure yet.
    writeClaude(dir, { resetsAt: futureSec + 600 });
    c.rebuild();
    const win = claudeOf(c.snapshot).fiveHour;
    assert.equal(win.usedPercentage, null, 'the renewal genuinely has no number yet');
    assert.equal(win.absence, 'awaiting-report');
    assert.equal(c._claudeRetained.fiveHour, null, 'the collector dropped the old window figure');
  });

  test('a window that rolled over stays rolled-over, never retained', () => {
    const dir = tmpdir();
    const c = collectorFor(dir);

    writeClaude(dir, { usedPercentage: 96, resetsAt: Math.floor((Date.now() + HOUR) / 1000) });
    c.rebuild();

    // The window's instant is now in the past: it has rolled over.
    writeClaude(dir, { usedPercentage: 96, resetsAt: Math.floor((Date.now() - 60_000) / 1000) });
    c.rebuild();
    assert.equal(claudeOf(c.snapshot).fiveHour.usedPercentage, null);
    assert.equal(claudeOf(c.snapshot).fiveHour.absence, 'rolled-over');
  });
});

test.describe('the Antigravity path is unaffected by Claude retention', () => {
  test('an Antigravity window that loses its figure is NOT retained', () => {
    const dir = tmpdir();
    const quotaFile = path.join(dir, 'antigravity-quota.json');
    const c = collectorFor(dir);

    // A weekly Antigravity figure via the CLI hook shape.
    fs.writeFileSync(quotaFile, JSON.stringify({
      capturedAt: new Date().toISOString(),
      present: true,
      quota: { 'gemini-weekly': { remainingFraction: 0.9, resetInSeconds: 3 * 24 * 60 * 60 } },
    }));
    log.setSink(() => {});
    try {
      c.rebuild();
      const ag1 = c.snapshot.providers.find((p) => p.id === 'antigravity');
      assert.equal(ag1.sevenDay.usedPercentage, 10, '1 - 0.9 = 10% used');

      // The hook now reports no usable quota. Claude's retention must not reach
      // across and keep the old Antigravity figure alive.
      fs.writeFileSync(quotaFile, JSON.stringify({
        capturedAt: new Date().toISOString(),
        present: true,
        quota: {},
      }));
      c.rebuild();
      const ag2 = c.snapshot.providers.find((p) => p.id === 'antigravity');
      assert.equal(ag2.sevenDay.usedPercentage, null, 'no cross-provider retention');
    } finally {
      log.setSink(null);
    }
  });
});
