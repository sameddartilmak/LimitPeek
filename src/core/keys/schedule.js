'use strict';

/**
 * When a keyed request is allowed to START (ADR-003 Amendment 5, K16).
 *
 * Pure, and deliberately separate from the code that makes the request: every
 * rule here is a rate limit on OUR side of the wire, and a rate limit that
 * lives inside the function it limits cannot be tested against a fake clock.
 * The tests drive 1000 refreshes and 48 simulated hours through these functions
 * and count the requests that would have been made.
 *
 * The rules, and why each exists:
 *
 *  - `MIN_GAP_MS` (15 min) between two request STARTS, not between a reply and
 *    the next start. A start-to-start floor is the only shape a hammering bug
 *    cannot walk around: a request that hangs for its full timeout still
 *    consumes its own slot.
 *  - PERSISTED. The floor survives a restart, so quitting and reopening the app
 *    twenty times is twenty starts' worth of nothing (the file lives beside the
 *    secret and is deleted with it).
 *  - 401 STOPS POLLING, full stop. A rejected key does not become valid by
 *    being retried, and retrying a rejected credential against an account is
 *    indistinguishable from a slow password guess. Only the user replacing or
 *    removing the key clears it.
 *  - `Retry-After` is honoured but CLAMPED to 15 min…24 h. A provider header is
 *    input: a `1` would let a broken server pull us into a per-second loop, and
 *    a `31536000` would silently disable the row for a year with no way for the
 *    user to see why.
 *  - Failures back off by DOUBLING to 6 h. An endpoint that is down stays down;
 *    the tenth attempt in an hour tells the user nothing the first did not.
 *  - Polling only happens while the provider is ENABLED (the user's own switch)
 *    and a key is stored. Both are checked at the moment of the start, not
 *    cached.
 */

const MINUTE_MS = 60 * 1000;
const MIN_GAP_MS = 15 * MINUTE_MS;
const MAX_BACKOFF_MS = 6 * 60 * MINUTE_MS;
const RETRY_AFTER_MIN_MS = 15 * MINUTE_MS;
const RETRY_AFTER_MAX_MS = 24 * 60 * MINUTE_MS;
/**
 * A persisted `nextEligibleAt` further out than this is not a schedule, it is a
 * clock that moved (or a tampered file). Treated as "wait one normal gap"
 * rather than honoured, so the row cannot be frozen for ever by a bad value.
 */
const MAX_FUTURE_MS = RETRY_AFTER_MAX_MS;

function emptyState() {
  return { lastAttemptAt: null, nextEligibleAt: null, backoffMs: 0, stopped: false };
}

/** A state object from disk, reduced to values this module can reason about. */
function sanitizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  if (Number.isFinite(raw.lastAttemptAt) && raw.lastAttemptAt > 0) state.lastAttemptAt = raw.lastAttemptAt;
  if (Number.isFinite(raw.nextEligibleAt) && raw.nextEligibleAt > 0) state.nextEligibleAt = raw.nextEligibleAt;
  if (Number.isFinite(raw.backoffMs) && raw.backoffMs > 0) {
    state.backoffMs = Math.min(raw.backoffMs, MAX_BACKOFF_MS);
  }
  state.stopped = raw.stopped === true;
  return state;
}

/**
 * @param {object} state
 * @param {number} now
 * @param {{enabled:boolean, hasKey:boolean, inFlight:boolean}} conditions
 */
function mayStart(state, now, conditions) {
  if (!conditions || conditions.enabled !== true || conditions.hasKey !== true) return false;
  if (conditions.inFlight === true) return false;
  if (!state || state.stopped === true) return false;
  if (!Number.isFinite(now)) return false;
  const next = state.nextEligibleAt;
  if (next === null || next === undefined) return true;
  // A clock that stepped BACKWARD would otherwise park the row until the
  // original instant arrived again.
  if (next - now > MAX_FUTURE_MS) return true;
  return now >= next;
}

/**
 * Applied the instant a request STARTS, before it is sent, so the slot is spent
 * even if the process dies mid-flight.
 */
function afterStart(state, now) {
  return {
    ...state,
    lastAttemptAt: now,
    nextEligibleAt: now + MIN_GAP_MS,
  };
}

/**
 * `Retry-After`, in milliseconds from `now`, or null.
 *
 * Accepts the two documented forms — delay-seconds and an HTTP-date — and
 * nothing else. The value is never logged and never shown; it only moves a
 * timer, and only inside the clamp.
 */
function parseRetryAfter(value, now) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) {
    return clampRetryAfter(Number(text) * 1000);
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null;
  return clampRetryAfter(at - now);
}

function clampRetryAfter(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms < RETRY_AFTER_MIN_MS) return RETRY_AFTER_MIN_MS;
  if (ms > RETRY_AFTER_MAX_MS) return RETRY_AFTER_MAX_MS;
  return ms;
}

/**
 * The state after a completed attempt.
 *
 * @param {object} state
 * @param {{kind:'ok'|'stop'|'rate-limited'|'fail', retryAfterMs?:number|null}} outcome
 * @param {number} now
 */
function afterOutcome(state, outcome, now) {
  const kind = outcome && outcome.kind;
  if (kind === 'ok') {
    return { lastAttemptAt: now, nextEligibleAt: now + MIN_GAP_MS, backoffMs: 0, stopped: false };
  }
  if (kind === 'stop') {
    // A rejected key. `nextEligibleAt` is left where it is: `stopped` is what
    // gates the start, and it is cleared only by a new key or a removal.
    return { ...state, lastAttemptAt: now, stopped: true };
  }
  if (kind === 'rate-limited') {
    const wait = Number.isFinite(outcome.retryAfterMs) && outcome.retryAfterMs !== null
      ? clampRetryAfter(outcome.retryAfterMs)
      : nextBackoff(state.backoffMs);
    return {
      lastAttemptAt: now,
      nextEligibleAt: now + wait,
      // A rate limit is not a fault in the endpoint, so it does not feed the
      // failure backoff; the header (or one normal step) decides the wait.
      backoffMs: state.backoffMs,
      stopped: false,
    };
  }
  const backoffMs = nextBackoff(state.backoffMs);
  return { lastAttemptAt: now, nextEligibleAt: now + backoffMs, backoffMs, stopped: false };
}

/** 15 min, then 30, 60, 2 h, 4 h, 6 h, 6 h, … */
function nextBackoff(current) {
  const base = Number.isFinite(current) && current > 0 ? current * 2 : MIN_GAP_MS;
  return Math.min(base, MAX_BACKOFF_MS);
}

module.exports = {
  emptyState,
  sanitizeState,
  mayStart,
  afterStart,
  afterOutcome,
  parseRetryAfter,
  clampRetryAfter,
  nextBackoff,
  MIN_GAP_MS,
  MAX_BACKOFF_MS,
  RETRY_AFTER_MIN_MS,
  RETRY_AFTER_MAX_MS,
};
