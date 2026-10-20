'use strict';
const path = require('node:path');

/**
 * The taskbar's button area — Start, Search, Task View, Widgets and the task
 * list — which the strip must never cover (taskbar-strip.js). Measured with
 * UI Automation in a worker (taskbar-icons-worker.js says why both); this is
 * the main-thread side: it starts the worker, keeps the latest answer, and
 * stops it.
 *
 * The answer is a cache. The strip asks `latest()` on every placement and
 * never waits: until the first measurement arrives, and whenever one fails,
 * there is no rectangle and the strip is hidden rather than placed blind.
 */

const WORKER = path.join(__dirname, 'taskbar-icons-worker.js');
/** How often the worker re-measures. Buttons move when a window opens or closes. */
const INTERVAL_MS = 1000;

/**
 * The union of the rectangles that are really on screen, or null. UI
 * Automation reports an element with no layout as an empty or inverted
 * rectangle (measured: 0,0,0,0 and ∞,∞,-∞,-∞), and those must not stretch the
 * union to the screen's corner.
 */
function unionOfRects(rects) {
  let out = null;
  for (const r of Array.isArray(rects) ? rects : []) {
    if (!r || ![r.left, r.top, r.right, r.bottom].every(Number.isFinite)) continue;
    if (r.right <= r.left || r.bottom <= r.top) continue;
    if (!out) out = { ...r };
    else {
      out.left = Math.min(out.left, r.left);
      out.top = Math.min(out.top, r.top);
      out.right = Math.max(out.right, r.right);
      out.bottom = Math.max(out.bottom, r.bottom);
    }
  }
  return out;
}

class IconProbe {
  /**
   * @param {object} deps
   * @param {Function} [deps.Worker]  worker_threads.Worker, or a fake
   * @param {{info: Function, warn: Function}} deps.log
   * @param {(rect: object|null) => void} [deps.onChange]
   */
  constructor({ Worker, log, onChange }) {
    // eslint-disable-next-line global-require
    this.Worker = Worker || require('node:worker_threads').Worker;
    this.log = log;
    this.onChange = onChange || (() => {});
    this.worker = null;
    this.rect = null;
    this.code = null;
    this.failed = false;
  }

  /** The button area in physical screen pixels, or null when not known. */
  latest() {
    return this.rect;
  }

  start() {
    if (this.worker || this.failed) return;
    try {
      this.worker = new this.Worker(WORKER, { workerData: { intervalMs: INTERVAL_MS } });
    } catch (err) {
      this.failed = true;
      this.log.warn(`taskbar buttons cannot be measured: code=${(err && err.code) || 'WORKER'}`);
      return;
    }
    const w = this.worker;
    w.on('message', (msg) => {
      if (this.worker !== w || !msg || typeof msg !== 'object') return;
      const rect = unionOfRects([msg.rect]);
      if (!rect && msg.code !== this.code) this.log.info(`taskbar buttons not measured: code=${String(msg.code).slice(0, 24)}`);
      this.code = rect ? null : msg.code;
      if (msg.fatal) this.failed = true;
      const changed = JSON.stringify(rect) !== JSON.stringify(this.rect);
      this.rect = rect;
      if (changed) {
        try { this.onChange(rect); } catch { /* the strip's problem, not the probe's */ }
      }
    });
    w.on('error', (err) => {
      if (this.worker !== w) return;
      this.log.warn(`taskbar button probe failed: code=${(err && err.code) || 'WORKER'}`);
      this.failed = true;
      this.worker = null;
      this.rect = null;
    });
    w.on('exit', () => {
      if (this.worker === w) this.worker = null;
    });
    if (typeof w.unref === 'function') w.unref();
  }

  /** Ask for a fresh measurement now (after the taskbar changed). */
  remeasure() {
    if (this.worker) this.worker.postMessage('measure');
  }

  stop() {
    const w = this.worker;
    this.worker = null;
    this.rect = null;
    if (w) {
      try { w.postMessage('stop'); } catch { /* already gone */ }
    }
  }
}

module.exports = { IconProbe, unionOfRects, WORKER, INTERVAL_MS };
