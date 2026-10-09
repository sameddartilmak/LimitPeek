'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * The bridge keeps a one-line-per-run log next to its capture. Owner,
 * 2026-10-09: the panel read "Güncel değil · 13 sa" while Claude Code
 * sessions were open, and nothing on disk could say whether the bridge had
 * not run or had refused to write. These fix what that log says, what it may
 * never carry, and that it stays small.
 *
 * Every run gets its own LOCALAPPDATA: the real capture is never touched.
 */

const SCRIPT = path.join(__dirname, '..', 'bridge', 'claude-statusline.mjs');
const H5 = 1790611200;
const D7 = 1790823600;
const SECRET = 'do-not-log-this-prompt-text';

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-runlog-'));
}

function run(dir, five, seven, extra = {}) {
  const payload = {
    session_id: '1a2b3c4d-5e6f-7080-90a0-b0c0d0e0f000',
    version: '2.1.295',
    cwd: `C:\\Users\\someone\\${SECRET}`,
    transcript_path: `C:\\Users\\someone\\${SECRET}.jsonl`,
    session_name: SECRET,
    rate_limits: {
      five_hour: { used_percentage: five[0], resets_at: five[1] },
      seven_day: { used_percentage: seven[0], resets_at: seven[1] },
    },
    ...extra,
  };
  const res = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, LOCALAPPDATA: dir },
  });
  assert.equal(res.status, 0, res.stderr);
}

function logLines(dir) {
  const text = fs.readFileSync(path.join(dir, 'UsageNotch', 'claude-bridge-log.jsonl'), 'utf8');
  return text.trim().split('\n').map((l) => JSON.parse(l));
}

test('a written capture is logged with its figures, version and session prefix', () => {
  const dir = home();
  run(dir, [37, H5], [17, D7]);
  const [line] = logLines(dir);
  assert.equal(line.outcome, 'written');
  assert.deepEqual(line.five, [37, H5]);
  assert.deepEqual(line.seven, [17, D7]);
  assert.equal(line.v, '2.1.295');
  assert.equal(line.sid, '1a2b3c4d');
  assert.equal(line.present, true);
  assert.ok(Number.isFinite(Date.parse(line.at)));
});

test('a refused capture is logged with what was stored, so the refusal can be checked', () => {
  const dir = home();
  run(dir, [37, H5], [17, D7]);
  run(dir, [3, H5], [10, D7]);
  const lines = logLines(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].outcome, 'older-than-stored');
  assert.deepEqual(lines[1].five, [3, H5]);
  assert.deepEqual(lines[1].storedFive, [37, H5]);
  assert.deepEqual(lines[1].storedSeven, [17, D7]);
});

test('the log never carries a path, a session name or any other payload text', () => {
  const dir = home();
  run(dir, [37, H5], [17, D7]);
  const text = fs.readFileSync(path.join(dir, 'UsageNotch', 'claude-bridge-log.jsonl'), 'utf8');
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes('someone'), false);
  assert.deepEqual(Object.keys(logLines(dir)[0]).sort(), ['at', 'five', 'outcome', 'present', 'seven', 'sid', 'v']);
});

test('a version or session id of an unexpected shape is dropped, not copied', () => {
  const dir = home();
  run(dir, [37, H5], [17, D7], { version: `2.1 ${SECRET}`, session_id: '../../x' });
  const [line] = logLines(dir);
  assert.equal(line.v, null);
  assert.equal(line.sid, null);
});

test('the log stays small: past its cap it becomes .old and a new one starts', () => {
  const dir = home();
  const out = path.join(dir, 'UsageNotch');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'claude-bridge-log.jsonl'), 'x'.repeat(65 * 1024) + '\n');
  run(dir, [37, H5], [17, D7]);
  assert.equal(fs.statSync(path.join(out, 'claude-bridge-log.jsonl.old')).size > 64 * 1024, true);
  assert.equal(logLines(dir).length, 1);
});
