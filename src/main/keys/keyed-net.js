'use strict';
const { net } = require('electron');

const log = require('../../core/log');
const { keySpec } = require('../../core/keys/registry');
const { validateUsername } = require('../../core/keys/validate');
const { isAllowedForAnyProvider } = require('../../core/keys/allowlist');
const { creditUsageFrom, keyStateForStatus } = require('../../core/keys/credits');
const { parseRetryAfter } = require('../../core/keys/schedule');
const security = require('../security');

/**
 * The ONLY module in this codebase that may open a socket (ADR-003 Amendment 5,
 * K13-K17). `test/contract-mirror.test.js` asserts that: the network scan holds
 * a single-file exception for this path and for nothing else, and that
 * `net.request(` appears here once and nowhere else.
 *
 * WHY ELECTRON `net` AND NOT NODE `https`
 * ---------------------------------------
 * Because a request made through `net` belongs to a SESSION, and a session can
 * carry a request filter. Node's `https` would bypass every control in this
 * file's neighbourhood: no allowlist, no proxy policy, nothing the security
 * review could point at. The session is `usage-notch-keyed`, in memory (no
 * `persist:` prefix), created LAZILY the first time a key exists, and it never
 * hosts a webContents — no BrowserWindow anywhere names this partition.
 *
 * THE TRAP THIS FILE IS SHAPED AROUND (Amendment 5)
 * -------------------------------------------------
 * Electron keeps only the LAST `onBeforeRequest` listener per session, and a
 * URL-FILTERED listener leaves non-matching URLs unfiltered. So:
 *   - `defaultSession`'s block-all listener is never touched, re-registered or
 *     scoped by anyone (K14a). The app's global block stays exactly as it was.
 *   - THIS session gets exactly ONE unfiltered listener, which delegates to the
 *     pure allowlist in `core/keys/allowlist.js`.
 *   - `security.createExemptSession` keeps the `session-created` hardening from
 *     installing a block-all listener on this session in the first place, so the
 *     two can never race over which one is last.
 *
 * WHAT LEAVES THE MACHINE
 * -----------------------
 * One GET to one hard-coded host, DIRECT. Proxy auto-discovery is off process
 * wide and this session is explicitly `{ mode: 'direct' }` (ADR-001 Amendment
 * 2026-09-22): WPAD put DNS datagrams and a loopback PAC fetch on the wire of
 * every machine that ran the packaged app, key or no key, through a channel the
 * request filter cannot see. The cost is stated where the switch is set — a user
 * whose network needs a proxy cannot reach `api.github.com`, so this figure is
 * unavailable to them and the row says 'unreachable'. The `login` handler below
 * stays anyway: it costs nothing and it is the right answer if a proxy is ever
 * reintroduced.
 *
 * The key travels in the Authorization header and nowhere else — never in the
 * URL, never in a query, never logged. No cookies,
 * no session credentials, no referrer, no cache, no redirect following, no TLS
 * override of any kind (this file calls neither `setCertificateVerifyProc` nor
 * anything like it), and a proxy that asks for credentials is refused rather
 * than answered.
 */

/**
 * Taken from `security.js` rather than written twice (security review of Phase
 * B, F1): that module refuses to exempt any other partition, so the name now
 * exists as a literal in exactly ONE place in this codebase. Two copies of a
 * string that has to match is the drift that would make the exemption silently
 * apply to a different session than the one this file uses.
 */
const PARTITION = security.EXEMPT_PARTITION;

/** Hard limits (K16). */
const TIMEOUT_MS = 15 * 1000;
const MAX_BODY_BYTES = 256 * 1024;

let keyedSession = null;
/**
 * The request in flight: at most one, ever (K16). It also carries the exact URL
 * the allowlist will accept, so with nothing in flight the session cancels
 * everything — including a request a removed key could otherwise have made.
 */
let inFlight = null;

function isInFlight() {
  return inFlight !== null;
}

/**
 * The keyed session, created on first use.
 *
 * Not created at startup, and not created by reading this module: an install
 * with no key must own no such session at all, which is what makes the
 * OS-level "no key = zero sockets" audit (F11) a property of the build rather
 * than of a code path nobody took.
 */
function ensureSession() {
  if (keyedSession) return keyedSession;
  keyedSession = security.createExemptSession(PARTITION);

  // ONE listener, no URL filter (see the header comment). `callback` is called
  // on every path: an un-answered onBeforeRequest hangs the request.
  keyedSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedForAnyProvider(details, {
      expectedUrl: inFlight ? inFlight.url : null,
    });
    if (!allowed) {
      // No URL, no host, no method: a fixed line. A cancelled request here is
      // either a bug in this file or something that should not exist, and both
      // are worth one word in the log.
      log.warn('keyed session cancelled a request that is not the allowlisted one');
    }
    callback({ cancel: !allowed });
  });

  // This session serves no page, so nothing may ever ask it for a capability.
  keyedSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  keyedSession.setPermissionCheckHandler(() => false);
  if (typeof keyedSession.setDevicePermissionHandler === 'function') {
    keyedSession.setDevicePermissionHandler(() => false);
  }
  return keyedSession;
}

/** The first value of a response header, lower-cased key, or null. */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

/**
 * Makes the one allowed request and maps the answer to a fixed code.
 *
 * `readSecret` is called HERE, immediately before the request is created, and
 * its result is used for the Authorization header and the path and then left to
 * go out of scope (K17). Nothing in this module stores it, and the caller
 * passes a function rather than a value precisely so there is no decrypted key
 * sitting in a variable while a timer waits.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {() => {ok:boolean, key?:string, username?:string, code?:string}} args.readSecret
 * @param {number} args.now
 * @returns {Promise<{keyState:string, usage:object|null, retryAfterMs:number|null, requests:number}>}
 *   `keyState` is one of A8's codes. `requests` is how many requests were
 *   actually created, which is what the "one request per refresh" tests count.
 */
async function requestCreditUsage({ providerId, readSecret, now }) {
  const spec = keySpec(providerId);
  if (!spec) return { keyState: 'not-available', usage: null, retryAfterMs: null, requests: 0 };
  if (inFlight) return { keyState: 'busy', usage: null, retryAfterMs: null, requests: 0 };

  const secret = readSecret();
  if (!secret || secret.ok !== true) {
    return {
      keyState: secret && secret.code === 'unreadable' ? 'unreadable' : 'none',
      usage: null,
      retryAfterMs: null,
      requests: 0,
    };
  }
  const user = validateUsername(providerId, secret.username);
  if (!user.ok) {
    // A record whose username no longer passes the shape check is a record we
    // cannot build a path from. 'unreadable' is the honest state: the local copy
    // is unusable, and nothing was sent.
    return { keyState: 'unreadable', usage: null, retryAfterMs: null, requests: 0 };
  }

  const url = `${spec.scheme}//${spec.host}${spec.buildPath(user.username)}`;
  const sess = ensureSession();
  inFlight = { url, request: null, timer: null, settled: false };

  try {
    return await new Promise((resolve) => {
      const done = (result) => {
        if (inFlight && inFlight.settled) return;
        if (inFlight) inFlight.settled = true;
        resolve(result);
      };
      // Published so `abortInFlight()` can END this promise as well as the
      // socket. Without it, an abort from removal would clear the timeout and
      // leave nothing to settle: `inFlight` would stay set for ever and every
      // later request would answer 'busy' — the key would be gone and the row
      // would be stuck, with no error anywhere to explain it.
      inFlight.settle = done;

      let request;
      try {
        request = net.request({
          method: spec.method,
          url,
          session: sess,
          // Follow nothing. A 3xx is an error, not a hop: a redirect is how a
          // request to one allowlisted host becomes a request to another.
          redirect: 'error',
          // No cookies and no session auth data, in either direction.
          credentials: 'omit',
          useSessionCookies: false,
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
      } catch (err) {
        log.warn(`keyed request could not be created: code=${(err && err.code) || 'UNKNOWN'}`);
        done({ keyState: 'unreachable', usage: null, retryAfterMs: null, requests: 0 });
        return;
      }
      inFlight.request = request;

      for (const [name, value] of Object.entries(spec.headers)) request.setHeader(name, value);
      // The ONLY place the key appears. Set on the request that is about to be
      // sent, from a value this function does not keep.
      request.setHeader('Authorization', `Bearer ${secret.key}`);

      inFlight.timer = setTimeout(() => {
        abortRequest(request);
        done({ keyState: 'unreachable', usage: null, retryAfterMs: null, requests: 1 });
      }, TIMEOUT_MS);
      if (inFlight.timer.unref) inFlight.timer.unref();

      // A proxy asking for credentials gets none, and the request ends. Answering
      // it would send the user's Windows credentials to whatever is on the path.
      request.on('login', (_authInfo, callback) => {
        callback();
        abortRequest(request);
        done({ keyState: 'unreachable', usage: null, retryAfterMs: null, requests: 1 });
      });

      request.on('error', (err) => {
        // `err.message` is never logged or surfaced (K19): on this path it can
        // carry the URL, the host and a certificate subject.
        log.warn(`keyed request failed: code=${(err && err.code) || 'NET'}`);
        done({ keyState: 'unreachable', usage: null, retryAfterMs: null, requests: 1 });
      });

      request.on('response', (response) => {
        const status = response.statusCode;
        const retryAfterMs = parseRetryAfter(headerValue(response.headers, 'retry-after'), now);
        // The only other header read, and only to tell GitHub's two meanings of
        // 403 apart (see `keyStateForStatus`). It moves a timer and chooses a
        // fixed code; it is never logged, stored or surfaced.
        const rateLimitRemaining = headerValue(response.headers, 'x-ratelimit-remaining');
        const chunks = [];
        let size = 0;
        let overflowed = false;

        response.on('data', (chunk) => {
          if (overflowed) return;
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            overflowed = true;
            abortRequest(request);
            done({ keyState: 'unreachable', usage: null, retryAfterMs: null, requests: 1 });
            return;
          }
          chunks.push(chunk);
        });
        response.on('aborted', () => {
          done({ keyState: 'unreachable', usage: null, retryAfterMs: null, requests: 1 });
        });
        response.on('error', () => {
          done({ keyState: 'unreachable', usage: null, retryAfterMs: null, requests: 1 });
        });
        response.on('end', () => {
          if (overflowed) return;
          if (status !== 200) {
            done({
              keyState: keyStateForStatus(status, retryAfterMs, rateLimitRemaining),
              usage: null,
              retryAfterMs,
              requests: 1,
            });
            return;
          }
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // The parse error message embeds a slice of the reply and is
            // dropped whole (ADR-001 security F3, K19).
            done({ keyState: 'not-available', usage: null, retryAfterMs: null, requests: 1 });
            return;
          }
          const usage = creditUsageFrom(body, now);
          if (usage === null) {
            // A 200 we could not fully validate produces NO figure and says so
            // (all-or-nothing, A6.3). Never a partial sum.
            done({ keyState: 'not-available', usage: null, retryAfterMs: null, requests: 1 });
            return;
          }
          done({ keyState: 'stored', usage, retryAfterMs: null, requests: 1 });
        });
      });

      request.end();
    });
  } finally {
    if (inFlight && inFlight.timer) clearTimeout(inFlight.timer);
    inFlight = null;
  }
}

function abortRequest(request) {
  try { request.abort(); } catch { /* already finished */ }
}

/**
 * Aborts anything in flight. Part of removal (K20) and of quitting: a request
 * whose key has just been deleted must not still be on the wire.
 */
function abortInFlight() {
  if (!inFlight) return false;
  if (inFlight.timer) clearTimeout(inFlight.timer);
  if (inFlight.request) abortRequest(inFlight.request);
  // The socket AND the promise. `inFlight` itself is cleared by the `finally`
  // in `requestCreditUsage`, so a second request cannot start while the first
  // one is still unwinding.
  if (inFlight.settle) {
    inFlight.settle({ keyState: 'unreachable', usage: null, retryAfterMs: null, requests: 1 });
  }
  return true;
}

/**
 * Removal and shutdown: abort, close every socket this session owns, and clear
 * any authentication it cached (K20). The session object itself is kept — there
 * is no `destroy()` for an in-memory session — but with nothing in flight its
 * allowlist cancels every request, so a kept session is not a reachable one.
 */
function teardown() {
  abortInFlight();
  if (!keyedSession) return;
  try {
    const closed = keyedSession.closeAllConnections();
    if (closed && typeof closed.catch === 'function') closed.catch(() => {});
  } catch { /* nothing open */ }
  try {
    const cleared = keyedSession.clearAuthCache();
    if (cleared && typeof cleared.catch === 'function') cleared.catch(() => {});
  } catch { /* nothing cached */ }
}

/** Test seam: forget the session so the next test creates its own. */
function _resetForTests() {
  keyedSession = null;
  inFlight = null;
}

module.exports = {
  requestCreditUsage,
  ensureSession,
  abortInFlight,
  teardown,
  isInFlight,
  PARTITION,
  TIMEOUT_MS,
  MAX_BODY_BYTES,
  _resetForTests,
};
