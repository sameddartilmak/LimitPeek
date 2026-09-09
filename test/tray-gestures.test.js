'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fakeElectron = require('./helpers/fake-electron');
const log = require('../src/core/log');

// The gesture trace is on by default in a real run, on purpose. It would
// narrate every assertion below to stdout without adding anything to them.
log.setTrace(false);

const electron = fakeElectron.install();
const { TrayController } = require('../src/main/tray');
const { PanelWindow } = require('../src/main/panel-window');

/**
 * What the tray icon does when it is clicked.
 *
 * Windows delivers `click` AND THEN `double-click` for one double-click
 * gesture. Measured here on a real tray icon with synthetic OS input: a single
 * click fired the handler once; a double-click fired it twice, 77 ms apart
 * (`click` at +752 ms, `double-click` at +829 ms). Never three times.
 *
 * Both events were bound to the same handler, and that handler became a
 * TOGGLE when hover-open was removed — so the habitual double-click a tray app
 * invites opened the panel and immediately closed it again. The two events are
 * therefore no longer the same handler: the second can only ever open.
 */

function harness() {
  const calls = [];
  const tray = new TrayController({
    onToggle: () => calls.push('toggle'),
    onOpen: () => calls.push('open'),
  });
  tray.create({ autostart: false, onToggleAutostart: () => {}, onQuit: () => {} });
  return { tray, calls, fire: (event) => tray.tray.emit(event) };
}

test.describe('tray gestures', () => {
  test('a single click toggles, once', () => {
    const { calls, fire } = harness();
    fire('click');
    assert.deepEqual(calls, ['toggle']);
  });

  test('a double click never toggles twice', () => {
    // The measured sequence for one gesture.
    const { calls, fire } = harness();
    fire('click');
    fire('double-click');
    assert.deepEqual(calls, ['toggle', 'open'], 'the second event must not flip the state back');
  });

  test('hover is observed but never acted on', () => {
    // The user asked for the panel to stop opening on hover; the tooltip is
    // the hover surface now. The two listeners that DO exist call nothing but
    // the logger — the invariant is "hover opens no window", not "nothing is
    // bound", and asserting the listener count instead would have blocked the
    // one signal that can tell us whether the pointer was still over the icon
    // when the reported flash happened.
    const { tray, calls, fire } = harness();
    fire('mouse-enter');
    fire('mouse-leave');
    assert.deepEqual(calls, [], 'hover must reach neither onToggle nor onOpen');
    assert.equal(tray.tray.listenerCount('mouse-enter'), 1, 'observed');
    assert.equal(tray.tray.listenerCount('mouse-leave'), 1);
  });

  test('every tray event is traced before its handler runs', () => {
    // The measurement that said "one click, one handler call" was synthetic.
    // A real click is reported to produce a flash, so the log has to show what
    // the SHELL delivered, not what we did about it: if Windows sends `click`
    // twice for one physical press, only a line emitted before the handler can
    // say so.
    const lines = [];
    log.setSink((_level, msg) => lines.push(msg));
    log.setTrace(true);
    try {
      const { fire } = harness();
      for (const event of ['click', 'double-click', 'mouse-enter', 'mouse-leave']) fire(event);
    } finally {
      log.setTrace(false);
      log.setSink(null);
    }
    const seen = lines.filter((l) => l.startsWith('trace ')).map((l) => l.split(' ').pop());
    assert.deepEqual(seen, ['tray.click', 'tray.double-click', 'tray.mouse-enter', 'tray.mouse-leave']);
  });

  test('the panel ends OPEN after a double click, whatever the panel state was', () => {
    // Replays both events against a stand-in for the real wiring in
    // src/main/index.js, from both starting states.
    for (const startVisible of [false, true]) {
      let visible = startVisible;
      const onToggle = () => { visible = !visible; };
      const onOpen = () => { if (!visible) visible = true; };
      onToggle();
      onOpen();
      assert.equal(visible, true, `double click starting from visible=${startVisible} left it shut`);
    }
  });

  test('a single click still closes an open panel', () => {
    let visible = true;
    const onToggle = () => { visible = !visible; };
    onToggle();
    assert.equal(visible, false, 'one click must remain a toggle');
  });

  test('a destroyed tray reports no bounds rather than throwing', () => {
    const { tray } = harness();
    tray.destroy();
    assert.equal(tray.bounds(), null);
  });
});

/* ------------------------------------------- a panel that is fading is open */

/**
 * The reported bug, from the real trace:
 *
 *   +576128  panel.scheduleHide reason=pointer-left ms=550
 *   +576660  tray.click
 *   +576660  tray.toggle visible=true pinned=false hidePending=true act=hide
 *   +576663  panel.hide reason=tray-toggle
 *   +577365  tray.click            <- the user clicking again
 *   +577373  panel.show
 *
 * The pointer left the panel ON ITS WAY TO THE TRAY ICON, which armed the
 * 550 ms leave grace, and the click landed 530 ms inside it. `isVisible()` was
 * still true, so the toggle read a live panel and closed it. One intent, two
 * visible state changes.
 *
 * These run against a REAL `PanelWindow` — the predicate is only interesting
 * because `isVisible()` and `hidePending()` disagree, and a hand-rolled stub
 * would be free to make them agree.
 */
function panelHarness(t) {
  const panel = new PanelWindow({ width: 200, height: 200 });
  panel.create();
  t.after(() => panel.destroy());

  const opens = [];
  // Byte-for-byte the decision in src/main/index.js. The source assertion
  // below is what stops the two from drifting.
  const onToggle = () => {
    const visible = panel.isVisible();
    const pending = panel.hidePending();
    const act = !visible ? 'open' : (pending ? 'keep' : 'hide');
    if (act === 'hide') panel.hide('tray-toggle');
    else { opens.push(act); panel.open(null, () => {}); }
  };
  const onOpen = () => {
    const visible = panel.isVisible();
    const pending = panel.hidePending();
    const act = !visible ? 'open' : (pending ? 'keep' : 'noop');
    if (act !== 'noop') { opens.push(act); panel.open(null, () => {}); }
  };
  return { panel, opens, onToggle, onOpen };
}

test.describe('a pending dismissal is not "open" for the purpose of a click', () => {
  test('clicking inside the leave grace KEEPS the panel and cancels the hide', (t) => {
    const { panel, onToggle } = panelHarness(t);
    panel.open(null, () => {});
    panel.scheduleHide(550, 'pointer-left');
    assert.equal(panel.isVisible(), true);
    assert.equal(panel.hidePending(), true, 'precondition: the grace period is armed');

    onToggle();

    assert.equal(panel.isVisible(), true, 'the click must not have closed it');
    assert.equal(panel.hidePending(), false, 'and it must not still be counting down');
  });

  test('it is NOT a no-op: swallowing the click would let the timer close it anyway', (t) => {
    const { panel, onToggle, opens } = panelHarness(t);
    panel.open(null, () => {});
    panel.scheduleHide(550, 'pointer-left');
    onToggle();
    assert.deepEqual(opens, ['keep'], 'the open path has to actually run');
    // The observable consequence of running it: the anchor was re-measured and
    // the transit latch re-armed, exactly as a fresh tray-click open does.
    assert.equal(panel._pointerSeen, false, 'the pointer watch was re-armed');
  });

  test('the timer really would have fired, so the case is not hypothetical', (t) => {
    const { panel } = panelHarness(t);
    panel.open(null, () => {});
    return new Promise((resolve) => {
      panel.scheduleHide(10, 'pointer-left');
      setTimeout(() => {
        assert.equal(panel.isVisible(), false, 'an uncancelled grace period does close it');
        resolve();
      }, 60);
    });
  });

  test('with NO hide pending a click still closes, which is the whole point of a toggle', (t) => {
    const { panel, onToggle } = panelHarness(t);
    panel.open(null, () => {});
    assert.equal(panel.hidePending(), false);
    onToggle();
    assert.equal(panel.isVisible(), false, 'the ordinary dismissal must survive the fix');
  });

  test('a closed panel still opens', (t) => {
    const { panel, onToggle } = panelHarness(t);
    assert.equal(panel.isVisible(), false);
    onToggle();
    assert.equal(panel.isVisible(), true);
  });

  test('one click can no longer produce close-then-open from one intent', (t) => {
    // The user's whole experience, replayed: leave the panel towards the tray,
    // click once. Before the fix this was hide() then a second click to show();
    // now the single click leaves it where the user wanted it.
    const { panel, onToggle } = panelHarness(t);
    panel.open(null, () => {});
    panel.scheduleHide(550, 'pointer-left');
    const before = panel.isVisible();
    onToggle();
    assert.equal(before, true);
    assert.equal(panel.isVisible(), true, 'one intent, no visible state change');
  });

  test('double click on a fading panel keeps it too, rather than leaving it armed', (t) => {
    // `onOpen` promises idempotent OPEN. A panel that is visible and still
    // counting down to its own dismissal is not open in that sense.
    const { panel, onToggle, onOpen } = panelHarness(t);
    panel.open(null, () => {});
    panel.scheduleHide(550, 'pointer-left');
    onToggle();
    onOpen();
    assert.equal(panel.isVisible(), true);
    assert.equal(panel.hidePending(), false);
  });

  test('a settled visible panel is left alone by double click', (t) => {
    const { panel, onOpen, opens } = panelHarness(t);
    panel.open(null, () => {});
    onOpen();
    assert.deepEqual(opens, [], 'nothing to do, so nothing was done');
    assert.equal(panel.isVisible(), true);
  });

  test('the real wiring in index.js consults hidePending, not just isVisible', () => {
    // The harness above restates the decision. This is what stops the
    // restatement from being the only place it is true.
    const fs = require('node:fs');
    const path = require('node:path');
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
    for (const handler of ['onToggle:', 'onOpen:']) {
      const start = main.indexOf(handler);
      assert.notEqual(start, -1, `${handler} is gone`);
      const body = main.slice(start, main.indexOf('\n    },', start));
      assert.ok(body.includes('panel.hidePending()'), `${handler} ignores a pending dismissal`);
    }
    const toggle = main.slice(main.indexOf('onToggle:'), main.indexOf('onOpen:'));
    assert.ok(
      /act === 'hide'/.test(toggle),
      'the toggle must hide only on the decided action, never on isVisible() alone',
    );
  });
});

test.after(() => electron.restore());
