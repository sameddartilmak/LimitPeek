'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  installAgy, isAgyInstalled, powershellPath, INSTALL_URL,
} = require('../src/core/antigravity/cli-install');
const {
  removeAntigravityStatusLine, installAntigravityStatusLine, cliInstalled,
} = require('../src/core/setup/antigravity-bridge');

/**
 * The one-click `agy` install, and the reversible disconnect that partners it.
 *
 * The download-and-run is the single network operation in this whole app, so
 * these tests hold its shape tightly: what command it runs, how it decides
 * success, and that every failure lands somewhere safe. None of them touches
 * the network — `installAgy` takes an `exec` seam, and every case drives it.
 */

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-agyinstall-'));
}

/* -------------------------------------------------- the download-and-run */

test.describe('installAgy: the one network operation, held tightly', () => {
  test('runs PowerShell by absolute path with an argument array and no shell', async () => {
    const dir = tmpdir();
    const binary = path.join(dir, 'agy.exe');
    let seen = null;
    await installAgy({
      binaryPath: binary,
      exec: (file, args, opts, cb) => { seen = { file, args, opts }; cb(null, '', ''); },
    });
    assert.match(seen.file, /^[A-Za-z]:\\/, 'absolute path');
    assert.match(seen.file, /powershell\.exe$/i);
    assert.equal(seen.file, powershellPath());
    assert.ok(Array.isArray(seen.args), 'arguments are a list, not a command string');
    assert.ok(seen.args.includes('-NoProfile'));
    assert.ok(seen.args.includes('-NonInteractive'));
    assert.ok(seen.opts.windowsHide, true);
    assert.ok(seen.opts.timeout > 0, 'an installer that can hang is a setup that can hang');
  });

  test('the URL it runs is the hard-coded vendor HTTPS constant', async () => {
    const dir = tmpdir();
    let cmd = null;
    await installAgy({
      binaryPath: path.join(dir, 'agy.exe'),
      exec: (file, args, opts, cb) => { cmd = args[args.length - 1]; cb(null, '', ''); },
    });
    assert.equal(INSTALL_URL, 'https://antigravity.google/cli/install.ps1');
    assert.match(INSTALL_URL, /^https:\/\//, 'never plain http');
    assert.ok(cmd.includes(INSTALL_URL), 'the command runs exactly that URL');
    assert.ok(cmd.includes('irm') && cmd.includes('iex'), 'the vendor one-liner');
    // Nothing user-derived is anywhere in the command.
    assert.equal(cmd, `irm ${INSTALL_URL} | iex`);
  });

  test('success is defined by the binary existing, not by the exit code', async () => {
    const dir = tmpdir();
    const binary = path.join(dir, 'agy.exe');
    // The installer "succeeds" by dropping the binary; simulate that in the cb.
    const res = await installAgy({
      binaryPath: binary,
      exec: (file, args, opts, cb) => { fs.writeFileSync(binary, 'MZ'); cb(null, 'done', ''); },
    });
    assert.deepEqual(res, { ok: true, code: 'installed' });
  });

  test('a non-zero exit that STILL installed the binary is a success', async () => {
    const dir = tmpdir();
    const binary = path.join(dir, 'agy.exe');
    const res = await installAgy({
      binaryPath: binary,
      exec: (file, args, opts, cb) => {
        fs.writeFileSync(binary, 'MZ');
        cb(Object.assign(new Error('warned'), { code: 1 }), '', 'a warning');
      },
    });
    assert.equal(res.ok, true, 'the binary is what matters, not the warning');
  });

  test('an error with no binary is run-failed, and leaks no message', async () => {
    const dir = tmpdir();
    const res = await installAgy({
      binaryPath: path.join(dir, 'agy.exe'),
      exec: (file, args, opts, cb) => cb(Object.assign(new Error('C:/secret/path failed'), { code: 'ETIMEDOUT' })),
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'run-failed');
    assert.equal(res.detail, 'ETIMEDOUT', 'the error CODE, never its message');
    assert.equal(JSON.stringify(res).includes('secret'), false);
  });

  test('a clean run that left no binary is no-binary, not a false success', async () => {
    const dir = tmpdir();
    const res = await installAgy({
      binaryPath: path.join(dir, 'agy.exe'),
      exec: (file, args, opts, cb) => cb(null, 'pretended', ''),
    });
    assert.deepEqual(res, { ok: false, code: 'no-binary' });
  });

  test('idempotent: an already-present binary is never reinstalled', async () => {
    const dir = tmpdir();
    const binary = path.join(dir, 'agy.exe');
    fs.writeFileSync(binary, 'MZ');
    let called = false;
    const res = await installAgy({ binaryPath: binary, exec: () => { called = true; } });
    assert.equal(res.code, 'already');
    assert.equal(called, false, 'the installer must not run over an existing binary');
  });

  test('a spawn that throws outright is caught, not propagated', async () => {
    const dir = tmpdir();
    const res = await installAgy({
      binaryPath: path.join(dir, 'agy.exe'),
      exec: () => { throw new Error('spawn refused'); },
    });
    assert.deepEqual(res, { ok: false, code: 'run-failed', detail: 'SPAWN' });
  });

  test('it never rejects, whatever the exec does', async () => {
    const dir = tmpdir();
    await assert.doesNotReject(() => installAgy({
      binaryPath: path.join(dir, 'agy.exe'),
      exec: (file, args, opts, cb) => cb(new Error('x')),
    }));
  });

  test('isAgyInstalled is a plain file check', () => {
    const dir = tmpdir();
    const binary = path.join(dir, 'agy.exe');
    assert.equal(isAgyInstalled(binary), false);
    fs.writeFileSync(binary, 'MZ');
    assert.equal(isAgyInstalled(binary), true);
  });
});

/* --------------------------------------------------- the way back: remove */

test.describe('removeAntigravityStatusLine: the reversible half', () => {
  function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-agyrm-'));
    const bridge = path.join(dir, 'antigravity-statusline.mjs');
    fs.writeFileSync(bridge, '// bridge\n');
    // A config dir so installAntigravityStatusLine writes a real "ours" hook.
    const home = path.join(dir, 'antigravity-cli');
    fs.mkdirSync(home);
    return { dir, bridge, home, binary: path.join(dir, 'no-agy', 'agy.exe'), settings: path.join(home, 'settings.json') };
  }
  const backups = (dir) => fs.readdirSync(dir).filter((f) => f.includes('usagenotch-backup'));

  test('a full round-trip: install the hook, then remove it', () => {
    const s = sandbox();
    fs.writeFileSync(s.settings, JSON.stringify({ theme: 'dark' }));
    const put = installAntigravityStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings, homeDir: s.home, binaryPath: s.binary });
    assert.equal(put.ok, true);
    assert.ok(JSON.parse(fs.readFileSync(s.settings, 'utf8')).statusLine, 'hook is in');

    const gone = removeAntigravityStatusLine({ settingsPath: s.settings });
    assert.equal(gone.ok, true);
    assert.equal(gone.code, 'REMOVED');
    const after = JSON.parse(fs.readFileSync(s.settings, 'utf8'));
    assert.equal(after.statusLine, undefined, 'hook is out');
    assert.equal(after.theme, 'dark', 'and every other key survived');
  });

  test('it backs up before removing, like the install path', () => {
    const s = sandbox();
    installAntigravityStatusLine({ confirmed: true, bridgePath: s.bridge, settingsPath: s.settings, homeDir: s.home, binaryPath: s.binary });
    const before = backups(s.home).length;
    removeAntigravityStatusLine({ settingsPath: s.settings });
    assert.equal(backups(s.home).length, before + 1, 'a timestamped backup is taken');
  });

  test('it refuses to remove a statusLine that is not ours', () => {
    const s = sandbox();
    fs.writeFileSync(s.settings, JSON.stringify({ statusLine: { type: 'command', command: 'my-own.sh' } }));
    const res = removeAntigravityStatusLine({ settingsPath: s.settings });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'STATUSLINE_FOREIGN');
    assert.deepEqual(JSON.parse(fs.readFileSync(s.settings, 'utf8')).statusLine, { type: 'command', command: 'my-own.sh' }, 'untouched');
  });

  test('no statusLine at all is already-absent, not an error', () => {
    const s = sandbox();
    fs.writeFileSync(s.settings, JSON.stringify({ theme: 'dark' }));
    const res = removeAntigravityStatusLine({ settingsPath: s.settings });
    assert.equal(res.ok, true);
    assert.equal(res.code, 'ALREADY_ABSENT');
  });

  test('no settings file at all is already-absent, not a crash', () => {
    const s = sandbox();
    const res = removeAntigravityStatusLine({ settingsPath: s.settings });
    assert.equal(res.ok, true);
    assert.equal(res.code, 'ALREADY_ABSENT');
  });

  test('a settings file that is not JSON is refused, not overwritten', () => {
    const s = sandbox();
    fs.writeFileSync(s.settings, '{ oops');
    const res = removeAntigravityStatusLine({ settingsPath: s.settings });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SETTINGS_INVALID');
    assert.equal(fs.readFileSync(s.settings, 'utf8'), '{ oops');
  });
});

/* ------------------------------- cliInstalled now believes the binary too */

test.describe('cliInstalled recognises the binary, not just the config dir', () => {
  // Every case names BOTH probes. Leaving `binaryPath` to its default reads
  // the real %LOCALAPPDATA%, and the answer then depends on whether the
  // machine running the suite happens to have agy installed.

  test('a config directory still counts as installed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-agyci-'));
    const home = path.join(dir, 'antigravity-cli');
    fs.mkdirSync(home);
    assert.equal(cliInstalled(home, path.join(dir, 'no-agy', 'agy.exe')), true);
  });

  test('the binary alone counts as installed, before agy has ever run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-agyci3-'));
    const binary = path.join(dir, 'agy.exe');
    fs.writeFileSync(binary, 'MZ');
    assert.equal(cliInstalled(path.join(dir, 'nope'), binary), true);
  });

  test('a machine with neither binary nor config dir is not installed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-agici2-'));
    assert.equal(cliInstalled(path.join(dir, 'nope'), path.join(dir, 'no-agy', 'agy.exe')), false);
  });
});
