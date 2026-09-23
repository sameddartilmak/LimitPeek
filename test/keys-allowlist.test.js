'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { isAllowedKeyedRequest, isAllowedForAnyProvider, rawAuthority } = require('../src/core/keys/allowlist');
const { keySpec } = require('../src/core/keys/registry');

/**
 * The allowlist matrix (ADR-003 Amendment 5, K14).
 *
 * Amendment 5 names the trap: a URL-FILTERED listener leaves non-matching URLs
 * unfiltered, so the keyed session's single listener is unfiltered and decides
 * everything here. Which means this table is the control — every row is a
 * request that must be CANCELLED, and the one allowed shape is spelled out once.
 */

const SPEC = keySpec('copilot');
const ALLOWED_URL = 'https://api.github.com/users/octocat/settings/billing/ai_credit/usage';
const CONTEXT = { expectedUrl: ALLOWED_URL };

function allowed(details, context = CONTEXT) {
  return isAllowedKeyedRequest(details, SPEC, context);
}

test('the one allowed request is allowed', () => {
  assert.equal(allowed({ url: ALLOWED_URL, method: 'GET' }), true);
  // Electron omits `method` on some resource types; the table's method is then
  // the only one that could have been used, since this module makes the request.
  assert.equal(allowed({ url: ALLOWED_URL }), true);
  assert.equal(isAllowedForAnyProvider({ url: ALLOWED_URL, method: 'GET' }, CONTEXT), true);
});

test('the cancellation matrix', () => {
  const cases = [
    ['another host entirely', { url: 'https://example.com/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['a suffix-extended lookalike', { url: 'https://api.github.com.evil.com/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['a prefix-extended lookalike', { url: 'https://evil.api.github.com/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['a trailing dot', { url: 'https://api.github.com./users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['plain http', { url: 'http://api.github.com/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['an explicit default port', { url: 'https://api.github.com:443/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['another port', { url: 'https://api.github.com:8443/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['userinfo', { url: 'https://user:pass@api.github.com/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['userinfo naming the host', { url: 'https://api.github.com@evil.com/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['POST', { url: ALLOWED_URL, method: 'POST' }],
    ['a lower-case method', { url: ALLOWED_URL, method: 'get' }],
    ['another path on the same host', { url: 'https://api.github.com/user', method: 'GET' }],
    ['the classic billing path', { url: 'https://api.github.com/users/octocat/settings/billing/usage', method: 'GET' }],
    ['a query string', { url: `${ALLOWED_URL}?year=2026`, method: 'GET' }],
    ['a fragment', { url: `${ALLOWED_URL}#x`, method: 'GET' }],
    ['a traversal in the path', { url: 'https://api.github.com/users/octocat/settings/billing/ai_credit/usage/../../../user', method: 'GET' }],
    ['a backslash authority terminator', { url: 'https://api.github.com\\@evil.com/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['an upper-case host', { url: 'https://API.GITHUB.COM/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['a websocket scheme', { url: 'wss://api.github.com/users/octocat/settings/billing/ai_credit/usage', method: 'GET' }],
    ['a file URL', { url: 'file:///C:/Windows/System32/config/SAM', method: 'GET' }],
    ['a data URL', { url: 'data:text/plain,hello', method: 'GET' }],
    ['a request owned by a page', { url: ALLOWED_URL, method: 'GET', webContentsId: 7 }],
    ['a webContentsId of 0', { url: ALLOWED_URL, method: 'GET', webContentsId: 0 }],
    ['no url', { method: 'GET' }],
    ['a non-string url', { url: 12, method: 'GET' }],
    ['an absurdly long url', { url: `${ALLOWED_URL}${'/a'.repeat(2000)}`, method: 'GET' }],
    ['no details at all', null],
  ];
  for (const [label, details] of cases) {
    assert.equal(allowed(details), false, label);
    assert.equal(isAllowedForAnyProvider(details, CONTEXT), false, label);
  }
});

test('with nothing in flight — no key, or a REMOVED key — everything is cancelled', () => {
  for (const context of [undefined, {}, { expectedUrl: null }, { expectedUrl: '' }]) {
    assert.equal(isAllowedKeyedRequest({ url: ALLOWED_URL, method: 'GET' }, SPEC, context), false);
    assert.equal(isAllowedForAnyProvider({ url: ALLOWED_URL, method: 'GET' }, context), false);
  }
});

test('a request for a DIFFERENT username than the one in flight is cancelled', () => {
  const other = 'https://api.github.com/users/someone-else/settings/billing/ai_credit/usage';
  assert.equal(allowed({ url: other, method: 'GET' }), false);
  // …and it is allowed when it IS the one in flight, so the check is the
  // equality and not an accident of the path pattern.
  assert.equal(allowed({ url: other, method: 'GET' }, { expectedUrl: other }), true);
});

test('a missing spec cancels rather than falling through', () => {
  assert.equal(isAllowedKeyedRequest({ url: ALLOWED_URL, method: 'GET' }, null, CONTEXT), false);
  assert.equal(isAllowedKeyedRequest({ url: ALLOWED_URL, method: 'GET' }, undefined, CONTEXT), false);
});

test('the raw authority is read as written, not as normalised', () => {
  // This is why an explicit :443 can be refused at all: `new URL()` drops it.
  assert.equal(new URL('https://api.github.com:443/x').port, '');
  assert.equal(rawAuthority('https://api.github.com:443/x'), 'api.github.com:443');
  assert.equal(rawAuthority('https://api.github.com/x'), 'api.github.com');
  assert.equal(rawAuthority('https://u@api.github.com/x'), 'u@api.github.com');
  assert.equal(rawAuthority('https://api.github.com'), 'api.github.com');
  assert.equal(rawAuthority('not a url'), null);
});
