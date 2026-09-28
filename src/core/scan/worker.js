'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { scan } = require('./scanner');
const log = require('../log');

/**
 * Worker entry point. The cold scan of the reference corpus measured at
 * 585-864 ms and ~100 MB RSS; running it on the Electron main thread would
 * freeze the tray and the panel for that long on every sweep.
 *
 * The worker's log sink forwards to the parent instead of writing to stdout,
 * so parse-discipline stays centralised in `core/log.js`.
 */
log.setSink((level, msg) => {
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg });
});

(async () => {
  try {
    const result = await scan({
      root: workerData.root,
      cursors: workerData.cursors,
      priorEvents: workerData.priorEvents,
      archive: workerData.archive,
      now: workerData.now,
      retentionDays: workerData.retentionDays,
      maxDepth: workerData.maxDepth,
    });
    if (parentPort) parentPort.postMessage({ type: 'result', result });
  } catch (err) {
    if (parentPort) {
      parentPort.postMessage({ type: 'error', code: (err && err.code) || (err && err.name) || 'ESCAN' });
    }
  }
})();
