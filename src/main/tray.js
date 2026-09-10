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

/**
 * How long, after ONE tray gesture acts, further tray `click`/`double-click`
 * events are treated as the same physical gesture and swallowed.
 *
 * Sized against a real trace: this machine delivers BOTH `click` and
 * `double-click` for a single physical click, 46-53 ms apart (measured gap; the
 * captured pair was 49 ms). 250 ms clears that with wide margin, yet stays well
 * under any deliberate open-then-reclose a human performs by hand — a real
 * second click lands hundreds of ms later and still toggles.
 */
const GESTURE_COALESCE_MS = 250;

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
    // Leading-edge gesture coalescing. `_lastGestureAt` is the timestamp of the
    // last gesture we ACTED on; anything within `GESTURE_COALESCE_MS` of it is
    // the shell's redundant second event for the same physical press and is
    // swallowed. Injectable clock so the suppression window is testable without
    // real waiting; `performance.now()` is monotonic, the same source the trace
    // uses, so its offsets and these are subtractable.
    this._lastGestureAt = -Infinity;
    this._clock = () => performance.now();
  }

  /**
   * Leading edge of one physical gesture: the FIRST event acts immediately (no
   * added latency before the panel opens), every further tray event inside the
   * coalescing window is the same press and is swallowed. This is what makes the
   * app robust to a shell that fires `click` AND `double-click` for one click.
   */
  handleGesture() {
    const now = this._clock();
    const since = now - this._lastGestureAt;
    if (since < GESTURE_COALESCE_MS) {
      // Logged so the next trace shows the coalescing working, not a silent gap.
      log.trace('tray.suppressed', { sinceMs: since });
      return;
    }
    this._lastGestureAt = now;
    this.handlers.onToggle(this.bounds());
  }

  create({ autostart, onToggleAutostart, onQuit }) {
    this.tray = new Tray(createTrayIcon());
    this.tray.setToolTip('Usage Notch');

    // BOTH events funnel into the SAME coalesced toggle. Windows delivers
    // `click` and then `double-click` for one physical press on the reporting
    // machine — the real trace shows the pair 49 ms apart, far faster than any
    // human double-click (a chattering switch or a driver, irrelevant: the app
    // has to be robust to it). The previous design bound `double-click` to an
    // idempotent-OPEN to stop the second event closing what the first opened,
    // but that only converts the failure: from a HIDDEN panel it read clean,
    // yet from a VISIBLE panel the click hid and the double-click re-opened
    // 49 ms later — the reported hide-then-show FLASH on the 2nd+ open.
    //
    // The fix is not a second special handler; it is to recognise the two
    // shell events as ONE gesture. `handleGesture` acts on the leading edge and
    // swallows anything within GESTURE_COALESCE_MS. So one physical click = one
    // toggle whether the shell sends `click`, `double-click`, or both.
    //
    // The `double-click`->onOpen binding is therefore DROPPED, not kept. Once
    // suppression lands it would be dead anyway: a `double-click` always trails
    // a `click` inside the window, so it is always the suppressed second event
    // and its handler would never run. Routing it through the same toggle is
    // also more robust — a machine that somehow emitted `double-click` alone
    // would still get one clean toggle instead of an open-only. (`onOpen` is
    // still provided by the caller; it is simply no longer wired here.)
    //
    // The `log.trace` line stays BEFORE the suppression check on purpose: the
    // trace must show what the SHELL delivered, not what we decided — that
    // transparency is the only reason this bug was diagnosable at all.
    this.tray.on('click', () => {
      log.trace('tray.click');
      this.handleGesture();
    });
    this.tray.on('double-click', () => {
      log.trace('tray.double-click');
      this.handleGesture();
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
