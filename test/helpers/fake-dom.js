'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { stripTypeScriptTypes } = require('node:module');
const { inlineJsonImports } = require('../../src/renderer/inline-json.cjs');

/**
 * Just enough DOM to MOUNT THE WHOLE RENDERER APP (`mountApp` in
 * src/renderer/src/app.ts) in plain Node, so app-level state rules — revert to
 * the last confirmed preference, clear a consent prompt on a language change,
 * switch language only on main's push — can be unit-tested without Electron.
 *
 * It is a shim, not a browser. It has no layout (every rect is 400x40), no CSS,
 * no focus management beyond `document.activeElement`, and selector support
 * limited to `.class`, `#id` and `tag` — which is all app.ts and the components
 * ask of it today. A component that starts relying on more will throw here
 * first; extend the shim rather than stubbing the component. Pixel, focus-ring
 * and animation behaviour stays with the render suite (test/render/).
 *
 * `settings-accordion.test.js` keeps its own smaller shim; this one is a
 * superset for whole-app mounts.
 */

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this._text = String(text);
    this.parentNode = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

class ClassList {
  constructor(el) { this.el = el; }
  _get() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _set(list) { this.el.setAttribute('class', list.join(' ')); }
  add(...names) { const l = this._get(); for (const n of names) if (!l.includes(n)) l.push(n); this._set(l); }
  remove(...names) { this._set(this._get().filter((n) => !names.includes(n))); }
  contains(name) { return this._get().includes(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

function matches(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  // A selector list, and a bare `[attr]` / `[attr="value"]`: row.ts asks
  // closest('button, a, …, [role="button"]') of a click's target.
  if (selector.includes(',')) return selector.split(',').some((part) => matches(node, part.trim()));
  const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (attr) return attr[2] === undefined ? node.hasAttribute(attr[1]) : node.getAttribute(attr[1]) === attr[2];
  const sel = selector.split(':')[0];
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return node.getAttribute('id') === sel.slice(1);
  return node.tagName === sel.toUpperCase();
}

function walk(node, out = []) {
  if (node && node.nodeType === 1) {
    out.push(node);
    for (const child of node.childNodes) walk(child, out);
  }
  return out;
}

class FakeElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.listeners = new Map();
    this.parentNode = null;
    this.hidden = false;
    this.classList = new ClassList(this);
    this.dataset = {};
    this.style = {
      _p: new Map(),
      setProperty(k, v) { this._p.set(k, String(v)); },
      removeProperty(k) { this._p.delete(k); },
      getPropertyValue(k) { return this._p.get(k) || ''; },
    };
    this.offsetHeight = 40;
    this.clientHeight = 600;
    this.clientWidth = 400;
    this.scrollTop = 0;
  }
  setAttribute(n, v) { this.attributes.set(n, String(v)); }
  getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null; }
  hasAttribute(n) { return this.attributes.has(n); }
  removeAttribute(n) { this.attributes.delete(n); }
  toggleAttribute(n, force) { if (force) this.setAttribute(n, ''); else this.removeAttribute(n); }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n); }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = this.childNodes.indexOf(ref);
    node.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...nodes); }
  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    parent.insertBefore(node, this);
    parent.removeChild(this);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(type, fn) { const l = this.listeners.get(type) || []; l.push(fn); this.listeners.set(type, l); }
  removeEventListener(type, fn) { const l = this.listeners.get(type) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of (this.listeners.get(type) || []).slice()) fn(event);
  }
  click() { this.dispatch('click'); }
  focus() { globalThis.document.activeElement = this; }
  blur() {}
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
  matches(sel) { return matches(this, sel); }
  querySelector(sel) { return walk(this).slice(1).find((n) => matches(n, sel)) || null; }
  querySelectorAll(sel) { return walk(this).slice(1).filter((n) => matches(n, sel)); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 400, height: 40, bottom: 40, right: 400, x: 0, y: 0 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  scrollIntoView() {}
  animate() { return { finished: Promise.resolve(), cancel() {} }; }
  get firstElementChild() { return this.childNodes.find((n) => n.nodeType === 1) || null; }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const kids = this.parentNode.childNodes;
    for (let i = kids.indexOf(this) + 1; i < kids.length; i += 1) if (kids[i].nodeType === 1) return kids[i];
    return null;
  }
  get textContent() { return this.childNodes.map((n) => n.textContent || '').join(''); }
  set textContent(v) { this.childNodes = []; if (v !== '' && v != null) this.appendChild(new FakeText(v)); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
}

/** Installs document/window globals. Returns restore(). */
function installDom({ prefersDark = true } = {}) {
  const saved = {};
  for (const k of ['document', 'window', 'Element', 'HTMLElement', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  const unref = (handle) => { if (handle && handle.unref) handle.unref(); return handle; };
  const docListeners = new Map();
  const doc = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(text),
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    activeElement: null,
    hidden: false,
    title: '',
    addEventListener(type, fn) { docListeners.set(type, fn); },
    removeEventListener(type) { docListeners.delete(type); },
    querySelector(sel) { return doc.body.querySelector(sel); },
  };
  const win = {
    matchMedia: () => ({ matches: prefersDark, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (fn, ms) => unref(setInterval(fn, ms)),
    clearInterval: (h) => clearInterval(h),
    requestAnimationFrame: (fn) => unref(setTimeout(fn, 0)),
    cancelAnimationFrame: (h) => clearTimeout(h),
    addEventListener() {},
    removeEventListener() {},
  };
  const define = (k, value) => Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  define('document', doc);
  define('window', win);
  define('Element', FakeElement);
  define('HTMLElement', FakeElement);
  define('requestAnimationFrame', win.requestAnimationFrame);
  define('cancelAnimationFrame', win.cancelAnimationFrame);
  return () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  };
}

/**
 * Strips every renderer .ts (plus contract.ts) into a temp mirror of src/,
 * inlining catalog JSON exactly as build.mjs does. Returns { dir, load, cleanup }.
 */
function mirrorRenderer() {
  const SRC = path.join(__dirname, '..', '..', 'src');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notch-app-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}', 'utf8');
  const files = [];
  const collect = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) collect(full);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.push(full);
    }
  };
  collect(path.join(SRC, 'renderer', 'src'));
  files.push(path.join(SRC, 'shared', 'contract.ts'));
  for (const file of files) {
    const out = path.join(dir, path.relative(SRC, file).replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const js = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' });
    fs.writeFileSync(out, inlineJsonImports(js, file).code, 'utf8');
  }
  return {
    dir,
    load: (...parts) => import(pathToFileURL(path.join(dir, 'renderer', 'src', ...parts)).href),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

module.exports = { FakeElement, FakeText, installDom, mirrorRenderer, walk };
