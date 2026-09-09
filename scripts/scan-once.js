'use strict';
/**
 * Runs one cold scan against the real corpus and prints the snapshot, without
 * Electron. Used to verify the collector core in isolation.
 *
 *   node scripts/scan-once.js
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { scan } = require('../src/core/scan/scanner');
const agg = require('../src/core/aggregate');
const { readClaudeRateLimits } = require('../src/core/ratelimits');
const { buildSnapshot } = require('../src/core/snapshot');
const paths = require('../src/core/paths');

(async () => {
  const now = Date.now();
  const t0 = process.hrtime.bigint();
  const result = await scan({ root: paths.claudeProjectsDir(), cursors: {}, priorEvents: [], now });
  const t1 = process.hrtime.bigint();

  const cold = Number(t1 - t0) / 1e6;
  console.log('--- cold scan ---');
  console.log(JSON.stringify(result.stats, null, 2));
  console.log(`wall: ${cold.toFixed(1)} ms   rss: ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);

  const deduped = agg.dedupe(result.events);
  const rawBillable = result.events.reduce((s, e) => s + agg.billableOf(e), 0);
  const dedupBillable = deduped.reduce((s, e) => s + agg.billableOf(e), 0);
  console.log('--- dedup ---');
  console.log(`events ${result.events.length} -> ${deduped.length} unique`);
  console.log(`billable ${rawBillable} -> ${dedupBillable}`
    + (dedupBillable ? `  (inflation without dedup: ${((rawBillable / dedupBillable - 1) * 100).toFixed(1)}%)` : ''));

  const rl = readClaudeRateLimits({ now });
  console.log('--- rate limits ---');
  console.log(JSON.stringify(rl, null, 2));

  const snapshot = buildSnapshot({ now, events: result.events, rateLimits: rl, scanOk: result.ok, planLabel: null });
  console.log('--- snapshot ---');
  console.log(JSON.stringify(snapshot, null, 2));

  // Warm scan: everything should be cursor-skipped.
  const t2 = process.hrtime.bigint();
  const warm = await scan({ root: paths.claudeProjectsDir(), cursors: result.cursors, priorEvents: result.events, now: Date.now() });
  const t3 = process.hrtime.bigint();
  console.log('--- warm scan ---');
  console.log(JSON.stringify(warm.stats, null, 2));
  console.log(`wall: ${(Number(t3 - t2) / 1e6).toFixed(1)} ms`);

  // Prove the persisted form carries no path, no cwd, no text.
  const tmp = path.join(os.tmpdir(), 'usage-notch-scan-check');
  const store = require('../src/core/store');
  store.save(tmp, { cursors: result.cursors, events: result.events, builtAt: new Date().toISOString() });
  const raw = fs.readFileSync(store.storePath(tmp), 'utf8');
  // Match JSON KEYS, not bare substrings. Base62 requestIds contain sequences
  // like "cwd" by chance (req_011CeqhdTWwFhkRcwdGnsxHr is a real example from
  // this corpus), so the loose version cried wolf on every run — and a leak
  // check that always fails is a leak check nobody reads.
  const leaks = ['"cwd"', '"gitBranch"', '"toolUseResult"', '"content"', '"text"', '"summary"']
    .filter((k) => raw.includes(k));
  // Windows path shapes, anchored to a drive letter plus separator.
  if (/[A-Za-z]:[\\/]/.test(raw)) leaks.push('absolute path');
  console.log('--- store hygiene ---');
  console.log(`store bytes: ${raw.length}`);
  console.log(`suspect substrings present: ${leaks.length ? leaks.join(', ') : 'none'}`);
})();
