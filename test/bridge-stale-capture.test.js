'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Several Claude Code sessions run the bridge, each with the rate limits of
 * ITS OWN last request. An idle session used to put its old 3% over the 37% an
 * active one had just written (owner, 2026-09-28: the panel read %3 / %10 while
 * claude.ai read 30% / 15%). Within one window usage only grows, so an older
 * reading is recognisable and is not written.
 *
 * Every run gets its own LOCALAPPDATA: the real capture is never touched.
 */

const SCRIPT = path.join(__dirname, '..', 'bridge', 'claude-statusline.mjs');
const H5 = 1790611200; // a five-hour window's reset
const D7 = 1790823600; // a seven-day window's reset

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-stale-'));
}

function run(dir, five, seven) {
  const payload = {
    session_id: 's', model: { id: 'claude-opus-5' },
    rate_limits: {
      five_hour: { used_percentage: five[0], resets_at: five[1] },
      seven_day: { used_percentage: seven[0], resets_at: seven[1] },
    },
  };
  const res = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, LOCALAPPDATA: dir },
  });
  assert.equal(res.status, 0, res.stderr);
  return res;
}

function stored(dir) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'UsageNotch', 'claude-rate-limits.json'), 'utf8'));
  return [j.fiveHour.usedPercentage, j.sevenDay.usedPercentage];
}

test('an idle session\'s lower figure for the same window does not replace the newer one', () => {
  const dir = home();
  run(dir, [37, H5], [17, D7]);
  run(dir, [3, H5], [10, D7]);
  assert.deepEqual(stored(dir), [37, 17]);
});

test('a higher figure for the same window is written', () => {
  const dir = home();
  run(dir, [30, H5], [15, D7]);
  run(dir, [37, H5], [17, D7]);
  assert.deepEqual(stored(dir), [37, 17]);
});

test('a reading from an EARLIER window is older, whatever its figure', () => {
  const dir = home();
  run(dir, [5, H5], [17, D7]);
  run(dir, [90, H5 - 5 * 3600], [17, D7]);
  assert.deepEqual(stored(dir), [5, 17]);
});

test('after a reset the new window is written even though its figure is lower', () => {
  const dir = home();
  run(dir, [80, H5], [17, D7]);
  run(dir, [2, H5 + 5 * 3600], [18, D7]);
  assert.deepEqual(stored(dir), [2, 18]);
});

test('the same window reported a few seconds apart is still the same window', () => {
  const dir = home();
  run(dir, [37, H5], [17, D7]);
  run(dir, [3, H5 + 1], [10, D7 - 1]);
  assert.deepEqual(stored(dir), [37, 17]);
});

test('an unreadable capture on disk never blocks a new one', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, 'UsageNotch'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'UsageNotch', 'claude-rate-limits.json'), '{not json');
  run(dir, [3, H5], [10, D7]);
  assert.deepEqual(stored(dir), [3, 10]);
});
