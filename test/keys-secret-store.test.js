'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fakeElectron = require('./helpers/fake-keys-electron');

// Installed before the store is required: it imports `safeStorage` at load time.
const electron = fakeElectron.install();
const log = require('../src/core/log');
const paths = require('../src/core/paths');
const settingsStore = require('../src/main/settings');
const store = require('../src/main/keys/secret-store');

log.setTrace(false);

/**
 * The secret store (ADR-003 Amendment 5, K7-K12 and K20).
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE
 * -------------------------------------
 * They prove the code AROUND DPAPI: that nothing is written when encryption is
 * unavailable, that the file holds only an encrypted blob in a versioned
 * envelope, that a corrupt or foreign record is 'unreadable' rather than a
 * crash, that the write is atomic, that removal leaves nothing behind, and that
 * no other file this app owns ever contains the key in any encoding.
 *
 * They do NOT prove that DPAPI protects the blob — `safeStorage` is only real
 * inside Electron, so the fake transforms the bytes instead. What it means for a
 * test here to pass is that the store never writes a value it did not put
 * through `safeStorage`, which is the part this lane owns.
 */

const KEY = `github_pat_${'Z'.repeat(70)}`;
const USERNAME = 'octocat';

let root;
let userData;
let previousLocalAppData;

test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-secrets-'));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-userdata-'));
  previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  electron.state.encryptionAvailable = true;
  store._resetForTests();
});

test.afterEach(() => {
  if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocalAppData;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
});

function recordFile() {
  return path.join(root, 'UsageNotch', 'secrets', 'copilot.json');
}

/** Every file under a directory tree, as paths. */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** The four encodings a secret could plausibly have been written in. */
function needlesFor(secret) {
  return [
    Buffer.from(secret, 'utf8'),
    Buffer.from(secret, 'utf16le'),
    Buffer.from(Buffer.from(secret, 'utf8').toString('base64'), 'utf8'),
    Buffer.from(Buffer.from(secret, 'utf8').toString('hex'), 'utf8'),
  ];
}

test('a stored record is a versioned envelope around an encrypted blob (K8)', () => {
  const result = store.store({ provider: 'copilot', key: KEY, username: USERNAME, now: Date.parse('2026-09-22T09:00:00Z') });
  assert.equal(result.ok, true);
  assert.equal(result.storedAt, '2026-09-22T09:00:00.000Z');

  const raw = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['blob', 'provider', 'region', 'storedAt', 'v']);
  assert.equal(raw.v, store.SECRET_VERSION);
  assert.equal(raw.provider, 'copilot');
  assert.equal(raw.region, null);
  assert.equal(typeof raw.blob, 'string');

  assert.deepEqual(store.read('copilot'), { state: 'stored', storedAt: '2026-09-22T09:00:00.000Z' });
  assert.deepEqual(store.open('copilot'), { ok: true, key: KEY, username: USERNAME });
});

test('no file under LOCALAPPDATA or userData holds the key in any encoding (K7/K11)', () => {
  // A settings file exists first, so "byte-identical" below is a real comparison.
  assert.equal(settingsStore.save(userData, settingsStore.load(userData)), true);
  const settingsPath = path.join(userData, 'settings.json');
  const before = fs.readFileSync(settingsPath);

  assert.equal(store.store({ provider: 'copilot', key: KEY, username: USERNAME }).ok, true);

  const files = [...walk(root), ...walk(userData)];
  assert.ok(files.length >= 2, 'the walk found nothing; the test is not looking anywhere');
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    for (const needle of needlesFor(KEY)) {
      assert.equal(bytes.includes(needle), false, `${file} contains the key`);
    }
  }

  // settings.json is untouched, to the byte: nothing key-related may reach it.
  assert.deepEqual(fs.readFileSync(settingsPath), before);
  const settings = settingsStore.load(userData);
  assert.equal(JSON.stringify(settings).includes('copilot'), false);
  assert.equal(JSON.stringify(settings).toLowerCase().includes('key'), false);
});

test('the username travels inside the ciphertext, not beside it', () => {
  assert.equal(store.store({ provider: 'copilot', key: KEY, username: USERNAME }).ok, true);
  const bytes = fs.readFileSync(recordFile());
  assert.equal(bytes.includes(Buffer.from(USERNAME, 'utf8')), false);
  assert.equal(store.open('copilot').username, USERNAME);
});

test('with encryption unavailable nothing is written at all (K7)', () => {
  electron.state.encryptionAvailable = false;
  assert.equal(store.isAvailable(), false);
  const result = store.store({ provider: 'copilot', key: KEY, username: USERNAME });
  assert.deepEqual(result, { ok: false, code: 'secure-storage-unavailable' });
  assert.equal(fs.existsSync(path.join(root, 'UsageNotch', 'secrets')), false);
  assert.deepEqual(store.read('copilot'), { state: 'none', storedAt: null });
  // And no fallback exists: the store has no path that writes a plaintext key.
  // Comment lines are stripped, exactly as the network scan in
  // contract-mirror.test.js does — the prose above the code names the API it
  // refuses to call, and that sentence is the documentation, not a call.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'keys', 'secret-store.js'), 'utf8')
    .split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
  assert.equal(source.includes('setUsePlainTextEncryption'), false);
});

test('a key stored while encryption works, then read with it gone, is unreadable — never a crash', () => {
  assert.equal(store.store({ provider: 'copilot', key: KEY, username: USERNAME }).ok, true);
  electron.state.encryptionAvailable = false;
  assert.deepEqual(store.open('copilot'), { ok: false, code: 'unreadable' });
  // The envelope is still readable, so the row still knows a key is stored.
  assert.equal(store.read('copilot').state, 'stored');
});

test('a foreign, corrupt, oversized or mismatched record is unreadable, never a throw (K10)', () => {
  const dir = path.join(root, 'UsageNotch', 'secrets');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'copilot.json');
  const good = () => {
    store.store({ provider: 'copilot', key: KEY, username: USERNAME });
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };

  const cases = [
    ['not JSON at all', 'this is not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"key"'],
    ['null', 'null'],
    ['truncated', JSON.stringify(good()).slice(0, 40)],
    ['a future version', JSON.stringify({ ...good(), v: 2 })],
    ['version zero', JSON.stringify({ ...good(), v: 0 })],
    ['another provider', JSON.stringify({ ...good(), provider: 'kimi' })],
    ['no blob', JSON.stringify({ v: 1, provider: 'copilot', region: null, storedAt: new Date().toISOString() })],
    ['a blob that is not a string', JSON.stringify({ ...good(), blob: 12 })],
    ['a storedAt that is not a date', JSON.stringify({ ...good(), storedAt: 'never' })],
    ['past the 4 KiB read cap', JSON.stringify({ ...good(), pad: 'x'.repeat(store.MAX_RECORD_BYTES) })],
    ['empty', ''],
  ];
  for (const [label, contents] of cases) {
    fs.writeFileSync(file, contents);
    const read = store.read('copilot');
    assert.equal(read.state, 'unreadable', label);
    assert.equal(read.storedAt, null, label);
    assert.deepEqual(store.open('copilot'), { ok: false, code: 'unreadable' }, label);
  }

  // A blob that is not our ciphertext decrypts to nothing, and says so.
  fs.writeFileSync(file, JSON.stringify({ ...good(), blob: Buffer.from('nonsense').toString('base64') }));
  assert.equal(store.read('copilot').state, 'stored');
  assert.deepEqual(store.open('copilot'), { ok: false, code: 'unreadable' });
});

test('an absent record is "none", which is not the same answer as "unreadable"', () => {
  assert.deepEqual(store.read('copilot'), { state: 'none', storedAt: null });
  assert.deepEqual(store.open('copilot'), { ok: false, code: 'none' });
  assert.equal(store.hasRecord('copilot'), false);
});

test('the write leaves no temporary behind, and removal deletes every trace (K9/K20)', () => {
  assert.equal(store.store({ provider: 'copilot', key: KEY, username: USERNAME }).ok, true);
  store.writeSchedule('copilot', { lastAttemptAt: 1, nextEligibleAt: 2, backoffMs: 0, stopped: false });
  const dir = path.join(root, 'UsageNotch', 'secrets');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['copilot.json', 'copilot.state.json']);

  // A crash during an earlier store can leave a temporary under a dead pid.
  fs.writeFileSync(path.join(dir, 'copilot.json.999999.tmp'), 'half a record');

  assert.deepEqual(store.remove('copilot'), { ok: true });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(store.read('copilot'), { state: 'none', storedAt: null });
  assert.equal(store.readSchedule('copilot'), null);
  // Idempotent: the user may press remove twice.
  assert.deepEqual(store.remove('copilot'), { ok: true });
});

test('the temporary is create-exclusive and unpredictable, so nothing pre-planted is written through (review F4)', () => {
  const dir = path.join(root, 'UsageNotch', 'secrets');
  fs.mkdirSync(dir, { recursive: true });

  // 1. A file ALREADY AT THE TEMPORARY PATH fails the write. That is the planted
  //    symlink case: with 'w' the open would have followed it and written the
  //    record through it. The namer is injected because the real name is random,
  //    which is the other half of the fix — there is nothing to pre-plant.
  const target = path.join(dir, 'copilot.json');
  const plantedTmp = path.join(dir, 'copilot.json.planted.tmp');
  fs.writeFileSync(plantedTmp, 'someone else’s file');
  assert.equal(store.writeAtomic(target, 'new contents', () => plantedTmp), 'EEXIST');
  assert.equal(fs.readFileSync(plantedTmp, 'utf8'), 'someone else’s file', 'the planted file is untouched');
  assert.equal(fs.existsSync(target), false, 'and nothing was renamed into place');
  fs.unlinkSync(plantedTmp);
  // The flag is the control, so it is asserted directly too.
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'keys', 'secret-store.js'), 'utf8'),
    /fs\.openSync\(tmp, 'wx', 0o600\)/,
  );

  // 2. The temporary name is not predictable: twenty names, twenty distinct
  //    values, each of the shape `remove()` knows how to clean.
  const names = new Set();
  for (let i = 0; i < 20; i += 1) {
    const tmp = store.tmpPath(target);
    assert.match(path.basename(tmp), /^copilot\.json\.\d+\.[0-9a-f]{12}\.tmp$/);
    names.add(tmp);
  }
  assert.equal(names.size, 20);

  // 3. A real store still succeeds and leaves no temporary behind.
  assert.equal(store.store({ provider: 'copilot', key: KEY, username: USERNAME }).ok, true);
  assert.equal(store.read('copilot').state, 'stored');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);

  // 4. A stale temporary from a crashed process cannot wedge the store: the next
  //    write picks a different name, and `remove()` cleans both leftovers.
  const stranger = path.join(dir, 'someone-else.json');
  fs.writeFileSync(stranger, 'not ours');
  fs.writeFileSync(path.join(dir, `copilot.json.${process.pid}.deadbeefcafe.tmp`), 'half a record');
  fs.writeFileSync(path.join(dir, `copilot.state.json.${process.pid}.deadbeefcafe.tmp`), 'half a state');
  assert.equal(store.store({ provider: 'copilot', key: KEY, username: USERNAME }).ok, true);
  assert.equal(store.writeSchedule('copilot', { lastAttemptAt: 1, nextEligibleAt: 2, backoffMs: 0, stopped: false }), true);
  assert.deepEqual(store.remove('copilot'), { ok: true });
  assert.deepEqual(
    fs.readdirSync(dir),
    ['someone-else.json'],
    'every temporary of ours is cleaned; a file that is not ours is left alone',
  );
});

test('a provider that is not key-capable can neither store, read nor remove (K24)', () => {
  for (const id of ['gemini', 'kimi', 'claude', '__proto__']) {
    assert.deepEqual(store.store({ provider: id, key: KEY, username: USERNAME }), { ok: false, code: 'unknown-provider' });
    assert.deepEqual(store.read(id), { state: 'none', storedAt: null });
    assert.deepEqual(store.remove(id), { ok: false });
    assert.equal(store.readSchedule(id), null);
    assert.equal(store.writeSchedule(id, {}), false);
  }
  assert.equal(fs.existsSync(path.join(root, 'UsageNotch', 'secrets')), false);
});

test('the secrets directory is refused when it is a network path (ADR-003 A3.1)', () => {
  process.env.LOCALAPPDATA = '\\\\server\\share\\AppData';
  store._resetForTests();
  assert.equal(store.secretsDirSafe(true), null);
  assert.deepEqual(store.store({ provider: 'copilot', key: KEY, username: USERNAME }), { ok: false, code: 'store-failed' });
  assert.deepEqual(store.read('copilot'), { state: 'none', storedAt: null });
  // Remembered for the process: a stalled share is not retried on every store.
  assert.equal(store.secretsDirSafe(true), null);
});

test('the schedule file holds no secret and survives a corrupt one', () => {
  assert.equal(store.store({ provider: 'copilot', key: KEY, username: USERNAME }).ok, true);
  assert.equal(store.writeSchedule('copilot', { lastAttemptAt: 111, nextEligibleAt: 222, backoffMs: 0, stopped: true }), true);
  const raw = store.readSchedule('copilot');
  assert.equal(raw.provider, 'copilot');
  assert.equal(raw.stopped, true);
  const bytes = fs.readFileSync(path.join(root, 'UsageNotch', 'secrets', 'copilot.state.json'));
  for (const needle of needlesFor(KEY)) assert.equal(bytes.includes(needle), false);

  fs.writeFileSync(path.join(root, 'UsageNotch', 'secrets', 'copilot.state.json'), 'not json');
  assert.equal(store.readSchedule('copilot'), null);
});

test.after(() => electron.restore());
