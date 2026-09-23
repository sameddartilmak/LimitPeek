'use strict';
const { keySpec } = require('./registry');

/**
 * Key and username validation (ADR-003 Amendment 5, K5/K23). Runs in MAIN, on
 * the value that arrived over IPC, and it is the only thing that decides
 * whether a secret is stored.
 *
 * Three rules shape every branch below:
 *
 *  1. NOTHING IS ECHOED. No return value, log line or error message here
 *     contains the input, a slice of it, its length or a mask of it. The
 *     renderer gets a fixed code from a closed set (A8), which is why the page
 *     can print a sentence without ever having seen the value.
 *  2. LENGTH BEFORE CONTENT. A 10 MB string is refused on its length before
 *     anything trims, copies or regex-matches it, so a hostile payload cannot
 *     turn one IPC message into unbounded main-thread work.
 *  3. A NAMED REFUSAL BEATS A GENERIC ONE, but only when it is certain. A
 *     `ghp_` token is another app's credential and is named as such
 *     ('wrong-token-type'); another vendor's prefix is named 'wrong-provider';
 *     everything else is 'invalid', because guessing WHY a string is not a
 *     fine-grained PAT would mean describing the string.
 */

/** Hard ceiling on an accepted key, before trimming (K5). */
const MAX_KEY_LENGTH = 512;

/**
 * Trimmed at the ENDS only, and that is deliberate. A pasted token routinely
 * carries a trailing newline or a leading space from the clipboard, and
 * refusing that would be a refusal the user cannot see. Whitespace INSIDE is
 * not trimmed and not tolerated: `keyPattern` has no whitespace class, so a
 * CRLF in the middle fails as it should.
 */
function trimEnds(value) {
  // Every codepoint is written as an ESCAPE, never as a literal byte. A literal
  // U+200B or U+FEFF inside a character class is invisible in review and one
  // editor pass away from silent corruption, which is why
  // `test/source-hygiene.test.js` bans the literal form repo-wide.
  // The class is: \s, C0 controls, NBSP, the U+2000-U+200B spaces, and BOM.
  return value.replace(/^[\s\u0000-\u001f\u00a0\u2000-\u200b\ufeff]+/, '')
    .replace(/[\s\u0000-\u001f\u00a0\u2000-\u200b\ufeff]+$/, '');
}


function startsWithAny(value, prefixes) {
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * @param {string} providerId
 * @param {unknown} raw
 * @returns {{ok:true, key:string} | {ok:false, code:'invalid'|'wrong-token-type'|'wrong-provider'|'unknown-provider'}}
 */
function validateKey(providerId, raw) {
  const spec = keySpec(providerId);
  if (!spec) return { ok: false, code: 'unknown-provider' };
  // A non-string — a number, an object, a Buffer from a hostile sender — is
  // refused before `.length` is read, because on some of those shapes
  // `.length` is attacker-controlled.
  if (typeof raw !== 'string') return { ok: false, code: 'invalid' };
  if (raw.length === 0 || raw.length > MAX_KEY_LENGTH) return { ok: false, code: 'invalid' };

  const key = trimEnds(raw);
  if (key.length === 0) return { ok: false, code: 'invalid' };

  // Another app's GitHub credential. Checked BEFORE the shape test so the user
  // is told what is wrong with the thing they pasted, and checked
  // case-sensitively because GitHub's prefixes are lower case and a
  // `GHP_`-cased string is not a token GitHub issued.
  if (startsWithAny(key, spec.wrongTokenTypePrefixes)) return { ok: false, code: 'wrong-token-type' };
  // Another vendor's key entirely.
  if (startsWithAny(key, spec.foreignProviderPrefixes)) return { ok: false, code: 'wrong-provider' };

  if (!spec.keyPattern.test(key)) return { ok: false, code: 'invalid' };
  return { ok: true, key };
}

/**
 * GitHub's own login shape, checked here as well as on the page (K23): the page
 * is convenience, this is the control. The username goes into a URL path, so
 * the pattern is an allowlist of exactly what GitHub permits — no dots, no
 * slashes, no percent, nothing that could add a path segment or a query.
 *
 * @returns {{ok:true, username:string} | {ok:false, code:'invalid-username'}}
 */
function validateUsername(providerId, raw) {
  const spec = keySpec(providerId);
  if (!spec) return { ok: false, code: 'invalid-username' };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
    return { ok: false, code: 'invalid-username' };
  }
  const username = trimEnds(raw);
  if (!spec.usernamePattern.test(username)) return { ok: false, code: 'invalid-username' };
  return { ok: true, username };
}

module.exports = { validateKey, validateUsername, MAX_KEY_LENGTH, trimEnds };
