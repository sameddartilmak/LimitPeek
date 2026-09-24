'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const schedule = require('../src/core/keys/schedule');

/**
 * The request budget (ADR-003 Amendment 5, K16), against a FAKE CLOCK.
 *
 * The two headline numbers the security review asked for are simulated end to
 * end below: a thousand refreshes make one request, and a 401 makes none at all
 * over 48 hours. They are simulations of the decision function rather than of
 * the network, which is the point — the limit has to hold whatever triggers a
 * refresh, and a test that needed a socket could only ever cover one trigger.
 */

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-22T08:00:00Z');

function conditions(extra) {
  return { enabled: true, hasKey: true, inFlight: false, ...(extra || {}) };
}

/** Runs `attempts` refreshes over `spanMs`, counting the ones that start. */
function simulate({ attempts, spanMs, outcome, state = schedule.emptyState() }) {
  let current = state;
  let started = 0;
  for (let i = 0; i < attempts; i += 1) {
    const now = T0 + Math.round((spanMs * i) / attempts);
    if (!schedule.mayStart(current, now, conditions())) continue;
    started += 1;
    current = schedule.afterStart(current, now);
    current = schedule.afterOutcome(current, outcome(i), now);
  }
  return { started, state: current };
}

test('1000 refreshes inside five minutes make ONE request', () => {
  const run = simulate({
    attempts: 1000,
    spanMs: 5 * MIN - 1000,
    outcome: () => ({ kind: 'ok' }),
  });
  assert.equal(run.started, 1);
});

test('1000 refreshes spread over a day make one request per five minutes, no more', () => {
  const run = simulate({ attempts: 1000, spanMs: 24 * 60 * MIN, outcome: () => ({ kind: 'ok' }) });
  // 24 h / 5 min = 288 slots, but 1000 attempts over a day are ~86 s apart,
  // so a slot opens every fourth attempt: 250. Never more than 289.
  assert.ok(run.started <= 289, `started ${run.started}`);
  assert.ok(run.started >= 240, `started ${run.started}`);
});

test('a 401 stops polling: no request in the next 48 hours, however often it is asked', () => {
  const first = schedule.afterStart(schedule.emptyState(), T0);
  const stopped = schedule.afterOutcome(first, { kind: 'stop' }, T0);
  assert.equal(stopped.stopped, true);

  let asked = 0;
  for (let i = 0; i < 2000; i += 1) {
    const now = T0 + Math.round((48 * 60 * MIN * i) / 2000);
    if (schedule.mayStart(stopped, now, conditions())) asked += 1;
  }
  assert.equal(asked, 0);

  // Only a new key clears it, and the service does that by resetting the state.
  assert.equal(schedule.mayStart(schedule.emptyState(), T0 + 48 * 60 * MIN, conditions()), true);
});

test('polling never starts while the provider is disabled, has no key, or one is in flight', () => {
  const state = schedule.emptyState();
  assert.equal(schedule.mayStart(state, T0, conditions()), true);
  assert.equal(schedule.mayStart(state, T0, conditions({ enabled: false })), false);
  assert.equal(schedule.mayStart(state, T0, conditions({ hasKey: false })), false);
  assert.equal(schedule.mayStart(state, T0, conditions({ inFlight: true })), false);
  assert.equal(schedule.mayStart(state, T0, null), false);
  assert.equal(schedule.mayStart(null, T0, conditions()), false);
  assert.equal(schedule.mayStart(state, Number.NaN, conditions()), false);
});

test('the slot is spent at the START, not at the reply', () => {
  const started = schedule.afterStart(schedule.emptyState(), T0);
  assert.equal(started.lastAttemptAt, T0);
  assert.equal(started.nextEligibleAt, T0 + 5 * MIN);
  // A request that never answers (the process died mid-flight) still consumed it.
  assert.equal(schedule.mayStart(started, T0 + 4 * MIN, conditions()), false);
  assert.equal(schedule.mayStart(started, T0 + 5 * MIN, conditions()), true);
});

test('failures back off by doubling and stop at six hours', () => {
  let state = schedule.emptyState();
  const waits = [];
  let now = T0;
  for (let i = 0; i < 10; i += 1) {
    state = schedule.afterStart(state, now);
    state = schedule.afterOutcome(state, { kind: 'fail' }, now);
    waits.push((state.nextEligibleAt - now) / MIN);
    now = state.nextEligibleAt;
  }
  assert.deepEqual(waits, [5, 10, 20, 40, 80, 160, 320, 360, 360, 360]);
});

test('a success clears the backoff', () => {
  let state = schedule.afterOutcome(schedule.emptyState(), { kind: 'fail' }, T0);
  state = schedule.afterOutcome(state, { kind: 'fail' }, T0);
  assert.equal(state.backoffMs, 10 * MIN);
  state = schedule.afterOutcome(state, { kind: 'ok' }, T0);
  assert.equal(state.backoffMs, 0);
  assert.equal(state.nextEligibleAt, T0 + 5 * MIN);
});

test('Retry-After is honoured only inside 15 min … 24 h', () => {
  assert.equal(schedule.parseRetryAfter('1', T0), 15 * MIN);
  assert.equal(schedule.parseRetryAfter('0', T0), 15 * MIN);
  assert.equal(schedule.parseRetryAfter('1800', T0), 30 * MIN);
  assert.equal(schedule.parseRetryAfter('31536000', T0), 24 * 60 * MIN);
  assert.equal(schedule.parseRetryAfter(String(20 * 60), T0), 20 * MIN);
  // The HTTP-date form, relative to now.
  assert.equal(
    schedule.parseRetryAfter(new Date(T0 + 40 * MIN).toUTCString(), T0),
    40 * MIN,
  );
  // A date in the past clamps up to the floor, never to zero.
  assert.equal(schedule.parseRetryAfter(new Date(T0 - 60 * MIN).toUTCString(), T0), 15 * MIN);
  for (const value of [null, undefined, '', 'soon', 42, 'x'.repeat(100), '12345678901']) {
    assert.equal(schedule.parseRetryAfter(value, T0), null, String(value));
  }
});

test('a rate limit waits the header out, and does not feed the failure backoff', () => {
  const state = schedule.afterOutcome(schedule.emptyState(), { kind: 'rate-limited', retryAfterMs: 90 * MIN }, T0);
  assert.equal(state.nextEligibleAt, T0 + 90 * MIN);
  assert.equal(state.backoffMs, 0);
  // With no header it waits one normal step rather than retrying at once.
  const noHeader = schedule.afterOutcome(schedule.emptyState(), { kind: 'rate-limited' }, T0);
  assert.equal(noHeader.nextEligibleAt, T0 + 5 * MIN);
});

test('a persisted schedule is sanitised, and a clock that stepped cannot freeze the row', () => {
  assert.deepEqual(schedule.sanitizeState(null), schedule.emptyState());
  assert.deepEqual(schedule.sanitizeState({ lastAttemptAt: 'soon', nextEligibleAt: -5, backoffMs: 'x' }), schedule.emptyState());
  assert.equal(schedule.sanitizeState({ backoffMs: 99 * 60 * MIN }).backoffMs, 6 * 60 * MIN);
  assert.equal(schedule.sanitizeState({ stopped: 'yes' }).stopped, false);
  assert.equal(schedule.sanitizeState({ stopped: true }).stopped, true);

  // A file (or a clock) claiming the next slot is a year away is not honoured.
  const frozen = { ...schedule.emptyState(), nextEligibleAt: T0 + 365 * 24 * 60 * MIN };
  assert.equal(schedule.mayStart(frozen, T0, conditions()), true);
});

/* ------------------------------------------------ manual refresh (2026-09-24) */

test('a thousand presses of "refresh" inside a minute make ONE request', () => {
  let state = schedule.afterOutcome(schedule.afterStart(schedule.emptyState(), T0), { kind: 'ok' }, T0);
  let started = 0;
  const from = T0 + 2 * MIN; // inside the automatic gap, past the manual one
  for (let i = 0; i < 1000; i += 1) {
    const now = from + Math.round((MIN - 1000) * i / 1000);
    if (!schedule.mayStartManual(state, now, conditions())) continue;
    started += 1;
    state = schedule.afterStart(state, now);
    state = schedule.afterOutcome(state, { kind: 'ok' }, now);
  }
  assert.equal(started, 1);
});

test('"refresh" waits one minute after any start, automatic or manual', () => {
  const state = schedule.afterStart(schedule.emptyState(), T0);
  assert.equal(schedule.mayStartManual(state, T0 + MIN - 1, conditions()), false);
  assert.equal(schedule.mayStartManual(state, T0 + MIN, conditions()), true);
  assert.equal(schedule.mayStartManual(schedule.emptyState(), T0, conditions()), true);
});

test('"refresh" cannot walk around a 401, a backoff or a Retry-After', () => {
  const stopped = schedule.afterOutcome(schedule.afterStart(schedule.emptyState(), T0), { kind: 'stop' }, T0);
  assert.equal(schedule.mayStartManual(stopped, T0 + 48 * 60 * MIN, conditions()), false);

  let failing = schedule.emptyState();
  for (let i = 0; i < 3; i += 1) failing = schedule.afterOutcome(failing, { kind: 'fail' }, T0);
  // Three failures: a 20-minute wait. The button does nothing inside it.
  assert.equal(schedule.mayStartManual(failing, T0 + 2 * MIN, conditions()), false);
  assert.equal(schedule.mayStartManual(failing, T0 + 20 * MIN, conditions()), true);

  const limited = schedule.afterOutcome(schedule.emptyState(), { kind: 'rate-limited', retryAfterMs: 60 * MIN }, T0);
  assert.equal(schedule.mayStartManual(limited, T0 + 30 * MIN, conditions()), false);
  assert.equal(schedule.mayStartManual(limited, T0 + 60 * MIN, conditions()), true);
});

test('"refresh" obeys the same switches as the poll', () => {
  const state = schedule.emptyState();
  assert.equal(schedule.mayStartManual(state, T0, conditions({ enabled: false })), false);
  assert.equal(schedule.mayStartManual(state, T0, conditions({ hasKey: false })), false);
  assert.equal(schedule.mayStartManual(state, T0, conditions({ inFlight: true })), false);
  assert.equal(schedule.mayStartManual(null, T0, conditions()), false);
});
