'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fakeElectron = require('./helpers/fake-electron');
const log = require('../src/core/log');

// The panel's gesture trace is on by default in a real run, on purpose. Here
// it would narrate several hundred timer transitions to stdout and bury the
// assertions. `test/trace.test.js` is where it is exercised.
log.setTrace(false);

// Must be installed before panel-window.js is required.
const electron = fakeElectron.install();
const {
  PanelWindow, LEAVE_GRACE_MS, POINTER_POLL_MS, TRANSIT_MARGIN_PX, NEVER_ENGAGED_MAX_MS,
} = require('../src/main/panel-window');
const { IPC } = require('../src/shared/contract');

/** The boolean visibility signals main pushed to the renderer, in order. */
function visibilitySignals(panel) {
  return panel.win.webContents.sent
    .filter((m) => m.channel === IPC.PANEL_VISIBILITY)
    .map((m) => m.payload);
}

/**
 * The panel's open / pin / leave state machine.
 *
 * `pinned` used to mean "hide when focus is lost" — the click-outside-dismisses
 * -a-popover pattern — so the one control the user pressed to KEEP the panel on
 * screen was the control that armed its dismissal. It now means what the word
 * means (contract.ts, `AnchorPayload.mode`):
 *
 *   pinned      survives blur, app switching, clicking anywhere else. Only an
 *               explicit close or unpin ends it.
 *   not pinned  survives while the pointer is over the panel, and closes
 *               shortly after it leaves.
 */

function build() {
  const anchors = [];
  const visibility = [];
  const pins = [];
  const panel = new PanelWindow({
    onVisibilityChange: (v) => visibility.push(v),
    onPinChange: (p) => pins.push(p),
    entry: __filename,
  });
  panel.create();
  const send = (a) => anchors.push(a);
  // A tray icon at the bottom-right, well clear of where the panel lands.
  const trayRect = { x: 1800, y: 1032, width: 24, height: 48 };
  return { panel, anchors, visibility, pins, send, trayRect };
}

/** Puts the OS cursor in the middle of wherever the panel currently is. */
function cursorInsidePanel(panel) {
  const b = panel.win.getBounds();
  electron.moveCursor(b.x + Math.floor(b.width / 2), b.y + Math.floor(b.height / 2));
}

function cursorFarAway() {
  electron.moveCursor(5, 5);
}

/**
 * Just outside the panel but inside the tray->panel corridor: where a hand
 * travelling between the two actually is, and where one resting on the taskbar
 * beside the icon sits.
 */
function cursorInCorridor(panel) {
  const b = panel.win.getBounds();
  electron.moveCursor(b.x - Math.floor(TRANSIT_MARGIN_PX / 2), b.y + 10);
}

/* ------------------------------------------------------------------ pin */

test.describe('pinned means the panel stays', () => {
  test('losing focus does not hide a pinned panel', (t) => {
    // The original defect, stated directly: `pinned` used to ARM this path.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    assert.equal(panel.isVisible(), true);
    // Well past the arming delay, and with the pointer nowhere near it: every
    // precondition the unpinned path needs is satisfied except `pinned`.
    t.mock.timers.tick(NEVER_ENGAGED_MAX_MS * 2);
    cursorFarAway();
    panel.win.focused = false;
    panel.win.emit('blur');
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    assert.equal(panel.isVisible(), true, 'a pinned panel must survive blur');
  });

  test('a pinned panel survives blur even before it was ever pointed at', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    t.mock.timers.tick(NEVER_ENGAGED_MAX_MS * 2);
    panel.win.emit('blur');
    panel.win.emit('blur');
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    assert.equal(panel.isVisible(), true);
  });

  test('the pointer leaving does not hide a pinned panel either', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS * 20);
    assert.equal(panel.isVisible(), true, 'only an explicit close or unpin ends a pin');
  });

  test('scheduleHide is a no-op while pinned', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    panel.scheduleHide();
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    assert.equal(panel.isVisible(), true);
  });

  test('pin reports mode "pin" and activates, so the keyboard path works', () => {
    const { panel, anchors, send, trayRect } = build();
    panel.pin(trayRect, send);
    assert.equal(anchors.at(-1).mode, 'pin');
    assert.equal(panel.win.isFocused(), true);
  });

  test('an explicit close ends it, and clears the pinned state', () => {
    const { panel, send, trayRect, pins } = build();
    panel.pin(trayRect, send);
    panel.hide();
    assert.equal(panel.isVisible(), false);
    assert.equal(panel.pinned, false);
    assert.deepEqual(pins, [true, false]);
  });

  test('unpin leaves the panel open and says so, so the toggle is not one-way', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, anchors, send, trayRect } = build();
    panel.pin(trayRect, send);
    panel.unpin(trayRect, send);
    assert.equal(panel.pinned, false);
    assert.equal(panel.isVisible(), true, 'unpinning is not closing');
    assert.equal(anchors.at(-1).mode, 'hover', 'the renderer keys its pin control on this');

    // ...and it is back under pointer control. The ticks are separate because
    // the grace timer is created INSIDE a poll tick, and a single combined
    // advance would not run a timer that did not exist when it started.
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });

  test('unpin on a panel that is not pinned changes nothing', () => {
    const { panel, anchors, send, trayRect } = build();
    panel.open(trayRect, send);
    const before = anchors.length;
    panel.unpin(trayRect, send);
    assert.equal(anchors.length, before, 'no anchor churn for a no-op');
    assert.equal(panel.isVisible(), true);
  });
});

/* -------------------------------------------------------------- unpinned */

test.describe('an unpinned panel follows the pointer, not the focus', () => {
  test('a click-open does NOT take focus, and reports mode "hover"', () => {
    // Inverted deliberately. This used to assert the panel activated, and that
    // activation is what put the shell's focus handoff inside the panel's
    // lifecycle — a race no fixed timeout can win. Nothing is focused now
    // until the user clicks inside, which Windows does on its own.
    const { panel, anchors, send, trayRect } = build();
    panel.open(trayRect, send);
    assert.equal(panel.isVisible(), true);
    assert.equal(panel.win.isFocused(), false, 'no programmatic focus on open');
    assert.equal(anchors.at(-1).mode, 'hover');
    assert.equal(panel.pinned, false);
  });

  test('the window is composited ONCE, off-screen, at create — never shown again on open', () => {
    // The root of the reported flicker: showing a transparent, always-on-top
    // window is a composite transition the foreground app repaints across. The
    // fix is to pay that transition exactly once, at create, and off-screen so
    // nobody sees it. From then on the window is never re-shown; it is MOVED.
    const { panel } = build();
    // build() has already called create(): the single show has happened, and it
    // put the window off every display so the prime is invisible.
    assert.deepEqual(panel.win.activations, ['showInactive'], 'exactly one show, at create');
    assert.ok(panel.win.getBounds().x <= -10000, 'and it was primed off-screen');
    assert.equal(panel.isVisible(), false, 'a primed-but-unopened panel is logically hidden');
  });

  test('a click-open MOVES the composited window and re-asserts z-order, without a second show', () => {
    // The mechanism, asserted directly. open() must NOT add a `showInactive`
    // (that would be the flashing transition back); it moves the already-shown
    // surface into place and raises it with moveTop. If a mutant reintroduced a
    // per-open show, this array would carry a second 'showInactive'.
    const { panel, send, trayRect } = build();
    const before = panel.win.activations.length;
    panel.open(trayRect, send);
    assert.deepEqual(
      panel.win.activations.slice(before),
      ['moveTop'],
      'open only raises z-order; it does not re-show',
    );
    assert.equal(panel.win.isFocused(), false, 'the reveal must not steal focus');
    assert.equal(panel.isVisible(), true);
  });

  test('a second open (panel buried behind another window) re-raises it again', () => {
    // The OTHER second click — not the toggle-closed path, but a re-open of a
    // still-visible panel that has been covered. Each open must re-assert
    // z-order, or a panel buried since the first open never resurfaces — and it
    // must do so WITHOUT a fresh show, or the flicker comes back on every click.
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.open(trayRect, send);
    assert.deepEqual(
      panel.win.activations,
      ['showInactive', 'moveTop', 'moveTop'],
      'one prime at create, then a z-order re-assert per open and never another show',
    );
    assert.equal(panel.isVisible(), true);
  });

  test('hiding does NOT hide or destroy the OS window; it moves it off-screen', () => {
    // The invariant the whole fix rests on: the OS window stays composited for
    // life, so there is never a show->composite transition to flash. `hide()`
    // clears LOGICAL visibility and parks the surface off every display.
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    const onScreen = panel.win.getBounds();
    assert.ok(onScreen.x > -10000, 'precondition: an open panel is on screen');

    panel.hide();
    assert.equal(panel.isVisible(), false, 'logically hidden');
    assert.equal(panel.win.isVisible(), true, 'but the OS window is never hidden');
    assert.equal(panel.win.isDestroyed(), false, 'nor destroyed');
    assert.ok(panel.win.getBounds().x <= -10000, 'it was moved off-screen instead');
  });

  test('a re-open after a hide brings it back with a move, still no re-show', () => {
    // Toggle closed, then open again: the surface that was parked off-screen is
    // moved back and raised. No new show anywhere in the sequence.
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.hide();
    panel.open(trayRect, send);
    assert.equal(panel.isVisible(), true);
    assert.ok(panel.win.getBounds().x > -10000, 'back on screen');
    assert.equal(
      panel.win.activations.filter((a) => a === 'showInactive').length,
      1,
      'still exactly one show for the whole open/hide/open cycle',
    );
  });

  test('the transit gap does not close it while the pointer is still travelling', (t) => {
    // The user clicked the tray and is moving towards the panel: for this
    // moment the pointer is over neither. Closing here would be the whole bug.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInCorridor(panel);
    t.mock.timers.tick(POINTER_POLL_MS * 40 + LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), true);
    assert.equal(panel._hideTimer, null, 'no leave timer may exist before the first entry');
  });

  test('once the pointer has been inside, leaving closes it after the grace', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect, visibility } = build();
    panel.open(trayRect, send);

    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.equal(panel.isVisible(), true);

    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.equal(panel.isVisible(), true, 'the grace period has not elapsed yet');
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
    assert.deepEqual(visibility, [true, false]);
  });

  test('a pointer sitting still INSIDE the panel never closes it', (t) => {
    // The renderer's keep-alive fires on pointerenter/pointermove/pointerdown,
    // so a resting cursor emits nothing at all. Treating that silence as
    // departure would close the panel under the user's hand — which is why
    // main asks the OS where the pointer is instead of waiting to be told.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS * 200);
    assert.equal(panel.isVisible(), true);
  });

  test('coming back inside cancels a pending hide', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);

    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.notEqual(panel._hideTimer, null, 'a leave timer should be pending');

    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.equal(panel._hideTimer, null, 'returning must cancel it');
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    assert.equal(panel.isVisible(), true);
  });

  test('the grace period is not re-armed on every tick, or it would never fire', (t) => {
    // A `scheduleHide()` per poll would reset the 550 ms countdown four times a
    // second and the panel would stay open for ever.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);

    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    const armed = panel._hideTimer;
    assert.notEqual(armed, null);
    // Another poll while still outside, inside the grace window. If it called
    // scheduleHide() again this would be a different object and the 550 ms
    // countdown would have restarted from zero — for ever, four times a second.
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.equal(panel._hideTimer, armed, 'the pending timer was replaced');
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });

  test('a renderer claim the cursor contradicts is refused, or the panel flashes', (t) => {
    // PANEL_OPENED is sent on MOUNT as well as on pointer events, and at mount
    // no pointer event has happened at all. Measured on the user's machine the
    // mount-time claim arrived 342 ms after `panel.show` and 147 ms BEFORE
    // `tray.mouse-leave`, so the cursor was demonstrably still on the tray
    // icon. Latching on it made the next poll read "the pointer has left" and
    // the panel dismissed itself ~550 ms after opening.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    // Where the cursor ACTUALLY was in that measurement: still on the tray
    // icon, 147 ms before `tray.mouse-leave`. Which is inside the corridor,
    // so nothing may dismiss the panel on account of it.
    electron.moveCursor(trayRect.x + 2, trayRect.y + 2);
    panel.notePointerInside();
    assert.equal(panel._pointerSeen, false, 'an unverified claim does not latch');
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), true, 'the panel is still there to be read');
  });

  test('a refused claim still leaves a dismissal path, it does not strand the panel', (t) => {
    // The other half of the same rule. Refusing the claim must not mean the
    // panel can never close: with the cursor genuinely elsewhere, the corridor
    // rule closes it. This is the property `blur` used to provide, and losing
    // it silently is how a 440x680 always-on-top window ends up parked over
    // someone's work.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    panel.notePointerInside();
    assert.equal(panel._pointerSeen, false, 'still refused');
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false, 'and the corridor rule takes it away');
  });

  test("the renderer's keep-alive extends a life the poll granted", (t) => {
    // A drag captures the pointer in the DOCUMENT, so the OS cursor can leave
    // the window rect while the gesture is still running and the renderer is
    // the only witness to it. Once the poll has latched, that claim is
    // honoured — as a keep-alive, never as the thing that sets the latch.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.equal(panel._pointerSeen, true, 'the poll set the latch');

    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.notEqual(panel._hideTimer, null, 'leaving armed the grace period');

    panel.notePointerInside();
    assert.equal(panel._hideTimer, null, 'the keep-alive cancelled it');
    assert.equal(panel.isVisible(), true);

    // And the poll is still the source of truth: with no further keep-alive
    // the very next tick re-arms, so a drag that ends off-panel still closes.
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.notEqual(panel._hideTimer, null, 'the poll re-armed on its own');
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });

  test('pinning mid-life stops the pointer watch outright', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    panel.pin(trayRect, send);
    assert.equal(panel._pointerTimer, null);
    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS * 20 + LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), true);
  });

  test('re-opening restarts the transit grace', (t) => {
    // The pointer is back at the tray icon, so it has to be allowed to travel
    // again — otherwise the second open closes itself immediately.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    cursorFarAway();

    panel.open(trayRect, send);
    t.mock.timers.tick(POINTER_POLL_MS * 20 + LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), true);
  });

  /* ------------------------------ focus is not a dismissal signal any more */

  test('a blur never dismisses, at any of the measured handoff latencies', (t) => {
    // THE REPORTED BUG, and the reason the mechanism changed rather than the
    // number. Real tray clicks on the user's machine handed focus around at
    // 414, 425, 500, 505, 510, 656, 729, 769, 860, 1088, 1211 and 1355 ms
    // after `show`. A 400 ms ignore-window let every one of them through; a
    // 1200 ms window let the 1211 ms sample through and the flash came back.
    // Every fixed threshold is a cliff with a tail behind it.
    //
    // So blur is not consulted at all. The panel never took focus, so losing
    // it says nothing about what the user wants.
    for (const latency of [414, 425, 500, 505, 510, 656, 729, 769, 860, 1088, 1211, 1355]) {
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
      const { panel, send, trayRect } = build();
      panel.open(trayRect, send);
      cursorInCorridor(panel);
      t.mock.timers.tick(latency);
      panel.win.focused = false;
      panel.win.emit('blur');
      assert.equal(panel._hideTimer, null, `blur at ${latency} ms must arm nothing`);
      t.mock.timers.tick(LEAVE_GRACE_MS * 4);
      assert.equal(panel.isVisible(), true, `panel must survive a blur at ${latency} ms`);
      t.mock.timers.reset();
    }
  });

  test('a blur long after the panel settled still dismisses nothing', (t) => {
    // Not a timing question at all any more: there is no window inside which
    // blur is special, because there is no window in which it is believed.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInCorridor(panel);
    t.mock.timers.tick(NEVER_ENGAGED_MAX_MS / 2);
    panel.win.focused = false;
    panel.win.emit('blur');
    panel.win.emit('blur');
    assert.equal(panel._hideTimer, null);
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    assert.equal(panel.isVisible(), true);
  });

  test('once the pointer has arrived, blur is irrelevant too', (t) => {
    // Another window can take focus without the user leaving the panel — a
    // notification, a background app stealing foreground. The pointer is the
    // authority, before engagement and after it.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    panel.win.focused = false;
    panel.win.emit('blur');
    assert.equal(panel._hideTimer, null);
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    assert.equal(panel.isVisible(), true, 'the pointer is still on it');
  });

  test('a blur on an already hidden panel does nothing', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.hide();
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    panel.win.emit('blur');
    assert.equal(panel._hideTimer, null, 'nothing to schedule for a window that is already gone');
  });

  /* ------------------------- the corridor: what replaced the blur path ---- */

  test('a pointer that leaves the corridor closes a panel it never reached', (t) => {
    // The hole blur used to cover: the user clicks the tray, then goes to work
    // somewhere else without ever touching the panel. The pointer says so
    // directly, and unlike focus it is not handed around by the shell.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect, visibility } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.notEqual(panel._hideTimer, null, 'leaving the corridor arms the grace');
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
    assert.deepEqual(visibility, [true, false]);
  });

  test('an overshoot that comes back into the corridor is forgiven', (t) => {
    // A hand that swings past the panel and returns must not lose it. This is
    // why the corridor rule uses the same 550 ms grace as leaving does.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.notEqual(panel._hideTimer, null);

    cursorInCorridor(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.equal(panel._hideTimer, null, 'coming back cancels it');
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    assert.equal(panel.isVisible(), true);
  });

  test('reaching the panel retires the corridor rule for that open', (t) => {
    // After the first entry the ordinary leave rule owns the panel, so a
    // cursor outside the corridor is judged by the grace period rather than by
    // the corridor — the two must not both arm a hide.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.equal(panel._pointerSeen, true);

    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.notEqual(panel._hideTimer, null);
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false, 'closed by the leave rule, not the corridor');
  });

  test('the corridor spans the tray icon, so a cursor resting on it is not "away"', (t) => {
    // The user clicks the icon and reads the panel with the cursor still on
    // the taskbar. That is the commonest un-engaged posture there is, and it
    // must not read as departure.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    electron.moveCursor(trayRect.x + 2, trayRect.y + 2);
    t.mock.timers.tick(POINTER_POLL_MS * 20);
    assert.equal(panel._hideTimer, null);
    assert.equal(panel.isVisible(), true);
  });

  test('with no measurable anchor there is no corridor, and nothing guesses one', (t) => {
    // `positionFor(null)` falls back to a synthetic rect at the cursor. If the
    // anchor cannot be measured at all the corridor is null, and the backstop
    // is the only rule left — better than inventing a journey we cannot see.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send } = build();
    panel.open(null, send);
    panel._transitBox = null;
    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS * 4);
    assert.equal(panel._hideTimer, null, 'no corridor means no corridor dismissal');
    assert.equal(panel.isVisible(), true);
  });

  /* ------------------------------------------ the never-engaged backstop -- */

  test('a never-engaged panel with a motionless cursor is hidden at the backstop', (t) => {
    // The alt-tab case: cursor parked on the taskbar, keyboard back in the
    // editor. The corridor rule cannot fire because nothing moves.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInCorridor(panel);
    t.mock.timers.tick(NEVER_ENGAGED_MAX_MS - POINTER_POLL_MS * 2);
    assert.equal(panel.isVisible(), true, 'still up a moment before the backstop');
    t.mock.timers.tick(POINTER_POLL_MS * 3);
    assert.equal(panel.isVisible(), false, 'and gone once it passes');
  });

  test('the backstop outlasts a real read, which is why it is a minute', (t) => {
    // Traces from this machine show un-engaged panels held for 7.0, 13.4 and
    // 28.5 seconds before the user dismissed them. A backstop inside that
    // range would close a panel mid-sentence.
    assert.ok(NEVER_ENGAGED_MAX_MS > 28_500 * 2, `${NEVER_ENGAGED_MAX_MS} must clear the measured reads`);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInCorridor(panel);
    t.mock.timers.tick(28_500);
    assert.equal(panel.isVisible(), true, 'the longest measured read must survive');
  });

  test('the backstop never touches a panel the pointer reached', (t) => {
    // Engagement hands the panel to the leave rule permanently. A user reading
    // it with the cursor resting on it for an hour is not "never engaged".
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(NEVER_ENGAGED_MAX_MS * 3);
    assert.equal(panel.isVisible(), true, 'the cursor is on it; it is engaged');
  });

  test('the backstop never touches a pinned panel', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    cursorFarAway();
    t.mock.timers.tick(NEVER_ENGAGED_MAX_MS * 3);
    assert.equal(panel.isVisible(), true, 'only an explicit close or unpin ends a pin');
  });

  /* -------------------------------------------------------- the invariants */

  test('the constants stand in the order the rules need', () => {
    // The corridor rule and the leave rule share one grace period, and both
    // are decided by a poll: a grace shorter than a poll interval could expire
    // before the pointer was asked again. The backstop must outlast a read.
    assert.ok(LEAVE_GRACE_MS > POINTER_POLL_MS, 'the grace must outlast a poll');
    assert.ok(NEVER_ENGAGED_MAX_MS > LEAVE_GRACE_MS, 'the backstop is not a grace period');
    assert.ok(TRANSIT_MARGIN_PX > 0, 'a zero-width corridor would close on any wobble');
  });

  test('unpinning RE-STAMPS the show instant, so the backstop cannot fire at once', (t) => {
    // Inverted deliberately, and the old comment here said the opposite. It
    // used to argue that re-stamping would blind the panel to a real blur;
    // blur dismisses nothing now, and `_shownAt` feeds only the backstop. A
    // panel pinned for an hour, then unpinned, must not be hidden on the very
    // next poll for having been "shown" long ago.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    const shownAt = panel._shownAt;
    t.mock.timers.tick(NEVER_ENGAGED_MAX_MS * 2);
    cursorInCorridor(panel);
    panel.unpin(trayRect, send);
    assert.notEqual(panel._shownAt, shownAt, 'the minute starts when it becomes dismissible');
    t.mock.timers.tick(POINTER_POLL_MS * 2);
    assert.equal(panel.isVisible(), true, 'and it is not hidden on the next poll');
  });

  test('unpinning with the pointer elsewhere closes the panel on its own', (t) => {
    // The latch is SEEDED, not cleared: there is no transit on an unpin, so
    // the pointer rule is live immediately and does not need a blur to help.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    cursorFarAway();
    panel.unpin(trayRect, send);
    assert.equal(panel._pointerSeen, true, 'the pointer position is known, so there is nothing to wait for');
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });

  test('sendCurrentAnchor re-announces the mode without changing visibility', (t) => {
    // What a renderer revived after `render-process-gone` needs: it remounts
    // at pinned:false, derived from anchor.mode.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, anchors, send, trayRect } = build();
    panel.pin(trayRect, send);
    const before = anchors.length;
    panel.sendCurrentAnchor(trayRect, send);
    assert.equal(anchors.length, before + 1);
    assert.equal(anchors.at(-1).mode, 'pin', 'a revived renderer must be told it is pinned');
    assert.equal(panel.isVisible(), true);
    assert.equal(panel.pinned, true);
  });

  test('sendCurrentAnchor says nothing when the panel is not on screen', () => {
    const { panel, anchors, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.hide();
    const before = anchors.length;
    panel.sendCurrentAnchor(trayRect, send);
    assert.equal(anchors.length, before);
  });

  test('hiding stops the watch, so a hidden panel costs no timer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.hide();
    assert.equal(panel._pointerTimer, null);
    assert.equal(panel._hideTimer, null);
  });

  test('destroy leaves no timer behind', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.destroy();
    assert.equal(panel._pointerTimer, null);
    assert.equal(panel._hideTimer, null);
  });
});

/* ---------------------------------------------- the open animation replays */

test.describe('the entrance animation replays on every open', () => {
  test('a reveal tells the renderer to open, so the content entrance plays', () => {
    // The bug this fixes: with the window living always-composited, `data-open`
    // no longer flips between opens on its own, so the panel just popped in.
    // Every reveal must now push `true` so the renderer replays the grow-in.
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    assert.deepEqual(visibilitySignals(panel), [true]);
  });

  test('a conceal tells the renderer to close, and does so off-screen', () => {
    // `false` sets the closed visual state, and it must be pushed AFTER the
    // window is off every display so the state change is invisible — which is
    // what leaves `data-open` false for the next reveal to animate against.
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.hide();
    assert.deepEqual(visibilitySignals(panel), [true, false]);
    assert.ok(panel.win.getBounds().x <= -10000, 'the window was off-screen when it was told to close');
  });

  test('create() sends no visibility signal, so app-start plays exactly one entrance', () => {
    // Main reveals nothing at startup — the renderer's own first-paint rAF is
    // the sole app-start entrance. If create() pushed a reveal, the first open
    // would double-fire it. build() has already called create().
    const { panel } = build();
    assert.deepEqual(visibilitySignals(panel), [], 'no reveal/conceal at startup');
  });

  test('close then re-open replays the entrance: true, false, true', () => {
    // The corridor-dismiss-then-reopen path the user reported as a dead "pop".
    // The false between the trues is what makes the second true a real
    // false->true transition rather than a no-op on an already-open panel.
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.hide();
    panel.open(trayRect, send);
    assert.deepEqual(visibilitySignals(panel), [true, false, true]);
  });

  test('the reveal animates content only — the OS window is never re-shown or resized', () => {
    // The hard constraint: the fix must stay CONTENT-only. Across a full
    // open/hide/open cycle the OS window is shown exactly once (at create) and
    // its size never changes, so nothing here animates the window itself.
    const { panel, send, trayRect } = build();
    const size = { w: panel.win.getBounds().width, h: panel.win.getBounds().height };
    panel.open(trayRect, send);
    panel.hide();
    panel.open(trayRect, send);
    assert.equal(
      panel.win.activations.filter((a) => a === 'show' || a === 'showInactive').length,
      1,
      'exactly one show for the whole cycle; the reveal is a move, not a show',
    );
    const b = panel.win.getBounds();
    assert.equal(b.width, size.w, 'the window is never resized (no geometric animation)');
    assert.equal(b.height, size.h, 'the window is never resized (no geometric animation)');
  });

  test('pinning a concealed panel signals a reveal, so its content is not shown blank', () => {
    // pin() activates via show()/focus() and does not go through _reveal(), so
    // without its own signal a pin from the concealed state would show a window
    // whose content is still in the closed (opacity 0) state. A fresh panel is
    // logically concealed until opened.
    const { panel, send, trayRect } = build();
    assert.equal(panel.isVisible(), false, 'precondition: a primed panel is concealed');
    panel.pin(trayRect, send);
    assert.deepEqual(visibilitySignals(panel), [true]);
  });

  test('pinning an already-open panel does not re-signal a redundant reveal', () => {
    // The common path is a pin toggle on a panel that is already up. Re-pushing
    // `true` would be harmless (the renderer no-ops it), but the signal should
    // track a real reveal, not every activation.
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.pin(trayRect, send);
    assert.deepEqual(visibilitySignals(panel), [true], 'the pin added no second reveal');
  });
});
