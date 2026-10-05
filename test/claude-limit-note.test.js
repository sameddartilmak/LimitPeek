'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LimitNoteTracker, noteFromLine, NOTE_KEEP_MS, PRIME_HORIZON_MS } = require('../src/core/claude-limit-note');
const { applyLimitNote } = require('../src/core/ratelimits');
const { Collector } = require('../src/core/collector');

/**
 * Owner, 2026-10-05: the 5h limit was full and the panel still read 99%. The
 * bridge carries the last SUCCESSFUL request's figure, and the request that
 * hits the limit is not one. Claude Code writes the moment into the session
 * transcript as a meta record with `usageLimitNote: "wrap_up"`, and writes
 * `"release"` once the limit lifts. These fix how that note is read and how it
 * turns a window full.
 */

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
// The owner's morning: the 5h window ran 09:10-14:10, the note came at 14:07.
const RESET = Date.parse('2026-10-05T11:10:00.000Z');
const NOTE_AT = Date.parse('2026-10-05T11:07:24.898Z');
const NOW = NOTE_AT + 30 * 1000;
// Tracker reads are stamped with a fixed instant too, so a note from this
// fixed morning is never past NOTE_KEEP_MS whenever the suite runs.
const LATER = NOTE_AT + 60 * 1000;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-limit-note-'));
}

/** A transcript line shaped like the one Claude Code wrote. */
function noteLine(note, atMs) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '[Usage limit reached; a short grace allowance remains ...]' },
    isMeta: true,
    usageLimitNote: note,
    timestamp: new Date(atMs).toISOString(),
    sessionId: 's',
  }) + '\n';
}

function usageLine(atMs) {
  return JSON.stringify({ type: 'assistant', timestamp: new Date(atMs).toISOString(), message: { model: 'm', usage: { input_tokens: 1 } } }) + '\n';
}

function reading(five, seven) {
  return {
    state: 'fresh', capturedAt: new Date(NOW - MIN).toISOString(), capturedAtMs: NOW - MIN, ageMs: MIN,
    fiveHour: five, sevenDay: seven,
  };
}

// ------------------------------------------------------------- one line

test.describe('a transcript line', () => {
  test('a wrap_up or release note is read with its instant, and nothing else', () => {
    const got = noteFromLine(Buffer.from(noteLine('wrap_up', NOTE_AT)));
    assert.deepEqual(got, { atMs: NOTE_AT, note: 'wrap_up' }, 'no message text comes out');
    assert.deepEqual(noteFromLine(Buffer.from(noteLine('release', NOTE_AT))), { atMs: NOTE_AT, note: 'release' });
  });

  test('an unknown note, a line without one, broken JSON or no timestamp is ignored', () => {
    assert.equal(noteFromLine(Buffer.from(noteLine('something_new', NOTE_AT))), null);
    assert.equal(noteFromLine(Buffer.from(usageLine(NOTE_AT))), null);
    assert.equal(noteFromLine(Buffer.from('{"usageLimitNote":"wrap_up",')), null);
    assert.equal(noteFromLine(Buffer.from('{"usageLimitNote":"wrap_up"}')), null);
  });
});

// ------------------------------------------------------------- the tracker

test.describe('the newest note across sessions', () => {
  test('start-up finds a note in a recently written session transcript', () => {
    const root = tmpdir();
    fs.mkdirSync(path.join(root, 'proj'));
    fs.writeFileSync(path.join(root, 'proj', 'a.jsonl'), usageLine(NOTE_AT - MIN) + noteLine('wrap_up', NOTE_AT));
    const t = new LimitNoteTracker({ root });
    assert.deepEqual(t.latest(LATER), { atMs: NOTE_AT, note: 'wrap_up' });
  });

  test('a transcript idle past the start-up horizon is not opened', () => {
    const root = tmpdir();
    fs.mkdirSync(path.join(root, 'proj'));
    const file = path.join(root, 'proj', 'old.jsonl');
    fs.writeFileSync(file, noteLine('wrap_up', NOTE_AT));
    const old = new Date(Date.now() - PRIME_HORIZON_MS - HOUR);
    fs.utimesSync(file, old, old);
    assert.equal(new LimitNoteTracker({ root }).latest(Date.now()), null);
  });

  test('a release written in ANOTHER session later wins over the wrap_up', () => {
    const root = tmpdir();
    fs.mkdirSync(path.join(root, 'p1'));
    fs.mkdirSync(path.join(root, 'p2'));
    const a = path.join(root, 'p1', 'a.jsonl');
    const b = path.join(root, 'p2', 'b.jsonl');
    fs.writeFileSync(a, noteLine('wrap_up', NOTE_AT));
    fs.writeFileSync(b, usageLine(NOTE_AT - HOUR));
    const t = new LimitNoteTracker({ root });
    assert.equal(t.latest(LATER).note, 'wrap_up');

    fs.appendFileSync(b, noteLine('release', NOTE_AT + 3 * MIN));
    t.touch(b);
    assert.deepEqual(t.latest(LATER), { atMs: NOTE_AT + 3 * MIN, note: 'release' });
  });

  test('a change is read from where the last read stopped', () => {
    const root = tmpdir();
    fs.mkdirSync(path.join(root, 'p'));
    const f = path.join(root, 'p', 'a.jsonl');
    fs.writeFileSync(f, noteLine('wrap_up', NOTE_AT));
    const t = new LimitNoteTracker({ root });
    t.latest(LATER);
    const offset = t._files.get(f).offset;
    assert.equal(offset, fs.statSync(f).size, 'the whole file was consumed');

    fs.appendFileSync(f, usageLine(NOTE_AT + MIN));
    t.touch(f);
    assert.equal(t.latest(LATER).note, 'wrap_up', 'an older note stays the newest until a newer one');
    assert.equal(t._files.get(f).offset, fs.statSync(f).size);
  });

  test('a rewritten (shorter) transcript is read again from its end', () => {
    const root = tmpdir();
    fs.mkdirSync(path.join(root, 'p'));
    const f = path.join(root, 'p', 'a.jsonl');
    fs.writeFileSync(f, usageLine(NOTE_AT - HOUR).repeat(5) + noteLine('wrap_up', NOTE_AT));
    const t = new LimitNoteTracker({ root });
    t.latest(LATER);
    fs.writeFileSync(f, noteLine('release', NOTE_AT + MIN));
    t.touch(f);
    assert.equal(t.latest(LATER).note, 'release');
  });

  test('only .jsonl changes are followed', () => {
    const t = new LimitNoteTracker({ root: tmpdir() });
    t.touch('x.json');
    t.touch(undefined);
    assert.equal(t._pending.size, 0);
  });

  test('a note older than a week and a day is forgotten', () => {
    const root = tmpdir();
    fs.mkdirSync(path.join(root, 'p'));
    fs.writeFileSync(path.join(root, 'p', 'a.jsonl'), noteLine('wrap_up', NOTE_AT));
    const t = new LimitNoteTracker({ root });
    assert.ok(t.latest(NOTE_AT + MIN));
    assert.equal(t.latest(NOTE_AT + NOTE_KEEP_MS + MIN), null);
  });
});

// ------------------------------------------------------------- applying it

test.describe('a wrap_up note marks the window full', () => {
  const five = { usedPercentage: 99, resetsAtMs: RESET };
  const seven = { usedPercentage: 58, resetsAtMs: RESET + 3 * 24 * HOUR };
  const renewedFive = { usedPercentage: 2, resetsAtMs: RESET + 5 * HOUR };
  const wrap = { atMs: NOTE_AT, note: 'wrap_up' };
  const apply = (rl, note, now, decided = null) => applyLimitNote(rl, note, now, decided);

  test("the owner's case: 99% in a 5h window that is in fact full reads 100%", () => {
    const out = apply(reading(five, seven), wrap, NOW).rateLimits;
    assert.equal(out.fiveHour.usedPercentage, 100);
    assert.equal(out.fiveHour.resetsAtMs, RESET, 'the reset instant is kept');
    assert.equal(out.sevenDay.usedPercentage, 58, 'the other window is untouched');
  });

  test('a 5h refusal ends with its window and never moves onto the weekly one', () => {
    const first = apply(reading(five, seven), wrap, NOW);
    // 14:10:01, the bridge still naming the ended window: found by replaying
    // the owner's morning, when the note slid onto the weekly window.
    const ended = apply(reading(five, seven), wrap, RESET + 1000, first.decided);
    assert.equal(ended.rateLimits.sevenDay.usedPercentage, 58);
    // The renewed window: the weekly one still contains 14:07, and must not
    // read full for days because of a 5h refusal.
    const renewed = apply(reading(renewedFive, seven), wrap, RESET + MIN, first.decided);
    assert.equal(renewed.rateLimits.fiveHour.usedPercentage, 2);
    assert.equal(renewed.rateLimits.sevenDay.usedPercentage, 58);
  });

  test('a weekly refusal stays through 5h renewals', () => {
    const weekly = { usedPercentage: 97, resetsAtMs: RESET + HOUR * 30 };
    const first = apply(reading({ usedPercentage: 20, resetsAtMs: RESET }, weekly), wrap, NOW);
    assert.equal(first.rateLimits.sevenDay.usedPercentage, 100);
    assert.equal(first.rateLimits.fiveHour.usedPercentage, 20);
    const later = apply(reading(renewedFive, weekly), wrap, RESET + 2 * HOUR, first.decided);
    assert.equal(later.rateLimits.sevenDay.usedPercentage, 100, 'the weekly limit did not renew');
    assert.equal(later.rateLimits.fiveHour.usedPercentage, 2);
  });

  test('first seen after the 5h window renewed (a restart): no window is marked', () => {
    const rl = reading(renewedFive, seven);
    const out = apply(rl, wrap, RESET + MIN);
    assert.equal(out.rateLimits, rl);
    assert.equal(out.decided.slot, null);
  });

  test('a window with no known reset instant: the note cannot be placed', () => {
    // resetInstant drops a reset more than a window plus slack away, and a
    // desktop sample past the bridge's window carries none.
    const rl = reading({ usedPercentage: 99, resetsAtMs: null }, seven);
    assert.equal(apply(rl, wrap, NOW).rateLimits, rl);
  });

  test('a release note, or no note, changes nothing', () => {
    const rl = reading(five, seven);
    assert.equal(apply(rl, { atMs: NOTE_AT, note: 'release' }, NOW).rateLimits, rl);
    assert.equal(apply(rl, null, NOW).rateLimits, rl);
  });

  test('no reading at all: the note is left unplaced', () => {
    const rl = { state: 'missing', capturedAt: null, capturedAtMs: null, ageMs: null, fiveHour: null, sevenDay: null };
    assert.equal(apply(rl, wrap, NOW).rateLimits, rl);
  });
});

// ------------------------------------------------------------- end to end

test('the collector shows 100% once a session records the limit, and back once released', () => {
  const dir = tmpdir();
  const projects = path.join(dir, 'projects');
  fs.mkdirSync(path.join(projects, 'p'), { recursive: true });
  const transcript = path.join(projects, 'p', 's.jsonl');
  const now = Date.now();
  const resetSec = Math.floor((now + 2 * MIN) / 1000);
  fs.writeFileSync(path.join(dir, 'claude-rate-limits.json'), JSON.stringify({
    schemaVersion: 1, capturedAt: new Date(now).toISOString(), present: true,
    fiveHour: { usedPercentage: 99, resetsAt: resetSec },
    sevenDay: { usedPercentage: 40, resetsAt: Math.floor((now + 3 * 24 * HOUR) / 1000) },
  }));
  fs.writeFileSync(transcript, usageLine(now - MIN));
  const c = new Collector({
    userDataDir: dir,
    projectsRoot: projects,
    rateLimitsFile: path.join(dir, 'claude-rate-limits.json'),
    codexHome: path.join(dir, 'codex'),
    antigravityUsageHome: path.join(dir, 'antigravity-home'),
    rateLimitsDir: dir,
    antigravityQuotaFile: path.join(dir, 'antigravity-quota.json'),
    ideAppDataDir: path.join(dir, 'ide'),
  });
  const claude = () => c.snapshot.providers.find((p) => p.id === 'claude');

  c.rebuild();
  assert.equal(claude().fiveHour.usedPercentage, 99);

  fs.appendFileSync(transcript, noteLine('wrap_up', now));
  c._limitNotes.touch(transcript);
  c.rebuild();
  assert.equal(claude().fiveHour.usedPercentage, 100);

  fs.appendFileSync(transcript, noteLine('release', now + 1000));
  c._limitNotes.touch(transcript);
  c.rebuild();
  assert.equal(claude().fiveHour.usedPercentage, 99);
  c.stop();
});
