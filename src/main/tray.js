'use strict';
const path = require('node:path');
const { Tray, Menu, nativeImage, app } = require('electron');
const log = require('../core/log');

/**
 * Tray icon and its click behaviour.
 *
 * Hover deliberately does NOTHING here. It used to open the panel through the
 * Tray's Windows-only `mouse-enter`, which meant a pointer merely crossing the
 * icon on its way somewhere else threw a 440x680 always-on-top window over the
 * user's work. Hover is now served by the NATIVE tooltip — see
 * `src/core/tray-tooltip.js` — which the shell shows instantly and takes down
 * the moment the pointer leaves, with no window involved. Replacing one
 * uninvited window with a smaller uninvited window would have missed the
 * point; not opening a window is the fix.
 *
 * `getBounds()` is re-read on every open rather than cached: the icon moves
 * whenever the overflow area reflows, the taskbar changes edge, or the user
 * drags it.
 */
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');

function createTrayIcon() {
  const image = nativeImage.createFromPath(ICON_PATH);
  // Let Windows use the 2x/4x representations on a HiDPI taskbar.
  for (const [scale, file] of [[2, 'tray-icon@2x.png'], [4, 'tray-icon@4x.png']]) {
    const rep = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', file));
    if (!rep.isEmpty()) image.addRepresentation({ scaleFactor: scale, buffer: rep.toPNG() });
  }
  return image;
}

class TrayController {
  constructor(handlers) {
    this.tray = null;
    this.handlers = handlers;
  }

  create({ autostart, onToggleAutostart, onQuit }) {
    this.tray = new Tray(createTrayIcon());
    this.tray.setToolTip('Usage Notch');

    // The two bindings are NOT the same handler. Windows delivers `click` and
    // then `double-click` for one double-click gesture — measured here with
    // synthetic input on a real tray icon: a single click fired the handler
    // once, a double-click fired it twice, 77 ms apart. Pointing both at a
    // TOGGLE therefore opened and immediately closed the panel, so the
    // habitual double-click a tray app invites left it shut after a flash.
    //
    // `double-click` is idempotent-open instead: it can only ever end with the
    // panel on screen, whichever order the two events arrive in.
    //
    // That measurement was SYNTHETIC (`SendInput`), and a user reports a flash
    // on one real physical click. The trace line goes in before the handler so
    // the log shows what the shell delivered, not what we did about it — if
    // Windows sends `click` twice for one press, only this can say so.
    this.tray.on('click', () => {
      log.trace('tray.click');
      this.handlers.onToggle(this.bounds());
    });
    this.tray.on('double-click', () => {
      log.trace('tray.double-click');
      this.handlers.onOpen(this.bounds());
    });

    // Hover is OBSERVED, never acted on. It used to open the panel through
    // `mouse-enter`, which threw a 440x680 always-on-top window over the
    // user's work whenever a pointer merely crossed the icon; hover is served
    // by the native tooltip now (`src/core/tray-tooltip.js`). These two
    // listeners call nothing but the logger, and the gesture suite asserts
    // exactly that — a tray hover has to be visible in the trace, because
    // "the pointer was still over the icon when the panel took focus" is one
    // of the candidate explanations for the reported flash, and it is not
    // decidable from the click line alone.
    this.tray.on('mouse-enter', () => log.trace('tray.mouse-enter'));
    this.tray.on('mouse-leave', () => log.trace('tray.mouse-leave'));

    this.setMenu({ autostart, onToggleAutostart, onQuit });
    return this.tray;
  }

  setMenu({ autostart, onToggleAutostart, onQuit }) {
    const menu = Menu.buildFromTemplate([
      { label: `Usage Notch ${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Windows açılışında başlat',
        type: 'checkbox',
        checked: Boolean(autostart),
        click: (item) => onToggleAutostart(item.checked),
      },
      { type: 'separator' },
      { label: 'Çıkış', click: () => onQuit() },
    ]);
    // Left click must open the panel, so the menu is bound to right click only.
    this.tray.setContextMenu(menu);
  }

  /** Screen-coordinate rect of the icon, or null when Windows will not say. */
  bounds() {
    if (!this.tray || this.tray.isDestroyed()) return null;
    try {
      const b = this.tray.getBounds();
      if (!b || (b.width === 0 && b.height === 0)) return null;
      return b;
    } catch {
      return null;
    }
  }

  /**
   * Swaps in a freshly drawn donut. A null image means the renderer could not
   * build one, and the icon already on screen — the static PNG at worst — is
   * left alone rather than cleared.
   */
  setIcon(image) {
    if (!image || image.isEmpty()) return false;
    if (!this.tray || this.tray.isDestroyed()) return false;
    try {
      this.tray.setImage(image);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The hover surface. Multi-line, and already inside the shell's budget when
   * it gets here (`src/core/tray-tooltip.js`) — Windows truncates
   * `NOTIFYICONDATAW.szTip` silently, and Electron neither throws nor offers a
   * getter, so nothing below this line could detect a string that was cut.
   */
  setTooltip(text) {
    if (this.tray && !this.tray.isDestroyed()) this.tray.setToolTip(String(text));
  }

  destroy() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}

module.exports = { TrayController, createTrayIcon, ICON_PATH };
