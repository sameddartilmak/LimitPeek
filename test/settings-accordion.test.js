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
 * The settings accordion (src/renderer/src/components/settings.ts).
 *
 * WHY A DOM SHIM AND NOT THE RENDER HARNESS
 * -----------------------------------------
 * The one-open-closes-others behaviour and the `aria-expanded` reflection are
 * DOM facts, and `npm test` has no window. The full electron render suite
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

const SECTION_IDS = ['models', 'usage', 'theme'];

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
  const handle = settingsMod.createSettings({
    onToggle() {},
    onTheme() {},
    onBack() {},
  });
  const triggers = new Map();
  const regions = new Map();
  for (const id of SECTION_IDS) {
    const trigger = findByAttr(handle.el, 'data-acc', id);
    assert.ok(trigger, `no accordion trigger for "${id}"`);
    triggers.set(id, trigger);
    regions.set(id, findById(handle.el, trigger.getAttribute('aria-controls')));
  }
  return { handle, triggers, regions };
}

const isOpen = (trigger) => trigger.getAttribute('aria-expanded') === 'true';

test('each section header is a real button carrying the disclosure ARIA', () => {
  const { triggers, regions } = mount();
  for (const id of SECTION_IDS) {
    const trigger = triggers.get(id);
    assert.equal(trigger.tagName, 'BUTTON', `${id} header must be a <button>`);
    assert.equal(trigger.getAttribute('type'), 'button');
    // aria-expanded is a real 'true'/'false' string, never absent.
    assert.ok(['true', 'false'].includes(trigger.getAttribute('aria-expanded')));
    // The button lives inside an <h3>, so it is navigable by heading.
    assert.equal(trigger.parentNode.tagName, 'H3');
    // aria-controls points at a region that exists and is labelled by the button.
    const region = regions.get(id);
    assert.ok(region, `${id} region is missing`);
    assert.equal(region.getAttribute('role'), 'region');
    assert.equal(region.getAttribute('aria-labelledby'), trigger.getAttribute('id'));
  }
});

test('the first section (Model Yönetimi) is open by default, the others collapsed', () => {
  const { triggers, regions } = mount();
  assert.equal(isOpen(triggers.get('models')), true);
  assert.equal(regions.get('models').hidden, false);

  for (const id of ['usage', 'theme']) {
    assert.equal(isOpen(triggers.get(id)), false, `${id} should start collapsed`);
    assert.equal(regions.get(id).hidden, true, `${id} region should start hidden`);
  }
});

test('opening one section closes the others (at most one open)', () => {
  const { triggers, regions } = mount();

  // Open "usage": models must close.
  triggers.get('usage').click();
  assert.equal(isOpen(triggers.get('usage')), true);
  assert.equal(regions.get('usage').hidden, false);
  assert.equal(isOpen(triggers.get('models')), false);
  assert.equal(regions.get('models').hidden, true);
  assert.equal(isOpen(triggers.get('theme')), false);

  // Open "theme": usage must close.
  triggers.get('theme').click();
  assert.equal(isOpen(triggers.get('theme')), true);
  assert.equal(regions.get('theme').hidden, false);
  assert.equal(isOpen(triggers.get('usage')), false);
  assert.equal(regions.get('usage').hidden, true);

  // Never more than one open at any point.
  const openCount = SECTION_IDS.filter((id) => isOpen(triggers.get(id))).length;
  assert.equal(openCount, 1);
});

test('clicking the open section collapses it — all-closed is reachable', () => {
  const { triggers, regions } = mount();
  // models starts open; click it to collapse.
  triggers.get('models').click();
  assert.equal(isOpen(triggers.get('models')), false);
  assert.equal(regions.get('models').hidden, true);
  const openCount = SECTION_IDS.filter((id) => isOpen(triggers.get(id))).length;
  assert.equal(openCount, 0, 'clicking the open header leaves every section closed');
});

test('aria-expanded and region.hidden stay in lockstep across a sequence of clicks', () => {
  const { triggers, regions } = mount();
  const clicks = ['usage', 'theme', 'theme', 'models', 'usage'];
  for (const id of clicks) {
    triggers.get(id).click();
    for (const s of SECTION_IDS) {
      // The region is hidden exactly when its trigger says collapsed.
      assert.equal(
        regions.get(s).hidden,
        !isOpen(triggers.get(s)),
        `${s} region.hidden must mirror aria-expanded after clicking ${id}`,
      );
    }
  }
});

// ------------------------------------------------ language (ADR-004)

/** The i18n and store modules of the SAME mirror, so setLocale reaches settings.js. */
async function mirrorModule(...parts) {
  return import(pathToFileURL(path.join(mirrorDir, 'renderer', 'src', ...parts)).href);
}

function stateWith(store, patch) {
  const s = new store.Store();
  s.set({ hasData: true, ...patch });
  return s.get();
}

function uninstalled(detail) {
  return {
    id: 'codex',
    displayName: 'Codex',
    connected: false,
    enabled: false,
    accent: '#10a37f',
    setupAction: { kind: 'not-installed', label: 'x', detail },
  };
}

test('the setup detail becomes a clause lower-cased in the RESOLVED language (A1.7)', async () => {
  const i18n = await mirrorModule('i18n.js');
  const store = await mirrorModule('store.js');
  const metaOf = (detail) => {
    const handle = settingsMod.createSettings({ onToggle() {}, onTheme() {}, onLanguage() {}, onBack() {} });
    handle.render(stateWith(store, {}), [uninstalled(detail)]);
    const meta = findById(handle.el, 'settings-meta-codex');
    assert.ok(meta, 'no meta line for the provider');
    return meta.textContent;
  };
  try {
    i18n.setLocale('tr', 'tr-TR');
    const tr = metaOf('Işık bulunamadı.');
    assert.ok(tr.endsWith('ışık bulunamadı'), tr);
    assert.ok(metaOf('İzmir kurulu değil.').endsWith('izmir kurulu değil'));

    i18n.setLocale('en', 'en-US');
    const en = metaOf('It is not installed.');
    assert.ok(en.endsWith('it is not installed'), en);
    assert.equal(/ıt is/.test(en), false, 'English "I" lower-cased with Turkish rules');
  } finally {
    i18n.setLocale('tr', 'tr-TR');
  }
});

test('picking a language only asks: the component does not switch the words itself', async () => {
  const i18n = await mirrorModule('i18n.js');
  const store = await mirrorModule('store.js');
  i18n.setLocale('tr', 'tr-TR');
  const asked = [];
  const handle = settingsMod.createSettings({
    onToggle() {}, onTheme() {}, onBack() {}, onLanguage: (choice) => asked.push(choice),
  });
  handle.render(stateWith(store, { language: 'tr' }), []);
  const en = findById(handle.el, 'language-en');
  assert.ok(en, 'no English radio');
  en.checked = true;
  en.dispatch('change');
  assert.deepEqual(asked, ['en']);
  // Main has not pushed PREFERENCES: the resolved language is unchanged.
  assert.equal(i18n.language(), 'tr');
  assert.equal(i18n.formatLocale(), 'tr-TR');
});
