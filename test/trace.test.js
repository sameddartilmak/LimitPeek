'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fakeElectron = require('./helpers/fake-electron');
const log = require('../src/core/log');

const electron = fakeElectron.install();
const { PanelWindow } = require('../src/main/panel-window');

/**
 * The gesture trace.
 *
 * It exists because a user reports the panel opening and closing again on ONE
 * real mouse click, and the measurement that says otherwise was synthetic
 * (`SendInput`). Nothing here asserts a fix — there is no diagnosis yet. What
 * it asserts is that the log is good enough to BE the diagnosis: that one
 * click produces an ordered, timestamped account of every decision on the
 * path, and that the account cannot leak anything it should not.
 */

function captured(fn) {
  const lines = [];
  const previousOn = log.traceEnabled();
  log.setSink((_level, msg) => lines.push(msg));
  log.setTrace(true);
  try {
    fn();
  } finally {
    log.setTrace(previousOn);
    log.setSink(null);
  }
  return lines.filter((l) => l.startsWith('trace '));
}

/** `trace +1234ms panel.hide reason=x` -> `panel.hide` */
const names = (lines) => lines.map((l) => l.split(' ')[2]);

test.describe('the trace format', () => {
  test('every line carries a millisecond offset from process start', () => {
    const lines = captured(() => log.trace('probe.one'));
    assert.equal(lines.length, 1);
    const m = /^trace \+(\d+)ms probe\.one$/.exec(lines[0]);
    assert.ok(m, lines[0]);
    assert.ok(Number(m[1]) >= 0);
  });

  test('the offset is monotonic, so two lines can be subtracted', () => {
    const lines = captured(() => {
      log.trace('probe.a');
      for (let i = 0; i < 200000; i++) { /* burn a little wall clock */ }
      log.trace('probe.b');
    });
    const at = (l) => Number(/\+(\d+)ms/.exec(l)[1]);
    assert.ok(at(lines[1]) >= at(lines[0]), lines.join(' | '));
  });

  test('detail is rendered as key=value pairs, in the order given', () => {
    const lines = captured(() => log.trace('probe.k', { visible: true, ms: 550, why: 'pinned' }));
    assert.equal(lines[0].endsWith('probe.k visible=true ms=550 why=pinned'), true, lines[0]);
  });

  test('a value that is not a safe token is REDACTED, not printed', () => {
    // The parse-discipline rule (ADR-001, security F3) applies to a diagnostic
    // channel exactly as it applies to a parse failure. This is enforced
    // structurally rather than by auditing call sites, because the audit is
    // what a later edit loses.
    const lines = captured(() => log.trace('probe.r', {
      path: 'C:\\Users\\someone\\.claude\\projects\\secret.jsonl',
      note: 'a sentence with spaces',
      obj: { a: 1 },
      arr: [1, 2],
    }));
    const line = lines[0];
    assert.equal(line.includes('someone'), false, line);
    assert.equal(line.includes('secret'), false, line);
    assert.equal(line.includes('a sentence'), false, line);
    assert.ok(line.endsWith('probe.r path=redacted note=redacted obj=redacted arr=redacted'), line);
  });

  test('an unsafe event name is redacted too', () => {
    const lines = captured(() => log.trace('C:\\Users\\someone\\file.jsonl'));
    assert.equal(lines[0].includes('someone'), false, lines[0]);
  });

  test('undefined keys are omitted rather than printed as "undefined"', () => {
    const lines = captured(() => log.trace('probe.u', { a: 1, b: undefined }));
    assert.ok(lines[0].endsWith('probe.u a=1'), lines[0]);
  });

  test('a non-finite number does not reach the log as NaN', () => {
    const lines = captured(() => log.trace('probe.n', { v: NaN, w: Infinity }));
    assert.equal(lines[0].includes('NaN'), false, lines[0]);
    assert.ok(lines[0].endsWith('probe.n v=nonfinite w=nonfinite'), lines[0]);
  });

  test('it is ON by default, because a flag nobody sets is a flag nobody sets', () => {
    // The bug is on the user's machine, not on this one. A trace that has to
    // be enabled first is a trace that will be off the one time it matters.
    delete require.cache[require.resolve('../src/core/log')];
    const fresh = require('../src/core/log');
    assert.equal(fresh.traceEnabled(), true);
    delete require.cache[require.resolve('../src/core/log')];
    require('../src/core/log');
  });

  test('setTrace(false) silences it completely', () => {
    const lines = [];
    log.setSink((_l, m) => lines.push(m));
    log.setTrace(false);
    log.trace('probe.silent');
    log.setTrace(true);
    log.setSink(null);
    assert.deepEqual(lines, []);
  });
});

/* --------------------------------------------------- one click, whole story */

function panelFor(t) {
  const panel = new PanelWindow({ width: 200, height: 200 });
  panel.create();
  t.after(() => panel.destroy());
  return panel;
}

test.describe('one click produces a readable sequence', () => {
  test('open -> blur inside the arming window -> deferred re-check are all logged', (t) => {
    const panel = panelFor(t);
    // The pointer is nowhere near the panel, which is the transit state a
    // tray click starts in and the state the reported flash would happen in.
    electron.moveCursor(5000, 5000);

    const lines = captured(() => {
      panel.open(null, () => {});
      panel.win.focused = false;
      panel.win.emit('blur');
    });

    const seen = names(lines);
    assert.ok(seen.includes('panel.pointerWatch'), seen.join(','));
    assert.ok(seen.includes('panel.show'), seen.join(','));
    assert.ok(seen.includes('panel.blur'), seen.join(','));
    // The candidate explanation, and the line that would confirm or kill it:
    // a blur arriving while the transit latch is still clear is DEFERRED, and
    // the log has to say so rather than leaving a silent gap before a hide
    // 550 ms later.
    const blur = lines.find((l) => l.includes('panel.blur '));
    assert.ok(/act=deferred/.test(blur), blur);
    assert.ok(/wait=\d+/.test(blur), blur);
  });

  test('the show line reports the resulting visibility, not the request', (t) => {
    const panel = panelFor(t);
    const lines = captured(() => panel.open(null, () => {}));
    const show = lines.find((l) => l.includes('panel.show'));
    assert.ok(/was=false/.test(show), show);
    assert.ok(/visible=true/.test(show), show);
    assert.ok(/pinned=false/.test(show), show);
  });

  test('a hide names who asked for it', (t) => {
    const panel = panelFor(t);
    const lines = captured(() => {
      panel.open(null, () => {});
      panel.hide('tray-toggle');
    });
    const hide = lines.find((l) => l.includes('panel.hide'));
    assert.ok(/reason=tray-toggle/.test(hide), hide);
    assert.ok(/was=true visible=false/.test(hide), hide);
  });

  test('scheduleHide and cancelHide both state a reason', (t) => {
    const panel = panelFor(t);
    const lines = captured(() => {
      panel.open(null, () => {});
      panel.scheduleHide(10_000, 'pointer-left');
      panel.cancelHide('pointer-inside');
    });
    const sched = lines.find((l) => l.includes('panel.scheduleHide'));
    const cancel = lines.find((l) => l.includes('panel.cancelHide'));
    assert.ok(/reason=pointer-left ms=10000/.test(sched), sched);
    assert.ok(/reason=pointer-inside/.test(cancel), cancel);
  });

  test('a timer-driven hide is distinguishable from a user-driven one', (t) => {
    // This is the whole question the user's report poses: did the panel close
    // because they clicked again, or because something else decided to close
    // it? The two must never read alike in the log.
    const panel = panelFor(t);
    const lines = captured(() => {
      panel.open(null, () => {});
      panel.scheduleHide(0, 'blur');
    });
    assert.ok(lines.some((l) => /panel\.scheduleHide reason=blur/.test(l)), lines.join('\n'));
  });

  test('cancelHide is silent when there was nothing to cancel', (t) => {
    // Most callers cancel unconditionally. Logging those would put four lines
    // of noise around every open and bury the sequence.
    const panel = panelFor(t);
    const lines = captured(() => panel.cancelHide('open'));
    assert.deepEqual(lines.filter((l) => l.includes('cancelHide')), []);
  });

  test('the pointer latch is logged once, not four times a second', (t) => {
    const panel = panelFor(t);
    panel.open(null, () => {});
    const b = panel.win.getBounds();
    electron.moveCursor(b.x + 5, b.y + 5);
    const lines = captured(() => {
      panel._pollPointer();
      panel._pollPointer();
      panel._pollPointer();
    });
    assert.deepEqual(names(lines), ['panel.pointerLatch'], lines.join('\n'));
    assert.ok(lines[0].endsWith('via=poll'), lines[0]);
  });

  test('a cursor the OS will not report is logged as a skipped tick', (t) => {
    const panel = panelFor(t);
    panel.open(null, () => {});
    const previous = electron.fake.screen.getCursorScreenPoint;
    electron.fake.screen.getCursorScreenPoint = () => { throw new Error('no cursor'); };
    const lines = captured(() => panel._pollPointer());
    electron.fake.screen.getCursorScreenPoint = previous;
    assert.ok(lines[0].endsWith('panel.poll act=skipped why=no-cursor'), lines[0]);
  });
});

test.after(() => electron.restore());
