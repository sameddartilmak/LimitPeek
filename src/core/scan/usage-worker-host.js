'use strict';
const { parentPort } = require('node:worker_threads');
const log = require('../log');
const { sameEvents } = require('../same-events');

/**
 * The long-lived scan worker protocol shared by the Gemini and Kimi readers.
 * Identical to the Codex worker's (codex/scan-worker.js), which it mirrors:
 * the scanner and its per-file cache live in the worker, so a rescan only reads
 * what changed, and the main thread never opens a chat log for usage.
 *
 *   in   { type: 'scan', id, now, startMs, home }
 *   out  { type: 'result', id, events, stats, unreadRange }
 *        { type: 'result', id, unchanged: true, stats, unreadRange }   same events as
 *                                      the previous result of THIS worker (ADR-003 A6 F3)
 *        { type: 'error', id, code }
 *        { type: 'log', level, msg }   fixed messages only, never content
 *
 * @param {{scan: Function, stats: Function, unreadRange: Function}} scanner
 */
function hostScanner(scanner) {
  log.setSink((level, msg) => {
    if (parentPort) parentPort.postMessage({ type: 'log', level, msg });
  });
  if (!parentPort) return;
  let lastEvents = null;
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object' || msg.type !== 'scan') return;
    try {
      const events = scanner.scan({
        now: msg.now,
        startMs: msg.startMs,
        home: msg.home || undefined,
      });
      const unchanged = lastEvents !== null && sameEvents(lastEvents, events);
      lastEvents = events;
      parentPort.postMessage({
        type: 'result',
        id: msg.id,
        ...(unchanged ? { unchanged: true } : { events }),
        stats: scanner.stats(),
        unreadRange: scanner.unreadRange(),
      });
    } catch (err) {
      // A code only: an error message could quote a path or a line.
      parentPort.postMessage({ type: 'error', id: msg.id, code: (err && err.code) || 'ESCAN' });
    }
  });
}

module.exports = { hostScanner };
