'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installClaudeStatusLine, statusLineState } = require('../src/core/setup/claude-bridge');
const { installAntigravityStatusLine } = require('../src/core/setup/antigravity-bridge');
const messages = require('../src/core/setup/messages');
const { NOTICE_MAX } = messages;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-setup-'));
  const bridge = path.join(dir, 'claude-statusline.mjs');
  fs.writeFileSync(bridge, '// bridge\n');
  return { dir, bridge, settings: path.join(dir, 'settings.json') };
}

function backupsIn(dir) {
  return fs.readdirSync(dir).filter((f) => f.includes('usagenotch-backup'));
}

test('refuses without an explicit confirmation flag and writes nothing', () => {
  const s = sandbox();
  fs.writeFileSync(s.settings, JSON.stringify({ model: 'opus' }));
  const before = fs.readFileSync(s.settings, 'utf8');

  for (const confirmed of [undefined, false, 'true', 1, null]) {
    const res = installClaudeStatusLine({ confirmed, bridgePath: s.bridge, settingsPath: s.settings });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'NOT_CONFIRMED');
    assert.match(res.message, /Onay/);
  }
  assert.equal(fs.readFileSync(s.settings, 'utf8'), before);
  assert.deepEqual(backupsIn(s.dir), []);
});

test('refuses to clobber an existing statusLine and tells the user how to chain', () => {
  const s = sandbox();
  const existing = { statusLine: { type: 'command', command: 'my-own-statusline' } };
  fs.writeFileSync(s.settings, JSON.stringify(existing));

  const res = installClaudeStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'STATUSLINE_EXISTS');
  assert.match(res.message, /zincirleyin/);
  assert.match(res.message, /claude-statusline\.mjs/);
  // This notice measured 194 characters against the renderer's 160-character
  // cap with a real packaged bridge path, so the cut landed 34 characters
  // inside the command — handing the user something that looks runnable and
  // is not. The command is now the clause that survives the budget.
  assert.ok(res.message.length <= NOTICE_MAX, `${res.message.length} chars`);

  assert.deepEqual(JSON.parse(fs.readFileSync(s.settings, 'utf8')), existing, 'untouched');
  assert.deepEqual(backupsIn(s.dir), [], 'no backup, because nothing was going to be written');
});

test('installs into a settings file that has no statusLine, keeping every other key', () => {
  const s = sandbox();
  fs.writeFileSync(s.settings, JSON.stringify({ model: 'opus[1m]', theme: 'dark', permissions: { deny: ['Read(**/.env)'] } }));

  const res = installClaudeStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings });
  assert.equal(res.ok, true);

  const after = JSON.parse(fs.readFileSync(s.settings, 'utf8'));
  assert.equal(after.model, 'opus[1m]');
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.permissions, { deny: ['Read(**/.env)'] });
  assert.equal(after.statusLine.type, 'command');
  assert.match(after.statusLine.command, /^node "/);
  assert.match(after.statusLine.command, /claude-statusline\.mjs"$/);
  assert.equal(after.statusLine.command.includes('\\'), false, 'forward slashes so the quoted path survives a shell');
});

test('takes a timestamped backup before writing', () => {
  const s = sandbox();
  const original = JSON.stringify({ model: 'opus' });
  fs.writeFileSync(s.settings, original);

  installClaudeStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings, now: Date.parse('2026-09-08T12:00:00Z') });

  const backups = backupsIn(s.dir);
  assert.equal(backups.length, 1);
  assert.match(backups[0], /settings\.json\.usagenotch-backup-2026-09-08T12-00-00-000Z/);
  assert.equal(fs.readFileSync(path.join(s.dir, backups[0]), 'utf8'), original);
});

test('creates settings.json when there is none, with no backup', () => {
  const s = sandbox();
  const res = installClaudeStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings });
  assert.equal(res.ok, true);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(s.settings, 'utf8'))).length, 1);
  assert.deepEqual(backupsIn(s.dir), []);
});

test('never overwrites a settings file it could not parse', () => {
  const s = sandbox();
  const broken = '{ "model": "opus", oops';
  fs.writeFileSync(s.settings, broken);
  const res = installClaudeStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'SETTINGS_INVALID');
  assert.equal(fs.readFileSync(s.settings, 'utf8'), broken);
});

test('refuses when the bridge script is not on disk', () => {
  const s = sandbox();
  const res = installClaudeStatusLine({ confirmed: true, bridgePath: path.join(s.dir, 'gone.mjs'), settingsPath: s.settings });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_BRIDGE');
  assert.equal(fs.existsSync(s.settings), false);
});

test('leaves no temp file behind', () => {
  const s = sandbox();
  installClaudeStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings });
  assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.includes('.tmp')), []);
});

test.describe('statusLineState probe', () => {
  test('reports none / ours / foreign / no-settings', () => {
    const s = sandbox();
    assert.equal(statusLineState(s.settings), 'no-settings');

    fs.writeFileSync(s.settings, JSON.stringify({ model: 'opus' }));
    assert.equal(statusLineState(s.settings), 'none');

    fs.writeFileSync(s.settings, JSON.stringify({ statusLine: { command: 'ccusage blocks' } }));
    assert.equal(statusLineState(s.settings), 'foreign');

    fs.writeFileSync(s.settings, JSON.stringify({ statusLine: { command: 'node "C:/x/claude-statusline.mjs"' } }));
    assert.equal(statusLineState(s.settings), 'ours');

    fs.writeFileSync(s.settings, 'nope');
    assert.equal(statusLineState(s.settings), 'invalid');
  });
});

test('the installer never reads the credentials file', () => {
  // Guard against a regression that reaches for the OAuth token to find a plan
  // label. ADR-001 security F1 is a CRITICAL veto on that path.
  const sources = [
    'src/core/setup/claude-bridge.js',
    'src/core/paths.js',
    'src/core/snapshot.js',
    'src/core/collector.js',
    'src/core/ratelimits.js',
    'src/main/bridge-install.js',
    'src/main/index.js',
    'src/main/settings.js',
  ];
  for (const rel of sources) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const forbidden of ['.credentials.json', 'accessToken', 'refreshToken', 'claudeAiOauth']) {
      // The word appears in prose in paths.js explaining why it is absent;
      // what must never appear is a use of it in code.
      const inCode = text
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
      assert.equal(inCode.includes(forbidden), false, `${rel} references ${forbidden}`);
    }
  }
});

test('aborts if the settings file changed between our read and our write', () => {
  // Claude Code owns settings.json too. Simulate it rewriting the file inside
  // our read-modify-write window by hooking the pre-rename stat.
  const s = sandbox();
  fs.writeFileSync(s.settings, JSON.stringify({ model: 'opus' }));

  const realStatSync = fs.statSync;
  let calls = 0;
  fs.statSync = function patched(...args) {
    const st = realStatSync.apply(fs, args);
    // First call is our read stamp; the second is the pre-rename re-check.
    if (String(args[0]) === s.settings && ++calls === 2) {
      return { ...st, size: st.size + 1, mtimeMs: st.mtimeMs + 1000 };
    }
    return st;
  };
  try {
    const res = installClaudeStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SETTINGS_CHANGED');
    assert.deepEqual(JSON.parse(fs.readFileSync(s.settings, 'utf8')), { model: 'opus' }, 'their write survives');
  } finally {
    fs.statSync = realStatSync;
  }
});


/* ---------------------------------------------------------- notice budget */

test.describe('every setup notice fits the renderer cap', () => {
  /**
   * A user pressed a connect button and read a sentence that stopped
   * mid-word. `trimMessage` in the renderer caps a notice at 160 characters
   * and appends an ellipsis, and in both providers the clause that overflowed
   * was the instruction — the chaining command they had to copy.
   *
   * This suite exists so the third instance is found here rather than by a
   * user. It drives every installer branch reachable without stubbing the
   * filesystem, and measures the result.
   */

  /** The shape of a real packaged bridge path, which is what overflowed. */
  const REAL_CLAUDE = 'node "C:/Users/user1/AppData/Roaming/usage-notch/bridge/claude-statusline.mjs"';
  const REAL_AGY = 'node "C:/Users/user1/AppData/Roaming/usage-notch/bridge/antigravity-statusline.mjs"';

  function claudeBox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-notice-'));
    const bridge = path.join(dir, 'claude-statusline.mjs');
    fs.writeFileSync(bridge, '// bridge\n');
    return { dir, bridge, settings: path.join(dir, 'settings.json') };
  }

  function agyBox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-notice-a-'));
    const bridge = path.join(dir, 'antigravity-statusline.mjs');
    fs.writeFileSync(bridge, '// bridge\n');
    const home = path.join(dir, 'antigravity-cli');
    fs.mkdirSync(home);
    return { dir, bridge, home, settings: path.join(home, 'settings.json') };
  }

  /** Every installer outcome reachable without stubbing `fs`. */
  function everyNotice() {
    const out = [];
    const add = (branch, res) => { if (res && res.message) out.push({ branch, message: res.message }); };

    let c = claudeBox();
    add('claude/not-confirmed', installClaudeStatusLine({ confirmed: false, bridgePath: c.bridge, settingsPath: c.settings }));
    c = claudeBox();
    add('claude/no-bridge', installClaudeStatusLine({ confirmed: true, bridgePath: path.join(c.dir, 'gone.mjs'), settingsPath: c.settings }));
    c = claudeBox();
    fs.writeFileSync(c.settings, '{ oops');
    add('claude/settings-invalid', installClaudeStatusLine({ confirmed: true, bridgePath: c.bridge, settingsPath: c.settings }));
    c = claudeBox();
    fs.writeFileSync(c.settings, JSON.stringify([1, 2]));
    add('claude/settings-not-object', installClaudeStatusLine({ confirmed: true, bridgePath: c.bridge, settingsPath: c.settings }));
    c = claudeBox();
    fs.writeFileSync(c.settings, JSON.stringify({ statusLine: { command: 'theirs' } }));
    add('claude/statusline-exists', installClaudeStatusLine({ confirmed: true, bridgePath: c.bridge, settingsPath: c.settings }));
    c = claudeBox();
    add('claude/installed', installClaudeStatusLine({ confirmed: true, bridgePath: c.bridge, settingsPath: c.settings }));

    let a = agyBox();
    add('agy/not-confirmed', installAntigravityStatusLine({ confirmed: false, bridgePath: a.bridge, settingsPath: a.settings, homeDir: a.home }));
    a = agyBox();
    fs.rmSync(a.home, { recursive: true });
    add('agy/cli-not-found', installAntigravityStatusLine({ confirmed: true, bridgePath: a.bridge, settingsPath: a.settings, homeDir: a.home }));
    a = agyBox();
    fs.writeFileSync(a.settings, '{ oops');
    add('agy/settings-invalid', installAntigravityStatusLine({ confirmed: true, bridgePath: a.bridge, settingsPath: a.settings, homeDir: a.home }));
    a = agyBox();
    fs.writeFileSync(a.settings, JSON.stringify({ statusLine: { command: 'theirs' } }));
    add('agy/statusline-exists', installAntigravityStatusLine({ confirmed: true, bridgePath: a.bridge, settingsPath: a.settings, homeDir: a.home }));
    a = agyBox();
    add('agy/installed', installAntigravityStatusLine({ confirmed: true, bridgePath: a.bridge, settingsPath: a.settings, homeDir: a.home }));

    // Built with a REAL packaged path rather than a temp one. The sandbox
    // paths are shorter than production's, which is how this defect survived
    // a suite that only ever measured sandbox output.
    out.push({ branch: 'claude/statusline-exists (packaged path)', message: messages.statusLineExists(REAL_CLAUDE) });
    out.push({ branch: 'agy/statusline-exists (packaged path)', message: messages.statusLineExists(REAL_AGY) });
    return out;
  }

  test('no installer branch produces a notice the renderer would cut', () => {
    const notices = everyNotice();
    assert.ok(notices.length >= 13, `only ${notices.length} branches exercised; the walk is wrong`);
    const over = notices.filter((n) => n.message.length > NOTICE_MAX)
      .map((n) => `${n.branch}: ${n.message.length} chars`);
    assert.deepEqual(over, []);
  });

  test('and none of them is empty, which the ladder could otherwise produce', () => {
    for (const n of everyNotice()) {
      assert.ok(n.message.length > 0, n.branch);
      assert.equal(n.message.endsWith('…'), false, `${n.branch} looks pre-truncated`);
    }
  });

  test('no fixed sentence in the setup lane is over budget on its own', () => {
    // Catches a future long literal that no branch above happens to reach —
    // including the two `runSetup` paths in `main/bridge-install.js`, which
    // need an Electron stub to drive and have none yet.
    const files = [
      'src/core/setup/claude-bridge.js',
      'src/core/setup/antigravity-bridge.js',
      'src/core/setup/messages.js',
      'src/main/bridge-install.js',
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      // Line by line, so a quote that opens on one line and closes on another
      // is never mistaken for one very long sentence.
      for (const line of src.split('\n')) {
        for (const m of line.matchAll(/'([^']{40,})'/g)) {
          // Turkish prose only; identifiers, paths and SQL are not notices.
          if (!/[şğıçöüŞĞİÇÖÜ]/.test(m[1])) continue;
          assert.ok(m[1].length <= NOTICE_MAX, `${rel}: ${m[1].length} chars: ${m[1].slice(0, 60)}…`);
        }
      }
    }
  });
});
