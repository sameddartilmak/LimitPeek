'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { claudePlanFrom, codexPlanFrom, planFields } = require('../src/core/plan-detect');
const { claudeCodeAccount } = require('../src/core/claude-desktop');
const rollout = require('../src/core/codex/rollout');
const { buildSnapshot } = require('../src/core/snapshot');

/**
 * The plan a tool RECORDS for the account (owner, 2026-09-30): Claude Code's
 * tier in ~/.claude.json, Codex's plan_type in its rollouts. The user's own
 * choice in Settings still wins, and nothing computes from either.
 */

test.describe('Claude Code: the tier ~/.claude.json records', () => {
  test('the rate-limit tier names the Max size', () => {
    assert.equal(claudePlanFrom({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' }), 'Max 5x');
    assert.equal(claudePlanFrom({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
    assert.equal(claudePlanFrom({ userRateLimitTier: 'default_claude_max_20x', organizationRateLimitTier: 'default_claude_max_5x' }), 'Max 20x',
      'the user tier is read first');
  });

  test('without a size, the organization type', () => {
    assert.equal(claudePlanFrom({ organizationType: 'claude_pro' }), 'Pro');
    assert.equal(claudePlanFrom({ organizationType: 'claude_max' }), 'Max');
    assert.equal(claudePlanFrom({ organizationType: 'claude_team' }), 'Team');
    assert.equal(claudePlanFrom({ organizationType: 'claude_enterprise' }), 'Enterprise');
  });

  test('anything unrecognised is NOTHING, never the raw value', () => {
    for (const account of [null, {}, { organizationType: 'claude_future' }, { organizationRateLimitTier: 'default_claude_foo' }, { organizationType: 42 }]) {
      assert.equal(claudePlanFrom(account), null, JSON.stringify(account));
    }
  });

  test('read from the file with the organization id, and nothing else of it kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-plan-'));
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({
      oauthAccount: {
        organizationUuid: '11111111-2222-3333-4444-555555555555',
        organizationType: 'claude_max',
        organizationRateLimitTier: 'default_claude_max_5x',
        emailAddress: 'someone@example.com',
      },
      projects: { secret: true },
    }));
    assert.deepEqual(claudeCodeAccount(file), { org: '11111111-2222-3333-4444-555555555555', plan: 'Max 5x' });
  });
});

test.describe('Codex: the plan_type its rollout records', () => {
  test('known values map to the plan names the Settings list uses', () => {
    assert.equal(codexPlanFrom('plus'), 'Plus');
    assert.equal(codexPlanFrom('pro'), 'Pro');
    assert.equal(codexPlanFrom('team'), 'Business');
    assert.equal(codexPlanFrom('business'), 'Business');
    assert.equal(codexPlanFrom('enterprise'), 'Enterprise');
    assert.equal(codexPlanFrom(' PLUS '), 'Plus');
  });

  test('unknown or missing is nothing', () => {
    for (const v of [null, undefined, '', 'platinum', 7]) assert.equal(codexPlanFrom(v), null, String(v));
  });

  test('a latest record with plan_type:null still yields the newest plan the tail states', () => {
    rollout._resetRolloutCacheForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-plan-'));
    const file = path.join(dir, 'rollout-x.jsonl');
    const now = Date.parse('2026-09-30T08:00:00Z');
    const rec = (ts, planType) => JSON.stringify({
      timestamp: new Date(ts).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: {
          limit_id: 'codex', plan_type: planType,
          primary: { used_percent: 3, window_minutes: 300, resets_at: Math.floor((now + 3600e3) / 1000) },
          secondary: { used_percent: 21, window_minutes: 10080, resets_at: Math.floor((now + 3 * 86400e3) / 1000) },
        },
      },
    });
    fs.writeFileSync(file, [rec(now - 120e3, 'plus'), rec(now - 60e3, null)].join('\n') + '\n');
    const read = rollout.readCodexRateLimits({ file, now });
    assert.equal(read.planType, 'plus');
    assert.equal(read.fiveHour.usedPercentage, 3, 'the figures still come from the newest record');
  });
});

test.describe('which label a row shows', () => {
  test('the user\'s choice wins; the tool\'s value is kept beside it for Settings', () => {
    assert.deepEqual(planFields('Max 20x', 'Max 5x'), { planLabel: 'Max 20x', planSource: 'user', planDetected: 'Max 5x' });
  });

  test('with no choice, the tool\'s value, marked as the tool\'s', () => {
    assert.deepEqual(planFields(undefined, 'Max 5x'), { planLabel: 'Max 5x', planSource: 'tool', planDetected: 'Max 5x' });
  });

  test('neither: nothing at all', () => {
    assert.deepEqual(planFields(undefined, null), { planLabel: null, planSource: null, planDetected: null });
  });

  test('the snapshot applies it, and a detected plan moves no figure', () => {
    const base = { now: Date.parse('2026-09-08T12:00:00Z'), events: [], codexEvents: [] };
    const plain = buildSnapshot(base);
    const detected = buildSnapshot({ ...base, claudePlan: 'Max 5x', codexRateLimits: { state: 'missing', fiveHour: null, sevenDay: null, planType: 'plus' } });
    const claude = detected.providers.find((p) => p.id === 'claude');
    assert.equal(claude.planLabel, 'Max 5x');
    assert.equal(claude.planSource, 'tool');
    const codex = detected.providers.find((p) => p.id === 'codex');
    assert.equal(codex.planDetected, 'Plus');
    const strip = (snap) => JSON.stringify(snap.providers.map(({ planLabel, planSource, planDetected, ...rest }) => rest));
    assert.equal(strip(detected), strip(buildSnapshot({ ...base, codexRateLimits: { state: 'missing', fiveHour: null, sevenDay: null, planType: null } })));
    assert.equal(plain.providers.find((p) => p.id === 'claude').planSource, null);
  });
});
