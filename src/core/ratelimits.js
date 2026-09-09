'use strict';
const fs = require('node:fs');
const { rateLimitsFile, antigravityQuotaFile } = require('./paths');

/**
 * Reads the ONLY defensible source of a usage percentage: the rate-limit
 * numbers Claude Code hands to its status line, captured by
 * `bridge/claude-statusline.mjs`.
 *
 * Per ADR-001 Decision 1, a percentage is never derived from token
 * arithmetic — there is no published denominator, the quota-per-token rate is
 * time-of-day weighted, and local files cannot see usage from claude.ai or
 * other machines, so any local estimate is biased optimistic. When this file
 * is absent, stale or malformed the answer is "unknown", never a guess.
 */

/**
 * The status line only runs while Claude Code is rendering, so a capture goes
 * "stale" quickly whenever the user steps away.
 *
 * ADR-001 amendment 2: stale no longer means discarded. A capture past this
 * budget is still a true statement about its window until that window resets —
 * see `snapshot.js`, which decides that per window. This constant only marks
 * the boundary between "exact" and "as of".
 */
const MAX_AGE_MS = 30 * 60 * 1000;
/**
 * A reset instant is only credible within roughly one window's length of now,
 * bounded per window rather than by one flat figure. 30 days is nonsense for a
 * 5-hour window: it would accept a reset instant four weeks out, which then
 * keeps a dead percentage alive indefinitely because `now >= resetsAt` never
 * becomes true. The slack absorbs clock skew and the time-of-day weighting
 * Anthropic applies to the 5h window.
 */
const RESET_SKEW_MS = {
  fiveHour: 6 * 60 * 60 * 1000,           // 5h window + 1h slack
  sevenDay: 8 * 24 * 60 * 60 * 1000,      // 7d window + 1d slack
};

function percentage(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0 || v > 100) return null;
  return v;
}

function resetInstant(v, now, skewMs) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // The payload carries epoch SECONDS.
  const ms = v * 1000;
  if (Math.abs(ms - now) > skewMs) return null;
  return ms;
}

function windowOf(raw, now, skewMs) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    usedPercentage: percentage(raw.usedPercentage),
    resetsAtMs: resetInstant(raw.resetsAt, now, skewMs),
  };
}

function emptyCapture(state) {
  return { state, capturedAt: null, capturedAtMs: null, ageMs: null, fiveHour: null, sevenDay: null };
}

/**
 * Opens a bridge capture file and applies the ONE aging rule this app has.
 *
 * Shared by both providers on purpose: two readers holding two copies of "when
 * is a capture too old" is how the second one silently drifts from the first.
 * The caller owns only the payload-specific part — which fields carry the
 * percentages — and never its own staleness rule.
 *
 * @returns {{state:'ok', raw:object, capturedAt:string, capturedAtMs:number, ageMs:number}
 *          |{state:'missing'|'invalid'}}
 */
function readCapture(file, now) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { state: (err && err.code) === 'ENOENT' ? 'missing' : 'invalid' };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: 'invalid' };
  }
  if (!raw || typeof raw !== 'object') return { state: 'invalid' };

  const capturedMs = Date.parse(raw.capturedAt);
  if (!Number.isFinite(capturedMs)) return { state: 'invalid' };

  return {
    state: 'ok',
    raw,
    capturedAt: new Date(capturedMs).toISOString(),
    capturedAtMs: capturedMs,
    ageMs: now - capturedMs,
  };
}

/**
 * @returns {{state:'missing'|'invalid'|'absent'|'stale'|'fresh', capturedAt:string|null,
 *            capturedAtMs:number|null, ageMs:number|null,
 *            fiveHour:object|null, sevenDay:object|null}}
 *   - `missing`  no file at all: the bridge was never installed
 *   - `invalid`  file unreadable or not the expected shape
 *   - `absent`   bridge ran but the payload carried no `rate_limits`
 *   - `stale`    older than MAX_AGE_MS
 *   - `fresh`    usable
 */
function readClaudeRateLimits(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
  const cap = readCapture(options.file || rateLimitsFile(), now);
  if (cap.state !== 'ok') return emptyCapture(cap.state);

  const { raw, capturedAt, capturedAtMs, ageMs } = cap;
  if (raw.present !== true) {
    return { state: 'absent', capturedAt, capturedAtMs, ageMs, fiveHour: null, sevenDay: null };
  }

  const fiveHour = windowOf(raw.fiveHour, now, RESET_SKEW_MS.fiveHour);
  const sevenDay = windowOf(raw.sevenDay, now, RESET_SKEW_MS.sevenDay);

  // A capture from the future (clock skew) is as untrustworthy as an old one.
  const state = (ageMs > maxAgeMs || ageMs < -maxAgeMs) ? 'stale' : 'fresh';
  return { state, capturedAt, capturedAtMs, ageMs, fiveHour, sevenDay };
}

/* ------------------------------------------------------------ Antigravity */

/**
 * The `agy` CLI's statusline payload, captured by
 * `bridge/antigravity-statusline.mjs`.
 *
 * Same rule as Claude's, and for the same reason: the ONLY percentage this app
 * may show is one the server computed. Antigravity states it as
 * `quota[bucket].remaining_fraction`, a 0..1 REMAINING share
 * (https://antigravity.google/docs/cli/statusline/). This app displays USED.
 *
 *   THE CONVERSION HAPPENS HERE AND NOWHERE ELSE:
 *       usedPercentage = (1 - remaining_fraction) * 100
 *
 * The bridge writes `remainingFraction` verbatim, so the file on disk stays a
 * faithful copy of what the CLI said, and `snapshot.js` consumes only
 * `usedPercentage`. A second conversion site is exactly the failure this
 * arrangement prevents: a figure that reads 94 on one surface and 6 on another.
 *
 * Nothing here derives a percentage from tokens. When `remaining_fraction` is
 * absent or unparseable the answer is "unknown", never an estimate.
 */

/**
 * Which contract window slot a quota bucket may occupy, decided by the
 * bucket's own ID.
 *
 * The contract has two fixed slots and the renderer labels them: a five-hour
 * window and a weekly one. Antigravity instead names its buckets — the doc's
 * example is `"gemini-weekly"` — so a bucket may only take a slot whose LABEL
 * its name makes true. `gemini-weekly` in the weekly slot is a restatement of
 * what the CLI called it; anything else would be us renaming the user's quota.
 *
 * An earlier version classified by reset HORIZON (`reset_time - capturedAt`)
 * instead, and it was wrong: the horizon is time-until-reset, not window
 * length. A weekly bucket read thirty minutes before it rolls over has a
 * thirty-minute horizon and would have been labelled a five-hour window. The
 * test `a reset_time already in the past is never presented as current` found
 * exactly that.
 *
 * There is deliberately NO pattern for the five-hour slot. Nothing in the
 * documentation describes such a bucket, and a speculative pattern for a name
 * nobody has seen is an untested branch that can only ever mislabel something.
 *
 * An unmatched bucket is DROPPED and counted. A partial answer is honest; a
 * mislabelled one is not.
 */
const BUCKET_SLOTS = [
  { slot: 'sevenDay', test: /week/i, skewMs: RESET_SKEW_MS.sevenDay },
];

/**
 * 0..1 remaining -> 0..100 used.
 *
 * Rejects anything outside the stated range rather than clamping it: a
 * fraction of 1.4 proves the producer is wrong, and clamping would turn that
 * proof into a confident number. Same rule as `percentage()` above.
 */
function usedFromRemaining(fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null;
  if (fraction < 0 || fraction > 1) return null;
  // Rounded to 2dp: the source carries four decimals (0.01% resolution), and
  // the raw subtraction produces float noise like 6.219999999999999.
  return Math.round((1 - fraction) * 10000) / 100;
}

/**
 * The bucket's reset instant in ms: the absolute `resetTime` when it parses,
 * otherwise the CLI's own `resetInSeconds` measured from the capture. Null
 * when neither is stated, which makes the bucket unclassifiable.
 */
function bucketResetMs(bucket, capturedAtMs) {
  if (bucket && typeof bucket.resetTime === 'string') {
    const ms = Date.parse(bucket.resetTime);
    if (Number.isFinite(ms)) return ms;
  }
  if (bucket && typeof bucket.resetInSeconds === 'number' && Number.isFinite(bucket.resetInSeconds)) {
    return capturedAtMs + bucket.resetInSeconds * 1000;
  }
  return null;
}

/**
 * Ids are echoed into a log line, so they get the same treatment the bridge
 * gives them before printing. The capture file is a plaintext file in the
 * user's profile and anything may write one; the bridge is not the only
 * possible author.
 */
function safeId(id) {
  if (typeof id !== 'string') return null;
  // Same class as `CONTROL_CHARS` in the bridge and in the renderer's
  // sanitizer: control, zero-width and bidi-override characters.
  const clean = id.replace(
    /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g,
    '',
  );
  return clean.length > 0 && clean.length <= 64 ? clean : null;
}

/**
 * @returns the same shape as `readClaudeRateLimits`, so that
 *   `snapshot.windowFrom` governs rollover for both providers through one
 *   implementation, plus diagnostics: `bucketsSeen`, `bucketsMapped`,
 *   `unmappedIds` and a `reason` naming WHY an `absent` is absent.
 *
 *   `bucketsSeen - bucketsMapped` is a count of buckets this reader could not
 *   put in a slot, for ANY cause: a non-object entry, a fraction it does not
 *   understand or will not accept, or a name neither window label describes.
 *   It is not a per-cause breakdown; `unmappedIds` names the buckets so the
 *   cause can be found in the capture file itself.
 *
 *   - `missing`  no file: the bridge was never installed
 *   - `invalid`  file unreadable or not the expected shape
 *   - `absent`   the bridge ran, but nothing could be stated truthfully.
 *                `reason` says which:
 *                  'no-quota'     the payload carried no `quota` object
 *                  'unrecognised' buckets arrived, none of them usable
 *                  'truncated'    more buckets than the bridge's cap, so the
 *                                 most-consumed one may have been dropped
 *   - `stale`    older than MAX_AGE_MS
 *   - `fresh`    usable
 */
function readAntigravityQuota(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
  const cap = readCapture(options.file || antigravityQuotaFile(), now);
  if (cap.state !== 'ok') {
    return { ...emptyCapture(cap.state), bucketsSeen: 0, bucketsMapped: 0, unmappedIds: [], reason: null };
  }

  const { raw, capturedAt, capturedAtMs, ageMs } = cap;
  const quota = raw.present === true && raw.quota && typeof raw.quota === 'object' && !Array.isArray(raw.quota)
    ? raw.quota
    : null;
  if (!quota) {
    return {
      state: 'absent', capturedAt, capturedAtMs, ageMs,
      fiveHour: null, sevenDay: null, bucketsSeen: 0, bucketsMapped: 0, unmappedIds: [], reason: 'no-quota',
    };
  }

  const ids = Object.keys(quota).sort();

  // The bridge caps how many buckets it copies, and the cap drops
  // alphabetically last — which is arbitrary with respect to consumption. The
  // slot below keeps the MOST consumed bucket as the binding constraint, so a
  // set we know is incomplete cannot yield a trustworthy maximum: the dropped
  // bucket may have been the binding one, and reporting the roomiest survivor
  // would be an OPTIMISTIC error manufactured by a size guard. We refuse the
  // whole reading instead of presenting a maximum we were told is partial.
  if (raw.truncated === true) {
    return {
      state: 'absent', capturedAt, capturedAtMs, ageMs,
      fiveHour: null, sevenDay: null,
      bucketsSeen: ids.length, bucketsMapped: 0,
      unmappedIds: ids.map(safeId).filter((x) => x !== null).slice(0, 16),
      reason: 'truncated',
    };
  }

  const slots = { fiveHour: null, sevenDay: null };
  const unmapped = [];
  let mapped = 0;

  for (const id of ids) {
    const bucket = quota[id];
    if (!bucket || typeof bucket !== 'object') { unmapped.push(id); continue; }

    const used = usedFromRemaining(bucket.remainingFraction);
    // No server-computed fraction means no percentage. Not an estimate and not
    // a zero: the bucket simply contributes nothing.
    if (used === null) { unmapped.push(id); continue; }

    const target = BUCKET_SLOTS.find((b) => b.test.test(id));
    if (!target) { unmapped.push(id); continue; }

    mapped += 1;
    // The same credibility guard as Claude's `resetInstant`: an instant far
    // outside this window's own length would keep a dead percentage alive
    // forever, because `now >= resetsAt` never becomes true. A bucket with no
    // usable instant at all keeps its figure and gets `resetsAtMs: null` —
    // identical to Claude's `windowOf`, and `snapshot.windowFrom` already
    // knows that such a reading may not outlive its freshness budget.
    const resetMs = bucketResetMs(bucket, capturedAtMs);
    const resetsAtMs = resetMs !== null && Math.abs(resetMs - now) <= target.skewMs ? resetMs : null;
    const candidate = { usedPercentage: used, resetsAtMs };

    // Two buckets in one slot: keep the MORE consumed one. It is the binding
    // constraint on the user, and it errs pessimistic — the same direction the
    // rest of this file takes when it has to choose.
    const held = slots[target.slot];
    if (!held || candidate.usedPercentage > held.usedPercentage) slots[target.slot] = candidate;
  }

  // Bounded and sanitised because the caller logs them. Sorted already, so the
  // slice is deterministic and the same run produces the same line twice.
  const unmappedIds = unmapped.map(safeId).filter((x) => x !== null).slice(0, 16);

  if (mapped === 0) {
    return {
      state: 'absent', capturedAt, capturedAtMs, ageMs,
      fiveHour: null, sevenDay: null, bucketsSeen: ids.length, bucketsMapped: 0,
      unmappedIds,
      // The distinction the collector logs. `no-quota` is "the CLI had nothing
      // to say"; this is "the CLI said something and we could not read it",
      // which is the likeliest real-world failure of this provider — the
      // bucket id space is undocumented — and the only one a user report can
      // be acted on from.
      reason: ids.length > 0 ? 'unrecognised' : 'no-quota',
    };
  }

  const state = (ageMs > maxAgeMs || ageMs < -maxAgeMs) ? 'stale' : 'fresh';
  return {
    state, capturedAt, capturedAtMs, ageMs,
    fiveHour: slots.fiveHour, sevenDay: slots.sevenDay,
    bucketsSeen: ids.length, bucketsMapped: mapped,
    unmappedIds,
    reason: null,
  };
}

module.exports = {
  readClaudeRateLimits,
  readAntigravityQuota,
  usedFromRemaining,
  MAX_AGE_MS,
  RESET_SKEW_MS,
  BUCKET_SLOTS,
};
