/**
 * The only way this renderer is allowed to build DOM.
 *
 * Provider names, model names and project slugs originate from the filesystem
 * and from file contents we do not control. `innerHTML` is therefore banned
 * outright: every string that reaches the document does so as a text node or
 * through `setAttribute`, both of which escape by construction.
 */

export type Attrs = Record<string, string | number | boolean | null | undefined>;
export type Child = Node | string | number | null | undefined | false;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The one attribute denylist, shared by `el()` and `svg()`.
 *
 * It lived only in `el()`, so its sibling accepted `href`, `src` and every
 * `on*` handler in the SVG namespace — where `<svg><a href>` and
 * `xlink:href` are both real vectors. No call site passes anything but
 * literals, so nothing was reachable, but a guardrail that protects one of two
 * identical doors is not a guardrail. `xlink:href` is here because the
 * deprecated namespaced form is still honoured by every browser and is the
 * spelling a sanitiser is most likely to miss.
 */
function forbiddenAttr(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.startsWith('on') ||
    lower === 'srcdoc' ||
    lower === 'href' ||
    lower === 'src' ||
    lower === 'xlink:href' ||
    lower === 'xlink:show' ||
    lower === 'xlink:actuate' ||
    lower === 'formaction' ||
    lower === 'action'
  );
}

function applyAttrs(node: Element, attrs: Attrs): void {
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === null || value === undefined || value === false) continue;

    // Inline event handlers and URL-bearing attributes are never needed here,
    // and each one is a way for file-sourced text to become behaviour.
    if (forbiddenAttr(key)) {
      throw new Error(`dom: attribute "${key}" is not permitted`);
    }

    if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

function appendChildren(node: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

/**
 * The SVG tags this renderer is allowed to create. A closed union rather than
 * `string`: the three marks, the two header icons and the tail are the entire
 * vocabulary, and an unconstrained tag name in the SVG namespace reaches
 * `<foreignObject>`, `<script>` and `<use>` — the elements that turn a drawing
 * primitive into a script host. Widening this list should be a decision, not
 * a typo.
 */
export type SvgTag = 'svg' | 'path' | 'circle';

/** SVG needs its own namespace; same escaping and the same denylist. */
export function svg(tag: SvgTag, attrs?: Attrs, ...children: Child[]): SVGElement {
  const node = document.createElementNS(SVG_NS, tag) as SVGElement;
  if (attrs) applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

/** Idempotent text write. Avoids churning the DOM when nothing changed. */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setAttr(node: Element, name: string, value: string | null): void {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replaceChildrenWith(node: Element, children: readonly Child[]): void {
  clear(node);
  appendChildren(node, children);
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement,
  type: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
): () => void {
  node.addEventListener(type, handler as EventListener);
  return () => node.removeEventListener(type, handler as EventListener);
}
