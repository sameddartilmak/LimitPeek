'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { stripTypeScriptTypes } = require('node:module');
const { inlineJsonImports } = require('../src/renderer/inline-json.cjs');

/**
 * The settings tabs (src/renderer/src/components/settings.ts; UI plan
 * 2026-09-29: "Araçlar", "Kullanım", "Genel" replaced the accordion).
 *
 * WHY A DOM SHIM AND NOT THE RENDER HARNESS
 * -----------------------------------------
 * The tabs pattern — one selected tab, one visible panel, a roving tab stop,
 * arrow keys that move and select — is a set of DOM facts, and `npm test` has
 * no window. The full electron render suite
 * (`npm run verify:render`) does, but it is a separate, slow GUI run. So this
 * mounts the REAL component against a tiny DOM implementing only the handful of
 * operations settings.ts touches at construction and on a click — enough to
 * assert the disclosure contract without a browser.
 *
 * The component is loaded FROM SOURCE (stripped into a mirror of the src tree,
 * exactly like test/helpers/load-format.js) so a stale dist cannot make this
 * pass — the same discipline the rest of the renderer unit suites use.
 */

// ---------------------------------------------------------------- DOM shim

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this._text = String(text);
    this.parentNode = null;
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
  }
}

class FakeElement {
  constructor(tag, ns) {
    this.tagName = String(tag).toUpperCase();
    this.namespaceURI = ns || null;
    this.attributes = new Map();
    this.childNodes = [];
    this.listeners = new Map();
    this._hidden = false;
    this.parentNode = null;
    this.style = {
      _p: new Map(),
      setProperty(k, v) {
        this._p.set(k, String(v));
      },
      getPropertyValue(k) {
        return this._p.get(k) || '';
      },
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(node) {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    const i = this.childNodes.indexOf(ref);
    node.parentNode = this;
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  addEventListener(type, fn) {
    const arr = this.listeners.get(type) || [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(type, fn) {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatch(type) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    };
    for (const fn of (this.listeners.get(type) || []).slice()) fn(event);
  }
  click() {
    this.dispatch('click');
  }
  focus() {}

  get hidden() {
    return this._hidden;
  }
  set hidden(v) {
    this._hidden = Boolean(v);
  }

  get firstElementChild() {
    return this.childNodes.find((n) => n instanceof FakeElement) || null;
  }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const kids = this.parentNode.childNodes;
    for (let i = kids.indexOf(this) + 1; i < kids.length; i += 1) {
      if (kids[i] instanceof FakeElement) return kids[i];
    }
    return null;
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent || '').join('');
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(new FakeText(v));
  }
}

function installDom() {
  const doc = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => new FakeElement(tag, ns),
    createTextNode: (text) => new FakeText(text),
    documentElement: new FakeElement('html'),
  };
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = doc;
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }) };
  return () => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  };
}

// walk helpers over the fake tree
function walk(node, out = []) {
  if (node instanceof FakeElement) {
    out.push(node);
    for (const child of node.childNodes) walk(child, out);
  }
  return out;
}
function findByAttr(root, name, value) {
  return walk(root).find((el) => el.getAttribute(name) === value) || null;
}
function findById(root, id) {
  return walk(root).find((el) => el.getAttribute('id') === id) || null;
}

// --------------------------------------------------- load settings from source

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function tsFilesUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFilesUnder(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function mirrorRenderer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-settings-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}', 'utf8');
  const sources = [
    ...tsFilesUnder(path.join(SRC, 'renderer', 'src')),
    path.join(SRC, 'shared', 'contract.ts'),
  ];
  for (const file of sources) {
    const rel = path.relative(SRC, file).replace(/\.ts$/, '.js');
    const out = path.join(dir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // Catalog JSON inlined as build.mjs does (ADR-004), so i18n.ts resolves.
    const js = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' });
    fs.writeFileSync(out, inlineJsonImports(js, file).code, 'utf8');
  }
  return dir;
}

const TAB_IDS = ['providers', 'usage', 'general'];

let settingsMod;
let mirrorDir;
let restoreDom;

test.before(async () => {
  restoreDom = installDom();
  mirrorDir = mirrorRenderer();
  const entry = path.join(mirrorDir, 'renderer', 'src', 'components', 'settings.js');
  settingsMod = await import(pathToFileURL(entry).href);
});

test.after(() => {
  if (restoreDom) restoreDom();
  if (mirrorDir) fs.rmSync(mirrorDir, { recursive: true, force: true });
});

function mount() {
  const picked = [];
  const handle = settingsMod.createSettings({
    onToggle() {},
    onTheme() {},
    onLanguage() {},
    onAutostart() {},
    onDisconnect() {},
    onPlanLabel() {},
    onBack() {},
    onTab(id) { picked.push(id); },
  });
  const tabs = new Map();
  const panels = new Map();
  for (const id of TAB_IDS) {
    const tab = walk(handle.el).find((el) => el.getAttribute('role') === 'tab' && el.getAttribute('data-tab') === id);
    assert.ok(tab, `no tab for "${id}"`);
    tabs.set(id, tab);
    panels.set(id, findById(handle.el, tab.getAttribute('aria-controls')));
  }
  return { handle, tabs, panels, picked };
}

const selectedOf = (tabs) => TAB_IDS.filter((id) => tabs.get(id).getAttribute('aria-selected') === 'true');

function press(el, key) {
  const event = { type: 'keydown', key, target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} };
  for (const fn of (el.listeners.get('keydown') || []).slice()) fn(event);
}

/** Just enough PanelState for settings.render(). */
function state(over = {}) {
  return {
    snapshot: null, hasData: false, settingsTab: 'providers', theme: 'system', themePending: false,
    themeReverted: false, language: 'system', languagePending: false, languageReverted: false,
    autostart: true, autostartPending: false, autostartReverted: false, autostartByWindows: false,
    enabledOverride: {}, enabledPending: [], revertedId: null, planPending: [], planReverted: null,
    ...over,
  };
}

test('a tablist of three real tab buttons, each controlling a labelled tabpanel', () => {
  const { handle, tabs, panels } = mount();
  const list = walk(handle.el).find((el) => el.getAttribute('role') === 'tablist');
  assert.ok(list, 'no tablist');
  assert.ok(list.getAttribute('aria-label'), 'the tablist has no name');
  for (const id of TAB_IDS) {
    const tab = tabs.get(id);
    assert.equal(tab.tagName, 'BUTTON');
    assert.equal(tab.getAttribute('type'), 'button');
    assert.ok(['true', 'false'].includes(tab.getAttribute('aria-selected')));
    const panel = panels.get(id);
    assert.ok(panel, `${id}: aria-controls points nowhere`);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tab.getAttribute('id'));
  }
});

test('"Araçlar" is selected on a fresh panel; one tab stop, one visible panel', () => {
  const { tabs, panels } = mount();
  assert.deepEqual(selectedOf(tabs), ['providers']);
  assert.deepEqual(TAB_IDS.map((id) => tabs.get(id).getAttribute('tabindex')), ['0', '-1', '-1']);
  assert.deepEqual(TAB_IDS.map((id) => panels.get(id).hidden), [false, true, true]);
});

test('a click selects its tab, shows its panel and tells the app', () => {
  const { tabs, panels, picked } = mount();
  tabs.get('usage').click();
  assert.deepEqual(selectedOf(tabs), ['usage']);
  assert.deepEqual(TAB_IDS.map((id) => panels.get(id).hidden), [true, false, true]);
  assert.deepEqual(picked, ['usage']);
});

test('arrow keys move and select, wrapping at both ends; Home and End jump', () => {
  const { tabs, picked } = mount();
  press(tabs.get('providers'), 'ArrowRight');
  assert.deepEqual(selectedOf(tabs), ['usage']);
  press(tabs.get('usage'), 'ArrowRight');
  assert.deepEqual(selectedOf(tabs), ['general']);
  press(tabs.get('general'), 'ArrowRight');
  assert.deepEqual(selectedOf(tabs), ['providers'], 'Right on the last tab wraps to the first');
  press(tabs.get('providers'), 'ArrowLeft');
  assert.deepEqual(selectedOf(tabs), ['general'], 'Left on the first tab wraps to the last');
  press(tabs.get('general'), 'Home');
  assert.deepEqual(selectedOf(tabs), ['providers']);
  press(tabs.get('providers'), 'End');
  assert.deepEqual(selectedOf(tabs), ['general']);
  assert.deepEqual(picked, ['usage', 'general', 'providers', 'general', 'providers', 'general']);
  // Exactly one tab stop at every point.
  assert.equal(TAB_IDS.filter((id) => tabs.get(id).getAttribute('tabindex') === '0').length, 1);
});

test('other keys do nothing', () => {
  const { tabs, picked } = mount();
  press(tabs.get('providers'), 'Enter');
  press(tabs.get('providers'), 'a');
  assert.deepEqual(selectedOf(tabs), ['providers']);
  assert.deepEqual(picked, []);
});

test('the store decides the tab on render, so it survives the panel hiding and a rebuild', () => {
  const { handle, tabs, panels } = mount();
  handle.render(state({ settingsTab: 'general' }), []);
  assert.deepEqual(selectedOf(tabs), ['general']);
  assert.equal(panels.get('general').hidden, false);
  handle.render(state({ settingsTab: 'usage' }), []);
  assert.deepEqual(selectedOf(tabs), ['usage']);
});

test('after a language change the language control is found on the "Genel" tab', () => {
  const { handle, tabs, picked } = mount();
  handle.focusLanguage();
  assert.deepEqual(selectedOf(tabs), ['general']);
  assert.deepEqual(picked, ['general']);
});
