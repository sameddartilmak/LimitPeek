'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const qwen = require('../src/core/qwen/usage');
const { qwenCost } = require('../src/core/qwen/pricing');
const kimi = require('../src/core/kimi/usage');
const grok = require('../src/core/grok/usage');
const { grokCost } = require('../src/core/grok/cost');

/**
 * Files WRITTEN BY THE REAL TOOLS, not by hand (2026-09-29): Qwen Code 0.24.6,
 * Kimi Code 2.1.1 and Grok Build 1.0.44 (X.AI LLC signed binary) were each run
 * once, headless, in a throwaway home, against a local fake model server that
 * answers every request with the same usage:
 *   prompt 1234 (of which 1000 cached), completion 56 (7 of it reasoning),
 *   and for xAI `cost_in_usd_ticks` 12345678 ($0.0012345678).
 * No account or subscription was used. Kimi's journals are trimmed to their
 * usage, fork and metadata records (the rest is the tool's prompts and tool
 * list, replaced line for line by `{type, trimmed, time}`); Qwen's and
 * Grok's files are byte for byte what the tools wrote. Grok's `<encoded-cwd>`
 * directory was renamed to a neutral path.
 *
 * If a tool update changes what it writes, re-run it the same way and replace
 * the fixture: these tests are the readers' contract with the real tools.
 */

const ROOT = path.join(__dirname, 'fixtures', 'real-cli');
const NOW = Date.parse('2026-09-29T12:00:00Z');
const FROM = NOW - 24 * 60 * 60 * 1000;

function eventsOf(res) {
  return Array.isArray(res) ? res : res.events;
}

test('Qwen Code 0.24.6: both responses, uncached input = prompt - cached, thinking inside output', () => {
  const evs = eventsOf(qwen.qwenUsageEvents({ home: path.join(ROOT, 'qwen'), now: NOW }));
  // The main answer, and the background memory extractor Qwen runs after it:
  // both are real API calls and both are billed.
  assert.equal(evs.length, 2);
  const { tokens, byModel } = qwen.sumQwenTokens(evs, FROM, NOW);
  assert.deepEqual(tokens, { input: 468, output: 112, cacheWrite: 0, cacheRead: 2000, billable: 580 });
  assert.deepEqual(byModel.map((m) => m.model), ['qwen3-coder-plus']);
  const cost = qwenCost(evs, FROM, NOW, false);
  assert.ok(cost.totalUsd > 0);
});

test('Kimi Code 2.1.1: one usage record per turn, plan alias kept, other aliases unknown', () => {
  const evs = eventsOf(kimi.kimiUsageEvents({ home: path.join(ROOT, 'kimi'), now: NOW }));
  assert.equal(evs.length, 2);
  const { tokens, byModel } = kimi.sumKimiTokens(evs, FROM, NOW);
  assert.deepEqual(tokens, { input: 468, output: 112, cacheWrite: 0, cacheRead: 2000, billable: 580 });
  assert.deepEqual(byModel.map((m) => m.model).sort(), ['kimi-code/kimi-for-coding', 'unknown']);
  assert.equal(kimi.isKimiPlanAlias('kimi-code/kimi-for-coding'), true);
});

test('Grok Build 1.0.44: the turn, its tokens and the cost xAI reported', () => {
  const evs = eventsOf(grok.grokUsageEvents({ home: path.join(ROOT, 'grok'), now: NOW }));
  assert.equal(evs.length, 1);
  const { tokens, byModel } = grok.sumGrokTokens(evs, FROM, NOW);
  assert.deepEqual(tokens, { input: 234, output: 56, cacheWrite: 0, cacheRead: 1000, billable: 290 });
  assert.deepEqual(byModel.map((m) => m.model), ['mock-model']);
  // RFC 3339 with nanoseconds (`11:27:39.781837200+00:00`) parses to the ms.
  assert.equal(evs[0].ts, Date.parse('2026-09-29T11:27:39.781Z'));
  assert.equal(evs[0].usd, 0.0012345678);
  assert.equal(grokCost(evs, FROM, NOW, false).totalUsd, 0.001235);
});
