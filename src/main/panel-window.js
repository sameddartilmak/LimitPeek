'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, screen, app } = require('electron');
const { IPC } = require('../shared/contract');
const log = require('../core/log');

/**
 * The panel window.
 *
 * Created ONCE, at its maximum size, transparent and hidden. It is never
 * destroyed and recreated per hover: on Windows that costs a fresh renderer
 * process (~150 ms and a visible flash) every time the pointer crosses the
 * tray icon. It is also never animated by moving the OS window — the renderer
 * animates its own content inside a fixed frame, which stays smooth because it
 * is a compositor job rather than a stream of SetWindowPos calls.
 */
const PANEL_WIDTH = 440;
const PANEL_HEIGHT = 680;
const EDGE_MARGIN = 8;
/** Size of the stand-in rect used when the real tray rect is unavailable. */
const SYNTHETIC_TRAY_SIZE = 16;
/**
 * How long an UNPINNED panel survives after the pointer leaves it. Unchanged
 * from the old tray-mouse-leave grace period, which was measured against a
 * real pointer travelling between two windows.
 */
const LEAVE_GRACE_MS = 550;
/**
 * How often main asks where the pointer is while an unpinned panel is open.
 *
 * Main has to answer "is the pointer over the panel" itself, and it is the ONLY
 * side that can: the renderer sees DOM events, never the OS cursor. The
 * `panelOpened()` keep-alive fires on pointerenter/pointermove/pointerdown, so
 * a pointer that is INSIDE the panel but not moving emits nothing at all —
 * treating that silence as departure would close the panel under a resting
 * cursor, which is the same over-eager dismissal this change exists to remove.
 * The keep-alive can still EXTEND a life this poll already granted (see
 * `notePointerInside`); it can no longer establish one.
 */
const POINTER_POLL_MS = 250;
/**
 * How long after the panel is shown that `blur` is ignored.
 *
 * Two jobs, and the second is the load-bearing one:
 *
 *  1. It absorbs any transient blur that activation itself might emit. Measured
 *     on Electron 44.2.0 here, none does: across open(), open() with a live
 *     Tray in the process, and pin(), `focus` arrived 3-19 ms after `show` and
 *     the only `blur` was the one the harness caused 2.5 s later by hiding the
 *     window. A control that opened a second window at +800 ms produced a blur
 *     at +830 ms, so the event does track real activation loss. The delay is
 *     therefore belt-and-braces against a case this process cannot synthesise
 *     — a physical click on the shell's own tray window — sized at roughly 20x
 *     the worst measured focus latency.
 *
 *  2. It guarantees at least one pointer poll has run before `blur` may act.
 *     MUST stay greater than POINTER_POLL_MS: otherwise a blur arriving in the
 *     first 250 ms would see `_pointerSeen` still false and dismiss a panel the
 *     pointer was already sitting on.
 *
 *  3. It has to outlast the shell's own focus handoff — the case (1) called
 *     unsynthesisable. It has since been MEASURED, from real tray clicks on
 *     this machine: `blur` arrived 414, 425, 500, 505, 510, 656, 729, 769,
 *     860, 1088 and 1355 ms after `show`. EVERY sample landed past the old
 *     400 ms floor, so every one of them took the immediate-hide path and the
 *     panel dismissed itself while the pointer was still on the tray icon;
 *     four hides in that one session were `timer:blur`. The user's report —
 *     "it opens, shuts, and opens again" — is that hide racing the second
 *     click that cancels it.
 *
 *     1200 clears ten of the eleven samples, and the eleventh (1355) is long
 *     enough after the click to be a real departure. What matters more than
 *     the percentile is that the window is now longer than the trip a hand
 *     makes from the tray icon to the panel: arriving sets `_pointerSeen`,
 *     which retires `blur` from the decision entirely.
 */
const BLUR_ARM_MS = 1200;
/**
 * How long a blur arriving AFTER the arming window is held before it is
 * believed.
 *
 * The old code had a cliff exactly at BLUR_ARM_MS. A blur at 399 ms was
 * treated as suspicious — deferred, then dropped if `isFocused()` had come
 * back — while one at 401 ms was believed outright and hid the panel with no
 * second look. The measured blurs cluster on both sides of that cliff, so two
 * halves of the same physical event were being judged by different rules.
 * Every blur is confirmed once now; only the length of the wait differs.
 *
 * Greater than POINTER_POLL_MS for the same reason the arming window is: a
 * poll must be able to latch the pointer inside the confirmation.
 */
const BLUR_CONFIRM_MS = 300;

class PanelWindow {
  constructor(options = {}) {
    this.width = options.width || PANEL_WIDTH;
    this.height = options.height || PANEL_HEIGHT;
    // Overridable only so `scripts/smoke-ipc.js` can drive the preload surface
    // against a page this lane owns. Production always resolves it.
    this.entry = options.entry || null;
    this.win = null;
    this.pinned = false;
    this._hideTimer = null;
    this._pointerTimer = null;
    /**
     * Has the pointer been inside the panel at least once since it opened?
     *
     * The transit problem: the user clicks the tray, then moves the pointer
     * towards the panel, and for that moment it is over neither. Arming the
     * leave timer at open would close the panel mid-journey. So the timer does
     * not exist until this latch is set.
     */
    this._pointerSeen = false;
    /** When the window was last SHOWN. Only the blur path reads it. */
    this._shownAt = 0;
    /** A blur that arrived inside the arming window, waiting to be re-asked. */
    this._blurTimer = null;
    this.onPinChange = options.onPinChange || (() => {});
    this.onVisibilityChange = options.onVisibilityChange || (() => {});
  }

  create() {
    if (this.win) return this.win;
    const entry = this.entry || resolveRendererEntry();

    this.win = new BrowserWindow({
      width: this.width,
      height: this.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      backgroundColor: '#00000000',
      title: 'Usage Notch',
      icon: path.join(__dirname, '..', '..', 'assets', 'tray-icon@4x.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        spellcheck: false,
        enableWebSQL: false,
        devTools: !app.isPackaged,
        backgroundThrottling: false,
      },
    });

    // Above the taskbar and other topmost windows, but not a screensaver-level
    // grab that would sit over UAC or full-screen apps.
    this.win.setAlwaysOnTop(true, 'pop-up-menu');
    this.win.setVisibleOnAllWorkspaces(true);
    this.win.setMenu(null);

    // Blur is now the NARROWEST of the three dismissal paths, and the
    // inversion is the point (contract.ts, `AnchorPayload.mode`). It used to
    // hide when PINNED — "click outside dismisses a popover" — so the one
    // control the user pressed to keep the panel on screen was the control
    // that armed its dismissal. It now never touches a pinned panel, and only
    // ever touches an unpinned one the pointer has not reached. See `_onBlur`.
    this.win.on('blur', () => this._onBlur());

    this.win.on('closed', () => { this.win = null; });

    const wc = this.win.webContents;

    // A dead renderer would leave a tray icon that opens nothing. Bring it
    // back once; if it dies again we stop, rather than spin.
    let revived = false;
    wc.on('render-process-gone', (_event, details) => {
      log.warn(`panel renderer gone: reason=${(details && details.reason) || 'unknown'}`);
      if (revived || !this.win || this.win.isDestroyed()) return;
      revived = true;
      this.win.loadFile(entry);
    });
    wc.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
      // `url` is one of our own local files; nothing user-derived is logged.
      if (isMainFrame) log.warn(`panel failed to load: code=${code}`);
    });
    wc.on('preload-error', () => log.warn('panel preload failed'));
    if (!app.isPackaged) {
      wc.on('did-finish-load', () => log.info(`panel loaded: ${path.basename(entry)}`));
    }

    this.win.loadFile(entry);
    return this.win;
  }

  isVisible() {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  /**
   * Places the panel next to the tray icon on the display that actually owns
   * the icon, and reports the geometry the renderer needs to point its arrow
   * at the right pixel.
   */
  positionFor(trayBounds) {
    if (!this.win || this.win.isDestroyed()) return null;

    // Everything below is in Electron's DIP screen space. Verified on this
    // machine at scaleFactor 1.25 (physical 1920x1080): display.bounds reads
    // 1536x864, tray.getBounds() reads {x:1263,y:816,w:33,h:48} with y exactly
    // equal to workArea.height, and dipToScreenRect(tray) returns
    // {1579,1020,42,60} = tray * 1.25. So Tray, BrowserWindow and Display all
    // report DIP and the renderer must NOT multiply by scaleFactor to line the
    // tail up with the icon.
    const realTray = isPlausibleDipRect(trayBounds) ? trayBounds : null;
    if (trayBounds && !realTray) {
      // Falls outside every display, so it cannot be a DIP screen rect. Better
      // a cursor-anchored panel than one pointing a quarter-screen away.
      log.warn('tray bounds outside all displays; falling back to cursor anchor');
    }

    // `tray` is non-nullable in AnchorPayload. Sending null here made the
    // renderer reject the WHOLE payload, taking `edge` and `mode` down with it
    // — so the pin control lied about its state and the tail pointed nowhere.
    // This is a common path, not an edge case: Windows 11 files new tray icons
    // into the hidden-icons overflow, where getBounds() reports zero size.
    // So we synthesise a rect around the fallback anchor point and tell the
    // renderer where it came from, rather than sending nothing.
    const anchorSource = realTray ? 'tray' : 'cursor';
    const anchorPoint = realTray
      ? { x: Math.round(realTray.x + realTray.width / 2), y: Math.round(realTray.y + realTray.height / 2) }
      : screen.getCursorScreenPoint();
    const tray = realTray || {
      x: Math.round(anchorPoint.x - SYNTHETIC_TRAY_SIZE / 2),
      y: Math.round(anchorPoint.y - SYNTHETIC_TRAY_SIZE / 2),
      width: SYNTHETIC_TRAY_SIZE,
      height: SYNTHETIC_TRAY_SIZE,
    };
    const display = screen.getDisplayNearestPoint(anchorPoint);
    const work = display.workArea;
    const edge = taskbarEdge(display, anchorPoint);

    // Clamped on BOTH axes in every branch. Without this the panel hangs off
    // the screen at a taskbar corner, where centring on the icon puts half of
    // it past the edge — and the renderer's tail-clamp has nothing to clamp
    // against.
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const minX = work.x + EDGE_MARGIN;
    const maxX = work.x + work.width - this.width - EDGE_MARGIN;
    const minY = work.y + EDGE_MARGIN;
    const maxY = work.y + work.height - this.height - EDGE_MARGIN;

    let x;
    let y;
    if (edge === 'left' || edge === 'right') {
      x = clamp(edge === 'left' ? minX : maxX, minX, maxX);
      y = clamp(Math.round(anchorPoint.y - this.height / 2), minY, maxY);
    } else {
      x = clamp(Math.round(anchorPoint.x - this.width / 2), minX, maxX);
      y = clamp(edge === 'top' ? minY : maxY, minY, maxY);
    }

    this.win.setBounds({ x: Math.round(x), y: Math.round(y), width: this.width, height: this.height });

    // Report what the OS actually gave us, not what we asked for. On a
    // fractional scale factor Chromium rounds the size through physical
    // pixels: measured here, setBounds(440x680) reads back as 442x681. The
    // renderer clamps its tail against this rect, so it has to be the real one.
    const bounds = this.win.getBounds();

    return {
      tray,
      anchorSource,
      display: {
        id: display.id,
        scaleFactor: display.scaleFactor,
        bounds: display.bounds,
        workArea: work,
      },
      window: bounds,
      edge,
    };
  }

  /**
   * Tray-click open. Activates the window, and does NOT pin it.
   *
   * Taking focus is now safe, and it is a simplification worth having: the
   * panel is no longer opened by a pointer merely crossing the tray icon, so
   * there is no longer a case where showing it steals focus from something the
   * user was typing into. Keyboard navigation and the drag gesture both work
   * in an activated window with no special handling.
   */
  open(trayBounds, sendAnchor) {
    this.cancelHide('open');
    this._cancelBlurRecheck();
    this.create();
    this._shownAt = Date.now();
    const anchor = this.positionFor(trayBounds);
    if (anchor && typeof sendAnchor === 'function') {
      sendAnchor({ ...anchor, mode: this.pinned ? 'pin' : 'hover' });
    }
    const wasVisible = this.win.isVisible();
    this.win.show();
    this.win.focus();
    log.trace('panel.show', {
      was: wasVisible,
      visible: this.win.isVisible(),
      pinned: this.pinned,
      anchor: anchor ? anchor.anchorSource : 'none',
    });
    if (!wasVisible) this.onVisibilityChange(true);
    // Re-armed on every open, including a re-open of an already visible panel:
    // the pointer is back at the tray icon, so the transit grace starts again.
    if (!this.pinned) this._startPointerWatch();
  }

  /**
   * Non-activating open. Nothing in the product calls this any more — the tray
   * no longer opens the panel on hover — but the smoke test drives it to hold
   * the property that makes it safe to reintroduce: it shows without stealing
   * focus.
   */
  showInactive(trayBounds, sendAnchor) {
    this.cancelHide('showInactive');
    this._cancelBlurRecheck();
    this.create();
    this._shownAt = Date.now();
    const anchor = this.positionFor(trayBounds);
    if (anchor && typeof sendAnchor === 'function') {
      sendAnchor({ ...anchor, mode: this.pinned ? 'pin' : 'hover' });
    }
    const wasVisible = this.win.isVisible();
    if (!wasVisible) {
      this.win.showInactive();
      this.onVisibilityChange(true);
    }
    log.trace('panel.showInactive', {
      was: wasVisible,
      visible: this.win.isVisible(),
      pinned: this.pinned,
    });
    if (!this.pinned) this._startPointerWatch();
  }

  /**
   * Pin: the panel stays on screen regardless of focus.
   *
   * Nothing dismisses it but an explicit close or unpin — no blur, no app
   * switch, no click elsewhere on the desktop — so the pointer watch is
   * stopped outright rather than merely ignored.
   */
  pin(trayBounds, sendAnchor) {
    this.cancelHide('pin');
    this._stopPointerWatch();
    this._cancelBlurRecheck();
    this.create();
    this._shownAt = Date.now();
    this.pinned = true;
    const anchor = this.positionFor(trayBounds);
    if (anchor && typeof sendAnchor === 'function') sendAnchor({ ...anchor, mode: 'pin' });
    const wasVisible = this.win.isVisible();
    this.win.show();
    this.win.focus();
    log.trace('panel.pin', { was: wasVisible, visible: this.win.isVisible() });
    if (!wasVisible) this.onVisibilityChange(true);
    this.onPinChange(true);
  }

  /**
   * Unpin, leaving the panel open and back under pointer control.
   *
   * The pin control in the panel is a TOGGLE, so main has to be able to answer
   * both ways; without this the button could only ever be pressed once and the
   * state it reported would be a one-way door. The latch is reset rather than
   * assumed: the pointer is over the panel right now (the user just clicked
   * the control), so the very next poll sets it, and the panel then behaves
   * exactly like a freshly click-opened one.
   */
  unpin(trayBounds, sendAnchor) {
    if (!this.pinned) return;
    this.pinned = false;
    log.trace('panel.unpin', { visible: this.isVisible() });
    this.onPinChange(false);
    if (!this.isVisible()) return;
    // The REAL tray rect, exactly as `open()` and `pin()` use it. Passing null
    // here anchored to the CURSOR instead, and `positionFor()` calls
    // `setBounds()` — so unpinning teleported the panel to wherever the mouse
    // happened to be. Unpinning changes a mode, not a place.
    const anchor = this.positionFor(trayBounds);
    if (anchor && typeof sendAnchor === 'function') sendAnchor({ ...anchor, mode: 'hover' });
    // `_shownAt` is deliberately NOT re-stamped here. BLUR_ARM_MS exists to
    // absorb the focus transient that ACTIVATION can emit, and unpinning
    // activates nothing — the window is already up, focused and settled.
    // Re-arming would only blind the panel to a real blur for 400 ms at the
    // exact moment the transit latch is decided, which is the shortest path
    // there is to a window with no way to close itself.
    //
    // `seed: true` for the same reason: there is no transit on an unpin, so
    // the latch is taken from where the pointer IS rather than cleared. This
    // used to assume the user had just CLICKED the pin control — true of a
    // mouse, false of Space or Enter on it, and in the keyboard case the
    // cleared latch made `_pollPointer()` return early for ever while the
    // footer promised "imleç ayrılınca kapanır".
    this._startPointerWatch({ seed: true });
  }

  /**
   * @param {string} [reason] who asked, for the trace. Purely diagnostic: the
   *   panel hides the same way whatever it says. It is a parameter rather than
   *   something inferred here because "the leave timer fired" and "the user
   *   clicked the tray again" are indistinguishable at this line, and they are
   *   the two answers the reported open-then-close flash has to choose between.
   */
  hide(reason = 'unspecified') {
    this.cancelHide('hide');
    this._stopPointerWatch();
    this._cancelBlurRecheck();
    this.pinned = false;
    this.onPinChange(false);
    const wasVisible = Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible());
    if (wasVisible) {
      this.win.hide();
      this.onVisibilityChange(false);
    }
    log.trace('panel.hide', { reason, was: wasVisible, visible: this.isVisible() });
  }

  /** Grace period so a pointer that clipped the edge can come back. */
  scheduleHide(delayMs = LEAVE_GRACE_MS, reason = 'unspecified') {
    this.cancelHide('reschedule');
    if (this.pinned) {
      log.trace('panel.scheduleHide', { act: 'refused', why: 'pinned', reason });
      return;
    }
    log.trace('panel.scheduleHide', { reason, ms: delayMs });
    this._hideTimer = setTimeout(() => {
      this._hideTimer = null;
      if (!this.pinned) this.hide(`timer:${reason}`);
    }, delayMs);
  }

  /** Silent when nothing was pending: most callers cancel unconditionally. */
  cancelHide(reason = 'unspecified') {
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
      log.trace('panel.cancelHide', { reason });
    }
  }

  /**
   * Is a hide already counting down?
   *
   * Read by the tray toggle's trace line. `isVisible()` is true throughout the
   * 550 ms grace period, so a toggle that arrives inside it sees an open panel
   * and closes it — which is one of the shapes the reported flash could take,
   * and is invisible unless the two are logged together.
   */
  hidePending() {
    return Boolean(this._hideTimer);
  }

  /**
   * The user went to work somewhere else before the panel was ever reached.
   *
   * This closes exactly one hole, and refuses to close any other: an unpinned
   * panel the pointer NEVER entered would otherwise have no dismissal path at
   * all, because `_pollPointer()` deliberately does nothing until the transit
   * latch is set. A 440x680 always-on-top window sitting over the user's work
   * indefinitely is a worse failure than any flicker this could cause.
   *
   * Every other case is someone else's:
   *  - pinned            survives everything, by definition
   *  - pointer arrived   the poll owns the lifecycle from then on, and a blur
   *                      while the pointer rests ON the panel must not dismiss
   *                      it (another window can take focus without the user
   *                      leaving the panel)
   *  - just shown        activation is still settling; see BLUR_ARM_MS
   */
  _onBlur(confirmed = false) {
    if (this.pinned) {
      log.trace('panel.blur', { act: 'ignored', why: 'pinned' });
      return;
    }
    if (!this.isVisible()) {
      log.trace('panel.blur', { act: 'ignored', why: 'hidden' });
      return;
    }
    if (this._pointerSeen) {
      log.trace('panel.blur', { act: 'ignored', why: 'pointer-seen' });
      return;
    }

    // DEFERRED, never discarded. An already-unfocused window emits no second
    // blur, so swallowing this one with a bare `return` would throw away the
    // only blur that will ever arrive — and `_pollPointer()` refuses to act
    // while the transit latch is unset, leaving the panel with no dismissal
    // path at all while its footer promises "imleç ayrılınca kapanır".
    //
    // Re-asking later keeps the belt-and-braces property intact: if the blur
    // was an activation transient, focus has come back by then and the
    // re-check drops it. If it was real, it is still true.
    const sinceShown = Date.now() - this._shownAt;
    const wait = this._shownAt + BLUR_ARM_MS - Date.now();
    // One confirmation for EVERY blur, not only an early one. Inside the
    // arming window the wait is whatever is left of it; outside, it is the
    // shorter BLUR_CONFIRM_MS. Either way the re-check runs, and with it the
    // `isFocused()` guard that drops a blur focus has already taken back.
    if (!confirmed || wait > 0) {
      const delay = wait > 0 ? wait : BLUR_CONFIRM_MS;
      log.trace('panel.blur', { act: 'deferred', wait: delay, sinceShown });
      this._armBlurRecheck(delay);
      return;
    }
    log.trace('panel.blur', { act: 'hide', sinceShown });
    this.scheduleHide(LEAVE_GRACE_MS, 'blur');
  }

  _armBlurRecheck(wait) {
    // One pending re-check is enough; a burst of blurs asks the same question.
    if (this._blurTimer) {
      log.trace('panel.blurRecheck', { act: 'coalesced' });
      return;
    }
    this._blurTimer = setTimeout(() => {
      this._blurTimer = null;
      // The window may have been hidden, pinned, re-shown or destroyed in the
      // meantime. `isFocused()` catches the transient this delay exists for;
      // re-entering `_onBlur()` re-applies every other guard rather than
      // restating them here, where they could drift.
      if (!this.win || this.win.isDestroyed()) {
        log.trace('panel.blurRecheck', { act: 'dropped', why: 'destroyed' });
        return;
      }
      if (this.win.isFocused()) {
        log.trace('panel.blurRecheck', { act: 'dropped', why: 'refocused' });
        return;
      }
      log.trace('panel.blurRecheck', { act: 'reask', pointerSeen: this._pointerSeen });
      this._onBlur(true);
    }, wait);
    if (this._blurTimer.unref) this._blurTimer.unref();
  }

  _cancelBlurRecheck() {
    if (this._blurTimer) {
      clearTimeout(this._blurTimer);
      this._blurTimer = null;
      log.trace('panel.blurRecheck', { act: 'cancelled' });
    }
  }

  /**
   * Re-sends the current anchor, changing nothing else.
   *
   * For a renderer that came back from `render-process-gone`: it remounts at
   * `pinned: false` (it derives that from `anchor.mode`), so without this a
   * revived panel sits there pinned while its own pin control says it is not.
   * Sibling of the SNAPSHOT re-push on the same event — the two are one
   * restoration and neither is complete alone.
   */
  sendCurrentAnchor(trayBounds, sendAnchor) {
    if (!this.isVisible()) return;
    const anchor = this.positionFor(trayBounds);
    if (anchor && typeof sendAnchor === 'function') {
      sendAnchor({ ...anchor, mode: this.pinned ? 'pin' : 'hover' });
    }
  }

  /**
   * The renderer says it is up, and possibly that a pointer event reached it.
   *
   * VERIFIED against the OS cursor before it is believed. `panelOpened()` is
   * sent on MOUNT as well as on pointerenter/pointermove/pointerdown, and at
   * mount no pointer event has happened at all — the signal there means "I am
   * alive and visible", not "the cursor is over me". Main used to latch
   * `_pointerSeen` on it anyway, which is the reported flash: measured on the
   * user's machine, the mount-time claim arrived 342 ms after `panel.show` and
   * 147 ms BEFORE `tray.mouse-leave`, so the cursor was demonstrably still on
   * the tray icon. The latch made the next poll read "the pointer has left the
   * panel", and the panel dismissed itself ~550 ms after opening.
   *
   * So the rule is now asymmetric, because the evidence is:
   *  - cursor agrees   latch, and cancel any pending hide. Redundant with the
   *                    poll (it would latch within POINTER_POLL_MS anyway) but
   *                    up to 250 ms earlier, and harmless.
   *  - cursor disagrees, latch already set: honoured as a KEEP-ALIVE only. A
   *                    drag captures the pointer in the DOCUMENT, so the OS
   *                    cursor can leave the window rect while the gesture is
   *                    still running, and the renderer is the only witness to
   *                    that. It extends a life the poll granted.
   *  - cursor disagrees, latch not set: refused. This is the mount-time case,
   *                    and a claim the cursor contradicts is worth nothing.
   *
   * The poll stays the source of truth in every branch.
   */
  notePointerInside() {
    const inside = this._pointerIsInside();
    if (inside === true) {
      if (!this._pointerSeen) log.trace('panel.pointerLatch', { via: 'renderer' });
      this._pointerSeen = true;
      this.cancelHide('pointer-inside');
      return;
    }
    // `cancelHide` traces itself when there was something to cancel, so the
    // ordinary mid-drag keep-alive stays silent instead of narrating itself
    // 2.5 times a second.
    if (this._pointerSeen) {
      this.cancelHide('keep-alive');
      return;
    }
    log.trace('panel.pointerClaim', {
      act: 'refused',
      why: inside === null ? 'no-cursor' : 'outside',
    });
  }

  /**
   * @param {{seed?: boolean}} [options] `seed` means there is no transit to
   *   protect — the panel is already on screen — so the latch is decided from
   *   the current pointer position instead of being cleared. Only `unpin()`
   *   passes it; a fresh open always has a journey from the tray icon.
   */
  _startPointerWatch({ seed = false } = {}) {
    this._stopPointerWatch();
    // A cursor we cannot read is not evidence either way, so the latch stays
    // clear and the panel keeps its blur path rather than closing on a guess.
    this._pointerSeen = seed && this._pointerIsInside() !== null;
    log.trace('panel.pointerWatch', { act: 'start', seed, latched: this._pointerSeen });
    this._pointerTimer = setInterval(() => this._pollPointer(), POINTER_POLL_MS);
    // Never a reason to hold the process open; the tray already does that.
    if (this._pointerTimer.unref) this._pointerTimer.unref();
    // Act on the seeded position now rather than up to POINTER_POLL_MS later.
    if (seed) this._pollPointer();
  }

  /** true / false, or null when the OS would not say. */
  _pointerIsInside() {
    if (!this.win || this.win.isDestroyed()) return null;
    try {
      const point = screen.getCursorScreenPoint();
      const b = this.win.getBounds();
      return point.x >= b.x && point.x < b.x + b.width
        && point.y >= b.y && point.y < b.y + b.height;
    } catch {
      return null;
    }
  }

  _stopPointerWatch() {
    if (this._pointerTimer) {
      clearInterval(this._pointerTimer);
      this._pointerTimer = null;
      log.trace('panel.pointerWatch', { act: 'stop' });
    }
  }

  /**
   * "Is the pointer still over the panel?", asked of the OS.
   *
   * Both rects are in Electron's DIP screen space — the space `positionFor()`
   * documents and the smoke test pins — so they compare directly, with no
   * scale factor involved.
   */
  _pollPointer() {
    if (this.pinned || !this.isVisible()) {
      this._stopPointerWatch();
      return;
    }
    // A transient failure must not close a panel the user is reading. Skip
    // this tick; the next one asks again.
    const inside = this._pointerIsInside();
    if (inside === null) {
      log.trace('panel.poll', { act: 'skipped', why: 'no-cursor' });
      return;
    }
    if (inside) {
      // Only the TRANSITION is traced. A resting pointer would otherwise
      // narrate itself four times a second and bury the sequence this log
      // exists to make readable.
      if (!this._pointerSeen) log.trace('panel.pointerLatch', { via: 'poll' });
      this._pointerSeen = true;
      this.cancelHide('pointer-inside');
      return;
    }
    // Still travelling from the tray icon: there is nothing to leave yet, and
    // no state changes, so nothing is logged.
    if (!this._pointerSeen) return;
    // Re-arming every 250 ms would reset the grace period forever and the timer
    // would never fire, so only start one when none is pending.
    if (!this._hideTimer) this.scheduleHide(LEAVE_GRACE_MS, 'pointer-left');
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed() && this.win.webContents && !this.win.webContents.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  sendAnchor(anchor) {
    this.send(IPC.ANCHOR, anchor);
  }

  destroy() {
    this.cancelHide('destroy');
    this._stopPointerWatch();
    this._cancelBlurRecheck();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

/**
 * Sanity check that a rect really is in Electron's DIP screen space.
 *
 * The renderer does its tail math as `tray.x + tray.width/2 - window.x` with
 * no scale multiplication, which is correct ONLY while Tray, BrowserWindow and
 * Display all speak DIP. If a future Electron (or an unusual driver) ever
 * handed back physical pixels instead, nothing would throw — the tail would
 * just land about a quarter of a panel away from the icon at 1.25x. A physical
 * rect on this machine reads x=1579 against a 1536-wide DIP desktop, so
 * "inside the union of all displays" catches it.
 */
function isPlausibleDipRect(rect) {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return false;
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return screen.getAllDisplays().some((d) => {
    const b = d.bounds;
    return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
  });
}

/**
 * Which screen edge the taskbar occupies, derived from the gap between the
 * display's full bounds and its work area. Windows docks the taskbar left or
 * right often enough that guessing "bottom" mispositions the panel outright.
 * With an auto-hiding taskbar the two rectangles are equal, so we fall back to
 * which half of the display the tray icon sits in.
 */
function taskbarEdge(display, anchorPoint) {
  const b = display.bounds;
  const w = display.workArea;
  if (w.y > b.y) return 'top';
  if (w.y + w.height < b.y + b.height) return 'bottom';
  if (w.x > b.x) return 'left';
  if (w.x + w.width < b.x + b.width) return 'right';
  return anchorPoint.y < b.y + b.height / 2 ? 'top' : 'bottom';
}

/**
 * The renderer lane owns `src/renderer/`. Until its entry point exists we load
 * a local placeholder rather than failing to start, so the tray, the collector
 * and the IPC surface can be exercised independently of that lane.
 */
function resolveRendererEntry() {
  const real = path.join(__dirname, '..', 'renderer', 'index.html');
  if (fs.existsSync(real)) return real;
  return path.join(__dirname, 'placeholder.html');
}

module.exports = {
  PanelWindow,
  PANEL_WIDTH,
  PANEL_HEIGHT,
  LEAVE_GRACE_MS,
  POINTER_POLL_MS,
  BLUR_ARM_MS,
  BLUR_CONFIRM_MS,
  resolveRendererEntry,
  taskbarEdge,
  isPlausibleDipRect,
};
