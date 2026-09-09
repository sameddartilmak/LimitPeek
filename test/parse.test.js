'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractEvents } = require('../src/core/scan/parse');
const log = require('../src/core/log');

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

function assistant(over = {}) {
  return {
    type: 'assistant',
    timestamp: '2026-09-08T10:00:00.000Z',
    sessionId: 'sess-1',
    uuid: 'uuid-1',
    requestId: 'req_1',
    cwd: 'C:\\Users\\someone\\secret-project',
    gitBranch: 'feature/secret',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'MY SECRET PROMPT TEXT' }],
      usage: {
        input_tokens: 2,
        output_tokens: 248,
        cache_creation_input_tokens: 36955,
        cache_read_input_tokens: 1000,
        output_tokens_details: { thinking_tokens: 126 },
        iterations: [
          { input_tokens: 2, output_tokens: 248, cache_creation_input_tokens: 36955, cache_read_input_tokens: 1000 },
        ],
      },
      ...over.message,
    },
    ...over,
  };
}

test('extracts exactly the permitted fields and nothing else', () => {
  const { events } = extractEvents(line(assistant()), 'fid');
  assert.equal(events.length, 1);
  // cw5/cw1h joined the set for ADR-002 pricing: a 1-hour cache write bills at
  // 2.0x against a 5-minute write's 1.25x. `speed` is present only when it is
  // not 'standard', so it is absent here. Both are numbers or a short enum —
  // this list is the boundary, and it stays exhaustive on purpose.
  assert.deepEqual(Object.keys(events[0]).sort(),
    ['cacheRead', 'cacheWrite', 'cw1h', 'cw5', 'f', 'input', 'key', 'model', 'output', 'ts'].sort());
  const serialised = JSON.stringify(events[0]);
  for (const forbidden of ['SECRET', 'cwd', 'gitBranch', 'content', 'thinking', 'feature/']) {
    assert.equal(serialised.includes(forbidden), false, `event leaked ${forbidden}`);
  }
});

test('top-level usage counters only; iterations[] must not be added on top', () => {
  const { events } = extractEvents(line(assistant()), 'fid');
  assert.equal(events[0].input, 2);
  assert.equal(events[0].output, 248, 'doubling would mean iterations[] was summed in');
  assert.equal(events[0].cacheWrite, 36955);
  assert.equal(events[0].cacheRead, 1000);
});

test('<synthetic> records are skipped', () => {
  const rec = assistant({ message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } });
  assert.equal(extractEvents(line(rec), 'fid').events.length, 0);
});

test('records without message.usage are skipped', () => {
  const user = { type: 'user', timestamp: '2026-09-08T10:00:00.000Z', message: { role: 'user', content: 'hi usage' } };
  assert.equal(extractEvents(line(user), 'fid').events.length, 0);
});

test('all-zero counters are skipped', () => {
  const rec = assistant({ message: { model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  assert.equal(extractEvents(line(rec), 'fid').events.length, 0);
});

test('an unparseable timestamp is skipped rather than defaulted to now', () => {
  const rec = assistant({ timestamp: 'not-a-date' });
  assert.equal(extractEvents(line(rec), 'fid').events.length, 0);
});

test('negative or non-numeric counters are coerced to 0, never NaN', () => {
  const rec = assistant({ message: { model: 'm', usage: { input_tokens: -5, output_tokens: 'lots', cache_creation_input_tokens: null, cache_read_input_tokens: 7 } } });
  const { events } = extractEvents(line(rec), 'fid');
  assert.deepEqual([events[0].input, events[0].output, events[0].cacheWrite, events[0].cacheRead], [0, 0, 0, 7]);
});

test.describe('dedup key precedence', () => {
  test('requestId wins', () => {
    assert.equal(extractEvents(line(assistant()), 'fid').events[0].key, 'req_1');
  });

  test('message.id is the fallback', () => {
    const rec = assistant();
    delete rec.requestId;
    assert.equal(extractEvents(line(rec), 'fid').events[0].key, 'msg_1');
  });

  test('sessionId:uuid is the last resort', () => {
    const rec = assistant();
    delete rec.requestId;
    delete rec.message.id;
    assert.equal(extractEvents(line(rec), 'fid').events[0].key, 'sess-1:uuid-1');
  });

  test('a record with no identity at all gets a unique key, so it is never merged', () => {
    const rec = assistant();
    delete rec.requestId;
    delete rec.message.id;
    delete rec.sessionId;
    delete rec.uuid;
    const text = line(rec) + line(rec);
    const { events } = extractEvents(text, 'fid');
    assert.equal(events.length, 2);
    assert.notEqual(events[0].key, events[1].key);
  });
});

test.describe('parse failures', () => {
  test('a malformed line is skipped and the rest of the file still parses', () => {
    const text = `{"type":"assistant","message":{"usage":{"input_tokens": broken\n${line(assistant())}`;
    const noise = [];
    log.setSink((_level, msg) => noise.push(msg));
    try {
      const res = extractEvents(text, 'fid');
      assert.equal(res.failed, 1);
      assert.equal(res.events.length, 1);
    } finally {
      log.setSink(null);
    }
  });

  test('the log line contains the file id and line index and NOTHING from the file', () => {
    const secret = 'PLEASE-DO-NOT-LOG-ME';
    const text = `{"usage":"${secret}", oops\n`;
    const messages = [];
    log.setSink((_level, msg) => messages.push(msg));
    try {
      extractEvents(text, 'abc123');
      assert.equal(messages.length, 1);
      assert.match(messages[0], /file=abc123/);
      assert.match(messages[0], /line=0/);
      assert.equal(messages[0].includes(secret), false);
      assert.equal(messages[0].includes('usage'), false, 'no substring of the line');
      assert.equal(messages[0].includes('assistant'), false, 'no substring of the line');
      assert.equal(/position|JSON|token/i.test(messages[0]), false, 'no JSON.parse message, it embeds source');
    } finally {
      log.setSink(null);
    }
  });
});

test('lines without "usage" are never handed to JSON.parse', () => {
  // 3 lines, only 1 candidate. If the prefilter were removed the two
  // syntactically broken lines would register as parse failures.
  const text = 'not json at all\n{ also not json\n' + line(assistant());
  const res = extractEvents(text, 'fid');
  assert.equal(res.failed, 0);
  assert.equal(res.events.length, 1);
});

test('an empty file yields nothing and does not throw', () => {
  assert.deepEqual(extractEvents('', 'fid').events, []);
  assert.deepEqual(extractEvents('\n\n\n', 'fid').events, []);
});

test('a file truncated mid-line loses only that line', () => {
  const second = line(assistant({ requestId: 'req_2' }));
  // Cut after the `usage` key so the truncated line still reaches JSON.parse.
  const text = line(assistant()) + second.slice(0, second.indexOf('"usage"') + 30);
  const messages = [];
  log.setSink((_l, m) => messages.push(m));
  try {
    const res = extractEvents(text, 'fid');
    assert.equal(res.events.length, 1);
    assert.equal(res.failed, 1);
  } finally {
    log.setSink(null);
  }
});
