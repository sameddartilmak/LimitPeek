'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Structural guard for the one arithmetic this project exists to refuse.
 *
 * ADR-001 Decision 1 and the headers of `src/core/history.js` and
 * `src/core/aggregate.js` ban a single "tokens used" figure that folds the four
 * token classes — and, worse, the four tools — into one number: on the
 * reference corpus `cacheRead` is 97.94% of raw volume and bills at 0.1x, so
 * the merged figure is dominated by the cheapest class and says nothing.
 *
 * `PeriodUsage.tokensByProvider` is keyed BY TOOL precisely so a subtotal can
 * be rendered without such a total ever existing. But a map is trivially
 * summable: one `Object.values(tokensByProvider).reduce(...)` in any lane
 * produces exactly the banned figure, and nothing else in the suite would fail.
 * A ban that lives only in JSDoc is a ban that ships broken once, so it is
 * asserted here over the source instead — main, core AND renderer, because the
 * renderer is where the temptation is (it has the map and it needs a headline).
 *
 * Comment lines are stripped before every scan, exactly as the network scan in
 * `contract-mirror.test.js` and the key scans in `keys-source-scan.test.js` do:
 * prose that NAMES the forbidden operation in order to forbid it is
 * documentation, and turning it into a failure would push the reasoning out of
 * the files that need to carry it.
 */

const ROOT = path.join(__dirname, '..');

/** Every hand-written source file, as `{ rel, code }`. Build output excluded:
 *  `src/renderer/dist` is generated, so an offender there is an offender in the
 *  `.ts` beside it and would be reported twice. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs|ts)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      out.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  return out.map((file) => ({
    rel: path.relative(ROOT, file).split(path.sep).join('/'),
    code: fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n'),
  }));
}

/** The ways a cross-tool total actually gets written, in rough order of likelihood. */
const MERGE_PATTERNS = [
  // Object.values(...tokensByProvider...).reduce / .forEach / for..of
  {
    name: 'Object.values(tokensByProvider) folded into one figure',
    re: /Object\s*\.\s*values\s*\([^)]*tokensByProvider[^)]*\)\s*(?:\.\s*\w+\s*\([^)]*\)\s*)*\.\s*(?:reduce|flatMap)\b/,
  },
  // for (const t of Object.values(x.tokensByProvider)) { total += ... }
  {
    name: 'iterating tokensByProvider values to accumulate',
    re: /for\s*\([^)]*\bof\s+Object\s*\.\s*values\s*\([^)]*tokensByProvider/,
  },
  // Object.entries(...).reduce over the map
  {
    name: 'Object.entries(tokensByProvider) folded into one figure',
    re: /Object\s*\.\s*entries\s*\([^)]*tokensByProvider[^)]*\)\s*(?:\.\s*\w+\s*\([^)]*\)\s*)*\.\s*(?:reduce|flatMap)\b/,
  },
  // Spreading the map into an accumulator, or summing two tools by name.
  {
    name: 'adding two tools’ token figures by name',
    re: /tokensByProvider\s*(?:\.|\[)[^\n;]*\+\s*[^\n;]*tokensByProvider\s*(?:\.|\[)/,
  },
  // A variable or property that claims to BE the merged total.
  {
    name: 'a field or variable naming a merged token total',
    re: /\b(?:totalTokens|tokensTotal|tokensUsed|allTokens|mergedTokens|totalTokensUsed|sumTokens)\b/,
  },
  // The renderer's own accessors over the map. This is the form the merge gets
  // written in once a helper layer exists, and it names neither
  // `tokensByProvider` nor any banned identifier - so without these two the
  // scan reported PASS on the first realistic attempt, which is precisely the
  // failure mode this file exists to prevent (and the same shape as a polling
  // socket sampler passing while the app sent DNS).
  {
    name: 'folding a per-tool accessor (tokensFor) into one figure',
    re: /tokensFor\s*\([^)]*\)[\s\S]{0,80}?\.\s*(?:reduce|forEach)/,
  },
  {
    name: 'accumulating over providersWithTokens',
    re: /providersWithTokens[\s\S]{0,200}?(?:reduce|\+=)/,
  },
];

test('no source composes a cross-tool token total from tokensByProvider', () => {
  const offenders = [];
  for (const { rel, code } of sources()) {
    for (const { name, re } of MERGE_PATTERNS) {
      if (re.test(code)) offenders.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'PeriodUsage.tokensByProvider is keyed by tool so a merged "tokens used" figure never exists '
    + '(ADR-001). Show the entries side by side, labelled by tool; never add them.',
  );
});

/** The panel holds every row at once, so folding `weeklyTokens` over
 *  `providers` is the other shape of the same mistake. Bounded lookaheads
 *  rather than `[^)]*`, because the callback itself contains parentheses. */
const CROSS_ROW_RE = /providers[\s\S]{0,120}?\.\s*(?:reduce|flatMap)\s*\([\s\S]{0,200}?weeklyTokens/;

test('the same ban covers ProviderSnapshot.weeklyTokens across rows', () => {
  const offenders = sources().filter(({ code }) => CROSS_ROW_RE.test(code)).map(({ rel }) => rel);
  assert.deepEqual(offenders, [], 'token counts are never summed across tools, on any surface');
});

test('the guard actually fires — it is not a regex that can never match', () => {
  // A scan that silently matches nothing is worse than no scan, because it
  // reports PASS forever. Each pattern is exercised against a sample of the
  // code it exists to catch.
  const samples = [
    'const total = Object.values(period.tokensByProvider).reduce((n, t) => n + t.billable, 0);',
    'for (const t of Object.values(period.tokensByProvider)) { n += t.billable; }',
    'const total = Object.entries(p.tokensByProvider).reduce((n, [, t]) => n + t.billable, 0);',
    'const n = period.tokensByProvider.claude.billable + period.tokensByProvider.codex.billable;',
    'const totalTokens = 5;',
    // The bypass code-reviewer found: the merge written with the renderer's own
    // accessors, naming neither the map nor a banned identifier.
    'const weekTotal = providersWithTokens(period, order).map((id) => tokensFor(period, id)!.billable).reduce((a, b) => a + b, 0);',
    'let allToolsTokens = 0; for (const id of providersWithTokens(period, order)) allToolsTokens += tokensFor(period, id)!.billable;',
  ];
  assert.equal(samples.length, MERGE_PATTERNS.length, 'every pattern needs a sample');
  // Both directions, because either one alone is satisfiable by a dead pattern:
  // every sample must be caught by SOMETHING, and every pattern must catch
  // SOMETHING. The second is what stops a pattern rotting into a no-op after an
  // edit while the count assertion still passes.
  samples.forEach((sample, i) => {
    assert.ok(
      MERGE_PATTERNS.some(({ re }) => re.test(sample)),
      `no pattern catches sample ${i}: ${sample}`,
    );
  });
  for (const { name, re } of MERGE_PATTERNS) {
    assert.ok(samples.some((sample) => re.test(sample)), `pattern "${name}" matches no sample; it is dead`);
  }
  const crossRow = 'const n = snapshot.providers.reduce((acc, p) => acc + (p.weeklyTokens?.billable ?? 0), 0);';
  assert.ok(CROSS_ROW_RE.test(crossRow), 'the cross-row pattern must catch the obvious form');
});

test('the scan reaches the files that matter, so it cannot pass by walking nothing', () => {
  const rels = sources().map((f) => f.rel);
  for (const must of [
    'src/core/history.js',
    'src/core/snapshot.js',
    'src/shared/contract.ts',
    'src/renderer/src/sanitize.ts',
  ]) {
    assert.ok(rels.includes(must), `the walk missed ${must}`);
  }
  assert.ok(rels.length >= 40, `suspiciously few files scanned (${rels.length}); the walk is wrong`);
});
