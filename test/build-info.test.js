'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { versionLabel } = require('../src/core/build-info');

// The tray's first menu row names the build, so an installed binary can be
// matched to its commit. Every build before 0.2.0 said "0.1.0" and nothing
// else, which is why a rollback target could not be named.

test('names the version and the short commit', () => {
  assert.equal(versionLabel('0.2.1', { sha: '1a2b3c4d5e6f7a8b', dirty: false }), 'LimitPeek 0.2.1 · 1a2b3c4');
});

test('a build from a tree with uncommitted changes says so', () => {
  assert.equal(versionLabel('0.2.1', { sha: '1a2b3c4d5e6f7a8b', dirty: true }), 'LimitPeek 0.2.1 · 1a2b3c4+');
});

test('no build info (a dev run) shows the version alone — nothing is invented', () => {
  assert.equal(versionLabel('0.2.1', null), 'LimitPeek 0.2.1');
  assert.equal(versionLabel('0.2.1', undefined), 'LimitPeek 0.2.1');
});

test('a malformed commit is dropped rather than printed', () => {
  for (const sha of ['', 'HEAD', 'zzzzzzz', '<script>', 42, null, '1a2b3c']) {
    assert.equal(versionLabel('0.2.1', { sha, dirty: false }), 'LimitPeek 0.2.1', String(sha));
  }
});

test('only a literal true marks the tree dirty', () => {
  assert.equal(versionLabel('0.2.1', { sha: '1a2b3c4', dirty: 'yes' }), 'LimitPeek 0.2.1 · 1a2b3c4');
});
