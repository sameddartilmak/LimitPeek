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
  PanelWindow, LEAVE_GRACE_MS, POINTER_POLL_MS, BLUR_ARM_MS, BLUR_CONFIRM_MS,
} = require('../src/main/panel-window');

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
    t.mock.timers.tick(BLUR_ARM_MS * 10);
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
    t.mock.timers.tick(BLUR_ARM_MS * 10);
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
  test('a click-open activates the window and reports mode "hover"', () => {
    const { panel, anchors, send, trayRect } = build();
    panel.open(trayRect, send);
    assert.equal(panel.isVisible(), true);
    assert.equal(panel.win.isFocused(), true, 'a click-opened panel may activate normally');
    assert.equal(anchors.at(-1).mode, 'hover');
    assert.equal(panel.pinned, false);
  });

  test('the transit gap does not close it: the timer waits for a first entry', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    // The user clicked the tray and is moving towards the panel: for this
    // moment the pointer is over neither. Arming the leave timer here would
    // close the panel mid-journey, which is the whole bug.
    cursorFarAway();
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
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    panel.notePointerInside();
    assert.equal(panel._pointerSeen, false, 'an unverified claim does not latch');
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), true, 'the panel is still there to be read');
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

  test('the arming delay outlasts a poll, or blur could beat the latch', () => {
    // Load-bearing invariant, not a style choice: if blur could fire before the
    // first pointer poll, it would see `_pointerSeen` still false and dismiss a
    // panel the pointer was already resting on.
    assert.ok(BLUR_ARM_MS > POINTER_POLL_MS, `${BLUR_ARM_MS} must exceed ${POINTER_POLL_MS}`);
  });

  test('a blur during the arming window is ignored', (t) => {
    // Measured on Electron 44.2.0 here, activation emits no transient blur —
    // focus landed 3-19 ms after show across open(), open() with a live Tray,
    // and pin(). This guard covers the one case the harness cannot synthesise,
    // a physical click on the shell's own tray window.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    t.mock.timers.tick(BLUR_ARM_MS - POINTER_POLL_MS);
    panel.win.emit('blur');
    assert.equal(panel._hideTimer, null, 'a blur inside the arming window must not arm a hide');
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    assert.equal(panel.isVisible(), true, 'the panel must not flash open and shut');
  });

  test('working elsewhere without ever reaching the panel closes it', (t) => {
    // The hole this path exists for: the user clicks the tray, then clicks
    // straight into another app. The pointer never crossed the panel, so the
    // poll deliberately does nothing, and without blur the window would sit
    // over their work until they dismissed it by hand.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    t.mock.timers.tick(BLUR_ARM_MS + POINTER_POLL_MS);
    panel.win.focused = false;
    panel.win.emit('blur');
    // Held for one confirmation before it is believed. That pause is what
    // stops the shell's own focus handoff from dismissing the panel; a blur
    // that is still true afterwards survives it and closes the window.
    assert.equal(panel._hideTimer, null, 'not armed until the blur is confirmed');
    t.mock.timers.tick(BLUR_CONFIRM_MS);
    assert.notEqual(panel._hideTimer, null, 'a confirmed blur arms the grace period');
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });

  test('a blur at the shell handoff cannot dismiss a panel nobody has reached yet', (t) => {
    // THE REPORTED BUG. Real tray clicks on the user's machine produced `blur`
    // at 414, 425, 500, 505, 510, 656, 729, 769, 860, 1088 and 1355 ms after
    // `show` — every sample past the old 400 ms floor, so each took the
    // immediate-hide path and the panel shut with the pointer still on the
    // tray icon. The user clicked again to bring it back, which is the
    // "opens, shuts, opens again" they reported.
    //
    // 505 is one of the measured samples. The panel must still be on screen
    // at the moment a hand travelling from the icon would arrive.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    t.mock.timers.tick(505);
    panel.win.focused = false;
    panel.win.emit('blur');
    assert.equal(panel._hideTimer, null, 'the handoff is held, not acted on');
    t.mock.timers.tick(BLUR_ARM_MS - 505 - 1);
    assert.equal(panel.isVisible(), true, 'still reachable');
  });

  test('and reaching it inside that window retires blur for good', (t) => {
    // The other half: the pause is only worth having if arriving during it
    // latches the pointer, after which `_onBlur` ignores every later blur.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    t.mock.timers.tick(505);
    panel.win.focused = false;
    panel.win.emit('blur');

    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.equal(panel._pointerSeen, true, 'the hand arrived');

    t.mock.timers.tick(BLUR_ARM_MS * 2);
    panel.win.emit('blur');
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    assert.equal(panel.isVisible(), true, 'the pointer is the authority now');
  });

  test('once the pointer has arrived, blur is irrelevant again', (t) => {
    // Another window can take focus without the user leaving the panel — a
    // notification, a background app stealing foreground. The pointer is the
    // authority from the first entry onward.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(BLUR_ARM_MS + POINTER_POLL_MS);
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
    t.mock.timers.tick(BLUR_ARM_MS * 2);
    panel.win.emit('blur');
    assert.equal(panel._hideTimer, null, 'nothing to schedule for a window that is already gone');
  });

  test('unpinning does NOT re-arm the activation delay', (t) => {
    // BLUR_ARM_MS absorbs the focus transient that ACTIVATION can emit, and
    // unpinning activates nothing — the window is already up and settled.
    // Re-stamping `_shownAt` here would blind the panel to a real blur for
    // 400 ms at exactly the moment the transit latch is decided.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    const shownAt = panel._shownAt;
    t.mock.timers.tick(BLUR_ARM_MS * 10);
    panel.unpin(trayRect, send);
    assert.equal(panel._shownAt, shownAt, 'unpin must not restamp the show instant');
  });

  test('unpinning with the pointer elsewhere closes the panel on its own', (t) => {
    // The latch is SEEDED, not cleared: there is no transit on an unpin, so
    // the pointer rule is live immediately and does not need a blur to help.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    t.mock.timers.tick(BLUR_ARM_MS * 10);
    cursorFarAway();
    panel.unpin(trayRect, send);
    assert.equal(panel._pointerSeen, true, 'the pointer position is known, so there is nothing to wait for');
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });

  test('a blur inside the arming window is DEFERRED, not discarded', (t) => {
    // The half that stranded the panel: an already-unfocused window emits no
    // second blur, so a swallowed one is the only one that will ever arrive,
    // and `_pollPointer()` will not act while the transit latch is unset.
    // Discarding it left a 440x680 always-on-top window with no dismissal path
    // while its footer promised "imleç ayrılınca kapanır".
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);

    panel.win.focused = false;
    panel.win.emit('blur');              // the ONLY blur there will ever be
    assert.equal(panel._hideTimer, null, 'not acted on yet');
    assert.notEqual(panel._blurTimer, null, 'but remembered');

    t.mock.timers.tick(BLUR_ARM_MS);     // arming window elapses
    assert.notEqual(panel._hideTimer, null, 'the deferred blur was re-asked');
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });

  test('a deferred blur is dropped when focus came back', (t) => {
    // This is what the delay is actually for. Re-asking preserves it: an
    // activation transient is a blur followed by a focus, and the re-check
    // sees the window focused again and lets it go.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();

    panel.win.focused = false;
    panel.win.emit('blur');
    panel.win.focused = true;            // activation settled
    t.mock.timers.tick(BLUR_ARM_MS + LEAVE_GRACE_MS * 2);
    assert.equal(panel.isVisible(), true, 'the panel must not flash open and shut');
    assert.equal(panel._hideTimer, null);
  });

  test('a burst of blurs inside the window arms exactly one re-check', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    panel.win.focused = false;
    panel.win.emit('blur');
    const first = panel._blurTimer;
    panel.win.emit('blur');
    panel.win.emit('blur');
    assert.equal(panel._blurTimer, first, 'the same question must not queue three timers');
  });

  test('a deferred blur cannot fire into a panel that was hidden meanwhile', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect, visibility } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    panel.win.focused = false;
    panel.win.emit('blur');
    panel.hide();
    assert.equal(panel._blurTimer, null, 'hide() must cancel the pending re-check');
    t.mock.timers.tick(BLUR_ARM_MS + LEAVE_GRACE_MS * 2);
    assert.deepEqual(visibility, [true, false], 'and it must not hide a second time');
  });

  test('a deferred blur cannot dismiss a panel that was pinned meanwhile', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    panel.win.focused = false;
    panel.win.emit('blur');
    panel.pin(trayRect, send);
    t.mock.timers.tick(BLUR_ARM_MS + LEAVE_GRACE_MS * 2);
    assert.equal(panel.isVisible(), true, 'pinning must win over an in-flight blur');
  });

  test('a deferred blur cannot fire into a destroyed window', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    panel.win.focused = false;
    panel.win.emit('blur');
    panel.destroy();
    assert.equal(panel._blurTimer, null);
    t.mock.timers.tick(BLUR_ARM_MS + LEAVE_GRACE_MS * 2);   // must not throw
  });

  test('re-opening cancels a re-check armed against the previous show', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    panel.win.focused = false;
    panel.win.emit('blur');
    panel.open(trayRect, send);
    assert.equal(panel._blurTimer, null);
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
