'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * The capture write when the rename is refused.
 *
 * Both statusline bridges write tmp + rename. On Windows a rename onto a file
 * that another process is renaming over at the same instant fails with EPERM
 * (measured on this project's dev machine: six processes renaming onto one
 * target saw 5-8% of renames refused). That is exactly two Claude Code — or
 * two agy — sessions firing their hooks together. An AV scanner or indexer
 * holding the target open without FILE_SHARE_DELETE does the same.
 *
 * Before this was pinned, a refused rename was swallowed by the bridge's
 * catch-all: the capture was silently dropped, the status line rendered
 * blank, and `<file>.<pid>.tmp` was left in %LOCALAPPDATA%\UsageNotch forever.
 * The four-writer race in `antigravity-edges.test.js` hit this only when the
 * scheduler happened to line two renames up, which is why it flaked.
 *
 * These tests do not wait for the scheduler. A preload replaces
 * `fs.renameSync` (and re-syncs the builtin ESM bindings the bridge imports)
 * so the refusal happens on exactly the attempts the test names.
 */

const BRIDGES = [
  {
    name: 'claude',
    script: path.join(__dirname, '..', 'bridge', 'claude-statusline.mjs'),
    file: 'claude-rate-limits.json',
    payload: (pct) => ({ rate_limits: { five_hour: { used_percentage: pct, resets_at: 1789000000 } } }),
    figure: (capture) => capture.fiveHour.usedPercentage,
  },
  {
    name: 'antigravity',
    script: path.join(__dirname, '..', 'bridge', 'antigravity-statusline.mjs'),
    file: 'antigravity-quota.json',
    payload: (pct) => ({ quota: { 'gemini-weekly': { remaining_fraction: pct / 100 } } }),
    figure: (capture) => Math.round(capture.quota['gemini-weekly'].remainingFraction * 100),
  },
];

const PRELOAD = `'use strict';
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const realRename = fs.renameSync;
let refusals = Number(process.env.USAGE_NOTCH_TEST_REFUSE_RENAMES);
let calls = 0;
fs.renameSync = function renameSync(...args) {
  calls += 1;
  if (refusals > 0) {
    refusals -= 1;
    const err = new Error('EPERM: operation not permitted, rename (simulated)');
    err.code = 'EPERM';
    throw err;
  }
  return realRename.apply(this, args);
};
syncBuiltinESMExports();
process.on('exit', () => {
  fs.writeFileSync(process.env.USAGE_NOTCH_TEST_RENAME_CALLS, String(calls));
});
`;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-atomic-'));
}

/** Runs one bridge with the first `refuse` renames refused. */
function runRefused(bridge, { refuse, pct, previous }) {
  const out = tmpdir();
  const preload = path.join(out, 'refuse-rename.cjs');
  fs.writeFileSync(preload, PRELOAD);
  const callsFile = path.join(out, 'rename-calls.txt');
  const dir = path.join(out, 'UsageNotch');
  const file = path.join(dir, bridge.file);
  if (previous !== undefined) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, previous);
  }
  const res = spawnSync(process.execPath, ['--require', preload, bridge.script], {
    input: JSON.stringify(bridge.payload(pct)),
    encoding: 'utf8',
    env: {
      ...process.env,
      LOCALAPPDATA: out,
      USAGE_NOTCH_TEST_REFUSE_RENAMES: String(refuse),
      USAGE_NOTCH_TEST_RENAME_CALLS: callsFile,
    },
  });
  return {
    status: res.status,
    stderr: res.stderr,
    stdout: res.stdout,
    file,
    renameCalls: Number(fs.readFileSync(callsFile, 'utf8')),
    leftovers: fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')) : [],
  };
}

for (const bridge of BRIDGES) {
  test.describe(`${bridge.name} bridge: a refused rename`, () => {
    test('the preload really intercepts the bridge\'s rename', () => {
      // Guards the seam itself: if the bridge ever stops importing renameSync
      // from node:fs, the tests below would pass without refusing anything.
      const r = runRefused(bridge, { refuse: 0, pct: 40 });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.renameCalls, 1);
      assert.equal(bridge.figure(JSON.parse(fs.readFileSync(r.file, 'utf8'))), 40);
    });

    test('a transient refusal still lands the capture, and leaves no temp file', () => {
      const r = runRefused(bridge, { refuse: 3, pct: 70, previous: '{"old":true}' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.renameCalls, 4, 'three refusals, then the rename that succeeded');
      assert.equal(bridge.figure(JSON.parse(fs.readFileSync(r.file, 'utf8'))), 70, 'this writer\'s capture, whole');
      assert.deepEqual(r.leftovers, []);
      assert.notEqual(r.stdout, '', 'the status line is not blanked by a lock that cleared');
    });

    test('a refusal that never clears gives up quickly, keeps the old capture whole, and litters nothing', () => {
      const previous = '{"old":true}';
      const r = runRefused(bridge, { refuse: 1000, pct: 70, previous });
      assert.equal(r.status, 0, 'a hook failure must never break the host CLI');
      assert.ok(r.renameCalls > 1, 'a transient code is retried');
      assert.ok(r.renameCalls <= 10, `bounded: ${r.renameCalls} attempts`);
      assert.equal(fs.readFileSync(r.file, 'utf8'), previous, 'the last good capture is untouched');
      assert.deepEqual(r.leftovers, [], 'no <pid>.tmp is left to accumulate');
    });
  });
}
