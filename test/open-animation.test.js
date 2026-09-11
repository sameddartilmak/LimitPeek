'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The renderer half of "replay the entrance on every open".
 *
 * The main half — a reveal pushing PANEL_VISIBILITY true, a conceal pushing
 * false, and no window-level animation — is exercised behaviourally in
 * panel-lifecycle.test.js against the fake Electron. The renderer half lives in
 * app.ts and needs a DOM to run, which only the Electron render fixture has, so
 * it is pinned here at the source. renderer-build.test.js separately proves
 * this source is what actually ships (dist matches), so a green source guard is
 * a green shipped behaviour.
 */
const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'app.ts'), 'utf8');

test('app.ts subscribes to the reveal/conceal signal and drives setOpen with it', () => {
  assert.match(APP, /bridge\.onPanelVisibility\(/, 'the renderer must subscribe to PANEL_VISIBILITY');
  assert.match(
    APP,
    /onPanelVisibility\(\(open\)\s*=>\s*panel\.setOpen\(open\)\)/,
    'the signal must drive panel.setOpen(open) so open animates and close resets',
  );
});

test('app-start still plays exactly one entrance', () => {
  // The first-paint rAF is the ONE app-start entrance. The reveal handler must
  // NOT add a second literal open at startup (it calls setOpen(open), a
  // variable), or the first real open would double-fire the animation.
  const literalOpens = APP.match(/panel\.setOpen\(true\)/g) || [];
  assert.equal(literalOpens.length, 1, `expected exactly one app-start entrance, saw ${literalOpens.length}`);
});
