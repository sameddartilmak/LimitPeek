'use strict';

/**
 * Logging with parse discipline (ADR-001, security F3).
 *
 * A malformed JSONL line may contain prompt text, file contents or secrets.
 * `JSON.parse`'s own error message embeds a slice of the offending source, so
 * it is never propagated either. We log the hashed file id and the line index
 * and nothing else.
 */

const DEFAULT_SINK = (level, msg) => {
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](`[usage-notch] ${msg}`);
};

let sink = DEFAULT_SINK;

/** Pass a function to redirect, or null/undefined to restore the default. */
function setSink(fn) {
  sink = typeof fn === 'function' ? fn : DEFAULT_SINK;
}

function info(msg) {
  sink('info', msg);
}

function warn(msg) {
  sink('warn', msg);
}

function error(msg) {
  sink('error', msg);
}

/* ------------------------------------------------------------------ trace */

/**
 * Timestamped diagnostic trace for the tray/panel gesture path.
 *
 * It exists because a user reported a visible open-then-close flash on ONE
 * real mouse click, and synthetic `SendInput` could not reproduce it. Nothing
 * short of the real sequence, in order, with real timings, can say which of
 * the tray events, the blur re-check and the pointer poll produced it — so
 * this prints every state transition on that path rather than a summary.
 *
 * ON BY DEFAULT, deliberately. A flag nobody sets is a flag that will not be
 * set on the machine where the bug happens. `USAGE_NOTCH_TRACE=0` turns it
 * off; the test suite does that so 480 tests do not narrate themselves.
 *
 * The offset is `performance.now()`, which Node and Electron both measure from
 * process start and which is monotonic — so a click at "+12873ms" and the hide
 * at "+13424ms" can be subtracted safely even if the wall clock steps.
 */
let traceOn = process.env.USAGE_NOTCH_TRACE !== '0';

/** Pass false to silence the trace (the test suite does). */
function setTrace(on) {
  traceOn = on !== false;
}

function traceEnabled() {
  return traceOn;
}

/**
 * The parse-discipline guard, applied structurally rather than by review.
 *
 * Every event name, key and value has to match this or it is replaced by the
 * literal `redacted`. That is what keeps a diagnostic channel from becoming
 * the one place a file path, a prompt fragment or an error message reaches the
 * log — the failure this module exists to prevent, and one that a hand-audited
 * list of call sites would eventually lose to a later edit.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_.:+-]{1,48}$/;

function traceValue(value) {
  if (typeof value === 'boolean' || value === null) return String(value);
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.round(value)) : 'nonfinite';
  }
  if (typeof value === 'string') return SAFE_TOKEN.test(value) ? value : 'redacted';
  return 'redacted';
}

/**
 * @param {string} event dotted name, e.g. `tray.click` or `panel.blur`
 * @param {Record<string, boolean|number|string|null>} [detail] scalars only
 */
function trace(event, detail) {
  if (!traceOn) return;
  const name = SAFE_TOKEN.test(String(event)) ? String(event) : 'redacted';
  let line = `trace +${Math.round(performance.now())}ms ${name}`;
  if (detail && typeof detail === 'object') {
    for (const key of Object.keys(detail)) {
      if (!SAFE_TOKEN.test(key)) continue;
      if (detail[key] === undefined) continue;
      line += ` ${key}=${traceValue(detail[key])}`;
    }
  }
  sink('info', line);
}

/* ---------------------------------------------------------------- records */

/** NEVER add the line, a substring of it, or the JSON.parse error message. */
function parseFailure(fileId, lineIndex) {
  sink('warn', `skipped unparsable record: file=${fileId} line=${lineIndex}`);
}

/** `err` is deliberately reduced to its code/name. No message, no path. */
function fileFailure(fileId, err) {
  const code = (err && (err.code || err.name)) || 'UNKNOWN';
  sink('warn', `skipped unreadable file: file=${fileId} code=${code}`);
}

module.exports = {
  setSink, info, warn, error, parseFailure, fileFailure,
  trace, setTrace, traceEnabled,
};
