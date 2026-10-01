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
  PanelWindow, LEAVE_GRACE_MS, POINTER_POLL_MS, NEVER_ENGAGED_MAX_MS,
} = require('../src/main/panel-window');
const { IPC } = require('../src/shared/contract');

/**
 * The dismissal state machine, on the paths `panel-lifecycle.test.js` does not
 * walk.
 *
 * That file covers the three cases the design was argued from: unpinned and
 * never reached loses to blur, unpinned with the pointer resting survives, and
 * pinned survives everything. Three more transitions exist and each of them
 * changes who owns the panel's life:
 *
 *   1. a SECOND open on a panel that is already on screen (`second-instance`,
 *      and a tray click that races the auto-hide)
 *   2. an unpin performed while the pointer is NOT on the panel — the keyboard
 *      path, and the reason `unpin()` cannot simply assume the transit latch
 *   3. a renderer that is revived under a panel whose mode main still holds
 *
 * None of them is exotic: (1) is a documented entry point in `src/main/index.js`,
 * (2) is what Space on the pin button does, and (3) is the one failure
 * `panel-window.js` writes explicit recovery code for.
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
  const trayRect = { x: 1800, y: 1032, width: 24, height: 48 };
  return { panel, anchors, visibility, pins, send, trayRect };
}

function cursorInsidePanel(panel) {
  const b = panel.win.getBounds();
  electron.moveCursor(b.x + Math.floor(b.width / 2), b.y + Math.floor(b.height / 2));
}

function cursorFarAway() {
  electron.moveCursor(5, 5);
}

/** One pixel past the right edge: outside, but only just. */
function cursorJustOutside(panel) {
  const b = panel.win.getBounds();
  electron.moveCursor(b.x + b.width, b.y + Math.floor(b.height / 2));
}

/* ------------------------------------------- a second open on a live panel */

test.describe('re-opening a panel that is already on screen', () => {
  test('a second open does not un-pin a pinned panel', (t) => {
    // `app.on('second-instance')` calls openPanel() unconditionally, and the
    // tray click can reach it too. A pinned panel that quietly became
    // unpinned would then be dismissed by the next blur while its own control
    // still reads "pinned".
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, anchors, send, trayRect } = build();
    panel.pin(trayRect, send);
    panel.open(trayRect, send);
    assert.equal(panel.pinned, true, 'a re-open must not change the mode');
    assert.equal(anchors.at(-1).mode, 'pin', 'the renderer keys its control on this');
  });

  test('a second open on a pinned panel starts no pointer watch', (t) => {
    // The pin promise is "nothing but an explicit close or unpin ends it". A
    // watch armed here would end it the moment the pointer moved away.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    panel.open(trayRect, send);
    assert.equal(panel._pointerTimer, null);
    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS * 20 + LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), true);
  });

  test('a second open reports one visibility change, not two', () => {
    // `collector.setPanelOpen` is driven off this. A spurious false->true edge
    // would restart the fast sweep cadence for a panel that never left.
    const { panel, visibility, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.open(trayRect, send);
    panel.open(trayRect, send);
    assert.deepEqual(visibility, [true]);
  });

  test('a re-open cancels a hide the pointer had already armed', (t) => {
    // The race a tray click loses today: the pointer left, the 550 ms grace is
    // running, and the user clicks the icon again. The panel is still visible,
    // so main hides it — but if anything re-opens instead, the pending timer
    // must not fire underneath the new panel.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.notEqual(panel._hideTimer, null, 'a leave timer should be pending');

    panel.open(trayRect, send);
    assert.equal(panel._hideTimer, null, 're-opening must cancel it');
    t.mock.timers.tick(LEAVE_GRACE_MS * 2);
    assert.equal(panel.isVisible(), true, 'the old grace timer must not fire under a new panel');
  });

  test('a re-open with the pointer resting inside is not dismissed by anything', (t) => {
    // The re-open clears the transit latch, so for one poll interval the panel
    // looks "never reached". It must not be dismissed in that window: the
    // cursor is demonstrably on it, and the very next poll re-latches. Blur
    // cannot dismiss it either, because blur no longer dismisses anything.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);

    panel.open(trayRect, send);
    assert.equal(panel._pointerSeen, false, 'the latch is cleared by the re-open');
    panel.win.focused = false;
    panel.win.emit('blur');
    assert.equal(panel._hideTimer, null, 'a blur may not arm anything');
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.equal(panel._pointerSeen, true, 'and the poll re-latches from the real cursor');
    t.mock.timers.tick(LEAVE_GRACE_MS * 4);
    assert.equal(panel.isVisible(), true);
  });
});

/* ------------------------------------------ unpinning away from the pointer */

test.describe('unpinning while the pointer is somewhere else', () => {
  test('the watch restarts with the latch SEEDED from the real pointer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    cursorFarAway();
    panel.unpin(trayRect, send);
    assert.notEqual(panel._pointerTimer, null);
    // Was `false` — cleared, as if the pointer still had to travel here. There
    // is no journey on an unpin: the panel is already on screen and the
    // pointer is wherever it is, so the latch is decided rather than reset.
    assert.equal(panel._pointerSeen, true);
  });

  test('unpinning by KEYBOARD, pointer elsewhere, still closes on the pointer rule', (t) => {
    // Space on the pin button unpins without moving the mouse. `unpin()` used
    // to justify clearing the latch by "the user just clicked the control" —
    // true of the mouse path, false of the keyboard one — and the transit rule
    // then held the panel open indefinitely while the footer promised
    // "imleç ayrılınca kapanır".
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    cursorFarAway();
    panel.unpin(trayRect, send);                      // no mouse involved at all
    assert.notEqual(panel._hideTimer, null, 'the pointer is not on it, so it is leaving');
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false, 'QA repro: 200 poll intervals used to change nothing');
  });

  test('unpinning with the pointer ON the panel keeps it, until the pointer goes', (t) => {
    // The mouse path. The seeded latch must not turn "I unpinned it and my
    // cursor is right here" into an immediate dismissal.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    cursorInsidePanel(panel);
    panel.unpin(trayRect, send);
    assert.equal(panel._hideTimer, null);
    t.mock.timers.tick(POINTER_POLL_MS * 20);
    assert.equal(panel.isVisible(), true);

    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });

  test('blur is no longer the only thing that can close it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    cursorFarAway();
    panel.unpin(trayRect, send);
    // No blur at all: the pointer rule alone is now sufficient.
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });

  test('the pointer arriving after an unpin restores normal dismissal', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    cursorInsidePanel(panel);
    panel.unpin(trayRect, send);
    t.mock.timers.tick(POINTER_POLL_MS * 4);

    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });

  test('unpin announces the mode before anything can act on it', (t) => {
    // The anchor is what the pin control reads. If the panel could close
    // before it was sent, the button would have reported a state that never
    // reached the screen.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, anchors, send, trayRect } = build();
    panel.pin(trayRect, send);
    cursorFarAway();
    panel.unpin(trayRect, send);
    assert.equal(anchors.at(-1).mode, 'hover');
    assert.equal(panel.isVisible(), true);
  });
});

/* ------------------------------------------------- a gesture main cannot see */

test.describe('a gesture in flight is invisible to main', () => {
  test('keep-alives at the renderer cadence hold the panel open from outside the rect', (t) => {
    // A drag captures the pointer inside the DOCUMENT, not inside the window
    // rect: `screen.getCursorScreenPoint()` still reports wherever the physical
    // cursor is. The only thing holding the panel open then is the renderer's
    // pointermove keep-alive, throttled to 400 ms in `panel.ts`. That is inside
    // the 550 ms grace, so a MOVING drag survives.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    cursorJustOutside(panel);
    for (let i = 0; i < 10; i++) {
      t.mock.timers.tick(400);
      panel.notePointerInside();
    }
    assert.equal(panel.isVisible(), true, 'a moving pointer must not lose the panel');
  });

  test('DEFECT: a 550 ms pause in those keep-alives closes it, drag or no drag', (t) => {
    // Nothing in the IPC surface says "a gesture is in flight", so a pointer
    // held STILL just outside the window rect — mid-drag, deciding — is
    // indistinguishable from one that walked away. `reorder.ts` claims the
    // drag is safe because "the pointer is captured inside the window for the
    // whole gesture, so the poll sees it there whether or not it is moving";
    // pointer capture retargets EVENTS, it does not move the OS cursor.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    cursorJustOutside(panel);
    panel.notePointerInside();
    // Separate ticks: the grace timer is created INSIDE a poll tick, so a
    // single combined advance would not run a timer that did not yet exist.
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false, 'main has no way to know a drag is running');
  });

  test('one pixel is the whole margin: just outside is outside', (t) => {
    // The rect test is half-open on both axes, so the panel is not forgiving
    // of a cursor grazing its own right or bottom edge.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    const b = panel.win.getBounds();
    electron.moveCursor(b.x + b.width - 1, b.y + b.height - 1);
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.equal(panel._pointerSeen, true, 'the last pixel inside is inside');
    electron.moveCursor(b.x + b.width, b.y + b.height);
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });
});

/* ------------------------------------------------ data arriving mid-dismissal */

test.describe('a snapshot arriving while the panel is closing', () => {
  test('a push does not cancel a hide the pointer armed', (t) => {
    // Data is not attention. A snapshot landing during the grace period must
    // not resurrect a panel the user has walked away from.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.notEqual(panel._hideTimer, null);

    panel.send(IPC.SNAPSHOT, { generatedAt: new Date().toISOString(), providers: [] });
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false);
  });

  test('a push to a hidden panel is dropped rather than thrown', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.hide();
    const before = panel.win.webContents.sent.length;
    panel.send(IPC.SNAPSHOT, { generatedAt: new Date().toISOString(), providers: [] });
    // A hidden window is still a live webContents; the push is legal and the
    // renderer paints it before the next show. What must not happen is a throw.
    assert.ok(panel.win.webContents.sent.length >= before);
  });

  test('a destroyed panel swallows the push instead of throwing', () => {
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.destroy();
    assert.doesNotThrow(() => panel.send(IPC.SNAPSHOT, { generatedAt: '', providers: [] }));
  });
});

/* ------------------------------------------------- a revived renderer */

test.describe('a renderer revived under a panel main still holds a mode for', () => {
  test('the panel is still pinned after its renderer is brought back', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.pin(trayRect, send);
    const loadsBefore = panel.win.loads;
    panel.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(panel.win.loads, loadsBefore + 1, 'the page is reloaded once');
    assert.equal(panel.pinned, true, 'main keeps the mode across a renderer death');
  });

  test('the mode is restated to the revived renderer, or its pin control lies', (t) => {
    // `AnchorPayload.mode` is the ONLY thing that tells the renderer whether it
    // is pinned, and a remounted page starts from `pinned: false`. Without a
    // restatement the panel sits there pinned while its own control says it is
    // not — and while no pointer poll is watching it and no blur will close it.
    // `src/main/index.js` calls this on `did-finish-load`.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, anchors, send, trayRect } = build();
    panel.pin(trayRect, send);
    panel.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    const before = anchors.length;
    panel.sendCurrentAnchor(trayRect, send);
    assert.equal(anchors.length, before + 1, 'the revived page is told something');
    assert.equal(anchors.at(-1).mode, 'pin');
  });

  test('an unpinned panel is restated as unpinned, not left to guess', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, anchors, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    panel.sendCurrentAnchor(trayRect, send);
    assert.equal(anchors.at(-1).mode, 'hover');
  });

  test('restating the anchor changes nothing else about the panel', (t) => {
    // It runs on every did-finish-load, including the first load at startup and
    // any reload. If it could arm or disarm anything, that would be a dismissal
    // path keyed on page loads.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    const watch = panel._pointerTimer;
    panel.sendCurrentAnchor(trayRect, send);
    assert.equal(panel.pinned, false);
    assert.equal(panel._pointerTimer, watch, 'the pointer watch is untouched');
    assert.equal(panel._pointerSeen, true, 'the transit latch is not reset');
    assert.equal(panel._hideTimer, null);
  });

  test('a panel that is not on screen is told nothing', (t) => {
    // did-finish-load also fires for the load at startup, when the window has
    // never been shown. An anchor then would describe a position nothing is at.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, anchors, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.hide();
    const before = anchors.length;
    panel.sendCurrentAnchor(trayRect, send);
    assert.equal(anchors.length, before);
  });

  test('the revive happens once, so a renderer that dies again does not spin', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    const loadsBefore = panel.win.loads;
    panel.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    panel.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    panel.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(panel.win.loads, loadsBefore + 1);
  });

  test('a revived renderer cannot latch the panel on a claim the cursor denies', (t) => {
    // The revived renderer sends PANEL_OPENED while mounting, and main turns
    // that into notePointerInside(). It is the SAME unverified claim a fresh
    // mount makes, so it gets the same answer: refused while the cursor says
    // otherwise. Latching here would hand a just-revived panel to the poll,
    // which would then read "the pointer has left" and dismiss it a grace
    // period later with the pointer nowhere near it.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    cursorFarAway();
    panel.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    panel.notePointerInside();
    assert.equal(panel._pointerSeen, false, 'the mount-time claim was refused');
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(LEAVE_GRACE_MS);
    // The cursor is far from the corridor, so the corridor rule is what closes
    // it — the panel is not stranded just because the claim was refused.
    assert.equal(panel.isVisible(), false, 'the corridor rule owns it, the renderer does not');
  });

  test('an unpinned panel keeps its dismissal paths across a revive', (t) => {
    // The guarantee that survives the stricter latch: the pointer watch is a
    // main-process timer and the revive only reloads the page, so a pointer
    // that genuinely reaches the panel and then leaves still closes it.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });

    cursorInsidePanel(panel);
    t.mock.timers.tick(POINTER_POLL_MS);
    assert.equal(panel._pointerSeen, true, 'the poll still latches after a revive');

    cursorFarAway();
    t.mock.timers.tick(POINTER_POLL_MS);
    t.mock.timers.tick(LEAVE_GRACE_MS);
    assert.equal(panel.isVisible(), false, 'and leaving still closes it');
  });
});

/* ---------------------------------------------------------------- hide */

test.describe('closing is idempotent', () => {
  test('two hides report one visibility change', () => {
    const { panel, visibility, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.hide();
    panel.hide();
    assert.deepEqual(visibility, [true, false]);
  });

  test('hiding an unpinned panel still reports the pin state it ends in', () => {
    // `hide()` clears `pinned` unconditionally, so the tray-click path leaves
    // main and the (hidden) renderer agreeing on 'hover' at the next open.
    const { panel, pins, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.hide();
    assert.equal(panel.pinned, false);
    assert.deepEqual(pins, [false], 'one report, and it is the state it ended in');
  });
});

/* ------------------------------------- the transparent frame lets clicks through */

test.describe('the space around the panel does not swallow clicks (2026-10-01)', () => {
  test('the window starts click-through, with moves forwarded so the panel can see the pointer', () => {
    const { panel } = build();
    assert.deepEqual(panel.win.ignoreCalls[0], { ignore: true, forward: true });
  });

  test('over the painted panel it takes the mouse; leaving gives it back; repeats are not re-sent', () => {
    const { panel } = build();
    panel.setPointerOverPanel(true);
    panel.setPointerOverPanel(true);
    panel.setPointerOverPanel(false);
    assert.deepEqual(panel.win.ignoreCalls.map((c) => c.ignore), [true, false, true]);
    assert.ok(panel.win.ignoreCalls.every((c) => c.forward), 'moves must stay forwarded or the pointer cannot come back');
  });

  test('hiding the panel resets it to click-through, whatever the renderer said last', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { panel, send, trayRect } = build();
    panel.open(trayRect, send);
    panel.setPointerOverPanel(true);
    panel.hide('test');
    assert.equal(panel.win.ignoreCalls.at(-1).ignore, true);
  });

  test('main accepts the report only from the panel, and only a literal true takes the mouse', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
    const handler = src.slice(src.indexOf('ipcMain.on(IPC.PANEL_HIT'), src.indexOf('});', src.indexOf('ipcMain.on(IPC.PANEL_HIT')));
    assert.match(handler, /fromPanel\(event\)/);
    assert.match(handler, /over === true/);
    assert.equal(IPC.PANEL_HIT, 'panel:hit');
  });
});
