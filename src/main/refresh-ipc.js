'use strict';

/**
 * The REQUEST_REFRESH handler, split out of `index.js` so its ordering is
 * tested rather than described. Nothing here requires `electron`.
 *
 * Two rules, and both are about ONE snapshot:
 *
 *   1. The reply is the snapshot that is CURRENT WHEN THE REPLY IS SENT, read
 *      after every await — never the one the scan returned. The handler waits
 *      on the Antigravity process probe (up to its budget), and main keeps
 *      running other messages meanwhile. A SET_LANGUAGE in that gap
 *      re-publishes the snapshot in the new language; a reply built from the
 *      pre-await value would land AFTER that push and put the old language
 *      back on screen.
 *
 *   2. The "Antigravity is not running" notice is judged against THAT SAME
 *      snapshot. The notice explains a row whose figures are old. If an agy
 *      capture or an IDE store write re-publishes the row as live during the
 *      probe wait, the notice must go: shipping a live row beside "its values
 *      are not updating" is a statement the data contradicts (ADR-001). So the
 *      staleness rule is applied once, to the snapshot being sent, here.
 *
 * The earlier staleness reads are optimisations only — not starting a process
 * probe, and not waiting on one, when there is nothing to explain. Neither can
 * add a notice; only the final read can.
 */

const NOT_RUNNING = 'ANTIGRAVITY_NOT_RUNNING';

/**
 * Are the Antigravity figures the user sees in THIS snapshot old — the only
 * thing the notice explains? Reads the row, not the raw IDE store: a fresh
 * CLI capture with the IDE closed is a live row with nothing to explain. Never
 * true for a row the user never added.
 *
 * @param {{providers?: Array<{id: string, enabled?: boolean, status?: string}>}|null} snapshot
 */
function antigravityRowIsStale(snapshot) {
  const providers = snapshot && Array.isArray(snapshot.providers) ? snapshot.providers : [];
  const row = providers.find((p) => p && p.id === 'antigravity');
  return Boolean(row) && row.enabled === true && row.status === 'stale';
}

/**
 * @param {object} deps
 * @param {(event: object) => boolean} deps.fromPanel
 * @param {() => Promise<string>} deps.startProbe       spawns the process probe; started BEFORE the scan so the two overlap
 * @param {() => Promise<object>} deps.refresh          the scan
 * @param {(probe: Promise<string>) => Promise<string>} deps.awaitProbe  the probe's answer within its budget ('unknown' past it)
 * @param {() => object|null} deps.latestSnapshot       the collector's current snapshot
 * @param {{warn: Function}} deps.log
 */
function createRefreshHandler({ fromPanel, startProbe, refresh, awaitProbe, latestSnapshot, log }) {
  return async (event) => {
    if (!fromPanel(event)) return null;
    // Decided from the PRE-refresh reading so the probe can overlap the scan.
    // The probe spawns a process; it is asked only when the row is old.
    const probe = antigravityRowIsStale(latestSnapshot()) ? startProbe() : null;
    let scanned = null;
    try {
      scanned = await refresh();
    } catch (err) {
      log.warn(`refresh failed: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    // Not waiting on a probe whose answer the scan already made moot.
    const answer = probe && antigravityRowIsStale(latestSnapshot()) ? await awaitProbe(probe) : 'unknown';

    // After the last await: whatever was re-published meanwhile wins, and the
    // notice is judged against exactly this object.
    const snapshot = latestSnapshot() || scanned || null;
    // `unknown` produces nothing: saying "your editor is closed" while it is
    // open is a wrong statement.
    if (!snapshot || answer !== 'not-running' || !antigravityRowIsStale(snapshot)) return snapshot;
    // A COPY, so the notice rides the invoke reply only. The object the
    // collector pushes on its own schedule must not start carrying the answer
    // to a question the user asked once.
    return { ...snapshot, refreshNotices: [NOT_RUNNING] };
  };
}

module.exports = { createRefreshHandler, antigravityRowIsStale };
