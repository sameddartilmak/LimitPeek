'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

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
    const expected = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), {
      mode: 'strip',
      sourceUrl: path.resolve(file),
    });
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
