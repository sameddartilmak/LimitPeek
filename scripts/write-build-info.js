'use strict';

// Writes src/main/build-info.json for the package step: the commit being built
// and whether the tree had uncommitted changes. See src/core/build-info.js.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let info;
try {
  info = { sha: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0 };
} catch {
  // No git (a source archive): write nothing rather than a guess.
  info = null;
}

const out = path.join(__dirname, '..', 'src', 'main', 'build-info.json');
if (info) {
  fs.writeFileSync(out, JSON.stringify(info) + '\n');
  console.log(`build-info: ${info.sha.slice(0, 7)}${info.dirty ? ' (dirty tree)' : ''}`);
} else {
  fs.rmSync(out, { force: true });
  console.log('build-info: git unavailable, version shown alone');
}
