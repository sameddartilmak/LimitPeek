'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fakeElectron = require('./helpers/fake-electron');
const log = require('../src/core/log');
log.setTrace(false);

const electron = fakeElectron.install();
const { PanelWindow } = require('../src/main/panel-window');

test.after(() => electron.restore());

/**
 * A window stub whose `getBounds()` answers with `firstGot` the first time it
 * is asked — the read-back the real Electron gives right after a cross-DPI
 * move, before the window is physically on the target monitor — so a test can
 * drive `_placeAcrossDpi` without a real multi-DPI display.
 */
function stubWin(firstGot) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    reads: () => reads,
    isDestroyed: () => false,
    setBounds(b) { calls.push({ ...b }); },
    getBounds() { reads++; return { ...firstGot }; },
  };
}

const WANT = { x: 1472, y: 344, width: 440, height: 680 };

test.describe('_placeAcrossDpi: cross-DPI reveal guard', () => {
  test('re-asserts bounds when the first read-back is the 1.25x inflation', () => {
    const panel = new PanelWindow({ entry: __filename });
    // 550x850 = 440x680 sized for the PARK monitor (1.25x) instead of the
    // target (1.0x) — the measured bug that spilled the panel off-screen.
    panel.win = stubWin({ x: 1472, y: 344, width: 550, height: 850 });
    panel._placeAcrossDpi(WANT);
    assert.equal(panel.win.calls.length, 2, 'set, then re-set in the correct DPI context');
    assert.deepEqual(panel.win.calls[0], WANT);
    assert.deepEqual(panel.win.calls[1], WANT, 'the re-assert requests the same anchor');
  });

  test('does NOT re-assert for the legitimate fractional-scale rounding (442x681)', () => {
    const panel = new PanelWindow({ entry: __filename });
    // A 1.25x display rounds 440x680 to 442x681; that is correct, not the bug.
    panel.win = stubWin({ x: 1472, y: 344, width: 442, height: 681 });
    panel._placeAcrossDpi(WANT);
    assert.equal(panel.win.calls.length, 1, 'one placement; rounding is not a mismatch');
    assert.deepEqual(panel.win.calls[0], WANT);
  });

  test('exact read-back places once', () => {
    const panel = new PanelWindow({ entry: __filename });
    panel.win = stubWin({ ...WANT });
    panel._placeAcrossDpi(WANT);
    assert.equal(panel.win.calls.length, 1);
  });

  test('a destroyed or missing window is a no-op, never a throw', () => {
    const panel = new PanelWindow({ entry: __filename });
    panel.win = null;
    assert.doesNotThrow(() => panel._placeAcrossDpi(WANT));

    let set = 0;
    panel.win = { isDestroyed: () => true, setBounds() { set++; }, getBounds() { return WANT; } };
    panel._placeAcrossDpi(WANT);
    assert.equal(set, 0, 'nothing is placed on a destroyed window');
  });
});
