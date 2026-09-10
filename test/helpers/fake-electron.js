'use strict';

/**
 * A stand-in for `electron`, so the panel's OPEN/PIN/LEAVE state machine can
 * be tested under plain `node --test`.
 *
 * That state machine is the part of `src/main/panel-window.js` with real logic
 * in it — a latch, a poll and a grace timer, which between them decide whether
 * the user's panel disappears while they are reading it. The pixels and the
 * window flags are already covered by the Electron smoke run; what was NOT
 * covered was the ordering, and ordering is where this class of bug lives.
 *
 * Installed by replacing the `electron` entry in `require.cache` BEFORE
 * `panel-window.js` is required. `node --test` gives each test file its own
 * process, so the substitution cannot leak into another suite.
 */

const DISPLAY = {
  id: 1,
  scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 },
};

/**
 * Enough of `Tray` to exercise the gesture wiring. Deliberately event-driven
 * in the same shape as the real one, so a test fires `click` / `double-click`
 * exactly as Windows does.
 */
class FakeTray {
  constructor() {
    this.destroyed = false;
    this.tooltip = null;
    this.image = null;
    this.menu = null;
    this.listeners = new Map();
    this.bounds = { x: 1231, y: 816, width: 33, height: 48 };
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  emit(event, ...args) {
    for (const handler of this.listeners.get(event) || []) handler(...args);
  }

  listenerCount(event) { return (this.listeners.get(event) || []).length; }
  isDestroyed() { return this.destroyed; }
  getBounds() {
    if (this.destroyed) throw new Error('tray is destroyed');
    return { ...this.bounds };
  }
  setToolTip(text) { this.tooltip = text; }
  setImage(image) { this.image = image; }
  setContextMenu(menu) { this.menu = menu; }
  destroy() { this.destroyed = true; }
}

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.visible = false;
    this.focused = false;
    this.activations = [];
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
    /** How many times the page was (re)loaded. A revive costs one. */
    this.loads = 0;
    this.listeners = new Map();
    // Recording, and able to fire its own events. `panel-window.js` subscribes
    // to `render-process-gone` and reloads once; nothing could observe what the
    // revived renderer is (or is not) told without this.
    const wcListeners = new Map();
    this.webContents = {
      /** Every IPC push, in order: `{ channel, payload }`. */
      sent: [],
      on(event, handler) {
        if (!wcListeners.has(event)) wcListeners.set(event, []);
        wcListeners.get(event).push(handler);
      },
      emit(event, ...args) {
        for (const handler of wcListeners.get(event) || []) handler(...args);
      },
      isDestroyed: () => false,
      send(channel, payload) {
        this.sent.push({ channel, payload });
      },
    };
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  /** Fires a window event, the way Electron would. */
  emit(event, ...args) {
    for (const handler of this.listeners.get(event) || []) handler(...args);
  }

  listenerCount(event) {
    return (this.listeners.get(event) || []).length;
  }

  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setMenu() {}
  loadFile() { this.loads++; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  setBounds(b) { this.bounds = { ...b }; }
  getBounds() { return { ...this.bounds }; }
  show() { this.visible = true; this.focused = true; this.activations.push('show'); }
  showInactive() { this.visible = true; this.activations.push('showInactive'); }
  // Real `moveTop()` reorders z-order without activating: it must NOT touch
  // `focused`. Recorded in `activations` so a test can assert it ran, and that
  // it ran AFTER the show rather than before it.
  moveTop() { this.activations.push('moveTop'); }
  focus() { this.focused = true; }
  hide() { this.visible = false; this.focused = false; }
  destroy() { this.destroyed = true; }
}

function install() {
  const cursor = { x: 0, y: 0 };
  const created = [];

  const trays = [];

  const fake = {
    app: { isPackaged: false, getPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
    Tray: class extends FakeTray {
      constructor() { super(); trays.push(this); }
    },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0), addRepresentation: () => {} }),
    },
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        created.push(this);
      }
    },
    screen: {
      getCursorScreenPoint: () => ({ ...cursor }),
      getAllDisplays: () => [DISPLAY],
      getDisplayNearestPoint: () => DISPLAY,
    },
  };

  const id = require.resolve('electron');
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: fake, children: [], paths: [] };

  return {
    fake,
    created,
    trays,
    /** Moves the OS cursor the poll reads. */
    moveCursor(x, y) { cursor.x = x; cursor.y = y; },
    restore() {
      if (previous) require.cache[id] = previous;
      else delete require.cache[id];
    },
  };
}

module.exports = { install, DISPLAY };
