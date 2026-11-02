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
  scrollIntoView() {}

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
    trayView: 'tray', stripStyle: 'plain', transparency: 45,
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

// --------------------------------------------- "Bağlantıyı kaldır" confirmation

test.describe('"Bağlantıyı kaldır" asks in the app\'s own box, not the system\'s', () => {
  const claude = {
    id: 'claude', displayName: 'Claude Code', accent: '#D97757', connected: true, enabled: true,
    hookInstalled: true, planLabel: null, planSource: null, planDetected: null,
  };

  function mountWithClaude() {
    const asked = [];
    const handle = settingsMod.createSettings({
      onToggle() {}, onTheme() {}, onLanguage() {}, onAutostart() {}, onPlanLabel() {}, onBack() {}, onTab() {},
      onDisconnect(id) { asked.push(id); },
    });
    const snap = { providers: [claude], usageHistory: null };
    handle.render(state({ snapshot: snap, hasData: true }), [claude]);
    const item = walk(handle.el).find((el) => el.getAttribute('data-provider') === 'claude' && el.tagName === 'LI');
    assert.ok(item, 'no Claude Code item');
    const button = walk(item).find((el) => (el.getAttribute('class') || '').includes('settings__disconnect'));
    const box = walk(item).find((el) => (el.getAttribute('class') || '').includes('settings__confirm'));
    const buttons = walk(box).filter((el) => el.tagName === 'BUTTON');
    return { handle, item, button, box, cancel: buttons[0], confirm: buttons[1], asked, snap };
  }

  test('the button only opens the box; nothing is sent until its confirm is pressed', () => {
    const { button, box, confirm, asked } = mountWithClaude();
    assert.equal(button.hidden, false);
    assert.equal(box.hidden, true, 'the box is open before anything was pressed');
    button.click();
    assert.equal(box.hidden, false);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(asked, [], 'opening the box disconnected');
    assert.match(box.textContent, /Claude Code/);
    confirm.click();
    assert.deepEqual(asked, ['claude']);
    assert.equal(box.hidden, true);
  });

  test('"Vazgeç" and Esc close it and send nothing', () => {
    const { button, box, cancel, asked } = mountWithClaude();
    button.click();
    cancel.click();
    assert.equal(box.hidden, true);
    button.click();
    press(box, 'Escape');
    assert.equal(box.hidden, true);
    assert.deepEqual(asked, []);
  });

  test('the box says what the connection is, in plain words', () => {
    const { button, box } = mountWithClaude();
    button.click();
    assert.match(box.textContent, /tek bir satır|single line/);
    assert.match(box.textContent, /yedeğ|backup/);
  });

  test('once the hook is gone the question goes with it', () => {
    const { handle, button, box } = mountWithClaude();
    button.click();
    const gone = { ...claude, hookInstalled: false };
    handle.render(state({ snapshot: { providers: [gone], usageHistory: null }, hasData: true }), [gone]);
    assert.equal(button.hidden, true);
    assert.equal(box.hidden, true);
  });
});

test.describe('after "Bağlantıyı kaldır" the way back is right there', () => {
  const gone = {
    id: 'claude', displayName: 'Claude Code', accent: '#D97757', connected: true, enabled: true,
    hookInstalled: false, planLabel: null, planSource: null, planDetected: null,
    setupAction: { kind: 'install-bridge', label: 'Bağla', detail: 'Durum satırına bir köprü eklenir.' },
  };

  test('"Bağla" replaces "Bağlantıyı kaldır", the line no longer says "bağlı", and a press goes to the card', () => {
    const asked = [];
    const handle = settingsMod.createSettings({
      onToggle() {}, onTheme() {}, onLanguage() {}, onAutostart() {}, onPlanLabel() {}, onBack() {}, onTab() {},
      onDisconnect() {}, onConnect(id) { asked.push(id); },
    });
    handle.render(state({ snapshot: { providers: [gone], usageHistory: null }, hasData: true, enabledOverride: { claude: true } }), [gone]);
    const item = walk(handle.el).find((el) => el.getAttribute('data-provider') === 'claude' && el.tagName === 'LI');
    const cls = (el) => el.getAttribute('class') || '';
    const off = walk(item).find((el) => cls(el) === 'settings__disconnect');
    const on = walk(item).find((el) => cls(el).includes('settings__connect'));
    assert.equal(off.hidden, true);
    assert.equal(on.hidden, false);
    assert.equal(on.textContent, 'Bağla');
    const meta = walk(item).find((el) => cls(el) === 'settings__meta');
    assert.match(meta.textContent, /bağlı değil|not connected/);
    on.click();
    assert.deepEqual(asked, ['claude']);
  });
});

test.describe('Settings → Tools tooltips say what "bağlı" means (2026-09-30)', () => {
  function metaTitle(provider) {
    const handle = settingsMod.createSettings({
      onToggle() {}, onTheme() {}, onLanguage() {}, onAutostart() {}, onPlanLabel() {}, onBack() {}, onTab() {},
      onDisconnect() {}, onConnect() {}, onReplayIntro() {},
    });
    handle.render(state({ snapshot: { providers: [provider], usageHistory: null }, hasData: true }), [provider]);
    const item = walk(handle.el).find((el) => el.getAttribute('data-provider') === provider.id && el.tagName === 'LI');
    const cls = (el) => el.getAttribute('class') || '';
    return {
      meta: walk(item).find((el) => cls(el) === 'settings__meta').getAttribute('title'),
      toggle: walk(item).find((el) => cls(el) === 'switch').getAttribute('title'),
    };
  }
  const base = { accent: '#000', enabled: true, planLabel: null, planSource: null, planDetected: null };

  test('Claude Code: the bridge, on or off', () => {
    const on = metaTitle({ ...base, id: 'claude', displayName: 'Claude Code', connected: true, hookInstalled: true, setupAction: null });
    assert.match(on.meta, /köprü|bridge/);
    const off = metaTitle({ ...base, id: 'claude', displayName: 'Claude Code', connected: true, hookInstalled: false,
      setupAction: { kind: 'install-bridge', label: 'Bağla', detail: 'x' } });
    assert.match(off.meta, /ekli değil|not in place/);
  });

  test('Codex: read from its own files, nothing to connect', () => {
    const tip = metaTitle({ ...base, id: 'codex', displayName: 'Codex', connected: true, setupAction: null });
    assert.match(tip.meta, /bağlantı gerekmez|no connection is needed/);
    assert.match(tip.toggle, /Codex/);
    assert.notEqual(tip.meta, 'Ana panelde · bağlı', 'the tooltip only repeated the line');
  });
});

// ------------------------------------------- Görünüm: tray icon or taskbar strip

test.describe('Görünüm: "Tepsi simgesi" or "Görev çubuğu şeridi", on the "Genel" tab', () => {
  function mountView() {
    const picked = [];
    const handle = settingsMod.createSettings({
      onToggle() {}, onTheme() {}, onLanguage() {}, onAutostart() {}, onPlanLabel() {}, onBack() {}, onTab() {},
      onDisconnect() {},
      onTrayView(view) { picked.push(view); },
    });
    const group = walk(handle.el).find((el) => el.tagName === 'FIELDSET' && (el.getAttribute('class') || '').includes('theme--tray-view'));
    assert.ok(group, 'no tray view group');
    const radios = walk(group).filter((el) => el.tagName === 'INPUT');
    return { handle, group, radios, picked };
  }

  test('two native radios in a named group, on the Genel tab under the Görünüm heading', () => {
    const { handle, group, radios } = mountView();
    assert.deepEqual(radios.map((r) => [r.getAttribute('type'), r.getAttribute('value')]), [['radio', 'tray'], ['radio', 'strip']]);
    const labels = walk(group).filter((el) => el.tagName === 'LABEL').map((el) => el.textContent);
    assert.deepEqual(labels, ['Tepsi simgesi', 'Görev çubuğu şeridi']);
    assert.ok(walk(group).find((el) => el.tagName === 'LEGEND').textContent, 'the group has a name');
    // It sits in the "Genel" panel, after the theme group and before "Dil".
    const general = walk(handle.el).find((el) => el.getAttribute('role') === 'tabpanel' && walk(el).includes(group));
    assert.ok(general, 'not on a tab panel');
    const kids = walk(general);
    const heading = kids.find((el) => el.tagName === 'H3' && el.textContent === 'Görünüm');
    const language = kids.find((el) => el.tagName === 'H3' && el.textContent === 'Dil');
    assert.ok(kids.indexOf(heading) < kids.indexOf(group) && kids.indexOf(group) < kids.indexOf(language));
  });

  test('the checked radio follows the state, and a pick tells the app', () => {
    const { handle, radios, picked } = mountView();
    handle.render(state({ trayView: 'tray', trayViewPending: false, trayViewReverted: false, stripAvailable: true }), []);
    assert.deepEqual(radios.map((r) => r.checked), [true, false]);
    radios[1].checked = true;
    radios[1].dispatch('change');
    assert.deepEqual(picked, ['strip']);
    handle.render(state({ trayView: 'strip', trayViewPending: true, trayViewReverted: false, stripAvailable: true }), []);
    assert.deepEqual(radios.map((r) => r.checked), [false, true]);
  });

  test('the help line explains; when the strip cannot be shown here it says so instead', () => {
    const { handle, group } = mountView();
    const help = walk(group).find((el) => el.tagName === 'P');
    handle.render(state({ trayView: 'strip', stripAvailable: true }), []);
    assert.match(help.textContent, /saatin solunda/);
    assert.equal(group.getAttribute('data-unavailable'), null);
    handle.render(state({ trayView: 'strip', stripAvailable: false }), []);
    assert.match(help.textContent, /gösterilemiyor; tepsi simgesi kullanılıyor/);
    assert.equal(group.getAttribute('data-unavailable'), 'true');
    handle.render(state({ trayView: 'tray', stripAvailable: false }), []);
    assert.equal(group.getAttribute('data-unavailable'), null, 'no note while the tray icon is chosen');
    handle.render(state({ trayView: 'strip', stripAvailable: true, stripNoRoom: true }), []);
    assert.match(help.textContent, /Görev çubuğunda şerit için yer yok/);
    assert.equal(group.getAttribute('data-unavailable'), 'true');
    handle.render(state({ trayView: 'strip', stripAvailable: false, stripNoRoom: true }), []);
    assert.match(help.textContent, /gösterilemiyor/, '"cannot be shown here" wins over "no room"');
  });
});

// ---------------------------------- Görünüm: no "Gösterge", no "Düzen" any more

test.describe('Görünüm has no "Gösterge" and no "Düzen": the panel has one list', () => {
  function mountLooks() {
    const handle = settingsMod.createSettings({
      onToggle() {}, onTheme() {}, onLanguage() {}, onAutostart() {}, onPlanLabel() {}, onBack() {}, onTab() {},
      onDisconnect() {}, onTrayView() {}, onTransparency() {},
    });
    return { handle };
  }

  test('no gauge or layout group; "Panel görünümü" is the theme, then "Saydamlık", then the taskbar group', () => {
    const { handle } = mountLooks();
    for (const gone of ['theme--gauge', 'theme--layout']) {
      assert.equal(walk(handle.el).some((el) => (el.getAttribute('class') || '').includes(gone)), false, gone);
    }
    assert.equal(walk(handle.el).some((el) => el.tagName === 'INPUT' && /gauge|layout/.test(el.getAttribute('name') || '')), false);
    const glass = walk(handle.el).find((el) => (el.getAttribute('class') || '').includes('settings__item--glass'));
    const general = walk(handle.el).find((el) => el.getAttribute('role') === 'tabpanel' && walk(el).includes(glass));
    const kids = walk(general);
    const theme = kids.find((el) => el.tagName === 'FIELDSET' && el.getAttribute('class') === 'theme');
    const panelHeading = kids.find((el) => el.tagName === 'H3' && el.textContent === 'Panel görünümü');
    const taskbarHeading = kids.find((el) => el.tagName === 'H3' && el.textContent === 'Görev çubuğu');
    assert.ok(kids.indexOf(panelHeading) < kids.indexOf(theme) && kids.indexOf(theme) < kids.indexOf(glass));
    assert.ok(kids.indexOf(glass) < kids.indexOf(taskbarHeading));
  });

  test('every choice shows its name above it: "Tema", "Kullanım nerede görünsün", "Şerit stili"', () => {
    const { handle } = mountLooks();
    const legends = walk(handle.el).filter((el) => el.tagName === 'LEGEND');
    const shown = legends.filter((el) => el.getAttribute('class') === 'theme__label').map((el) => el.textContent);
    assert.deepEqual(shown, ['Tema', 'Kullanım nerede görünsün', 'Şerit stili']);
  });
});

// ------------------------------------------------------- Görünüm: "Saydamlık"

test.describe('Görünüm → "Saydamlık": the Liquid Glass on or off, a switch on the "Genel" tab', () => {
  function mountGlass() {
    const moved = [];
    const handle = settingsMod.createSettings({
      onToggle() {}, onTheme() {}, onLanguage() {}, onAutostart() {}, onPlanLabel() {}, onBack() {}, onTab() {},
      onDisconnect() {}, onTrayView() {},
      onTransparency(level) { moved.push(level); },
    });
    const row = walk(handle.el).find((el) => (el.getAttribute('class') || '').includes('settings__item--glass'));
    assert.ok(row, 'no "Saydamlık" row');
    const control = walk(row).find((el) => el.getAttribute('role') === 'switch');
    return { handle, row, control, moved };
  }

  test('a real switch named "Saydamlık", its help saying where the picture stays, after the theme and before "Dil"', () => {
    const { handle, row, control } = mountGlass();
    assert.equal(control.tagName, 'BUTTON');
    assert.equal(walk(row).some((el) => el.tagName === 'INPUT'), false, 'the old slider is gone');
    const name = findById(handle.el, control.getAttribute('aria-labelledby'));
    assert.equal(name.textContent, 'Saydamlık');
    const help = findById(handle.el, control.getAttribute('aria-describedby'));
    assert.match(help.textContent, /^Panel, arkasındaki ekranı hafif buğulu bir cam gibi gösterir; kapatınca zemin düz olur\./);
    assert.match(help.textContent, /yalnızca bu bilgisayarda, panel açıkken kullanılır\.$/, 'the screen picture is said, and where it stays');
    const general = walk(handle.el).find((el) => el.getAttribute('role') === 'tabpanel' && walk(el).includes(row));
    assert.equal(general.getAttribute('data-tab'), 'general');
    const all = walk(general);
    const theme = all.find((el) => el.tagName === 'FIELDSET' && el.getAttribute('class') === 'theme');
    const language = all.find((el) => el.tagName === 'H3' && el.textContent === 'Dil');
    assert.ok(all.indexOf(theme) < all.indexOf(row) && all.indexOf(row) < all.indexOf(language));
  });

  test('on for any level above 0; a press sends 0 or 100; pending and revert are on the row', () => {
    const { handle, row, control, moved } = mountGlass();
    handle.render(state({ transparency: 45 }), []);
    assert.equal(control.getAttribute('aria-checked'), 'true', "a slider's old level reads as on");
    control.click();
    handle.render(state({ transparency: 0 }), []);
    assert.equal(control.getAttribute('aria-checked'), 'false');
    control.click();
    assert.deepEqual(moved, [0, 100]);
    handle.render(state({ transparency: 100, transparencyPending: true }), []);
    assert.equal(control.getAttribute('aria-busy'), 'true');
    assert.equal(row.getAttribute('data-pending'), 'true');
    handle.render(state({ transparency: 0, transparencyReverted: true }), []);
    assert.equal(control.getAttribute('aria-checked'), 'false');
    assert.equal(control.getAttribute('aria-busy'), null);
    assert.equal(row.getAttribute('data-revert'), 'true');
  });

  test('while Windows asks for less, the switch is disabled and the line under it says why', () => {
    const { handle, control } = mountGlass();
    const help = findById(handle.el, control.getAttribute('aria-describedby'));
    handle.render(state({ transparency: 100, systemReducedTransparency: true }), []);
    assert.equal(control.getAttribute('disabled'), '');
    assert.match(help.textContent, /saydamlık efektleri kapalı ya da yüksek kontrast açık; bu yüzden panel şu an saydam değil/);
    handle.render(state({ transparency: 100, systemReducedTransparency: false }), []);
    assert.equal(control.getAttribute('disabled'), null);
    assert.match(help.textContent, /^Panel, arkasındaki ekranı/);
  });

  test('no slider styles are left behind', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles', 'panel.css'), 'utf8');
    assert.doesNotMatch(css, /glass-slider/);
  });
});

// ------------------------------------------------------ Görünüm: "Şerit stili"

test.describe('Görünüm → "Şerit stili", on the "Genel" tab', () => {
  function mountLooks() {
    const picked = { strip: [] };
    const handle = settingsMod.createSettings({
      onToggle() {}, onTheme() {}, onLanguage() {}, onAutostart() {}, onPlanLabel() {}, onBack() {}, onTab() {},
      onDisconnect() {}, onTrayView() {}, onTransparency() {},
      onStripStyle(style) { picked.strip.push(style); },
    });
    const strip = walk(handle.el).find((el) => el.tagName === 'FIELDSET' && (el.getAttribute('class') || '').includes('theme--strip-style'));
    assert.ok(strip, 'the strip style group is missing');
    const radios = (g) => walk(g).filter((el) => el.tagName === 'INPUT');
    const labels = (g) => walk(g).filter((el) => el.tagName === 'LABEL').map((el) => el.textContent);
    return { handle, strip, radios, labels, picked };
  }

  test('"Şerit stili: Sade / Halkalı / Dolgulu" sits under the tray / strip choice and shows only with the strip', () => {
    const { handle, strip, radios, labels, picked } = mountLooks();
    assert.deepEqual(radios(strip).map((r) => r.getAttribute('value')), ['plain', 'rings', 'fill']);
    assert.deepEqual(labels(strip), ['Sade', 'Halkalı', 'Dolgulu']);
    assert.equal(walk(strip).find((el) => el.tagName === 'LEGEND').textContent, 'Şerit stili');
    const kids = walk(handle.el);
    const trayView = kids.find((el) => el.tagName === 'FIELDSET' && (el.getAttribute('class') || '').includes('theme--tray-view'));
    assert.equal(kids.indexOf(strip), kids.indexOf(trayView) + walk(trayView).length, 'right after the tray / strip group');
    handle.render(state({ trayView: 'tray' }), []);
    assert.equal(strip.hidden, true);
    handle.render(state({ trayView: 'strip', stripStyle: 'fill' }), []);
    assert.equal(strip.hidden, false);
    assert.deepEqual(radios(strip).map((r) => r.checked), [false, false, true]);
    radios(strip)[1].checked = true;
    radios(strip)[1].dispatch('change');
    assert.deepEqual(picked.strip, ['rings']);
    handle.render(state({ trayView: 'strip', stripStyle: 'rings', stripStylePending: true }), []);
    assert.equal(strip.getAttribute('data-pending'), 'true');
  });
});
