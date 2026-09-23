'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * No source file may contain a literal control, zero-width or line-separator
 * character. They must be written as escapes (`\u200b`) instead.
 *
 * WHY THIS EXISTS: three separate corruptions in one session
 * ---------------------------------------------------------
 * A file-writing step turned intended escapes into raw bytes three times while
 * this feature was being built:
 *
 *   1. `test/token-merge-scan.test.js` - a literal BACKSPACE (U+0008) where a
 *      `\b` word boundary was meant. The regex then matched nothing, and the
 *      guard it belonged to reported PASS forever.
 *   2. `test/render/cost.js` - two more of the same, fixed by hand.
 *   3. `src/core/plan-labels.js` - a literal U+2028 inside a character class,
 *      which is a line terminator in JavaScript, so the regex literal did not
 *      close and the module failed to parse.
 *
 * Only the third failed loudly. The first two produced code that ran, did
 * nothing, and said it was fine — which is the same shape as the polling socket
 * sampler that reported PASS while the packaged app was sending DNS. A check
 * that cannot fail is worse than no check, and the cause here is invisible by
 * construction: a zero-width space looks exactly like nothing at all in every
 * editor, diff and review.
 *
 * THE RULE IS UNIVERSAL AND HAS NO EXCEPTION LIST
 * -----------------------------------------------
 * `\u200b` and a raw U+200B are the SAME value to the JavaScript parser, so a
 * file that genuinely needs one of these characters — `src/core/keys/validate.js`
 * strips them from pasted keys; `test/keys-validation.test.js` and
 * `test/quota-fields.test.js` embed them as fixtures to prove they are rejected
 * — loses nothing by writing the escape. That is what "allowed by construction"
 * means here: the legitimate uses were converted (behaviour verified identical
 * across all 65,536 BMP codepoints for `validate.js`), so this test needs no
 * allowlist, and an allowlist is exactly where the next corruption would hide.
 *
 * Tab, newline and carriage return are the three literals a source file
 * legitimately contains as layout, so they are permitted.
 */

const ROOT = path.join(__dirname, '..');

/** Skipped whole: generated output, dependencies, and VCS internals. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', 'out']);

/**
 * Banned codepoints, by class:
 *   C0 controls except \t \n \r   - a backspace or NUL in source is a defect
 *   DEL and the C1 controls       - never intentional in JavaScript source
 *   U+200B-U+200F                 - zero-width space/joiners and the two
 *                                   bidi marks; invisible, and the RLO family
 *                                   can reorder how a line READS versus runs
 *   U+2028 / U+2029               - line and paragraph separators: JavaScript
 *                                   line terminators, so a literal one can
 *                                   silently end a regex or a string
 *   U+FEFF                        - a BOM anywhere but byte 0 is stray data
 */
function isBanned(cp) {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  if (cp < 0x20) return true;
  if (cp === 0x7f) return true;
  if (cp >= 0x80 && cp <= 0x9f) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp === 0x2028 || cp === 0x2029) return true;
  if (cp === 0xfeff) return true;
  return false;
}

/** Every hand-written source file under `src/`, `test/`, `scripts/` and `bridge/`. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs|ts)$/.test(entry.name)) continue;
      out.push(full);
    }
  };
  for (const dir of ['src', 'test', 'scripts', 'bridge']) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) walk(full);
  }
  return out;
}

/** `{ file, line, column, codepoint }` for every banned character in `text`. */
function offendersIn(rel, text) {
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (let j = 0; j < line.length; j += 1) {
      const cp = line.codePointAt(j);
      if (!isBanned(cp)) continue;
      found.push({
        file: rel,
        line: i + 1,
        column: j + 1,
        codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
      });
    }
  }
  return found;
}

test('no source file contains a literal control, zero-width or separator character', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    offenders.push(...offendersIn(rel, fs.readFileSync(file, 'utf8')));
  }
  // Named individually, with file:line:col and the codepoint, because the whole
  // point is that the character itself is invisible: a message saying only
  // "found 1" would send the reader hunting for something they cannot see.
  const message = offenders.length === 0 ? '' : [
    'literal invisible characters found; write them as escapes (e.g. \\u200b) instead:',
    ...offenders.map((o) => `  ${o.file}:${o.line}:${o.column}  ${o.codepoint}`),
  ].join('\n');
  assert.deepEqual(offenders, [], message);
});

test('the scan reaches every source tree, so it cannot pass by walking nothing', () => {
  const rels = sourceFiles().map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  for (const must of [
    'src/core/plan-labels.js',
    'src/core/keys/validate.js',
    'src/shared/contract.ts',
    'src/renderer/src/sanitize.ts',
    'test/token-merge-scan.test.js',
    'scripts/smoke-ipc.js',
    'bridge/claude-statusline.mjs',
  ]) {
    assert.ok(rels.includes(must), `the walk missed ${must}`);
  }
  assert.ok(rels.length >= 80, `suspiciously few files scanned (${rels.length}); the walk is wrong`);
  assert.equal(rels.some((r) => r.startsWith('src/renderer/dist/')), false,
    'generated output is skipped; an offender there is an offender in the .ts beside it');
});

test('the detector catches each banned class and clears the legitimate layout ones', () => {
  // A scan that silently matches nothing reports PASS forever - the exact
  // failure this file exists to prevent, so the detector is exercised directly.
  const cases = [
    ['backspace, the one that killed a regex guard', '\u0008', 'U+0008'],
    ['NUL', '\u0000', 'U+0000'],
    ['escape', '\u001b', 'U+001B'],
    ['DEL', '\u007f', 'U+007F'],
    ['a C1 control', '\u0085', 'U+0085'],
    ['zero-width space', '\u200b', 'U+200B'],
    ['zero-width joiner', '\u200d', 'U+200D'],
    ['right-to-left mark', '\u200f', 'U+200F'],
    ['line separator, the one that broke a module', '\u2028', 'U+2028'],
    ['paragraph separator', '\u2029', 'U+2029'],
    ['BOM', '\ufeff', 'U+FEFF'],
  ];
  for (const [label, ch, expected] of cases) {
    const got = offendersIn('f.js', `const a = 'x${ch}y';`);
    assert.equal(got.length, 1, `${label} was not caught`);
    assert.equal(got[0].codepoint, expected, label);
    assert.equal(got[0].line, 1, label);
  }
  // Tab, newline and CR are layout and must NOT trip it, or no file would pass.
  assert.deepEqual(offendersIn('f.js', "const a = 1;\n\tconst b = 2;\r\n"), []);
  // ...and neither may ordinary text, including the non-ASCII this repo is
  // full of: Turkish copy, em dashes and arrows in comments.
  assert.deepEqual(offendersIn('f.js', "// Ayrintilar - hafta -> gun. 'en az' çok ışık"), []);
});

test('it reports the exact position, because the character is invisible by definition', () => {
  const got = offendersIn('src/x.js', ["'ok'", "const re = /[a\u200b]/;", "'ok'"].join('\n'));
  assert.deepEqual(got, [{ file: 'src/x.js', line: 2, column: 15, codepoint: 'U+200B' }]);
});
