'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

/**
 * The Antigravity IDE contract fields, at the renderer's gate:
 * `absence`, `provenance`, `source` and `modelQuotas`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * All four reached `src/shared/contract.ts` and were dropped on the floor by
 * `src/renderer/src/sanitize.ts`, which built `WindowUsage` from a fixed field
 * list. The core lane's reader was correct, the contract was correct, the
 * panel was ready — and the feature was inert end to end because one validator
 * silently omitted four keys. Nothing failed; the data simply never arrived.
 * A passthrough with no test is a passthrough that can be lost again in one
 * refactor, so every field is pinned here.
 *
 * Each fallback is pinned in its DIRECTION as well as its value. For all four
 * of these there is a wrong answer that makes the panel look more certain than
 * the payload justified, which is the one failure mode ADR-001 exists to
 * prevent, so "it degrades" is not enough — it has to degrade downward.
 *
 * Loaded from the TypeScript source, like `sanitize.test.js`: its imports are
 * type-only, so stripping leaves a standalone module and a stale `dist/`
 * cannot make these pass.
 */
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'renderer', 'src', 'sanitize.ts');

let s;
test.before(async () => {
  const js = stripTypeScriptTypes(fs.readFileSync(SOURCE, 'utf8'), { mode: 'strip' });
  s = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
});

function snapshotWith(patch) {
  return {
    generatedAt: '2026-09-08T15:00:00.000Z',
    providers: [{
      id: 'antigravity',
      displayName: 'Antigravity',
      accent: '#E8B84B',
      connected: true,
      status: 'ok',
      planLabel: null,
      fiveHour: null,
      sevenDay: null,
      tokens: null,
      burnRatePerHour: null,
      setupAction: null,
      ...patch,
    }],
  };
}
const rowOf = (patch) => s.sanitizeSnapshot(snapshotWith(patch)).providers[0];

const KNOWN_5H = {
  usedPercentage: 62,
  certainty: 'known',
  resetsAt: '2026-09-08T20:00:00.000Z',
  capturedAt: '2026-09-08T15:00:00.000Z',
};

// ------------------------------------------------------------------ absence

test.describe('absence: why there is no figure, as a closed set', () => {
  test('every value the contract defines survives the gate', () => {
    for (const absence of ['no-capture', 'not-supplied', 'stale', 'rolled-over', 'unreadable']) {
      const row = rowOf({
        sevenDay: { usedPercentage: null, certainty: 'unknown', resetsAt: null, absence },
      });
      assert.equal(row.sevenDay.absence, absence);
    }
  });

  test('an unrecognised reason falls back to the one that asserts least', () => {
    // Deliberately NOT 'not-supplied'. That value asserts "this tool does not
    // publish this limit" — a claim the user can disprove by opening the tool,
    // which is the exact failure it was added to prevent. 'no-capture' maps to
    // today's "bilinmiyor" and claims nothing.
    for (const bad of ['made-up', '', null, 42, {}, undefined, 'NOT-SUPPLIED']) {
      const row = rowOf({
        sevenDay: { usedPercentage: null, certainty: 'unknown', resetsAt: null, absence: bad },
      });
      assert.equal(row.sevenDay.absence, 'no-capture', JSON.stringify(bad));
    }
  });

  test('a window that HAS a figure carries no reason for not having one', () => {
    // The contract's invariant, enforced rather than trusted: a window holding
    // both a percentage and a reason it has none is a contradiction, and the
    // renderer would have to pick one of the two to believe.
    const row = rowOf({ fiveHour: { ...KNOWN_5H, absence: 'not-supplied' } });
    assert.equal(row.fiveHour.usedPercentage, 62);
    assert.equal(row.fiveHour.absence, undefined);
  });

  test('a figure THIS validator rejected reads unreadable, not as main described it', () => {
    // main believed it had a number, so whatever it said about an absence
    // describes a different situation than "we threw your value away".
    const row = rowOf({
      fiveHour: { usedPercentage: 250, certainty: 'known', resetsAt: null, absence: 'not-supplied' },
    });
    assert.equal(row.fiveHour.usedPercentage, null);
    assert.equal(row.fiveHour.certainty, 'unknown');
    assert.equal(row.fiveHour.absence, 'unreadable');
  });

  test('certainty unknown with a percentage still yields a stated absence', () => {
    const row = rowOf({
      sevenDay: { usedPercentage: 40, certainty: 'unknown', resetsAt: null, absence: 'stale' },
    });
    assert.equal(row.sevenDay.usedPercentage, null);
    assert.equal(row.sevenDay.absence, 'stale');
  });
});

// ------------------------------------------------- provenance and source

test.describe('provenance and source travel with the figure', () => {
  test('a documented figure keeps both', () => {
    const row = rowOf({
      fiveHour: {
        ...KNOWN_5H,
        provenance: 'documented',
        source: 'claude.rate_limits.used_percentage',
      },
    });
    assert.equal(row.fiveHour.provenance, 'documented');
    assert.equal(row.fiveHour.source, 'claude.rate_limits.used_percentage');
  });

  test('an unrecognised provenance degrades to derived, never to documented', () => {
    // 'documented' is a claim that a published interface stands behind the
    // number. A malformed producer must make a figure look LESS trustworthy.
    for (const bad of ['documented ', 'official', true, null, undefined, 1, {}]) {
      const row = rowOf({ fiveHour: { ...KNOWN_5H, provenance: bad } });
      assert.equal(row.fiveHour.provenance, 'derived', JSON.stringify(bad));
    }
  });

  test('all three real sources pass', () => {
    const sources = [
      'claude.rate_limits.used_percentage',
      'antigravity.cli.quota.remaining_fraction',
      'antigravity.ide.quota_info.remaining_fraction',
    ];
    for (const src of sources) {
      assert.equal(rowOf({ fiveHour: { ...KNOWN_5H, source: src } }).fiveHour.source, src);
    }
  });

  test('an unrecognised source is dropped rather than passed through', () => {
    // It names a wire field, so it must never be able to carry file content
    // to a surface that prints it.
    for (const bad of ['some.other.field', '<script>alert(1)</script>', 7, {}, null]) {
      assert.equal(
        rowOf({ fiveHour: { ...KNOWN_5H, source: bad } }).fiveHour.source,
        null,
        JSON.stringify(bad),
      );
    }
  });
});

// -------------------------------------------------------------- modelQuotas

const GROUP_A = {
  usedPercentage: 60,
  resetsAt: '2026-09-08T20:00:00.000Z',
  members: ['Claude Opus 4.6 (Thinking)', 'Claude Sonnet 4.6 (Thinking)', 'GPT-OSS 120B (Medium)'],
};
const GROUP_B = {
  usedPercentage: 0,
  resetsAt: '2026-09-09T02:00:00.000Z',
  members: ['Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (Low)'],
};
const QUOTAS = {
  groups: [GROUP_A, GROUP_B],
  diverged: true,
  source: 'antigravity.ide.quota_info.remaining_fraction',
  provenance: 'derived',
  capturedAt: '2026-09-08T15:00:00.000Z',
};
const quotasOf = (patch) => rowOf({ modelQuotas: { ...QUOTAS, ...patch } }).modelQuotas;

test.describe('modelQuotas passes through with its order and its flags', () => {
  test('the live shape survives intact', () => {
    const q = quotasOf({});
    assert.equal(q.groups.length, 2);
    assert.equal(q.groups[0].usedPercentage, 60);
    assert.equal(q.diverged, true);
    assert.equal(q.provenance, 'derived');
    assert.equal(q.source, 'antigravity.ide.quota_info.remaining_fraction');
    assert.equal(q.capturedAt, '2026-09-08T15:00:00.000Z');
    assert.deepEqual(q.groups[0].members, GROUP_A.members);
  });

  test('group order is preserved, never re-sorted', () => {
    // Most consumed first is main's ordering, and the renderer renders it as
    // given — the same rule Snapshot.providers already states.
    assert.deepEqual(quotasOf({}).groups.map((g) => g.usedPercentage), [60, 0]);
  });

  test('a provider that reports no model detail simply has none', () => {
    assert.equal(rowOf({}).modelQuotas, null);
    assert.equal(rowOf({ modelQuotas: null }).modelQuotas, null);
    assert.equal(rowOf({ modelQuotas: 'çok' }).modelQuotas, null);
  });

  test('no shape here can pair one model name with one percentage', () => {
    // The contract makes that string unconstructible on purpose: it would sit
    // beneath the user's real Claude Code row and read as a claim about their
    // Claude quota. The validator must not reintroduce it.
    for (const group of quotasOf({}).groups) {
      for (const member of group.members) assert.equal(typeof member, 'string');
      assert.equal(Object.keys(group).sort().join(','), 'members,resetsAt,usedPercentage');
    }
  });
});

test.describe('modelQuotas is untrusted text from a foreign process', () => {
  test('bidi overrides and control characters are stripped from model names', () => {
    // Written as escapes, never as literal characters: an invisible U+202E in
    // a test file is one editor away from being silently deleted, and the test
    // would then pass by asserting the absence of something never present.
    const RLO = '‮';
    const NUL = '\u0000';
    const ZWSP = '\u200b';
    const q = quotasOf({
      groups: [{ ...GROUP_A, members: ['Cla' + RLO + 'ude Opus' + NUL + ' 4.6', 'Nor' + ZWSP + 'mal'] }],
    });
    const first = q.groups[0].members[0];
    // U+202E reverses everything after it, so one name could rewrite the row
    // drawn around it. The guard only means anything if the name still arrived.
    assert.ok(first.startsWith('Cla'), JSON.stringify(first));
    assert.ok(first.indexOf('Opus') > 0, JSON.stringify(first));
    assert.equal(first.indexOf(RLO), -1, JSON.stringify(first));
    assert.equal(first.indexOf(NUL), -1, JSON.stringify(first));
    assert.equal(q.groups[0].members[1], 'Normal');
  });

  test('a model name is bounded at 64 characters', () => {
    const q = quotasOf({ groups: [{ ...GROUP_A, members: ['M'.repeat(500)] }] });
    assert.ok(q.groups[0].members[0].length <= 64, q.groups[0].members[0].length);
    assert.ok(q.groups[0].members[0].endsWith('…'));
  });

  test('the member list is capped at twelve', () => {
    const many = Array.from({ length: 90 }, (_, i) => 'Model ' + i);
    assert.equal(quotasOf({ groups: [{ ...GROUP_A, members: many }] }).groups[0].members.length, 12);
  });

  test('the group list is capped at eight', () => {
    const many = Array.from({ length: 40 }, () => GROUP_A);
    assert.equal(quotasOf({ groups: many }).groups.length, 8);
  });

  test('non-string members are dropped, not stringified', () => {
    const q = quotasOf({ groups: [{ ...GROUP_A, members: [null, 5, {}, 'Gerçek model'] }] });
    assert.deepEqual(q.groups[0].members, ['Gerçek model']);
  });
});

test.describe('a malformed group is dropped, never repaired into a number', () => {
  test('a group with no usable figure is dropped rather than zeroed', () => {
    // "%0 kullanıldı" is the most optimistic reading there is. Manufacturing
    // it under a list of real model names would be a fabricated claim in the
    // one direction this product refuses to err.
    for (const bad of [null, 'çok', NaN, -1, 101, undefined]) {
      const q = quotasOf({ groups: [{ ...GROUP_A, usedPercentage: bad }, GROUP_B] });
      assert.equal(q.groups.length, 1, JSON.stringify(bad));
      assert.equal(q.groups[0].usedPercentage, 0, JSON.stringify(bad));
    }
  });

  test('zero and one hundred are real readings and survive', () => {
    assert.equal(quotasOf({ groups: [{ ...GROUP_A, usedPercentage: 0 }] }).groups[0].usedPercentage, 0);
    assert.equal(
      quotasOf({ groups: [{ ...GROUP_A, usedPercentage: 100 }] }).groups[0].usedPercentage,
      100,
    );
  });

  test('a figure attributed to nobody is not this shape', () => {
    const q = quotasOf({ groups: [{ ...GROUP_A, members: [] }, GROUP_B] });
    assert.equal(q.groups.length, 1);
    assert.equal(q.groups[0].usedPercentage, 0);
  });

  test('an unparseable reset instant keeps the figure and drops the instant', () => {
    const q = quotasOf({ groups: [{ ...GROUP_A, resetsAt: 'yarın' }] });
    assert.equal(q.groups[0].usedPercentage, 60);
    assert.equal(q.groups[0].resetsAt, null);
  });

  test('the whole block goes when nothing in it survives', () => {
    assert.equal(quotasOf({ groups: [{ usedPercentage: null, members: [] }] }), null);
    assert.equal(quotasOf({ groups: [] }), null);
    assert.equal(quotasOf({ groups: 'çok' }), null);
  });
});

test.describe('the flags a renderer would otherwise have to infer', () => {
  test('diverged is a strict boolean and defaults to the quieter answer', () => {
    // The renderer may not compare two percentages to decide whether they
    // differ — that is arithmetic on usage data. An absent flag must collapse
    // the row to one figure rather than have it claim a spread nobody reported.
    for (const bad of [undefined, null, 'true', 1, {}]) {
      assert.equal(quotasOf({ diverged: bad }).diverged, false, JSON.stringify(bad));
    }
  });

  test('one surviving group cannot be diverged from anything', () => {
    // main's flag described a set this validator no longer holds: the second
    // group was dropped as malformed. Carrying the flag would announce a
    // spread with a single number on screen.
    const q = quotasOf({ groups: [GROUP_A, { ...GROUP_B, members: [] }], diverged: true });
    assert.equal(q.groups.length, 1);
    assert.equal(q.diverged, false);
  });

  test('a block with no capture instant is dropped whole', () => {
    // A set of figures with no instant they were true at is not something this
    // app prints, and there is no other field here to fall back on.
    assert.equal(quotasOf({ capturedAt: null }), null);
    assert.equal(quotasOf({ capturedAt: 'dün' }), null);
    assert.equal(quotasOf({ capturedAt: undefined }), null);
  });

  test('a block naming an unrecognised source is dropped whole', () => {
    assert.equal(quotasOf({ source: 'antigravity.ide.something_else' }), null);
    assert.equal(quotasOf({ source: undefined }), null);
  });

  test('an unrecognised provenance degrades to derived here too', () => {
    assert.equal(quotasOf({ provenance: 'documented' }).provenance, 'documented');
    assert.equal(quotasOf({ provenance: 'official' }).provenance, 'derived');
    assert.equal(quotasOf({ provenance: undefined }).provenance, 'derived');
  });
});

// ------------------------------------------------- selected model marker

test.describe('the selected model, validated against the SANITISED groups', () => {
  test('a valid selection passes through with its group index', () => {
    const q = quotasOf({
      selectedModel: 'Claude Opus 4.6 (Thinking)',
      selectedGroupIndex: 0,
    });
    assert.equal(q.selectedModel, 'Claude Opus 4.6 (Thinking)');
    assert.equal(q.selectedGroupIndex, 0);
  });

  test('no selection reads as null on both fields', () => {
    for (const bad of [null, undefined, '', 42, {}]) {
      const q = quotasOf({ selectedModel: bad, selectedGroupIndex: 0 });
      assert.equal(q.selectedModel, null, JSON.stringify(bad));
      assert.equal(q.selectedGroupIndex, null, JSON.stringify(bad));
    }
  });

  test('a selection main placed in the WRONG group is not carried', () => {
    // The name is real and in group 0, but main said group 1. Trusting the
    // index would mark a member of the Gemini group as the selection — a false
    // statement about the figure beside it. Keep the name, drop the index.
    const q = quotasOf({ selectedModel: 'Claude Opus 4.6 (Thinking)', selectedGroupIndex: 1 });
    assert.equal(q.selectedModel, 'Claude Opus 4.6 (Thinking)');
    assert.equal(q.selectedGroupIndex, null);
  });

  test('an out-of-range index is dropped, the name kept', () => {
    for (const idx of [-1, 2, 99, 1.5, NaN, '0', null]) {
      const q = quotasOf({ selectedModel: 'GPT-OSS 120B (Medium)', selectedGroupIndex: idx });
      assert.equal(q.selectedModel, 'GPT-OSS 120B (Medium)', JSON.stringify(idx));
      // Only index 0 legitimately contains it; everything else is unplaceable.
      if (idx !== 0) assert.equal(q.selectedGroupIndex, null, JSON.stringify(idx));
    }
  });

  test('a selected member truncated out of the group is unplaceable', () => {
    // 13 members: the sanitiser caps at 12, so the 13th is dropped. If the
    // selection was that member, the index cannot point at it truthfully.
    const many = Array.from({ length: 13 }, (_, i) => 'Model ' + i);
    const q = quotasOf({
      groups: [{ ...GROUP_A, members: many }],
      selectedModel: 'Model 12',
      selectedGroupIndex: 0,
    });
    assert.equal(q.groups[0].members.length, 12);
    assert.equal(q.selectedModel, 'Model 12');
    assert.equal(q.selectedGroupIndex, null);
  });

  test('the selected name gets the same text() treatment as the members', () => {
    // Control/bidi stripping and the 64-cap apply identically, so a name that
    // survives as a member also matches as the selection.
    const q = quotasOf({
      groups: [{ ...GROUP_A, members: ['Nor\u200Bmal Model', 'Other'] }],
      selectedModel: 'Nor\u200Bmal Model',
      selectedGroupIndex: 0,
    });
    assert.deepEqual(q.groups[0].members[0], 'Normal Model');
    assert.equal(q.selectedModel, 'Normal Model');
    assert.equal(q.selectedGroupIndex, 0);
  });
});

// ---------------------------------------------------- refresh notices

const refreshOf = (notices) =>
  s.sanitizeSnapshot({
    generatedAt: '2026-09-08T15:00:00.000Z',
    providers: [],
    refreshNotices: notices,
  }).refreshNotices;

test.describe('refreshNotices: a closed set, present only when non-empty', () => {
  test('the one known notice passes', () => {
    assert.deepEqual(refreshOf(['ANTIGRAVITY_NOT_RUNNING']), ['ANTIGRAVITY_NOT_RUNNING']);
  });

  test('unknown values are dropped, so a bubble never renders with no copy', () => {
    assert.equal(refreshOf(['SOMETHING_ELSE']), undefined);
    assert.equal(refreshOf([42, null, {}, 'nope']), undefined);
  });

  test('a mixed array keeps only what is recognised', () => {
    assert.deepEqual(
      refreshOf(['x', 'ANTIGRAVITY_NOT_RUNNING', 7]),
      ['ANTIGRAVITY_NOT_RUNNING'],
    );
  });

  test('absent or non-array leaves the field off entirely', () => {
    assert.equal(refreshOf(undefined), undefined);
    assert.equal(refreshOf('ANTIGRAVITY_NOT_RUNNING'), undefined);
    assert.equal(refreshOf([]), undefined);
  });

  test('a normal snapshot never invents the field', () => {
    const out = s.sanitizeSnapshot({ generatedAt: '2026-09-08T15:00:00.000Z', providers: [] });
    assert.equal('refreshNotices' in out, false);
  });
});
