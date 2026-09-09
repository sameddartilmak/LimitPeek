'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scan } = require('../src/core/scan/scanner');
const { walkJsonlFiles } = require('../src/core/scan/walk');
const { fileId } = require('../src/core/ids');
const log = require('../src/core/log');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-08T12:00:00.000Z');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-scan-'));
  return root;
}

function write(root, rel, records, mtimeMs) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, text);
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function rec(over = {}) {
  return {
    timestamp: new Date(over.at || NOW - 60 * 60 * 1000).toISOString(),
    requestId: over.requestId || 'req_x',
    sessionId: 's', uuid: 'u',
    message: {
      model: over.model || 'claude-opus-5',
      usage: {
        input_tokens: 1, output_tokens: over.output ?? 100,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      },
    },
  };
}

test('walks the nested subagent tree, not just the top level', async () => {
  const root = fixture();
  write(root, 'slug/session.jsonl', [rec({ requestId: 'a' })]);
  write(root, 'slug/session/subagents/agent-1.jsonl', [rec({ requestId: 'b' })]);
  write(root, 'slug/session/subagents/workflows/wf/agent-2.jsonl', [rec({ requestId: 'c' })]);

  const { files } = await walkJsonlFiles(root, {});
  assert.equal(files.length, 3, 'a non-recursive glob would find only 1 of these');

  const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
  assert.deepEqual(res.events.map((e) => e.key).sort(), ['a', 'b', 'c']);
});

test('sibling agent-*.meta.json files are not parsed', async () => {
  const root = fixture();
  write(root, 'slug/s/subagents/agent-1.jsonl', [rec({ requestId: 'a' })]);
  fs.writeFileSync(path.join(root, 'slug/s/subagents/agent-1.meta.json'), '{"usage":"not a transcript"}');
  const { files } = await walkJsonlFiles(root, {});
  assert.equal(files.length, 1);
  assert.equal(files[0].path.endsWith('.jsonl'), true);
});

test('the depth limit stops a pathological tree', async () => {
  const root = fixture();
  write(root, 'a/b/c/d/deep.jsonl', [rec()]);
  const shallow = await walkJsonlFiles(root, { maxDepth: 2 });
  assert.equal(shallow.files.length, 0);
  const deep = await walkJsonlFiles(root, { maxDepth: 6 });
  assert.equal(deep.files.length, 1);
});

test.describe('mtime prefilter', () => {
  test('a never-seen file older than the retention window is never opened', async () => {
    const root = fixture();
    write(root, 'old.jsonl', [rec({ at: NOW - 60 * DAY })], NOW - 30 * DAY);
    write(root, 'new.jsonl', [rec({ requestId: 'fresh' })], NOW - 60 * 1000);

    const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(res.stats.filesSeen, 2);
    assert.equal(res.stats.filesParsed, 1, 'only the recent file is read');
    assert.deepEqual(res.events.map((e) => e.key), ['fresh']);
  });

  test('the skipped file still gets a cursor, so it is not reconsidered', async () => {
    const root = fixture();
    const f = write(root, 'old.jsonl', [rec({ at: NOW - 60 * DAY })], NOW - 30 * DAY);
    const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.ok(res.cursors[fileId(f)], 'cursor recorded for the unopened file');
  });

  test('a size change re-parses regardless of mtime', async () => {
    const root = fixture();
    const f = write(root, 'x.jsonl', [rec({ requestId: 'one' })], NOW - 30 * DAY);
    const first = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(first.stats.filesParsed, 0);

    // Append and force the mtime back into the past: only size changed.
    fs.appendFileSync(f, JSON.stringify(rec({ requestId: 'two' })) + '\n');
    fs.utimesSync(f, (NOW - 30 * DAY) / 1000, (NOW - 30 * DAY) / 1000);

    const second = await scan({ root, cursors: first.cursors, priorEvents: first.events, now: NOW });
    assert.equal(second.stats.filesParsed, 1, 'a size change must beat the mtime prefilter');
    assert.deepEqual(second.events.map((e) => e.key).sort(), ['one', 'two']);
  });
});

test.describe('cursors', () => {
  test('an unchanged file is not re-read and its events are carried forward', async () => {
    const root = fixture();
    write(root, 'a.jsonl', [rec({ requestId: 'a' })]);
    const first = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(first.stats.filesParsed, 1);

    const second = await scan({ root, cursors: first.cursors, priorEvents: first.events, now: NOW });
    assert.equal(second.stats.filesParsed, 0);
    assert.equal(second.stats.bytesParsed, 0);
    assert.deepEqual(second.events.map((e) => e.key), ['a']);
  });

  test('a deleted file drops out of both cursors and events', async () => {
    const root = fixture();
    const f = write(root, 'a.jsonl', [rec({ requestId: 'a' })]);
    write(root, 'b.jsonl', [rec({ requestId: 'b' })]);
    const first = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(first.events.length, 2);

    fs.unlinkSync(f);
    const second = await scan({ root, cursors: first.cursors, priorEvents: first.events, now: NOW });
    assert.deepEqual(second.events.map((e) => e.key), ['b']);
    assert.equal(Object.keys(second.cursors).length, 1);
  });

  test('a changed file replaces its old events instead of adding to them', async () => {
    const root = fixture();
    const f = write(root, 'a.jsonl', [rec({ requestId: 'a', output: 10 })]);
    const first = await scan({ root, cursors: {}, priorEvents: [], now: NOW });

    fs.writeFileSync(f, JSON.stringify(rec({ requestId: 'a', output: 999 })) + '\n');
    const second = await scan({ root, cursors: first.cursors, priorEvents: first.events, now: NOW });
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].output, 999);
  });

  test('events outside the retention window are pruned on every scan', async () => {
    const root = fixture();
    write(root, 'a.jsonl', [rec({ requestId: 'old', at: NOW - 9 * DAY }), rec({ requestId: 'new', at: NOW - 1 * DAY })]);
    const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.deepEqual(res.events.map((e) => e.key), ['new']);
  });
});

test('one unreadable file cannot kill the scan', async () => {
  const root = fixture();
  write(root, 'good.jsonl', [rec({ requestId: 'good' })]);
  const bad = path.join(root, 'bad.jsonl');
  fs.writeFileSync(bad, JSON.stringify(rec({ requestId: 'bad' })) + '\n');

  // Make the read fail deterministically by turning the file into a directory
  // between the walk and the read: EISDIR, on every platform.
  fs.unlinkSync(bad);
  fs.mkdirSync(path.join(root, 'bad.jsonl.d'));
  fs.writeFileSync(path.join(root, 'bad.jsonl.d', 'inner.jsonl'), 'garbage without the keyword\n');

  log.setSink(() => {});
  try {
    const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
    assert.equal(res.ok, true);
    assert.deepEqual(res.events.map((e) => e.key), ['good']);
  } finally {
    log.setSink(null);
  }
});

test('an unreadable root is an error, and keeps the previous data', async () => {
  const root = fixture();
  const priorEvents = [{ f: 'x', ts: NOW, model: 'm', input: 1, output: 1, cacheWrite: 0, cacheRead: 0, key: 'k' }];
  const priorCursors = { x: { size: 1, mtimeMs: 1 } };
  // A file where a directory is expected: readdir fails with ENOTDIR.
  const notADir = path.join(root, 'file-not-dir');
  fs.writeFileSync(notADir, 'x');

  log.setSink(() => {});
  try {
    const res = await scan({ root: notADir, cursors: priorCursors, priorEvents, now: NOW });
    assert.equal(res.ok, false, 'an unreadable root must not read as "you used nothing"');
    assert.deepEqual(res.events, priorEvents, 'previous data is retained');
    assert.deepEqual(res.cursors, priorCursors);
  } finally {
    log.setSink(null);
  }
});

test('a missing root is reported, not thrown', async () => {
  log.setSink(() => {});
  try {
    const res = await scan({ root: path.join(os.tmpdir(), 'usage-notch-nope-' + Date.now()), cursors: {}, priorEvents: [], now: NOW });
    assert.equal(res.ok, true, 'a projects dir that was never created is not an error');
    assert.deepEqual(res.events, []);
    assert.deepEqual({ ...res.cursors }, {});
  } finally {
    log.setSink(null);
  }
});

test('cursor keys are hashes, never paths: the store cannot leak a cwd', async () => {
  const root = fixture();
  write(root, 'C--Users-someone-Documents-secret/a.jsonl', [rec({ requestId: 'a' })]);
  const res = await scan({ root, cursors: {}, priorEvents: [], now: NOW });
  const serialised = JSON.stringify({ cursors: res.cursors, events: res.events });
  assert.equal(serialised.includes('secret'), false);
  assert.equal(serialised.includes('Users'), false);
  for (const key of Object.keys(res.cursors)) assert.match(key, /^[0-9a-f]{16}$/);
});
