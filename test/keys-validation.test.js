'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateKey, validateUsername, MAX_KEY_LENGTH } = require('../src/core/keys/validate');
const { KEY_CAPABLE_IDS, isKeyCapable, keySpec, soleKeyCapableId } = require('../src/core/keys/registry');

/**
 * ADR-003 Amendment 5, K5 and K23, and Amendment 6's decision that Copilot is
 * the ONLY key-capable provider (K24).
 *
 * The table below is the whole point: every row is a value a user or a hostile
 * sender could put on the channel, and the assertion is always the same two
 * things — nothing is stored, and the refusal carries a FIXED CODE rather than
 * anything derived from the input.
 */

const VALID = `github_pat_${'A'.repeat(60)}`;

test('a well-formed fine-grained PAT is accepted, trimmed at the ends only', () => {
  assert.deepEqual(validateKey('copilot', VALID), { ok: true, key: VALID });
  // A pasted token routinely arrives with a trailing newline or a leading space.
  assert.deepEqual(validateKey('copilot', `  ${VALID}\r\n`), { ok: true, key: VALID });
  assert.deepEqual(validateKey('copilot', `\t${VALID} `), { ok: true, key: VALID });
});

test('every foreign GitHub token prefix is refused as wrong-token-type', () => {
  for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
    const result = validateKey('copilot', `${prefix}${'B'.repeat(50)}`);
    assert.deepEqual(result, { ok: false, code: 'wrong-token-type' }, prefix);
  }
});

test('another vendor’s key is refused as wrong-provider', () => {
  for (const key of [
    `sk-ant-api03-${'c'.repeat(40)}`,
    `sk-${'d'.repeat(40)}`,
    `sk-kimi-${'e'.repeat(40)}`,
    `AIza${'F'.repeat(35)}`,
    `ya29.${'g'.repeat(40)}`,
    `gsk_${'h'.repeat(40)}`,
    `xai-${'i'.repeat(40)}`,
  ]) {
    assert.deepEqual(validateKey('copilot', key), { ok: false, code: 'wrong-provider' }, key.slice(0, 6));
  }
});

test('the refusal table: nothing here is accepted, and no code is derived from the value', () => {
  const cases = [
    ['empty', ''],
    ['whitespace only', '   \r\n\t  '],
    ['a CRLF in the middle', `github_pat_${'A'.repeat(30)}\r\n${'A'.repeat(30)}`],
    ['a space in the middle', `github_pat_${'A'.repeat(30)} ${'A'.repeat(30)}`],
    ['too short', 'github_pat_short'],
    ['past the length cap', `github_pat_${'A'.repeat(MAX_KEY_LENGTH)}`],
    ['a 10 MB paste', 'a'.repeat(10 * 1024 * 1024)],
    ['a 10 MB paste that starts right', `github_pat_${'A'.repeat(10 * 1024 * 1024)}`],
    ['a Cyrillic lookalike', `github_pаt_${'A'.repeat(60)}`],
    ['a full-width lookalike', `ｇithub_pat_${'A'.repeat(60)}`],
    ['a zero-width space inside', `github_pat_${'A'.repeat(30)}\u200b${'A'.repeat(30)}`],
    ['a right-to-left override', `github_pat_‮${'A'.repeat(60)}`],
    ['the prefix alone', 'github_pat_'],
    ['a hyphen, which the alphabet excludes', `github_pat_${'A'.repeat(30)}-${'A'.repeat(30)}`],
    ['a NUL inside', `github_pat_${'A'.repeat(30)}\u0000${'A'.repeat(30)}`],
  ];
  for (const [label, value] of cases) {
    const result = validateKey('copilot', value);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, 'invalid', label);
    // The refusal must not carry the value back in any field.
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'key'), false, label);
  }
});

test('a non-string is refused without its own length being consulted', () => {
  let lengthReads = 0;
  const hostile = { get length() { lengthReads += 1; return 12; }, toString() { throw new Error('never'); } };
  for (const value of [undefined, null, 42, true, {}, [], Buffer.from('x'), hostile, () => VALID]) {
    const result = validateKey('copilot', value);
    assert.deepEqual(result, { ok: false, code: 'invalid' });
  }
  assert.equal(lengthReads, 0, 'a hostile object’s length getter must never run');
});

test('an unknown provider can never validate a key, whatever the key is', () => {
  for (const id of ['gemini', 'kimi', 'claude', 'codex', 'antigravity', '', '__proto__', 'constructor']) {
    assert.deepEqual(validateKey(id, VALID), { ok: false, code: 'unknown-provider' });
  }
});

test('the username is GitHub’s own shape and nothing wider (K23)', () => {
  assert.deepEqual(validateUsername('copilot', 'octocat'), { ok: true, username: 'octocat' });
  assert.deepEqual(validateUsername('copilot', '  octo-cat \n'), { ok: true, username: 'octo-cat' });
  assert.deepEqual(validateUsername('copilot', 'a'.repeat(39)), { ok: true, username: 'a'.repeat(39) });
  // Trimmed at the ends, like the key: a pasted login carries a newline. What
  // matters is that the TRIMMED value still has to pass GitHub's own shape, so
  // nothing that could add a path segment survives.
  assert.deepEqual(validateUsername('copilot', 'octocat\r\n'), { ok: true, username: 'octocat' });
  for (const value of [
    '',
    'a'.repeat(40),
    'octo cat',
    'octo/cat',
    'octo.cat',
    'octo_cat',
    '../../etc',
    'octocat?x=1',
    'octocat#frag',
    'octocat%2f',
    'octöcat',
    'octo\r\ncat',
    42,
    null,
    {},
  ]) {
    assert.deepEqual(validateUsername('copilot', value), { ok: false, code: 'invalid-username' }, String(value));
  }
});

test('only Copilot is key-capable, and the table is frozen (K24, ADR-003 A6)', () => {
  assert.deepEqual(KEY_CAPABLE_IDS, ['copilot']);
  assert.equal(soleKeyCapableId(), 'copilot');
  for (const id of ['gemini', 'kimi', 'claude', 'codex', 'antigravity']) {
    assert.equal(isKeyCapable(id), false, id);
    assert.equal(keySpec(id), null, id);
  }
  const spec = keySpec('copilot');
  assert.equal(Object.isFrozen(spec), true);
  assert.equal(spec.host, 'api.github.com');
  assert.equal(spec.scheme, 'https:');
  assert.equal(spec.method, 'GET');
  assert.equal(spec.headers['X-GitHub-Api-Version'], '2022-11-28');
  // A fixed User-Agent: nothing machine-derived goes on the wire.
  assert.equal(spec.headers['User-Agent'], 'UsageNotch');
});

test('the path is built from the username only, and the built path matches the recogniser', () => {
  const spec = keySpec('copilot');
  const built = spec.buildPath('octo-cat');
  assert.equal(built, '/users/octo-cat/settings/billing/ai_credit/usage');
  assert.equal(spec.pathPattern.test(built), true);
  // `GET /user` is deliberately not used to discover the login (A6.3).
  assert.equal(spec.pathPattern.test('/user'), false);
  assert.equal(spec.pathPattern.test('/users/octo-cat/settings/billing/usage'), false);
});
