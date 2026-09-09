'use strict';
/**
 * Entry point for the render suites: `npm run verify:render`.
 *
 * WHY THESE ARE NOT IN `npm test`
 * -------------------------------
 * They boot a real Electron GUI process, load `src/renderer/index.html`
 * against a fixture preload, and assert on COMPUTED DOM — resolved colours,
 * stroke weights, focus after a DOM move, aria names, and real OS-level mouse
 * input for the drag. `node --test` has no window to do any of that in, and
 * wiring a headless browser would be the runtime dependency this project does
 * not have.
 *
 * WHAT THEY COVER THAT NOTHING ELSE DOES
 * --------------------------------------
 *   panel.js  the six identity marks, the connected/monochrome rule as
 *             RESOLVED colour and stroke weight, drag-and-drop, the Alt+Arrow
 *             keyboard path, focus surviving a row move, the optimistic
 *             reorder and its visible revert.
 *   cost.js   every honesty property of the cost block: the figure never
 *             appears without its framing sentence, caveats turn it into
 *             "en az", an all-unpriced week prints no figure at all, and a
 *             partial payload degrades instead of vanishing.
 *
 * Each suite runs in its own Electron process because each needs a different
 * fixture — the panel suite drives mouse input at measured coordinates and
 * needs short rows, the cost suite needs rows carrying every cost state.
 *
 *   node test/render/run.js            both suites
 *   node test/render/run.js cost       one suite
 *
 * Exits 0 only if every check in every suite passed.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');

const SUITES = [
  { name: 'panel', file: 'panel.js', fixture: 'panel' },
  { name: 'cost', file: 'cost.js', fixture: 'cost' },
];

function electronBin() {
  // The module exports the absolute path to the packaged binary. Resolved
  // rather than assumed, so a hoisted or pnpm layout still works.
  try {
    return require(path.join(ROOT, 'node_modules', 'electron'));
  } catch {
    return null;
  }
}

function main() {
  const only = process.argv[2];
  const suites = only ? SUITES.filter((s) => s.name === only) : SUITES;
  if (suites.length === 0) {
    console.error(`render: unknown suite "${only}". Known: ${SUITES.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }

  const bin = electronBin();
  if (typeof bin !== 'string') {
    // Electron is a devDependency; a checkout without it should say so rather
    // than fail with a confusing spawn error.
    console.error('render: electron is not installed; run `npm install` first');
    process.exit(2);
  }

  let failed = 0;
  for (const suite of suites) {
    console.log(`\n--- render: ${suite.name} ---`);
    // Electron's stdout does not reliably reach a pipe on Windows — the same
    // reason scripts/smoke-ipc.js writes a file — so each suite logs to a file
    // and the runner prints it. Without this a green run says nothing at all,
    // and a green run that says nothing is indistinguishable from one that
    // never ran a check.
    const out = path.join(os.tmpdir(), `usage-notch-render-${suite.name}.txt`);
    fs.rmSync(out, { force: true });

    const result = spawnSync(bin, [path.join(HERE, suite.file)], {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        RENDER_FIXTURE: suite.fixture,
        RENDER_OUT: out,
        ELECTRON_ENABLE_LOGGING: '',
      },
    });

    let printed = 0;
    try {
      const log = fs.readFileSync(out, 'utf8');
      printed = log.split('\n').filter((l) => l.startsWith('PASS') || l.startsWith('FAIL')).length;
      process.stdout.write(log);
      fs.rmSync(out, { force: true });
    } catch {
      console.error(`render: ${suite.name} wrote no log`);
    }
    // Zero checks is a failure. A suite whose window never opened would
    // otherwise exit 0 having asserted nothing — which is the shape of defect
    // these suites exist to catch one layer down.
    if (printed === 0) {
      failed++;
      console.error(`render: ${suite.name} ran no checks`);
      continue;
    }

    // A suite that could not start is a failure, not a skip: silently passing
    // when the window never opened is exactly what this suite exists to catch
    // one layer down.
    const code = result.status === null ? 1 : result.status;
    if (code !== 0) {
      failed++;
      console.error(`render: ${suite.name} FAILED (exit ${code})`);
    }
  }

  console.log(
    `\nrender: ${suites.length - failed}/${suites.length} suite(s) passed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
