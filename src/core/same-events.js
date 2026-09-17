'use strict';

/**
 * Are two event lists the same values in the same order? Flat objects only
 * (every usage reader emits numbers, strings and booleans). Linear in the list.
 *
 * Used so that a scan which found nothing new keeps the PREVIOUS array's
 * identity, which is what lets the snapshot reuse its memoised usage history
 * (ADR-003 A6 Phase A, F3). The long-lived scan workers run it on their own
 * thread and post `unchanged: true` instead of the events.
 */
function sameEvents(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (!x || !y || typeof x !== 'object' || typeof y !== 'object') return false;
    const kx = Object.keys(x);
    if (kx.length !== Object.keys(y).length) return false;
    for (const k of kx) if (x[k] !== y[k]) return false;
  }
  return true;
}

module.exports = { sameEvents };
