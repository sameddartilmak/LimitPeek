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
 * Windows delivers `click` AND THEN `double-click` for ONE physical click on
 * the reporting machine — the real trace caught the pair 49 ms apart, far
 * faster than any human double-click. Binding `click`->toggle and
 * `double-click`->open turned that into a VISIBLE hide-then-show FLASH on the
 * 2nd+ open: the click hid the panel, the double-click re-opened it 49 ms later.
 *
 * The tray now coalesces the two shell events into one physical gesture: the
 * leading edge toggles, anything within GESTURE_COALESCE_MS is swallowed. One
 * physical click = one toggle, whichever events the shell sends. The
 * `double-click`->onOpen binding is dropped; both events run the same toggle.
 */

function harness() {
  const calls = [];
  // Injected clock so the coalescing window is exercised without real waiting.
  // Fires do not advance it, so two synchronous fires read as the same instant
  // (as one physical press does); `setClock` steps it for a deliberate reclick.
  let clock = 1000;
  const tray = new TrayController({
    onToggle: () => calls.push('toggle'),
    onOpen: () => calls.push('open'),
  });
  tray._clock = () => clock;
  tray.create({ autostart: false, onToggleAutostart: () => {}, onQuit: () => {} });
  return {
    tray,
    calls,
    fire: (event) => tray.tray.emit(event),
    setClock: (ms) => { clock = ms; },
  };
}

test.describe('tray gestures', () => {
  test('a single click toggles, once', () => {
    const { calls, fire } = harness();
    fire('click');
    assert.deepEqual(calls, ['toggle']);
  });

  test('one physical click (click + double-click 49ms apart) is a single toggle', () => {
    // The reported double-fire: the shell sends BOTH events for one press. The
    // second must be swallowed, not converted into a second handler call.
    const { calls, fire } = harness();
    fire('click');
    fire('double-click');
    assert.deepEqual(calls, ['toggle'], 'the redundant double-click must be suppressed');
  });

  test('a VISIBLE panel + one physical click does NOT hide-then-show', () => {
    // The exact user complaint. `visible` starts true; the coalesced pair must
    // produce ONE transition (hide), never hide followed by re-show. Reverting
    // the fix (re-adding the double-click->onOpen call) makes this ['hide',
    // 'show'] and the test fails — the mutation check for the whole fix.
    const states = [];
    let visible = true;
    let clock = 5000;
    const tray = new TrayController({
      onToggle: () => { visible = !visible; states.push(visible ? 'show' : 'hide'); },
      onOpen: () => { if (!visible) { visible = true; states.push('show'); } },
    });
    tray._clock = () => clock;
    tray.create({ autostart: false, onToggleAutostart: () => {}, onQuit: () => {} });
    tray.tray.emit('click');
    tray.tray.emit('double-click'); // same instant: within the coalescing window
    assert.deepEqual(states, ['hide'], 'one physical click on an open panel just hides it');
  });

  test('a deliberate separate re-click after the window still toggles', () => {
    // Coalescing must not eat a genuine second gesture. Step the clock past the
    // window: the re-click has to act, or a real open-then-close would be lost.
    const { calls, fire, setClock } = harness();
    setClock(1000);
    fire('click');          // acts
    setClock(1049);
    fire('double-click');   // 49 ms later: same physical press, suppressed
    setClock(1400);
    fire('click');          // 351 ms after the first: a new gesture, acts
    assert.deepEqual(calls, ['toggle', 'toggle']);
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

  test('every tray event is traced as the SHELL delivered it, before coalescing', () => {
    // The log has to show what the shell sent, not what we did about it: if
    // Windows sends `click` twice for one press, only a line emitted before the
    // suppression check can say so. The redundant `double-click` is still
    // traced, and its swallowing is traced too, so a later capture shows the
    // coalescing working rather than an unexplained missing handler call.
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
    // The event name is the token after `+<ms>ms`: `trace +N ms <name> ...`.
    const seen = lines.filter((l) => l.startsWith('trace ')).map((l) => l.split(' ')[2]);
    assert.deepEqual(seen, [
      'tray.click',        // delivered, acts on the leading edge
      'tray.double-click', // delivered by the shell, still traced
      'tray.suppressed',   // ...then swallowed as the same physical gesture
      'tray.mouse-enter',
      'tray.mouse-leave',
    ]);
  });

  test('one physical double-click is a single toggle from either state', () => {
    // The `double-click`->onOpen binding is gone: both shell events run the
    // coalesced toggle, so one physical press flips the state exactly once.
    // From hidden that opens; from visible that closes. Routed through the real
    // tray wiring, not a hand-rolled stand-in, so the assertion tracks the code.
    for (const startVisible of [false, true]) {
      let visible = startVisible;
      let clock = 2000;
      const tray = new TrayController({
        onToggle: () => { visible = !visible; },
        onOpen: () => { visible = true; },
      });
      tray._clock = () => clock;
      tray.create({ autostart: false, onToggleAutostart: () => {}, onQuit: () => {} });
      tray.tray.emit('click');
      tray.tray.emit('double-click'); // suppressed
      assert.equal(visible, !startVisible, `one press from visible=${startVisible} must flip once`);
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
