'use strict';

/**
 * The hard-coded table of key-capable providers (ADR-003 Amendment 5 K13/K14,
 * Amendment 6 decision 3, Amendment 8).
 *
 * EVERYTHING about an outbound request is in here, as a constant: the scheme,
 * the exact host, the method, the path shape, the headers. Nothing in this
 * table is ever built from a stored value, an IPC argument or a provider reply.
 * That is the whole point — the allowlist (`allowlist.js`) and the request
 * (`main/keys/keyed-net.js`) both read THIS object, so "one host per stored
 * key" is a property of a frozen literal rather than of a code path someone
 * has to keep reviewing.
 *
 * Copilot is the ONLY entry, and the only one that may be added without a
 * fresh ADR: Amendment 6 rules out a Gemini key flow (an API key exposes no
 * quota and is a different pool from the Google-login CLI) and holds Kimi (an
 * undocumented endpoint reached with a full spend key). `keyCapable` is
 * therefore FALSE for every other provider, and that is asserted in tests
 * rather than left to this comment.
 *
 * Imports nothing from `electron`, like everything else under `src/core`
 * (ADR-001 Decision 2).
 */

/**
 * The one allowed GitHub request: the documented AI-credit usage report for a
 * user (ADR-003 A6.3).
 *
 *   GET https://api.github.com/users/{username}/settings/billing/ai_credit/usage
 *
 * `GET /user` is deliberately NOT used to discover the login: it needs no extra
 * permission but it returns the whole account profile, and one more endpoint is
 * one more reply to validate and one more thing the allowlist has to permit.
 * The username comes from the user (A8; the entry page collects it) and is
 * checked against GitHub's own login shape before it is ever put in a path.
 */
const USERNAME_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

/**
 * The path, as a template and as a recogniser.
 *
 * Two forms of the same constant on purpose: `buildPath` is what the request
 * uses, `PATH_PATTERN` is what the session filter checks an arbitrary URL
 * against. They are held equal by a test that builds a path and matches it.
 */
function buildCopilotPath(username) {
  return `/users/${username}/settings/billing/ai_credit/usage`;
}

const COPILOT_PATH_PATTERN = /^\/users\/[A-Za-z0-9-]{1,39}\/settings\/billing\/ai_credit\/usage$/;

/**
 * A fine-grained PAT, GitHub's documented shape: `github_pat_` followed by
 * base62 and underscores. The length band is wide because GitHub has never
 * published an exact one; what matters is that an OAuth token, an app token or
 * another vendor's key cannot pass (K5).
 */
const COPILOT_KEY_PATTERN = /^github_pat_[A-Za-z0-9_]{40,244}$/;

/**
 * GitHub's OTHER token prefixes. Every one of these is a credential some app
 * already holds — `gho_`/`ghu_` are OAuth app tokens, `ghp_` a classic PAT,
 * `ghs_` an installation token, `ghr_` a refresh token. Accepting one would
 * mean accepting a credential the user did not mint for us, with scopes we
 * cannot see, which is the pre-declared veto in Amendment 5.
 */
const GITHUB_FOREIGN_TOKEN_PREFIXES = Object.freeze(['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']);

/**
 * Prefixes that identify ANOTHER VENDOR's key. A user who pastes one has
 * misunderstood which field they are in, and the honest answer names the
 * mistake ('wrong-provider') instead of a generic refusal.
 */
const FOREIGN_PROVIDER_PREFIXES = Object.freeze([
  'sk-ant-', 'sk-proj-', 'sk-kimi', 'sk-or-', 'sk-', 'AIza', 'ya29.', 'gsk_', 'xai-', 'moonshot-', 'csk-',
]);

const COPILOT = Object.freeze({
  id: 'copilot',
  /** The single allowed origin, as its three parsed parts. */
  scheme: 'https:',
  host: 'api.github.com',
  /** No port, ever: an explicit `:443` is refused too (Amendment 2, Kimi rules). */
  method: 'GET',
  buildPath: buildCopilotPath,
  pathPattern: COPILOT_PATH_PATTERN,
  usernamePattern: USERNAME_PATTERN,
  keyPattern: COPILOT_KEY_PATTERN,
  wrongTokenTypePrefixes: GITHUB_FOREIGN_TOKEN_PREFIXES,
  foreignProviderPrefixes: FOREIGN_PROVIDER_PREFIXES,
  /**
   * Fixed headers. `X-GitHub-Api-Version` pins the documented REST version, so
   * a future default cannot change the reply shape under us. The User-Agent is
   * a constant: GitHub requires one, and a machine-derived string would put
   * the user's hostname or account name on the wire.
   */
  headers: Object.freeze({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'UsageNotch',
  }),
  /**
   * No regional hosts. Kept as an explicit null so the field exists in the
   * stored record for every provider (the store writes `region`), and a future
   * multi-region provider cannot forget it.
   */
  region: null,
});

const KEY_PROVIDERS = Object.freeze({ copilot: COPILOT });

/** Ids in the table, i.e. every provider for which a key is even offered. */
const KEY_CAPABLE_IDS = Object.freeze(Object.keys(KEY_PROVIDERS));

function isKeyCapable(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(KEY_PROVIDERS, id);
}

/** The frozen spec, or null. Never throws: callers validate ids at the boundary. */
function keySpec(id) {
  return isKeyCapable(id) ? KEY_PROVIDERS[id] : null;
}

/**
 * The single key-capable provider, or null when there is not exactly one.
 *
 * Used by the panel's no-argument "open the token page" call (A8 addendum):
 * with one entry in the table there is nothing to disambiguate, and with two
 * the call must be refused rather than guessed.
 */
function soleKeyCapableId() {
  return KEY_CAPABLE_IDS.length === 1 ? KEY_CAPABLE_IDS[0] : null;
}

module.exports = {
  KEY_PROVIDERS,
  KEY_CAPABLE_IDS,
  USERNAME_PATTERN,
  isKeyCapable,
  keySpec,
  soleKeyCapableId,
};
