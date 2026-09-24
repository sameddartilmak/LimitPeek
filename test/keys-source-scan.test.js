'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { IPC_KEY_ENTRY } = require('../src/shared/contract');

/**
 * Structural guards for the optional-key feature (ADR-003 Amendment 5).
 *
 * Several K conditions are properties of the SHAPE of the codebase, not of any
 * one call: exactly one module may open a socket, exactly one may hand a URL to
 * the OS, no module may touch the clipboard, none may weaken TLS, and the keyed
 * partition may never be mounted in a window. A comment cannot hold any of
 * those, and a review holds them only until the next edit — so they are asserted
 * here, over the source.
 *
 * Comment lines are stripped before every scan, exactly as the network scan in
 * `contract-mirror.test.js` does: the prose that NAMES an API in order to say it
 * is never called is documentation, and turning it into a failure would push the
 * reasoning out of the file.
 */

const ROOT = path.join(__dirname, '..');

function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

function codeOf(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
}

/** Every main/core source file, as `{ rel, code }`. */
function mainAndCore() {
  return [...sourceFiles(path.join(ROOT, 'src', 'main')), ...sourceFiles(path.join(ROOT, 'src', 'core'))]
    .map((file) => ({ rel: path.relative(ROOT, file).split(path.sep).join('/'), code: codeOf(file) }));
}

const KEYED_NET = 'src/main/keys/keyed-net.js';
const TOKEN_PAGE = 'src/main/keys/token-page.js';

test('exactly one module may open a socket, and it is the keyed request module (K13)', () => {
  const offenders = mainAndCore().filter(({ rel, code }) => {
    if (rel === KEYED_NET) return false;
    // `net` destructured from electron, in any order, plus a direct call.
    return /\{[^}]*\bnet\b[^}]*\}\s*=\s*require\(['"]electron['"]\)/.test(code)
      || code.includes('net.request(')
      || /require\(['"]electron['"]\)\.net\b/.test(code);
  });
  assert.deepEqual(offenders.map((o) => o.rel), []);

  const keyed = codeOf(path.join(ROOT, KEYED_NET));
  assert.ok(keyed.includes("require('electron')"), 'the keyed module gets net from electron');
  assert.equal(keyed.split('net.request(').length - 1, 1, 'one request site, not two');
  // Node's own network modules are nowhere in the feature.
  for (const needle of ["require('node:https')", "require('https')", "require('node:http')", "require('node:net')", 'fetch(']) {
    assert.equal(keyed.includes(needle), false, needle);
  }
});

test('the keyed partition is named in one place and never mounted in a window (K13, review F1)', () => {
  // The literal exists ONCE, in the module that decides which partition may skip
  // the block-all filter. The request module takes it from there, so the name the
  // exemption guards and the name the request uses cannot drift apart.
  const namers = mainAndCore().filter(({ code }) => code.includes("'usage-notch-keyed'")).map((o) => o.rel);
  assert.deepEqual(namers, ['src/main/security.js']);
  const users = mainAndCore().filter(({ code }) => code.includes('usage-notch-keyed')).map((o) => o.rel);
  assert.deepEqual(users, ['src/main/security.js']);

  // Neither the module that names it nor the module that uses it can mount a
  // window on it: neither one so much as mentions a BrowserWindow.
  for (const rel of ['src/main/security.js', KEYED_NET]) {
    const code = codeOf(path.join(ROOT, rel));
    assert.equal(/\bBrowserWindow\b/.test(code), false, `${rel} must not create a window`);
    assert.equal(code.includes('webPreferences'), false, rel);
  }

  // And the entry window's partition is a different one, named in its own module.
  const entry = codeOf(path.join(ROOT, 'src', 'main', 'keys', 'entry-window.js'));
  assert.ok(entry.includes("'usage-notch-key-entry'"));
  assert.equal(entry.includes('usage-notch-keyed'), false);
});

test('shell.openExternal exists once, with a quoted literal, and nowhere else (A8 addendum)', () => {
  const offenders = mainAndCore()
    .filter(({ rel, code }) => rel !== TOKEN_PAGE && code.includes('openExternal'))
    .map((o) => o.rel);
  assert.deepEqual(offenders, []);

  const code = codeOf(path.join(ROOT, TOKEN_PAGE));
  const calls = code.match(/shell\.openExternal\([^)]*\)/g) || [];
  assert.equal(calls.length, 1, 'one call, not two');
  // A literal, single-quoted https URL. No variable, no template, no concatenation.
  // `?`, `=`, `&` and `+` are allowed for GitHub's documented prefill query;
  // quotes, backticks, `$`, `{` and spaces still are not, so nothing can be
  // interpolated into it.
  assert.match(calls[0], /^shell\.openExternal\('https:\/\/[A-Za-z0-9./_?=&+-]+'\)$/);
  assert.equal(calls[0], "shell.openExternal('https://github.com/settings/personal-access-tokens/new?name=Usage+Notch&description=Reads+Copilot+AI+credits+for+Usage+Notch&expires_in=30&plan=read')");
});

test('nothing in main or core touches the clipboard (K6)', () => {
  const offenders = mainAndCore()
    .filter(({ code }) => /\bclipboard\b/i.test(code))
    .map((o) => o.rel);
  assert.deepEqual(offenders, []);
  // Including the preloads, which are the surfaces a page can reach.
  for (const preload of ['src/main/preload.js', 'src/main/keys/entry-preload.js']) {
    assert.equal(/\bclipboard\b/i.test(codeOf(path.join(ROOT, preload))), false, preload);
  }
});

test('no TLS override and no plaintext-storage escape hatch exists anywhere (K7/K15)', () => {
  const forbidden = [
    'setCertificateVerifyProc',
    'rejectUnauthorized',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'setUsePlainTextEncryption',
    'allowNTLMCredentialsForDomains',
    'ignore-certificate-errors',
  ];
  const offenders = [];
  for (const { rel, code } of mainAndCore()) {
    for (const needle of forbidden) {
      if (code.includes(needle)) offenders.push(`${rel}: ${needle}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the proxy mode is a literal DIRECT, in one place, and never the system proxy (ADR-001 A2026-09-22)', () => {
  const callers = mainAndCore().filter(({ code }) => code.includes('setProxy(')).map((o) => o.rel);
  assert.deepEqual(callers, ['src/main/security.js'], 'one module decides the proxy mode');

  const code = codeOf(path.join(ROOT, 'src', 'main', 'security.js'));
  const calls = code.match(/setProxy\([^)]*\)/g) || [];
  assert.equal(calls.length, 1, 'one call, not two');
  // A literal object with a literal mode: no variable, so which mode ships
  // cannot depend on a caller, a setting or a stored value.
  assert.equal(calls[0], "setProxy({ mode: 'direct' })");

  // `mode: 'system'` would put WPAD back on every machine that runs the app.
  // It is not shipped anywhere, and this is what says so.
  for (const { rel, code: body } of mainAndCore()) {
    assert.equal(body.includes("mode: 'system'"), false, rel);
    assert.equal(body.includes('proxyRules'), false, rel);
    assert.equal(body.includes('pacScript'), false, rel);
  }

  // And the process-global control, which is the one devops measured at zero.
  assert.ok(code.includes("appendSwitch('no-proxy-server')"));
});

test('DNS-over-HTTPS and the built-in resolver are pinned off, in one place (security F9)', () => {
  // The pin exists, exactly once, in the module that owns network hardening.
  const callers = mainAndCore().filter(({ code }) => code.includes('configureHostResolver(')).map((o) => o.rel);
  assert.deepEqual(callers, ['src/main/security.js'], 'one module decides the resolver mode');

  const code = codeOf(path.join(ROOT, 'src', 'main', 'security.js'));
  const calls = code.match(/configureHostResolver\([^)]*\)/g) || [];
  assert.equal(calls.length, 1, 'one call, not two');
  // Literal values, both of them: a DoH lookup is a host resolution and not a
  // URLRequest, so if an Electron default ever flips, the block-all filter would
  // not see it and no in-process test could. This line is what says no.
  assert.equal(
    calls[0],
    "configureHostResolver({ enableBuiltInResolver: false, secureDnsMode: 'off' })",
  );

  // And the modes that would undo it are nowhere.
  for (const { rel, code: body } of mainAndCore()) {
    assert.equal(body.includes('enableBuiltInResolver: true'), false, rel);
    assert.equal(body.includes("secureDnsMode: 'automatic'"), false, rel);
    assert.equal(body.includes("secureDnsMode: 'secure'"), false, rel);
  }
});

test('spellcheck is off on every window, because the dictionary is a download (security F11)', () => {
  /**
   * NOT typography. Electron downloads hunspell dictionaries from a Google host
   * the first time a spellcheckable field takes focus, through a browser-process
   * loader that no session `onBeforeRequest` sees — the same class of blind spot
   * as the `wpad` lookups. The key-entry window is exactly a text field, so this
   * flag is a network control and cannot be dropped as cosmetic.
   */
  const withWindows = mainAndCore().filter(({ code }) => code.includes('webPreferences'));
  assert.deepEqual(
    withWindows.map((o) => o.rel).sort(),
    ['src/main/keys/entry-window.js', 'src/main/panel-window.js'],
  );
  for (const { rel, code } of withWindows) {
    assert.ok(code.includes('spellcheck: false'), `${rel} must keep spellcheck: false`);
  }
  // No spelling of the opposite, anywhere, including the loader switch that
  // would fetch a dictionary without a webPreferences block at all.
  for (const { rel, code } of mainAndCore()) {
    assert.equal(code.includes('spellcheck: true'), false, rel);
    assert.equal(code.includes('setSpellCheckerEnabled'), false, rel);
    assert.equal(code.includes('setSpellCheckerLanguages'), false, rel);
  }
});

test('the entry preload exposes five methods, no getter, and no generic passthrough (K3)', () => {
  const file = path.join(ROOT, 'src', 'main', 'keys', 'entry-preload.js');
  const code = codeOf(file);
  assert.ok(code.includes("exposeInMainWorld('usageNotchKeyEntry'"), 'the global the page reads');
  const exposed = code.slice(code.indexOf('exposeInMainWorld'));
  const methods = (exposed.match(/^ {2}([a-zA-Z]+):/gm) || []).map((m) => m.trim().replace(':', ''));
  assert.deepEqual(methods.sort(), ['cancel', 'consent', 'entryInfo', 'openTokenPage', 'submit']);
  // No getter of any spelling, and no generic invoke/send.
  for (const needle of ['getKey', 'readKey', 'keyFor', 'peek', 'reveal', 'invoke:', 'send:', 'on:']) {
    assert.equal(exposed.includes(needle), false, needle);
  }
  // The channel strings are the contract's, character for character.
  for (const [name, channel] of Object.entries(IPC_KEY_ENTRY)) {
    assert.ok(code.includes(`${name}: '${channel}'`), `the preload is missing ${name} ('${channel}')`);
  }
  // The entry window's channels are NOT on the panel's bridge.
  const panel = codeOf(path.join(ROOT, 'src', 'main', 'preload.js'));
  for (const channel of Object.values(IPC_KEY_ENTRY)) {
    assert.equal(panel.includes(channel), false, `the panel must not reach ${channel}`);
  }
});

test('nothing key-related reaches settings.json (K11)', () => {
  const code = codeOf(path.join(ROOT, 'src', 'main', 'settings.js'));
  for (const needle of ['secret', 'blob', 'safeStorage', 'apiKey', 'token', 'keyState', 'creditUsage']) {
    assert.equal(code.toLowerCase().includes(needle.toLowerCase()), false, needle);
  }
  // The store writes into its own directory, which is not userData.
  const paths = codeOf(path.join(ROOT, 'src', 'core', 'paths.js'));
  assert.ok(paths.includes("'secrets'"));
  assert.ok(paths.includes('rateLimitsDir()'), 'the secrets directory hangs off %LOCALAPPDATA%\\UsageNotch');
  const store = codeOf(path.join(ROOT, 'src', 'main', 'keys', 'secret-store.js'));
  assert.equal(store.includes('getPath('), false, 'the store never reads an app path (userData)');
});

test('a real uninstall deletes the secrets directory (K12)', () => {
  const nsh = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
  const macro = nsh.slice(nsh.indexOf('!macro customUnInstall'), nsh.indexOf('!macroend'));
  assert.match(macro, /RMDir \/r "\$LOCALAPPDATA\\UsageNotch\\secrets"/);
  // Guarded, so an UPGRADE (which runs the old uninstaller) keeps the key.
  assert.ok(macro.includes('${ifNot} ${isUpdated}'));
  // Block depth, not a slice to the first `${endIf}`. The macro gained nested
  // `${if}` blocks (the post-removal verification and its two-language
  // message), and a slice from the guard to the FIRST `${endIf}` then ran to the
  // innermost closer — so it spanned almost the whole macro and stopped
  // constraining anything. Counting openers and closers from the guard line
  // means "the removal is still inside the guard" whatever nests in between.
  const lines = macro.split('\n').filter((l) => !l.trimStart().startsWith(';'));
  const guardLine = lines.findIndex((l) => l.includes('${ifNot} ${isUpdated}'));
  assert.ok(guardLine >= 0, 'the isUpdated guard is not on a code line');
  let depth = 0;
  let removalDepth = null;
  for (let i = guardLine; i < lines.length; i += 1) {
    if (/\$\{ifNot\}|\$\{if\}/.test(lines[i])) depth += 1;
    if (lines[i].includes('RMDir /r "$LOCALAPPDATA\\UsageNotch\\secrets"') && removalDepth === null) {
      removalDepth = depth;
    }
    if (lines[i].includes('${endIf}')) depth -= 1;
  }
  assert.ok(
    removalDepth !== null && removalDepth >= 1,
    'the delete must be inside the isUpdated guard; at the RMDir line the guard was already closed',
  );
  // And it deletes ONLY the secrets, not the whole app directory.
  assert.equal(/RMDir \/r "\$LOCALAPPDATA\\UsageNotch"\s*$/m.test(macro), false);
});

test('the secret store is the only module that decrypts, and the service never holds a key', () => {
  const offenders = mainAndCore()
    .filter(({ rel, code }) => rel !== 'src/main/keys/secret-store.js' && code.includes('decryptString'))
    .map((o) => o.rel);
  assert.deepEqual(offenders, []);

  // The service passes a CALLBACK to the request function; it never binds the
  // decrypted value to anything of its own (K17).
  const service = codeOf(path.join(ROOT, 'src', 'main', 'keys', 'service.js'));
  assert.ok(service.includes('readSecret: () => secretStore.open(id)'));
  assert.equal(/=\s*secretStore\.open\(/.test(service), false, 'no assignment of an opened secret');
  const keyed = codeOf(path.join(ROOT, KEYED_NET));
  // One read, into a local that the function does not outlive.
  assert.equal(keyed.split('readSecret()').length - 1, 1);
});
