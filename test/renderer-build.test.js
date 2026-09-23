'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { inlineJsonImports } = require('../src/renderer/inline-json.cjs');

/**
 * `src/renderer/index.html` loads `./dist/renderer/src/main.js`, so the
 * renderer that actually runs is the BUILD OUTPUT, not the TypeScript source.
 * A source edit with no rebuild therefore ships silently-old behaviour — which
 * is the exact failure mode of a hand-fixed formatter bug that was never
 * rebuilt. These two tests close that gap and pin the Turkish casing rule that
 * no unit test can reach, because it lives in CSS.
 */
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(SRC, 'renderer', 'dist');

function tsFilesUnder(dir) {
  const out = [];
  const stat = fs.statSync(dir, { throwIfNoEntry: false });
  if (!stat) return out;
  if (stat.isFile()) {
    if (dir.endsWith('.ts') && !dir.endsWith('.d.ts')) out.push(dir);
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    out.push(...tsFilesUnder(path.join(dir, entry.name)));
  }
  return out;
}

test('every renderer module the app loads is built from the current source', () => {
  const sources = [
    ...tsFilesUnder(path.join(SRC, 'renderer', 'src')),
    path.join(SRC, 'shared', 'contract.ts'),
  ];
  assert.ok(sources.length >= 10, 'found suspiciously few renderer modules; the walk is wrong');

  const stale = [];
  for (const file of sources) {
    const out = path.join(DIST, path.relative(SRC, file).replace(/\.ts$/, '.js'));
    if (!fs.existsSync(out)) {
      stale.push(`${path.relative(ROOT, out)} (never built)`);
      continue;
    }
    // Same two steps as build.mjs: strip, then inline catalog JSON. A catalog
    // edit with no rebuild is therefore stale too, not only a .ts edit.
    const expected = inlineJsonImports(
      stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), {
        mode: 'strip',
        sourceUrl: path.resolve(file),
      }),
      path.resolve(file),
    ).code;
    if (expected !== fs.readFileSync(out, 'utf8')) {
      stale.push(path.relative(ROOT, out));
    }
  }
  assert.deepEqual(stale, [], 'run `node src/renderer/build.mjs`; the panel is running old code');
});

test('nothing in the shipped renderer upper-cases text, which would break Turkish i', () => {
  const roots = [
    path.join(SRC, 'renderer', 'src'),
    path.join(SRC, 'renderer', 'styles'),
    path.join(SRC, 'renderer', 'index.html'),
  ];
  const files = [];
  const walk = (p) => {
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isFile()) { files.push(p); return; }
    for (const e of fs.readdirSync(p, { withFileTypes: true })) walk(path.join(p, e.name));
  };
  roots.forEach(walk);
  assert.ok(files.length > 0);

  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
      if (line.includes('/*') && line.includes('uppercase')) return;
      // `toLocaleUpperCase('tr-TR')` is the one correct form and is allowed.
      const bad = /text-transform:\s*uppercase|\.toUpperCase\(/.test(line)
        || /toLocaleUpperCase\((?!'tr-TR'|"tr-TR")/.test(line);
      if (bad) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'CSS and JS upper-casing map i -> I, which is wrong in Turkish');
});

/**
 * Packaging sync: `PACKAGE_GLOBS` in src/renderer/build.mjs is the renderer
 * lane's statement of what a packaged app must contain; `build.files` in
 * package.json is what electron-builder actually copies into the asar. The two
 * lists are owned by different lanes and nothing connected them, so
 * `key-entry.html` was added to one and not the other — a packaged build with
 * no key-entry page, on a flow that REFUSES rather than improvising a fallback
 * (src/main/keys/entry-window.js:60).
 *
 * The check is made against real files on disk, not glob string equality: every
 * file a PACKAGE_GLOB matches must survive build.files' include/exclude rules.
 * That is why adding a page to PACKAGE_GLOBS alone fails here, and the reverse
 * direction (a page in build.files that the renderer build never declared) is
 * asserted separately below.
 */

/** Minimatch subset used by electron-builder's file patterns: `**`, `*`, `?`. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` crosses zero or more directories; a trailing `**` takes the rest.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
      continue;
    }
    if (ch === '?') { re += '[^/]'; continue; }
    re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The literal array out of build.mjs, without importing it: the module builds on import. */
function packageGlobs() {
  // Split on CRLF too: with core.autocrlf a Windows checkout writes CRLF, the
  // `.*$` below then stops at the `\r`, and a comment's apostrophe ("window's")
  // is read as the start of a glob.
  const source = fs.readFileSync(path.join(SRC, 'renderer', 'build.mjs'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
  const match = /export const PACKAGE_GLOBS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(match, 'build.mjs no longer exports PACKAGE_GLOBS as a literal array; fix this test');
  const globs = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(globs.length >= 5, `parsed only ${globs.length} PACKAGE_GLOBS; the parse is wrong`);
  return globs;
}

/** Files under src/renderer/ that a PACKAGE_GLOB matches, as root-relative posix paths. */
function packagedRendererFiles() {
  const renderer = path.join(SRC, 'renderer');
  const all = [];
  const walk = (p) => {
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isFile()) { all.push(p); return; }
    for (const e of fs.readdirSync(p, { withFileTypes: true })) walk(path.join(p, e.name));
  };
  walk(renderer);
  const matchers = packageGlobs().map(globToRegExp);
  return all
    .map((file) => path.relative(renderer, file).split(path.sep).join('/'))
    .filter((rel) => matchers.some((m) => m.test(rel)))
    .map((rel) => `src/renderer/${rel}`);
}

/** electron-builder: included by at least one pattern and excluded by no `!` pattern. */
function includedByBuildFiles(files, rel) {
  const includes = files.filter((f) => !f.startsWith('!')).map(globToRegExp);
  const excludes = files.filter((f) => f.startsWith('!')).map((f) => globToRegExp(f.slice(1)));
  return includes.some((m) => m.test(rel)) && !excludes.some((m) => m.test(rel));
}

test('package.json build.files ships every file the renderer build declares as packaged', () => {
  const { build } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const declared = packagedRendererFiles();
  assert.ok(
    declared.includes('src/renderer/key-entry.html'),
    'key-entry.html is no longer matched by PACKAGE_GLOBS; if the page moved, move it here too',
  );

  const missing = declared.filter((rel) => !includedByBuildFiles(build.files, rel));
  assert.deepEqual(
    missing,
    [],
    'these files are in src/renderer/build.mjs PACKAGE_GLOBS but excluded from package.json build.files; '
      + 'the packaged app would not contain them',
  );
});

test('no renderer page is packaged that the renderer build never declared', () => {
  const { build } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const globs = packageGlobs();
  const pages = fs.readdirSync(path.join(SRC, 'renderer'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => e.name);
  assert.ok(pages.includes('index.html'), 'the panel document vanished; the walk is wrong');

  const undeclared = pages.filter(
    (name) => includedByBuildFiles(build.files, `src/renderer/${name}`)
      && !globs.some((g) => globToRegExp(g).test(name)),
  );
  assert.deepEqual(
    undeclared,
    [],
    'these pages are in package.json build.files but not in PACKAGE_GLOBS; the renderer lane does not '
      + 'know they ship, so their scripts and styles may be left out',
  );
});
