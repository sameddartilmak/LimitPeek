'use strict';
/**
 * Does this change need a zero-socket audit (scripts/zero-socket-audit.ps1)?
 *
 * The audit measures the "never touches the network" claim at the kernel, but
 * it takes 16 minutes and an elevated shell, so it is run when a change could
 * move that claim, not on every commit. This script makes that call from the
 * files changed since the last release tag (every `v*` tag is an audited
 * build), including uncommitted changes.
 *
 *   node scripts/audit-needed.js            compare with the newest v* tag
 *   node scripts/audit-needed.js v0.2.1     compare with a given ref
 *
 * Exit code 1 means an audit is needed, 0 means it is not, 2 means an error.
 *
 * NEEDS AN AUDIT: main-process and core code (sessions, windows, the security
 * filter, the one keyed request, the agy installer all live there), the
 * installer script, and any change to what gets installed or bundled
 * (dependencies, the Electron version, electron-builder config).
 * DOES NOT: the renderer (it runs on a session that cannot reach the network,
 * which the smoke test checks every time), catalogs, tests, docs and the site.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/** Paths whose change can move the network claim, with the reason printed. */
const RULES = [
  [/^src\/main\//, 'main-process code'],
  [/^src\/core\//, 'core code, loaded by main'],
  [/^build\//, 'installer and packaging'],
  [/^package-lock\.json$/, 'installed dependency versions'],
];

/** package.json fields that change what ships. A version bump alone does not. */
const PACKAGE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'build', 'main'];

function packageFieldsChanged(base) {
  let before;
  try {
    before = JSON.parse(git('show', `${base}:package.json`));
  } catch {
    return ['package.json (not in the base)'];
  }
  const after = JSON.parse(require('node:fs').readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return PACKAGE_FIELDS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function main() {
  const base = process.argv[2] || git('describe', '--tags', '--abbrev=0', '--match', 'v*');
  // Against the working tree, so an uncommitted change counts too.
  const changed = git('diff', '--name-only', base).split('\n').filter(Boolean)
    .concat(git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean));

  const reasons = [];
  for (const file of [...new Set(changed)]) {
    const rule = RULES.find(([re]) => re.test(file));
    if (rule) reasons.push(`${file}  (${rule[1]})`);
  }
  if (changed.includes('package.json')) {
    for (const field of packageFieldsChanged(base)) reasons.push(`package.json ${field}  (what gets installed or bundled)`);
  }

  console.log(`base: ${base}, ${changed.length} file(s) changed`);
  if (reasons.length === 0) {
    console.log('audit NOT needed: nothing that can reach the network changed');
    return 0;
  }
  console.log('audit NEEDED, because of:');
  for (const reason of reasons) console.log(`  ${reason}`);
  console.log('run (elevated): scripts\\zero-socket-audit.ps1 -Case A -Minutes 16');
  return 1;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`audit-needed: ${(err && err.message) || err}`);
  process.exitCode = 2;
}
