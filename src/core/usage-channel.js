'use strict';
const { Worker } = require('node:worker_threads');
const log = require('./log');
const { resolveLocalDir } = require('./codex/rollout');
const { historyStartMs } = require('./history');
const { sameEvents } = require('./same-events');

/**
 * One tool's off-thread local usage scan, as the collector sees it (ADR-003 A6,
 * ADR-002 A3.11-12). Used for Gemini CLI, Kimi Code and
 * Antigravity's conversation stores.
 *
 * It follows the Codex arrangement in collector.js (long-lived worker holding
 * the per-file cache, a minimum gap between dispatches, a full-scan TTL, a
 * generous timeout that restarts the worker, and PENDING until the first
 * result) without the Codex-only parts: there is no watcher and no
 * changed-files mode, because neither tool gives a cheap, attributable change
 * signal; every scan is a full walk, which over an unchanged tree is one lstat
 * per file inside the worker.
 *
 * Nothing is spawned for a tool that is not on this machine. Whether it is
 * installed is probed on the main thread at most once per PROBE_TTL_MS with the
 * shared path guard (a few lstat calls; a network target is refused without
 * being opened and reads as not installed, as a network Codex home does).
 */

const MIN_GAP_MS = 3 * 1000;
/** Old-generation heap cap for each long-lived usage scan worker (security F4). */
const WORKER_MAX_OLD_GEN_MB = 512;
const PROBE_TTL_MS = 60 * 1000;
/** Same reasoning as CODEX_SCAN_TIMEOUT_MS: a short timeout would restart the
 *  worker, losing its cache, for ever on a large corpus. */
const SCAN_TIMEOUT_MS = 15 * 60 * 1000;

class LocalUsageChannel {
  /**
   * @param {object} o
   * @param {string} o.id              provider id ('gemini' | 'kimi' | 'antigravity')
   * @param {string} o.label           fixed path-guard label, never a path
   * @param {string} o.workerPath
   * @param {string|null} o.home       override passed to the reader (tests), or null
   * @param {() => (string|null)} o.installDir  the directory whose existence means installed
   * @param {() => boolean} o.isStopped
   * @param {() => boolean} o.canRebuild  false until Claude's corpus has settled (A3.14)
   * @param {() => void} o.rebuild
   * @param {(name: string, payload: any) => void} o.emit
   */
  constructor(o) {
    this.id = o.id;
    this.label = o.label;
    this.workerPath = o.workerPath;
    this.home = o.home || null;
    this._installDir = o.installDir;
    this._isStopped = o.isStopped;
    this._canRebuild = o.canRebuild;
    this._rebuild = o.rebuild;
    this._emit = o.emit;

    /** Last completed result, or null (PENDING) until the first one. */
    this.events = null;
    this.stats = null;
    this.readFailed = false;
    this.resultAtMs = null;
    this.unreadRange = null;

    this.auto = false;
    this.worker = null;
    this.inFlight = null;
    this.seq = 0;
    this.dispatchedAt = 0;
    this.fullAt = 0;
    this.followUp = null;
    this._installed = null;
    this._probedAt = null;
  }

  /** Is the tool on this machine? Cached for PROBE_TTL_MS; a clock that went
   *  backwards expires the cache. */
  installed(now = Date.now()) {
    const age = this._probedAt === null ? Infinity : now - this._probedAt;
    if (this._installed === null || age < 0 || age >= PROBE_TTL_MS) {
      let value = false;
      try {
        const dir = this._installDir();
        value = Boolean(dir && resolveLocalDir(dir, this.label));
      } catch (err) {
        log.warn(`${this.id} install probe failed: code=${(err && err.code) || 'UNKNOWN'}`);
        value = false;
      }
      this._installed = value;
      this._probedAt = now;
    }
    return this._installed;
  }

  /** Tools whose usage is not read yet: installed and no result so far. */
  pending(now = Date.now()) {
    return this.installed(now) && this.events === null;
  }

  /** What `buildSnapshot` needs for this tool. */
  snapshotInput(now = Date.now()) {
    return {
      installed: this.installed(now),
      events: this.events,
      readFailed: this.readFailed,
      resultAtMs: this.resultAtMs,
      unreadRange: this.unreadRange,
    };
  }

  /** Keep the scan fresh: a full scan when none has completed or the last one
   *  is older than `ttlMs`. Never for a tool that is not installed. */
  tick(now, ttlMs) {
    if (this._isStopped() || !this.auto) return;
    if (!this.installed(now)) return;
    if (this.inFlight) return;
    const age = now - this.fullAt;
    if (this.events === null || this.fullAt === 0 || age < 0 || age >= ttlMs) this.request(now);
  }

  request(now = Date.now(), afterGap = false) {
    if (this._isStopped() || this.inFlight) return;
    const age = now - this.dispatchedAt;
    const gapOk = afterGap || this.dispatchedAt === 0 || age < 0 || age >= MIN_GAP_MS;
    if (!gapOk) {
      if (!this.followUp) {
        this.followUp = setTimeout(() => {
          this.followUp = null;
          this.request(Date.now(), true);
        }, MIN_GAP_MS - age);
        if (typeof this.followUp.unref === 'function') this.followUp.unref();
      }
      return;
    }
    this.dispatch(now);
  }

  dispatch(now) {
    let worker;
    try {
      worker = this._ensureWorker();
    } catch (err) {
      log.warn(`${this.id} scan worker unavailable: code=${(err && err.code) || 'UNKNOWN'}`);
      this._markReadFailed();
      return;
    }
    const id = ++this.seq;
    const timer = setTimeout(() => {
      log.warn(`${this.id} usage scan timed out; restarting its worker`);
      this.stopWorker();
    }, SCAN_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.inFlight = { id, now, timer };
    this.dispatchedAt = now;
    this.fullAt = now;
    worker.postMessage({ type: 'scan', id, now, startMs: historyStartMs(now), home: this.home });
  }

  _ensureWorker() {
    if (this.worker) return this.worker;
    // Bounded (security F4): a hostile or runaway log cannot take the app's memory.
    const worker = new Worker(this.workerPath, { resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_MB } });
    if (typeof worker.unref === 'function') worker.unref();
    worker.on('message', (msg) => this._onMessage(worker, msg));
    worker.on('error', (err) => {
      log.warn(`${this.id} scan worker failed: code=${(err && err.code) || 'UNKNOWN'}`);
      this._onWorkerGone(worker);
    });
    worker.on('exit', () => this._onWorkerGone(worker));
    this.worker = worker;
    return worker;
  }

  _onMessage(worker, msg) {
    if (worker !== this.worker || !msg || typeof msg !== 'object') return;
    if (msg.type === 'log') { log.warn(String(msg.msg)); return; }
    const flight = this.inFlight;
    if (!flight || msg.id !== flight.id) return;
    clearTimeout(flight.timer);
    this.inFlight = null;
    // `unchanged`: the worker compared on its own thread and posted no events;
    // the held array (and its identity, which the history memo keys on) stays.
    const unchanged = msg.type === 'result' && msg.unchanged === true && this.events !== null;
    if (msg.type === 'result' && (Array.isArray(msg.events) || unchanged)) {
      if (!unchanged && !sameEvents(this.events, msg.events)) this.events = msg.events;
      this.stats = msg.stats || null;
      this.readFailed = false;
      this.resultAtMs = Number.isFinite(flight.now) ? flight.now : Date.now();
      const r = msg.unreadRange;
      this.unreadRange = r && typeof r === 'object' && Number.isFinite(r.fromMs) && Number.isFinite(r.throughMs) && r.fromMs <= r.throughMs
        ? { fromMs: r.fromMs, throughMs: r.throughMs }
        : null;
      this._emit(`${this.id}-scan`, this.stats);
      if (!this._isStopped() && this._canRebuild()) this._rebuild();
    } else if (msg.type === 'error') {
      log.warn(`${this.id} usage scan failed: code=${msg.code || 'UNKNOWN'}`);
      this.fullAt = 0;
      this._markReadFailed();
    }
  }

  _onWorkerGone(worker) {
    if (worker !== this.worker) return;
    this.worker = null;
    this.fullAt = 0;
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer);
      this.inFlight = null;
      this._markReadFailed();
    }
  }

  /** The held result is known to be behind its logs (ADR-002 A3.15). */
  _markReadFailed() {
    if (this.readFailed) return;
    this.readFailed = true;
    if (!this._isStopped() && this._canRebuild() && this.events !== null) this._rebuild();
  }

  stopWorker() {
    const worker = this.worker;
    if (!worker) return;
    this._onWorkerGone(worker);
    try { worker.terminate(); } catch { /* already exiting */ }
  }

  stop() {
    if (this.followUp) clearTimeout(this.followUp);
    this.followUp = null;
    this.stopWorker();
  }
}

module.exports = { LocalUsageChannel, sameEvents, MIN_GAP_MS, PROBE_TTL_MS, SCAN_TIMEOUT_MS, WORKER_MAX_OLD_GEN_MB };
