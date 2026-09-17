'use strict';
const { parentPort } = require('node:worker_threads');
const { createCodexUsageScanner } = require('./usage');
const log = require('../log');

/**
 * Codex rollout scan worker (ADR-002 Amendment 3.11).
 *
 * Unlike the Claude scan worker, which is spawned per scan and handed its
 * cursors, this one is LONG-LIVED: the scanner's per-file cache (offsets,
 * running totals, folded UTC 15-minute buckets) lives here, so a rescan only reads what
 * changed. The main thread never touches a rollout for usage; it only receives
 * the resulting turn deltas.
 *
 * Protocol (one request at a time; the collector never overlaps them):
 *   in   { type: 'scan', id, now, startMs, home, changed? }
 *   out  { type: 'result', id, events, stats, unreadRange }
 *        { type: 'error', id, code }
 *        { type: 'log', level, msg }   fixed messages only, never content
 */
log.setSink((level, msg) => {
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg });
});

const scanner = createCodexUsageScanner();

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object' || msg.type !== 'scan') return;
    try {
      const events = scanner.scan({
        now: msg.now,
        startMs: msg.startMs,
        home: msg.home || undefined,
        changed: Array.isArray(msg.changed) ? msg.changed : undefined,
      });
      parentPort.postMessage({
        type: 'result',
        id: msg.id,
        events,
        stats: scanner.stats(),
        // { fromMs, throughMs } of turns known unread, or null (ADR-002 A3.15).
        unreadRange: scanner.unreadRange(),
      });
    } catch (err) {
      // A code only: an error message could quote a path or a line.
      parentPort.postMessage({ type: 'error', id: msg.id, code: (err && err.code) || 'ESCAN' });
    }
  });
}
