'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  installClaudeStatusLine,
  removeClaudeStatusLine,
  statusLineState,
  bridgePathFromCommand,
} = require('../src/core/setup/claude-bridge');
const { buildSnapshot, _resetHistoryMemoForTests } = require('../src/core/snapshot');
const { sanitizeSnapshot } = require('../src/renderer/dist/renderer/src/sanitize.js');

/**
 * The way back from the Claude setup (2026-09-25): "Bağlantıyı kaldır" in the
 * settings screen, and the uninstaller's --cleanup-integrations run. Nothing
 * of ours may be left in the user's Claude Code settings, and a status line of
 * their own that the setup kept must come back exactly as it was.
 */
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-disconnect-'));
  const bridgeDir = path.join(dir, 'bridge');
  fs.mkdirSync(bridgeDir);
  const bridge = path.join(bridgeDir, 'claude-statusline.mjs');
  fs.writeFileSync(bridge, '// bridge\n');
  return { dir, bridge, bridgeDir, settings: path.join(dir, 'settings.json') };
}
const backupsIn = (dir) => fs.readdirSync(dir).filter((f) => f.includes('usagenotch-backup'));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test.describe('removeClaudeStatusLine', () => {
  test('ours and nothing kept: the key goes, every other key stays, a backup is taken', () => {
    const s = sandbox();
    fs.writeFileSync(s.settings, JSON.stringify({ model: 'opus' }));
    assert.equal(installClaudeStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings }).ok, true);
    const before = backupsIn(s.dir).length;

    const res = removeClaudeStatusLine({ settingsPath: s.settings });
    assert.equal(res.code, 'REMOVED');
    assert.deepEqual(readJson(s.settings), { model: 'opus' });
    assert.equal(backupsIn(s.dir).length, before + 1);
    assert.equal(statusLineState(s.settings), 'none');
  });

  test('the user\'s own line, kept at setup, comes back exactly and the kept file goes', () => {
    const s = sandbox();
    const own = { type: 'command', command: 'bash ~/.claude/mine.sh', padding: 1 };
    fs.writeFileSync(s.settings, JSON.stringify({ statusLine: own, theme: 'dark' }));
    assert.equal(installClaudeStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings, chainExisting: true }).ok, true);
    assert.ok(fs.existsSync(path.join(s.bridgeDir, 'claude-chain.json')));

    const res = removeClaudeStatusLine({ settingsPath: s.settings });
    assert.equal(res.code, 'RESTORED');
    assert.deepEqual(readJson(s.settings), { statusLine: own, theme: 'dark' });
    assert.equal(fs.existsSync(path.join(s.bridgeDir, 'claude-chain.json')), false);
  });

  test('a line that is not ours, no line, no file and a broken file are all left exactly as found', () => {
    const s = sandbox();
    const foreign = JSON.stringify({ statusLine: { type: 'command', command: 'my-line' } });
    fs.writeFileSync(s.settings, foreign);
    assert.equal(removeClaudeStatusLine({ settingsPath: s.settings }).code, 'STATUSLINE_FOREIGN');
    assert.equal(fs.readFileSync(s.settings, 'utf8'), foreign);

    fs.writeFileSync(s.settings, '{"model":"x"}');
    assert.equal(removeClaudeStatusLine({ settingsPath: s.settings }).code, 'ALREADY_ABSENT');
    fs.writeFileSync(s.settings, '{ not json');
    assert.equal(removeClaudeStatusLine({ settingsPath: s.settings }).code, 'SETTINGS_INVALID');
    assert.equal(fs.readFileSync(s.settings, 'utf8'), '{ not json');
    assert.equal(removeClaudeStatusLine({ settingsPath: path.join(s.dir, 'nope.json') }).code, 'ALREADY_ABSENT');
    assert.deepEqual(backupsIn(s.dir), [], 'nothing was written, so nothing was backed up');
  });

  test('the bridge path is read back out of our own command', () => {
    assert.equal(bridgePathFromCommand('node "C:/Users/u/AppData/Roaming/usage-notch/bridge/claude-statusline.mjs"'),
      'C:/Users/u/AppData/Roaming/usage-notch/bridge/claude-statusline.mjs');
    assert.equal(bridgePathFromCommand('my-line'), null);
    assert.equal(bridgePathFromCommand(null), null);
  });
});

test.describe('the settings screen learns whether the hook is in', () => {
  test('buildSnapshot puts hookInstalled on Claude and Antigravity only, and only when main says', () => {
    _resetHistoryMemoForTests();
    const snap = buildSnapshot({ now: Date.now(), events: [], scanOk: true, hooks: { claude: true, antigravity: false, codex: true } });
    const by = Object.fromEntries(snap.providers.map((p) => [p.id, p.hookInstalled]));
    assert.equal(by.claude, true);
    assert.equal(by.antigravity, false);
    assert.equal(by.codex, undefined);
    _resetHistoryMemoForTests();
    const none = buildSnapshot({ now: Date.now(), events: [], scanOk: true });
    assert.equal(none.providers.find((p) => p.id === 'claude').hookInstalled, undefined);
  });

  test('the renderer keeps only a literal boolean', () => {
    _resetHistoryMemoForTests();
    const snap = buildSnapshot({ now: Date.now(), events: [], scanOk: true, hooks: { claude: true } });
    const claude = (s) => s.providers.find((p) => p.id === 'claude');
    assert.equal(claude(sanitizeSnapshot(snap)).hookInstalled, true);
    claude(snap).hookInstalled = false;
    assert.equal(claude(sanitizeSnapshot(snap)).hookInstalled, false);
    claude(snap).hookInstalled = 'yes';
    assert.equal(claude(sanitizeSnapshot(snap)).hookInstalled, undefined);
  });

  test('with the hook removed, "Bağla" comes back even while a figure is still shown', () => {
    _resetHistoryMemoForTests();
    const now = Date.now();
    const rl = {
      state: 'fresh', capturedAt: new Date(now - 60e3).toISOString(),
      fiveHour: { usedPercentage: 4, resetsAt: new Date(now + 3600e3).toISOString() },
      sevenDay: { usedPercentage: 67, resetsAt: new Date(now + 86400e3).toISOString() },
    };
    const claude = (s) => s.providers.find((p) => p.id === 'claude');
    const on = buildSnapshot({ now, events: [], scanOk: true, rateLimits: rl, hooks: { claude: true } });
    assert.equal(claude(on).setupAction, null, 'a connected hook offers no setup');
    _resetHistoryMemoForTests();
    const off = buildSnapshot({ now, events: [], scanOk: true, rateLimits: rl, hooks: { claude: false } });
    assert.equal(claude(off).setupAction?.kind, 'install-bridge');
    assert.equal(claude(off).hookInstalled, false);
  });
});

test.describe('the uninstaller takes the hooks out', () => {
  test('installer.nsh runs --cleanup-integrations only on a real uninstall, before the files go', () => {
    const nsh = read('build/installer.nsh');
    const macro = nsh.slice(nsh.indexOf('!macro customUnInstall'), nsh.indexOf('!macroend', nsh.indexOf('!macro customUnInstall')));
    const notUpdate = macro.indexOf('${ifNot} ${isUpdated}');
    const run = macro.indexOf('--cleanup-integrations');
    assert.ok(notUpdate >= 0 && run > notUpdate, 'inside the not-an-update branch');
    assert.match(macro, /nsExec::ExecToLog \/TIMEOUT=\d+/);
  });

  test('index.js handles the flag before the single-instance lock, and exits', () => {
    const index = read('src/main/index.js');
    const flag = index.indexOf("process.argv.includes('--cleanup-integrations')");
    assert.ok(flag > 0 && flag < index.indexOf('app.requestSingleInstanceLock()'));
    assert.match(index.slice(flag, flag + 200), /cleanupIntegrations\(\);\s*app\.exit\(0\);/);
  });
});
