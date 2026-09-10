'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

const store = require('./store');
const log = require('./log');
const paths = require('./paths');
const { readClaudeRateLimits, readAntigravityQuota } = require('./ratelimits');
const { readAntigravityIdeQuota } = require('./antigravity/ide-quota');
const { resolveAntigravityIdeStore } = require('./antigravity/install');
const { buildSnapshot, loadingSnapshot } = require('./snapshot');
const { sanitizeOrder } = require('./order');
const { sanitizeEnabled } = require('./enabled');

/**
 * Owns the scan lifecycle. Imports nothing from `electron` on purpose
 * (ADR-001 Decision 2, reversibility): if this ever ships as a Tauri sidecar,
 * this file moves unchanged.
 */

const DEBOUNCE_MS = 400;        // file-watcher coalescing
const SWEEP_OPEN_MS = 15 * 1000;
const SWEEP_IDLE_MS = 60 * 1000;
const WORKER_TIMEOUT_MS = 30 * 1000;
/** Floor between two scans. Hovering the tray repeatedly would otherwise
 *  dispatch a worker per hover. */
const MIN_SCAN_GAP_MS = 1500;

/** Shallow compare of the cursor maps: same files, same size, same mtime. */
function cursorsDiffer(a, b) {
  const prev = a || {};
  const next = b || {};
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return true;
  for (const key of nextKeys) {
    const p = prev[key];
    const n = next[key];
    if (!p || p.size !== n.size || p.mtimeMs !== n.mtimeMs) return true;
  }
  return false;
}

class Collector extends EventEmitter {
  constructor(options) {
    super();
    this.userDataDir = options.userDataDir;
    this.projectsRoot = options.projectsRoot || paths.claudeProjectsDir();
    this.rateLimitsFile = options.rateLimitsFile || paths.rateLimitsFile();
    this.rateLimitsDir = options.rateLimitsDir || paths.rateLimitsDir();
    /** The Antigravity bridge's capture. Same directory, separate file: the
     *  two hooks are run by two different programs at two different cadences,
     *  so one shared file would mean whichever ran last erased the other. */
    this.antigravityQuotaFile = options.antigravityQuotaFile || paths.antigravityQuotaFile();
    /** Last `reason:ids` warned about, so `_reportUnusableQuota` speaks on a
     *  transition rather than on every rebuild. */
    this._quotaWarnKey = null;
    /** Same discipline for the IDE store: which install, how old, what state. */
    this._ideStoreKey = null;
    /** The directory the IDE store watcher is currently attached to. */
    this._ideWatchDir = null;
    this._ideWatcher = null;
    this._ideDebounce = null;
    /**
     * Where to look for Antigravity IDE installs. Null means the real
     * %APPDATA%. A seam, because without it every test that builds a Collector
     * silently reads the developer's own store — which is both a hidden
     * dependency and a way for a suite to pass on one machine only.
     */
    this.ideAppDataDir = options.ideAppDataDir || null;
    /** Last IDE reading, for callers that must not re-open the database. */
    this.antigravityIde = null;
    this.workerPath = options.workerPath || path.join(__dirname, 'scan', 'worker.js');
    this.planLabel = options.planLabel || null;
    /** User's drag order. Owned and persisted by main; held here so that every
     *  snapshot this object emits is already ordered. */
    this.order = sanitizeOrder(options.order);
    /** Which providers the user added to the panel. Same arrangement as
     *  `order`: main owns and persists it, we only apply it, so that every
     *  snapshot this object emits already carries `enabled` on every row. */
    this.enabled = sanitizeEnabled(options.enabled);

    this.store = store.emptyStore();
    this.snapshot = null;
    this.scanOk = true;
    this.panelOpen = false;
    /** When the transcript data was last known-good. Feeds `lastGoodAt`. */
    this.scanGoodAtMs = null;

    this._scanning = false;
    this._pending = false;
    this._debounce = null;
    this._rlDebounce = null;
    this._sweep = null;
    this._throttle = null;
    this._lastScanAt = 0;
    /** A watcher event arrived while the panel was closed. */
    this._missedChange = false;
    this._watchers = [];
    this._stopped = false;
  }

  /** Loads the persisted store and emits a snapshot before any I/O work. */
  start() {
    this.store = store.load(this.userDataDir);
    // On a cold start the persisted events were last good when they were
    // written, not now. Saying otherwise would make a week-old store claim it
    // is current for the seconds before the first scan lands.
    const builtAtMs = Date.parse(this.store.builtAt);
    this.scanGoodAtMs = Number.isFinite(builtAtMs) ? builtAtMs : null;
    if (this.store.events.length > 0 || this.store.builtAt) {
      this.rebuild();
    } else {
      this.snapshot = loadingSnapshot(Date.now(), this.order, this.enabled);
      this.emit('snapshot', this.snapshot);
    }
    this._startWatchers();
    this._scheduleSweep();
    this.requestScan();
    return this.snapshot;
  }

  stop() {
    this._stopped = true;
    if (this._debounce) clearTimeout(this._debounce);
    if (this._rlDebounce) clearTimeout(this._rlDebounce);
    if (this._ideDebounce) clearTimeout(this._ideDebounce);
    if (this._throttle) clearTimeout(this._throttle);
    if (this._sweep) clearTimeout(this._sweep);
    for (const w of this._watchers) {
      try { w.close(); } catch { /* already gone */ }
    }
    this._watchers = [];
    // Cleared so a restarted collector re-attaches instead of believing it is
    // still watching a directory whose watcher it just closed.
    this._ideWatcher = null;
    this._ideWatchDir = null;
  }

  setPanelOpen(open) {
    const next = Boolean(open);
    if (next === this.panelOpen) return;
    this.panelOpen = next;
    this._scheduleSweep();
    if (next) {
      // Transcript changes seen while the panel was closed were not acted on;
      // opening it is the moment they matter, so force past the throttle.
      const force = this._missedChange;
      this._missedChange = false;
      this.requestScan(force);
    }
  }

  /**
   * Applies a new provider order and re-emits.
   *
   * Deliberately a rebuild, not a re-sort of `this.snapshot`: the snapshot has
   * already been handed to the renderer and to the tray, and mutating it in
   * place would reorder an object someone else is holding. Rebuild is cheap —
   * no filesystem walk, events are already in memory.
   *
   * @returns {string[]} the order actually applied, after validation
   */
  setOrder(ids) {
    this.order = sanitizeOrder(ids);
    this.rebuild();
    return this.order.slice();
  }

  /**
   * Applies a new enablement map and re-emits.
   *
   * A rebuild for the same reason `setOrder` is one: the last snapshot has
   * already been handed to the renderer and to the tray, and mutating it in
   * place would change an object someone else is holding. It is also what
   * repaints the tray — the icon is driven by the first ENABLED row, so
   * toggling the top provider off has to produce a new snapshot, not just a
   * new settings file.
   *
   * @returns {object} the map actually applied, after validation
   */
  setEnabled(map) {
    this.enabled = sanitizeEnabled(map);
    this.rebuild();
    return { ...this.enabled };
  }

  setPlanLabel(label) {
    this.planLabel = typeof label === 'string' && label ? label : null;
    this.rebuild();
  }

  /**
   * Cheap path: re-reads the rate-limit capture and re-derives the snapshot
   * from events already in memory. No filesystem walk. Used when only the
   * bridge output changed, and after every scan.
   */
  rebuild() {
    const rateLimits = readClaudeRateLimits({ file: this.rateLimitsFile, now: Date.now() });
    const antigravityQuota = readAntigravityQuota({ file: this.antigravityQuotaFile, now: Date.now() });
    this._reportUnusableQuota(antigravityQuota);
    const antigravityIde = this._readIdeQuota();
    // Held so the refresh handler can ask "was this reading stale?" without
    // re-opening the store. Read-only to everyone else.
    this.antigravityIde = antigravityIde;
    this.snapshot = buildSnapshot({
      now: Date.now(),
      events: this.store.events,
      rateLimits,
      antigravityQuota,
      antigravityIde,
      scanOk: this.scanOk,
      scanGoodAtMs: this.scanGoodAtMs,
      planLabel: this.planLabel,
      order: this.order,
      enabled: this.enabled,
    });
    this.emit('snapshot', this.snapshot);
    return this.snapshot;
  }

  /**
   * The Antigravity IDE store reading, with its own failures kept local.
   *
   * Wrapped because this is the one reader that opens a database and decodes a
   * format we do not control. A throw here would take the whole snapshot down
   * — including the Claude row, which has nothing to do with it — so anything
   * unexpected degrades to "no reading" and is logged once.
   *
   * The chosen install is logged on transition, per GUARD 1: which of several
   * candidate directories won, and how old its store is, is the fact that
   * makes a "why is this number wrong" report answerable in one line.
   */
  _readIdeQuota() {
    let reading;
    try {
      reading = readAntigravityIdeQuota({ now: Date.now(), appDataDir: this.ideAppDataDir || undefined });
    } catch (err) {
      log.warn(`antigravity ide store read failed: code=${(err && err.code) || 'UNKNOWN'}`);
      return { state: 'invalid', reason: 'threw', fiveHour: null, sevenDay: null, groups: [] };
    }

    const install = reading.install;
    // The chosen install can change under us — a rename, a second install
    // written more recently — so the watcher follows the resolver rather than
    // being attached once at startup.
    this._watchIdeStore(install);
    const key = install
      ? `${install.name}|${install.mtimeMs}|${reading.state}|${reading.reason || ''}`
      : `none|${reading.state}|${reading.reason || ''}`;
    if (key !== this._ideStoreKey) {
      this._ideStoreKey = key;
      if (install) {
        const others = install.candidates.filter((c) => c.name !== install.name).map((c) => c.name);
        log.info(
          `antigravity ide store: chose "${install.name}" written ${new Date(install.mtimeMs).toISOString()}`
          + (others.length ? ` over ${others.map((n) => `"${n}"`).join(', ')}` : '')
          + ` state=${reading.state}${reading.reason ? ` reason=${reading.reason}` : ''}`,
        );
      }
      // A refused shape is the loud outcome GUARD 3a is for. It means the
      // format moved under us, and it is the difference between shipping no
      // number and shipping a wrong one.
      if (reading.reason === 'schema') {
        log.warn(`antigravity ide store shape refused: ${reading.schemaError || 'unknown'}`);
      }
    }
    return reading;
  }

  /**
   * Watches the chosen IDE store so a model switch shows up promptly.
   *
   * Without it the only thing that notices is the sweep, which is 15 s with
   * the panel open and 60 s without — long enough that switching model in
   * Antigravity and looking at the tray reads as "it did not update". The
   * store is rewritten by the IDE itself, so this is the same arrangement the
   * two statusline bridges already have: watch the directory, filter by name,
   * debounce, rebuild. No scan is involved.
   *
   * Attached to the DIRECTORY, not the file: the store is replaced rather than
   * appended to, and a watch on an inode that gets swapped stops firing.
   */
  _watchIdeStore(install) {
    const dir = install ? path.dirname(install.file) : null;
    if (dir === this._ideWatchDir) return;

    if (this._ideWatcher) {
      try { this._ideWatcher.close(); } catch { /* already gone */ }
      this._ideWatcher = null;
    }
    this._ideWatchDir = dir;
    if (dir === null) return;

    const base = path.basename(install.file);
    try {
      const w = fs.watch(dir, { persistent: false }, (_evt, name) => {
        // SQLite writes a journal beside the database and renames it away, so
        // the interesting events land on names that START with the store's.
        if (name && !String(name).startsWith(base)) return;
        this._onIdeStoreChange();
      });
      w.on('error', () => { /* watcher died; the sweep still runs */ });
      this._ideWatcher = w;
      this._watchers.push(w);
    } catch (err) {
      log.warn(`antigravity ide watcher unavailable: code=${(err && err.code) || 'UNKNOWN'}`);
    }
  }

  _onIdeStoreChange() {
    if (this._ideDebounce) clearTimeout(this._ideDebounce);
    this._ideDebounce = setTimeout(() => {
      this._ideDebounce = null;
      if (!this._stopped) this.rebuild();
    }, DEBOUNCE_MS);
  }

  /**
   * Names an Antigravity capture the reader could not use.
   *
   * The Antigravity bucket id space is undocumented — `readAntigravityQuota`
   * matches on the bucket's NAME — so "the hook ran and we recognised nothing
   * in it" is this provider's likeliest real failure. Downstream it collapses
   * into a row that reads "Güncellenemedi" beside a retry button that cannot
   * help, which tells nobody what to change. The bucket ids do, and they are
   * already sitting in the capture file verbatim, so naming them here adds no
   * exposure and turns an unactionable row into a one-line bug report.
   *
   * Logged on TRANSITION only. `rebuild()` runs on every watcher event and on
   * a 15s sweep while the panel is open; an unconditional warn would print the
   * same line hundreds of times an hour and bury everything else.
   */
  _reportUnusableQuota(q) {
    const reason = q && q.reason ? q.reason : null;
    const ids = (q && q.unmappedIds) || [];
    const key = reason === null ? null : `${reason}:${ids.join(',')}`;
    if (key === this._quotaWarnKey) return;
    this._quotaWarnKey = key;
    if (reason === null || reason === 'no-quota') return;
    log.warn(
      `antigravity quota unusable: reason=${reason} seen=${q.bucketsSeen} mapped=${q.bucketsMapped}`
      + (ids.length ? ` ids=${ids.join(',')}` : ''),
    );
  }

  /** Coalescing, throttled entry point. Safe to call from a watcher storm. */
  requestScan(force = false) {
    if (this._stopped) return;
    if (this._scanning) { this._pending = true; return; }

    const wait = force ? 0 : MIN_SCAN_GAP_MS - (Date.now() - this._lastScanAt);
    if (wait > 0) {
      if (!this._throttle) {
        this._throttle = setTimeout(() => {
          this._throttle = null;
          this.requestScan(true);
        }, wait);
        if (this._throttle.unref) this._throttle.unref();
      }
      return;
    }

    this._runScan().catch((err) => {
      log.warn(`scan dispatch failed: code=${(err && err.code) || 'UNKNOWN'}`);
    });
  }

  /** Awaitable scan used by the renderer's explicit refresh. */
  async refreshNow() {
    if (this._scanning) {
      await new Promise((resolve) => this.once('scan-settled', resolve));
      return this.snapshot || this.rebuild();
    }
    await this._runScan();
    return this.snapshot;
  }

  async _runScan() {
    this._scanning = true;
    let result = null;
    try {
      result = await this._spawnScan();
    } catch (err) {
      this.scanOk = false;
      log.warn(`scan failed: code=${(err && err.code) || 'UNKNOWN'}`);
    }

    if (result && result.ok) {
      this.scanOk = true;
      this.scanGoodAtMs = Date.now();
      // A no-op scan still produces a full result, and persisting it rewrites
      // and fsyncs the entire store for data identical to what is already on
      // disk. During an active Claude Code session that is hundreds of MB of
      // writes for nothing.
      const changed = result.stats.filesParsed > 0 || cursorsDiffer(this.store.cursors, result.cursors);
      this.store = {
        schemaVersion: store.SCHEMA_VERSION,
        cursors: result.cursors,
        events: result.events,
        builtAt: changed ? new Date().toISOString() : (this.store.builtAt || new Date().toISOString()),
      };
      if (changed) store.save(this.userDataDir, this.store);
      this.emit('stats', { ...result.stats, persisted: changed });
    } else if (result && !result.ok) {
      this.scanOk = false;
    }

    // `_scanning` MUST be cleared even if rebuild(), a snapshot listener or
    // store.save() throws. Without this, one synchronous throw leaves the flag
    // stuck true forever: every later scan is swallowed as "pending", and
    // refreshNow() awaits a 'scan-settled' that will never be emitted, so the
    // renderer's refresh hangs with no recovery short of restarting the app.
    try {
      this.rebuild();
    } finally {
      this._scanning = false;
      this._lastScanAt = Date.now();
      this.emit('scan-settled');
    }

    if (this._pending && !this._stopped) {
      this._pending = false;
      this.requestScan();
    }
  }

  _spawnScan() {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(this.workerPath, {
          workerData: {
            root: this.projectsRoot,
            cursors: this.store.cursors,
            priorEvents: this.store.events,
            now: Date.now(),
          },
        });
      } catch (err) {
        reject(err);
        return;
      }

      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { worker.terminate(); } catch { /* already exiting */ }
        fn(value);
      };

      const timer = setTimeout(() => {
        finish(reject, Object.assign(new Error('scan timeout'), { code: 'ETIMEDOUT' }));
      }, WORKER_TIMEOUT_MS);

      worker.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'log') { log.warn(String(msg.msg)); return; }
        if (msg.type === 'result') { finish(resolve, msg.result); return; }
        if (msg.type === 'error') {
          finish(reject, Object.assign(new Error('scan error'), { code: msg.code }));
        }
      });
      worker.on('error', (err) => finish(reject, err));
      worker.on('exit', (code) => {
        if (settled) return;
        finish(reject, Object.assign(new Error('worker exited'), { code: `EEXIT_${code}` }));
      });
    });
  }

  _startWatchers() {
    // The IDE store, if there is one to watch. `_readIdeQuota()` re-points
    // this on every rebuild, so a store that appears later is picked up by the
    // sweep and then watched from that moment on.
    try {
      this._watchIdeStore(resolveAntigravityIdeStore(this.ideAppDataDir || undefined));
    } catch (err) {
      log.warn(`antigravity ide watcher setup failed: code=${(err && err.code) || 'UNKNOWN'}`);
    }

    // Transcripts. Recursive watch is supported on Windows; if it is not
    // available we simply fall back to the periodic sweep.
    try {
      const w = fs.watch(this.projectsRoot, { recursive: true, persistent: false }, () => {
        this._onTranscriptChange();
      });
      w.on('error', () => { /* watcher died; the sweep still runs */ });
      this._watchers.push(w);
    } catch (err) {
      log.warn(`transcript watcher unavailable: code=${(err && err.code) || 'UNKNOWN'}`);
    }

    // Bridge output, both providers'. Only a rebuild is needed, not a scan.
    // One watcher, because both capture files live in the same directory; the
    // name filter keeps the tmp+rename churn of unrelated files out.
    const captureNames = [
      path.basename(this.rateLimitsFile),
      path.basename(this.antigravityQuotaFile),
    ];
    try {
      fs.mkdirSync(this.rateLimitsDir, { recursive: true });
      const w = fs.watch(this.rateLimitsDir, { persistent: false }, (_evt, name) => {
        if (name && !captureNames.some((n) => String(name).startsWith(n))) return;
        this._onRateLimitChange();
      });
      w.on('error', () => { /* watcher died; the sweep still runs */ });
      this._watchers.push(w);
    } catch (err) {
      log.warn(`rate-limit watcher unavailable: code=${(err && err.code) || 'UNKNOWN'}`);
    }
  }

  _onTranscriptChange() {
    // Only rescan on a file change while the panel is actually open. With it
    // closed, an hour of active Claude Code fires this thousands of times and
    // each one costs a worker spawn plus a recursive walk of the whole tree —
    // for a snapshot nobody is looking at, at roughly 40x the IDLE_MS cadence
    // the contract advertises. Closed, the 60s sweep is the guarantee, and it
    // is the one the renderer sizes its staleness thresholds against.
    if (!this.panelOpen) {
      this._missedChange = true;
      return;
    }
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      this._debounce = null;
      this.requestScan();
    }, DEBOUNCE_MS);
  }

  _onRateLimitChange() {
    if (this._rlDebounce) clearTimeout(this._rlDebounce);
    this._rlDebounce = setTimeout(() => {
      this._rlDebounce = null;
      if (!this._stopped) this.rebuild();
    }, DEBOUNCE_MS);
  }

  _scheduleSweep() {
    if (this._sweep) clearTimeout(this._sweep);
    if (this._stopped) return;
    const every = this.panelOpen ? SWEEP_OPEN_MS : SWEEP_IDLE_MS;
    this._sweep = setTimeout(() => {
      this._sweep = null;
      this.requestScan();
      this._scheduleSweep();
    }, every);
    if (this._sweep.unref) this._sweep.unref();
  }
}

module.exports = { Collector, cursorsDiffer, DEBOUNCE_MS, SWEEP_OPEN_MS, SWEEP_IDLE_MS, MIN_SCAN_GAP_MS };
