'use strict';
const { KEY_PROVIDERS } = require('./registry');

/**
 * The keyed session's request allowlist (ADR-003 Amendment 5, K14).
 *
 * WHY THIS IS A PURE FUNCTION IN core/
 * ------------------------------------
 * It is the single decision that keeps ADR-001's zero-outbound rule true once a
 * key exists, and Amendment 5 names the trap it avoids: Electron keeps only the
 * LAST `onBeforeRequest` listener per session, and a URL-FILTERED listener
 * leaves every non-matching URL unfiltered. So the keyed session gets exactly
 * ONE unfiltered listener, and it delegates to this function — which can then
 * be tested against the whole hostile matrix under plain `node --test`, with no
 * Electron and no sockets.
 *
 * `defaultSession`'s block-all listener is never touched by any of this. That
 * is K14a, and it is asserted by a test that checks the default session still
 * cancels `https://api.github.com` while a key is stored.
 *
 * WHAT IS ALLOWED
 * ---------------
 * `https`, the exact host from the hard-coded table (no port, no userinfo), the
 * method from the table, a path matching the table's pattern, no query, no
 * fragment, and no owning webContents. Anything else — another host, a
 * suffix-extended lookalike (`api.github.com.evil.com`), plain http, an
 * explicit `:443`, a POST, another path, a request while no key is stored — is
 * cancelled. Nothing here is a denylist: an unrecognised shape falls through to
 * `false` at every step.
 */

/** A URL longer than this is not one of ours and is not worth parsing. */
const MAX_URL_LENGTH = 2048;

/**
 * The authority as WRITTEN, not as parsed.
 *
 * `new URL()` normalises the default port away — `https://api.github.com:443/x`
 * parses with `port === ''` — so a parsed check cannot honour "no port". It
 * also lower-cases the host. Comparing the raw authority to the table's host
 * refuses an explicit port, any userinfo (`user@`), any case variant and any
 * bracketed IPv6 form in one comparison, before anything is parsed.
 *
 * @returns {string|null} the raw authority, or null when the URL has no `//`
 */
function rawAuthority(url) {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd < 0) return null;
  const start = schemeEnd + 3;
  let end = url.length;
  for (let i = start; i < url.length; i += 1) {
    const ch = url[i];
    if (ch === '/' || ch === '?' || ch === '#' || ch === '\\') { end = i; break; }
  }
  return url.slice(start, end);
}

/**
 * @param {{url?:unknown, method?:unknown, webContentsId?:unknown}} details
 *   Shaped like Electron's `onBeforeRequest` details, but it is only ever read
 *   as plain data here.
 * @param {object} spec  a frozen entry of `KEY_PROVIDERS`
 * @param {{expectedUrl?:string|null}} [context]
 *   `expectedUrl` is the URL of the request this module is CURRENTLY making. It
 *   is a second, tighter gate, not a substitute for the structural checks: with
 *   nothing in flight (and therefore with no key, or with a removed one) it is
 *   null and everything is cancelled.
 * @returns {boolean} true only when the request may proceed
 */
function isAllowedKeyedRequest(details, spec, context) {
  if (!details || typeof details !== 'object' || !spec) return false;

  const { url, method } = details;
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return false;

  // An owning webContents means a page made this request. The keyed session
  // must never host one (K13); if it somehow does, its requests are not ours.
  if (details.webContentsId !== undefined && details.webContentsId !== null) return false;

  // Electron reports the method in upper case; anything else is refused rather
  // than folded, so a `get` from a stranger does not become a GET.
  if (method !== undefined && method !== spec.method) return false;

  if (!url.startsWith(`${spec.scheme}//`)) return false;
  if (rawAuthority(url) !== spec.host) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== spec.scheme) return false;
  if (parsed.host !== spec.host || parsed.hostname !== spec.host || parsed.port !== '') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.search !== '' || parsed.hash !== '') return false;
  if (!spec.pathPattern.test(parsed.pathname)) return false;

  const expected = context && typeof context.expectedUrl === 'string' ? context.expectedUrl : null;
  if (expected === null) return false;
  return url === expected;
}

/**
 * The same decision for a session that may serve several key-capable providers.
 * Today the table has one entry; this exists so the listener never has to be
 * rewritten to gain a second, which is exactly the edit that would reintroduce
 * a URL filter.
 */
function isAllowedForAnyProvider(details, context) {
  for (const id of Object.keys(KEY_PROVIDERS)) {
    if (isAllowedKeyedRequest(details, KEY_PROVIDERS[id], context)) return true;
  }
  return false;
}

module.exports = { isAllowedKeyedRequest, isAllowedForAnyProvider, rawAuthority, MAX_URL_LENGTH };
