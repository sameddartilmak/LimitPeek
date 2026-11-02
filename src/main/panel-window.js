'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, screen, app } = require('electron');
const { IPC } = require('../shared/contract');
const log = require('../core/log');
const { PANEL_BASE, PANEL_EDGE, panelAccent } = require('../core/panel-material');
const { sanitizeTransparency } = require('../core/transparency');
const { handleOf } = require('./win32');

/**
 * The panel window.
 *
 * Created ONCE, at its maximum size, transparent and hidden. It is never
 * destroyed and recreated per hover: on Windows that costs a fresh renderer
 * process (~150 ms and a visible flash) every time the pointer crosses the
 * tray icon. It is also never animated by moving the OS window — the renderer
 * animates its own content inside a fixed frame, which stays smooth because it
 * is a compositor job rather than a stream of SetWindowPos calls.
 *
 * TWO SHAPES OF WINDOW (concept "A · Gerçek Windows camı", 2026-10-21)
 * --------------------------------------------------------------------
 *   'canvas'  a TRANSPARENT frame larger than the panel. The renderer draws
 *             the panel inside it with its own corners, shadow and the tail
 *             that points at the tray icon; the empty margin is click-through
 *             (setPointerOverPanel). Windows 10, and every earlier version.
 *   'fitted'  the window IS the panel: opaque to Windows, so DWM rounds its
 *             corners, draws its shadow and — when the material is 'acrylic'
 *             — Windows' glass behind it, with the page transparent on top.
 *             Windows 11 (src/core/panel-material.js).
 *
 * Why fitted and not glass behind the canvas, measured in Electron 44.2 on
 * Windows 11 26200 (scratch spike, 2026-10-21): `backgroundMaterial: 'acrylic'`
 * on a TRANSPARENT window does draw acrylic, but across the whole window rect
 * — margins included — with square corners and no shadow, because Electron
 * turns DWM's rounding off for transparent windows; asking DWM for the
 * rounding by hand on that window turned the backdrop flat grey instead. On
 * an opaque frameless window Windows gives its 8px corners and its shadow.
 * That window also had Windows' invisible resize borders, 8 physical px left,
 * right and below, that answered hit tests for the panel; so the thick frame
 * is off and the corners and the shadow are asked of DWM directly (win32
 * setFlyoutShape). Measured after: WindowFromPoint 3px outside any edge is the
 * window behind.
 *
 * THE GLASS IS THE ACCENT POLICY, NOT `backgroundMaterial` (2026-10-22). Up to
 * 0.6.41 the fitted window took Electron's `backgroundMaterial: 'acrylic'`,
 * Windows' system backdrop. It has one strength, and it changes with the
 * window's activation (the backdrop falls back while the window is inactive):
 * the panel turned another colour every time the user clicked somewhere else
 * ("panel dışı bir yere tıklayınca renk değişiyor").
 * The window is now born with `backgroundMaterial: 'none'`, and the glass
 * comes from SetWindowCompositionAttribute (win32 setAccent), which measured
 * the same inactive as active.
 *
 * THE LIQUID GLASS (2026-11-02). Windows' own glasses were not what the owner
 * wanted (panel-material.js says why), so with "Saydamlık" on the accent only
 * CLEARS the window, and the page draws the glass from a picture of the
 * screen behind it. The picture is taken here, as the panel opens and while
 * the window is still parked off-screen (`_captureBackdrop`): the region the
 * TALLEST panel would cover at this anchor, so a panel that grows later
 * (Settings, a sheet) still has what is behind it. It goes to the page with
 * IPC.BACKDROP, then only its position again whenever the window moves over
 * it, and the page is told to drop it when the panel closes. Never taken for
 * a panel already on screen (it would copy itself), never stored.
 *
 * A fitted window grows and shrinks with the panel: the renderer reports the
 * panel's height (IPC.PANEL_SIZE, `setContentHeight`) and the window follows,
 * keeping the edge nearest the taskbar where it is. It is still created once,
 * composited once and parked off-screen between opens; only its size moves,
 * and only when the content does.
 */
/**
 * The window's size where the work area allows it (UI plan 2026-09-29: the
 * panel inside a 480x720 frame; the panel is 320 wide since 2026-10-22). A
 * smaller work area gets a smaller window — `fitTo` — and the renderer sizes
 * the panel as `min(320px, 100vw - 32px)` and its list from the window height
 * it is handed, so nothing is cut off.
 */
const PANEL_WIDTH = 480;
const PANEL_HEIGHT = 720;
const EDGE_MARGIN = 8;
/** Size of the stand-in rect used when the real tray rect is unavailable. */
const SYNTHETIC_TRAY_SIZE = 16;
/**
 * The fitted window (see the header). 320 wide, the canvas panel's width
 * (`--panel-w` in tokens.css; 400 until the minimal redesign, 2026-10-22, and
 * one width for every view, so it never changes under the pointer); at most
 * 680 tall, the tallest panel the 720 canvas held; 12 from the taskbar and
 * the work-area edges, where Windows 11 puts its own flyouts. The start
 * height only lasts until the renderer's first report.
 */
const FITTED_WIDTH = 320;
const FITTED_MAX_HEIGHT = 680;
const FITTED_GAP = 12;
const FITTED_START_HEIGHT = 420;
/** A report below this is not a panel (the header alone is 60). */
const FITTED_MIN_HEIGHT = 64;
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
 * How far outside the tray->panel corridor the pointer may stray before an
 * unpinned panel NOBODY HAS REACHED YET is treated as abandoned.
 *
 * This replaces `blur` as the dismissal path for a never-engaged panel. See
 * `open()` for why focus stopped being a signal at all; this is the answer to
 * the hole that leaves — an unpinned panel nobody engages still needs a way to
 * go away, or a 440x680 always-on-top window sits over the user's work.
 *
 * The corridor is the bounding box of the tray icon and the panel, inflated by
 * this much. The panel is anchored adjacent to its icon, so that box is the
 * panel plus a short strip to the icon: a hand travelling from one to the
 * other stays inside it, and a cursor that leaves it has gone somewhere else.
 * Sized for a hand that overshoots, not for one that leaves.
 */
const TRANSIT_MARGIN_PX = 48;
/**
 * Backstop for a panel that is never engaged AND whose cursor never leaves the
 * corridor.
 *
 * Reachable one realistic way: the user clicks the tray, leaves the pointer
 * resting on the taskbar, and goes back to the keyboard. The corridor rule
 * never fires because the cursor never moves.
 *
 * Deliberately long. Real traces from this machine show un-engaged panels held
 * for 7.0, 13.4 and 28.5 seconds before the user dismissed them by clicking
 * elsewhere, so anything in that range would close a panel mid-read — the same
 * over-eager dismissal this change exists to remove. Erring long is the safe
 * direction: a late close costs one click, an early one is the reported bug.
 */
const NEVER_ENGAGED_MAX_MS = 60_000;
/**
 * Where the panel parks when it is logically "hidden".
 *
 * The window is never `hide()`n — see `PanelWindow._open`. Instead it is moved
 * far outside the union of every plausible display so it composites nothing a
 * user can see and catches no click a user can make. -32000 is comfortably past
 * any real multi-monitor arrangement (that would be sixteen 1080p monitors
 * stacked to the left) yet inside the signed-16-bit range Win32 window
 * coordinates historically clamp to, so no driver quietly snaps it back on
 * screen. It is a position, not a `hide()`, so moving BACK to the anchor is a
 * SetWindowPos on an already-composited surface — no show event, no composite
 * transition, and therefore no flash.
 */
const OFFSCREEN = { x: -32000, y: -32000 };
/**
 * RETIRED, and kept as prose because the measurements are the argument for
 * what replaced it.
 *
 * `blur` no longer dismisses anything (see `_onBlur`), so there is no arming
 * window to size. Two fixed windows were tried, 400 ms and then 1200 ms, and
 * both were cliffs: the shell's focus handoff after a real tray click was
 * measured at 414, 425, 500, 505, 510, 656, 729, 769, 860, 1088, 1211 and
 * 1355 ms, and a 1211 ms sample — eleven milliseconds past the second window —
 * produced a fresh flash on the fixed build. Any fixed threshold has a tail
 * behind it; raising it only thins the tail while delaying genuine dismissal.
 * The fix was to stop treating the shell's focus handoff as a signal.
 *
 * The original reasoning, preserved:
 *
 * Two jobs, and the second was the load-bearing one:
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
/**
 * RETIRED with the arming window above.
 *
 * How long a blur arriving AFTER the arming window was held before it was
 * believed.
 *
 * The old code had a cliff exactly at BLUR_ARM_MS. A blur at 399 ms was
 * treated as suspicious — deferred, then dropped if `isFocused()` had come
 * back — while one at 401 ms was believed outright and hid the panel with no
 * second look. The measured blurs cluster on both sides of that cliff, so two
 * halves of the same physical event were being judged by different rules.
 * Every blur is confirmed once now; only the length of the wait differs.
 *
 * Greater than POINTER_POLL_MS for the same reason the arming window was: a
 * poll had to be able to latch the pointer inside the confirmation. The value
 * was 300 ms.
 */

/**
 * A look's transparency as a level. Absent (a caller that says nothing, as
 * every test and the canvas do) is 0, the opaque base: the look that is
 * right over any window.
 */
function levelOf(value) {
  return typeof value === 'number' ? sanitizeTransparency(value) : 0;
}

class PanelWindow {
  constructor(options = {}) {
    this.width = options.width || PANEL_WIDTH;
    this.height = options.height || PANEL_HEIGHT;
    // Overridable only so `scripts/smoke-ipc.js` can drive the preload surface
    // against a page this lane owns. Production always resolves it.
    this.entry = options.entry || null;
    /** 'canvas' unless the caller measured the OS for 'fitted' (see the header). */
    this.frame = options.frame === 'fitted' ? 'fitted' : 'canvas';
    const look = options.look || {};
    /**
     * What the caller asked for, 0 (opaque) to 100 (clear glass); `_material`
     * is what is actually live.
     */
    this._transparency = levelOf(look.transparency);
    this._dark = look.dark !== false;
    this._material = 'none';
    /**
     * Set when Windows refused the glass once (or there is no way to ask:
     * koffi unavailable); the panel stays opaque after. Asking again on every
     * slider step would log a warning per step for a window that cannot.
     */
    this._glassBroken = false;
    /** win32.loadDwm, injected so a test never loads koffi. */
    this._dwm = typeof options.dwm === 'function' ? options.dwm : null;
    /** The panel's own height, as the renderer last reported it (fitted only). */
    this._fitHeight = FITTED_START_HEIGHT;
    /**
     * Where the fitted window was last placed from: the anchor point, the
     * taskbar edge, the work area and the tray rect. A content resize
     * re-places from THIS, never from a fresh anchor — a cursor fallback
     * re-read mid-open would move the panel to wherever the mouse is.
     */
    this._place = null;
    /**
     * The picture behind the panel for its glass, while one is held:
     * `{ rect }` in DIP screen coords and `{ shot }` from win32 captureScreen.
     * Taken on an open with the glass live, dropped on every conceal.
     */
    this._backdrop = null;
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
    /**
     * When the window was last SHOWN, or null if it never has been. Read by
     * the never-engaged backstop.
     *
     * `null` rather than `0` because 0 is a legitimate instant — it is what
     * `Date.now()` returns under the test suite's mocked clock — and a falsy
     * check here silently disabled the backstop for the whole first tick of
     * epoch time. A sentinel that a real value can collide with is not a
     * sentinel.
     */
    this._shownAt = null;
    /**
     * The tray->panel corridor, in DIP screen space, or null when the anchor
     * could not be measured. A pointer outside it, on a panel that has not
     * been engaged, means the user went somewhere else. See TRANSIT_MARGIN_PX.
     */
    this._transitBox = null;
    /**
     * LOGICAL visibility — is the panel meant to be on screen for the user?
     *
     * The OS window is composited exactly once (in `create()`, off-screen) and
     * from then on is NEVER hidden or re-shown: `win.isVisible()` is true for
     * the whole life of the process. Showing a transparent, always-on-top
     * window is the composite transition the foreground app repaints across —
     * the reported open flicker — so the panel is revealed and concealed by
     * MOVING it on and off screen, not by `hide()`/`showInactive()`. That makes
     * `win.isVisible()` useless as the "is the panel up?" signal, and this flag
     * is what every caller and the pointer poll must read instead. See
     * `isVisible()`, `_reveal()` and `_conceal()`.
     */
    this._open = false;
    this.onPinChange = options.onPinChange || (() => {});
    this.onVisibilityChange = options.onVisibilityChange || (() => {});
    /**
     * Called while a visible panel is still on screen and still holds the
     * foreground, just before it is concealed: the moment the taskbar strip
     * hands the foreground back (TaskbarStrip.handBackFocus).
     */
    this.onBeforeConceal = options.onBeforeConceal || (() => {});
  }

  create() {
    if (this.win) return this.win;
    const entry = this.entry || resolveRendererEntry();
    const fitted = this.frame === 'fitted';
    // Born transparent to the page only if the glass is wanted; _applyLook
    // below puts the base back if Windows will not draw it.
    const glass = fitted && this._transparency > 0;
    const size = fitted
      ? { width: FITTED_WIDTH, height: this._fitHeight }
      : { width: this.width, height: this.height };

    this.win = new BrowserWindow({
      width: size.width,
      height: size.height,
      show: false,
      frame: false,
      // Fitted: opaque to Windows, so DWM rounds, shadows and backdrops it;
      // the page stays transparent over the glass (header comment).
      transparent: !fitted,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // The fitted window's shadow is Windows' own; the canvas draws its own.
      hasShadow: fitted,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      backgroundColor: fitted && !glass ? this._base() : '#00000000',
      // No thick frame: with one, Windows adds invisible resize borders that
      // take clicks beside the panel (win32.js, setFlyoutShape gives the
      // corners and the shadow back). No system backdrop: the glass is the
      // accent policy, which keeps its look when the window is inactive
      // (header comment).
      ...(fitted ? { backgroundMaterial: 'none', thickFrame: false } : {}),
      title: 'LimitPeek',
      icon: path.join(__dirname, '..', '..', 'assets', 'app-icon.png'),
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
    if (fitted) this._applyLook();

    // The canvas is larger than the panel and transparent around it, and a
    // transparent window still takes every click on its rectangle. So it
    // starts click-through, with mouse MOVES forwarded so the renderer can
    // still see the pointer arrive; the renderer reports when the pointer is
    // over the painted panel and only then is the mouse taken back
    // (setPointerOverPanel, IPC.PANEL_HIT). Owner, 2026-10-01: the space
    // beside and above the panel blocked clicks on the apps behind it. A
    // fitted window has no such space and simply takes the mouse.
    this._clickThrough = null;
    this.setPointerOverPanel(false);

    // Blur is now DIAGNOSTIC ONLY and dismisses nothing at all. A tray open no
    // longer takes focus, so losing focus is not evidence the user dismissed
    // anything — most of the time it is the shell handing focus back to
    // whatever they were using. The listener stays because the trace is how
    // this was diagnosed twice, and a silent event is one nobody can argue
    // about. See `_onBlur`.
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

    // Composite the window ONCE, here, and off-screen. This is the only
    // show->composite transition in the panel's whole life; every subsequent
    // "open" is a move of this already-composited surface, which is what makes
    // the reveal flash-free. The bounds are set BEFORE the show so the show
    // happens at OFFSCREEN, never at the default 0,0 — otherwise startup would
    // flash the empty frame at the top-left corner. `showInactive()` is
    // SW_SHOWNOACTIVATE: it does not take focus, so priming the window at launch
    // cannot yank the keyboard away from whatever the user is doing.
    this.win.setBounds({ x: OFFSCREEN.x, y: OFFSCREEN.y, ...size });
    this.win.showInactive();

    return this.win;
  }

  /**
   * LOGICAL visibility, not the OS window's. The window is composited for the
   * whole life of the process (see `create()` and `_open`), so `win.isVisible()`
   * would answer "yes" the moment the app started and never change. The corridor
   * poll, the tray toggle, `onVisibilityChange` and every test read THIS.
   */
  isVisible() {
    return Boolean(this.win && !this.win.isDestroyed() && this._open);
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

    // Clamped on BOTH axes in every branch (placeNear) — and the renderer's
    // tail-clamp has nothing to clamp against otherwise.
    const fitted = this.frame === 'fitted';
    // The screen behind, read BEFORE the window moves onto it.
    const captured = fitted && !this._open && this._captureBackdrop(anchorPoint, edge, work);
    const size = fitted ? this._fittedSize(work) : fitTo(this.width, this.height, work);
    this._placeAcrossDpi(placeNear(anchorPoint, edge, work, size, fitted ? FITTED_GAP : EDGE_MARGIN));
    // The fitted window follows its content from here (setContentHeight).
    this._place = fitted ? { anchorPoint, edge, work, tray } : null;
    if (captured) this._sendBackdrop(true);

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
      // The tallest the renderer may draw the panel: the canvas itself, or the
      // most a fitted window will grow to on this work area.
      maxHeight: fitted ? fitTo(FITTED_WIDTH, FITTED_MAX_HEIGHT, work, FITTED_GAP).height : bounds.height,
      edge,
    };
  }

  /** The fitted window's size for a work area: the panel's, within the limits. */
  _fittedSize(work) {
    return fitTo(FITTED_WIDTH, Math.min(this._fitHeight, FITTED_MAX_HEIGHT), work, FITTED_GAP);
  }

  /**
   * The renderer measured the panel (IPC.PANEL_SIZE). A fitted window takes
   * that height at once while it is open — keeping the side nearest the
   * taskbar where it is, so the panel grows away from it — and remembers it
   * for the next open otherwise. A canvas window has a fixed size and ignores
   * it. Untrusted input, so anything that is not a plausible height changes
   * nothing.
   *
   * @returns {boolean} true when the height was taken
   */
  setContentHeight(height) {
    if (this.frame !== 'fitted') return false;
    const h = typeof height === 'number' ? Math.round(height) : NaN;
    if (!Number.isFinite(h) || h < FITTED_MIN_HEIGHT || h > 4 * FITTED_MAX_HEIGHT) return false;
    if (h === this._fitHeight) return false;
    this._fitHeight = h;
    if (!this._open || !this._place || !this.win || this.win.isDestroyed()) return true;
    const { anchorPoint, edge, work, tray } = this._place;
    const size = this._fittedSize(work);
    this._placeAcrossDpi(placeNear(anchorPoint, edge, work, size, FITTED_GAP));
    // The window moved over the picture: where the picture now sits in it.
    this._sendBackdrop(false);
    // A panel still in transit keeps a corridor that matches its new size.
    if (this._transitBox) this._transitBox = this._corridorFrom({ tray });
    log.trace('panel.fit', { height: size.height });
    return true;
  }

  /**
   * The window's material, live: Windows' glass behind a fitted panel, or the
   * opaque base. `transparency` is the caller's verdict, 0 to 100
   * (src/core/panel-material.js effectiveTransparency: the slider, unless
   * Windows asks for less); `dark` is the panel's resolved theme, which tints
   * both the glass and the base. Safe to call again with the same look —
   * index.js does after every nativeTheme change, because Electron rewrites
   * the dark-mode attribute then — and as often as the slider moves.
   *
   * A canvas window is always 'none': its backdrop would fill the margins.
   *
   * @param {{transparency?: number, dark?: boolean}} look
   * @returns {'acrylic'|'none'} the material now live
   */
  setLook(look = {}) {
    this._transparency = levelOf(look.transparency);
    this._dark = look.dark !== false;
    if (this.frame !== 'fitted' || !this.win || this.win.isDestroyed()) return this.material();
    this._applyLook();
    return this._material;
  }

  /**
   * The look onto the window: the accent (src/core/panel-material.js
   * panelAccent) through win32 setAccent, the frame attributes, and the
   * window's own background — transparent over the glass, the base itself
   * when there is none, so a frame that paints before the page (a resize, a
   * revived renderer) shows the panel's colour and never black or white.
   *
   * The accent is asserted on every call, an unchanged one too: it is one
   * cheap call, and a window attribute something else rewrote (as Electron
   * rewrites the dark mode) is put back by the next push instead of trusted.
   *
   * Any refusal — setAccent answering false or throwing, no DWM helper at all
   * — costs the glass and nothing else: the opaque base, once, with a warning,
   * and the glass is not asked for again in this process.
   */
  _applyLook() {
    const win = this.win;
    const accent = panelAccent(this._glassBroken ? 0 : this._transparency);
    let material = accent.state === 0 ? 'none' : 'acrylic';
    // The window's own background first, then the accent over it: the order
    // the spike measured (a transparent window, then the policy).
    win.setBackgroundColor(material === 'acrylic' ? '#00000000' : this._base());
    if (!this._setAccent(accent) && material === 'acrylic') {
      log.warn('panel glass refused; the panel stays opaque');
      this._glassBroken = true;
      material = 'none';
      // Take back whatever half of it Windows may have applied, and put the
      // base under the page.
      this._setAccent(panelAccent(0));
      win.setBackgroundColor(this._base());
    }
    if (material !== this._material) {
      this._material = material;
      log.trace('panel.material', { material, transparency: this._transparency });
      // No glass, no picture: the page drops the one it holds.
      if (material === 'none') this._dropBackdrop();
    }
    this._applyDwm();
  }

  /**
   * Copy the screen region the tallest panel would cover at this anchor, for
   * the glass (header: THE LIQUID GLASS). Only when the glass is live and the
   * window is off-screen; a failure costs the picture (the page draws its
   * tint alone), nothing else.
   *
   * @returns {boolean} true when a picture is held
   */
  _captureBackdrop(anchorPoint, edge, work) {
    this._backdrop = null;
    if (this._material !== 'acrylic') return false;
    const dwm = this._dwm ? this._dwm() : null;
    if (!dwm || typeof dwm.captureScreen !== 'function') return false;
    const rect = placeNear(anchorPoint, edge, work, fitTo(FITTED_WIDTH, FITTED_MAX_HEIGHT, work, FITTED_GAP), FITTED_GAP);
    const startedAt = Date.now();
    let shot = null;
    try {
      shot = dwm.captureScreen(screen.dipToScreenRect(null, rect));
    } catch (err) {
      log.warn(`panel backdrop failed: code=${(err && err.code) || 'UNKNOWN'}`);
    }
    if (!shot) return false;
    this._backdrop = { rect, shot };
    log.trace('panel.backdrop', { ms: Date.now() - startedAt, width: shot.width, height: shot.height });
    return true;
  }

  /**
   * The held picture to the page, as IPC.BACKDROP: its rect in the window's
   * CSS px (the window's top-left is 0,0), and the pixels when `withImage`.
   */
  _sendBackdrop(withImage) {
    if (!this._backdrop || !this.win || this.win.isDestroyed()) return;
    const { rect, shot } = this._backdrop;
    const at = this.win.getBounds();
    this.send(IPC.BACKDROP, {
      x: rect.x - at.x,
      y: rect.y - at.y,
      width: rect.width,
      height: rect.height,
      image: withImage ? { pixelWidth: shot.width, pixelHeight: shot.height, bgra: shot.bgra } : null,
    });
  }

  /** Forget the picture, here and in the page. */
  _dropBackdrop() {
    if (!this._backdrop) return;
    this._backdrop = null;
    this.send(IPC.BACKDROP, null);
  }

  /** win32 setAccent on our window. False when it cannot be had or was refused. */
  _setAccent(accent) {
    const dwm = this._dwm ? this._dwm() : null;
    if (!dwm || typeof dwm.setAccent !== 'function' || !this.win || this.win.isDestroyed()) return false;
    const hwnd = handleOf(this.win);
    if (!hwnd) return false;
    try {
      return dwm.setAccent(hwnd, accent) === true;
    } catch (err) {
      log.warn(`panel accent failed: code=${(err && err.code) || 'UNKNOWN'}`);
      return false;
    }
  }

  /** 'acrylic' while Windows' glass is live behind the panel, else 'none'. */
  material() {
    if (this.frame !== 'fitted' || !this.win || this.win.isDestroyed()) return 'none';
    return this._material;
  }

  _base() {
    return PANEL_BASE[this._dark ? 'dark' : 'light'];
  }

  /**
   * Windows' half of the frame (win32.loadDwm): the rounded corners and the
   * shadow, a light or dark frame to match the PANEL's theme, and a neutral
   * hairline instead of the accent colour. Best effort; without it the panel
   * is square and shadowless (and opaque: the glass needs the same helper).
   */
  _applyDwm() {
    const dwm = this._dwm ? this._dwm() : null;
    if (!dwm || !this.win || this.win.isDestroyed()) return;
    const hwnd = handleOf(this.win);
    if (!hwnd) return;
    dwm.setDarkMode(hwnd, this._dark);
    // Over the glass the window is clear and square: the page draws the
    // corners, the rim and the edge (win32 setGlassShape).
    if (this._material === 'acrylic' && typeof dwm.setGlassShape === 'function') {
      dwm.setGlassShape(hwnd);
      return;
    }
    dwm.setFlyoutShape(hwnd);
    dwm.setBorderColour(hwnd, PANEL_EDGE[this._dark ? 'dark' : 'light']);
  }

  /**
   * Over the painted panel: the window takes the mouse. Anywhere else in its
   * transparent frame: clicks go through to whatever is behind it, and moves
   * are still forwarded so the renderer sees the pointer come back.
   *
   * A fitted window is nothing BUT panel, so it always takes the mouse: the
   * renderer still reports, and the report changes nothing. Click-through
   * there would hand a click on the panel to the window behind it.
   */
  setPointerOverPanel(over) {
    if (!this.win || this.win.isDestroyed()) return;
    const through = this.frame === 'canvas' && over !== true;
    if (this._clickThrough === through) return;
    this._clickThrough = through;
    this.win.setIgnoreMouseEvents(through, { forward: true });
    log.trace('panel.clickThrough', { through });
  }

  /**
   * `setBounds` onto the anchor, guarding the cross-DPI reveal bug.
   *
   * The window PARKS off-screen at OFFSCREEN {-32000,-32000}, which Windows
   * associates with the left-most monitor — on a laptop-plus-external setup
   * that is the internal panel, and its scale factor need not match the
   * monitor the panel is about to open on. Electron converts the 440x680 DIP
   * size to physical pixels using the scale of the monitor the window is
   * CURRENTLY on, so the first `setBounds` after a park onto a
   * differently-scaled monitor sizes the window for the WRONG scale.
   *
   * MEASURED on this machine (internal 1.25x at negative x, external 1.0x
   * primary): parked at -32000 then `setBounds(440x680)` onto the 1.0x primary
   * read back as 550x850 — exactly 1.25x — so the right edge ran past 1920 and
   * the bottom past the work area, i.e. "part of it is off the screen". A
   * SECOND `setBounds`, now that the window is physically on the target
   * monitor, read back 440x680 and sat inside the work area.
   *
   * So: set, then re-assert ONCE if the read-back size is grossly off. Both
   * calls are synchronous, so no frame paints between them and the oversized
   * placement is never shown. A fractional scale legitimately rounds 440x680
   * to 442x681 (see the `getBounds` note in `positionFor`), so only a mismatch
   * far larger than that rounding — the 1.25x inflation — triggers the re-set;
   * on a single monitor, or a target on the park monitor, the check passes and
   * the second call never runs.
   */
  _placeAcrossDpi(bounds) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setBounds(bounds);
    const got = this.win.getBounds();
    if (Math.abs(got.width - bounds.width) > 4 || Math.abs(got.height - bounds.height) > 4) {
      this.win.setBounds(bounds);
    }
  }

  /**
   * Tray-click open. Shows WITHOUT activating, and does NOT pin.
   *
   * The panel used to call `show()` then `focus()`. That made the shell's
   * focus handoff part of the panel's lifecycle, and it is a race we cannot
   * win: after a real tray click Windows hands focus around on its own
   * schedule, measured here at 414, 425, 500, 505, 510, 656, 729, 769, 860,
   * 1088, 1211 and 1355 ms. Every fixed "ignore blur for N ms" window is a
   * cliff with a tail behind it — a 1211 ms sample flashed on a build with the
   * window set to 1200 — and raising N only thins the tail while making
   * genuine dismissal slower.
   *
   * So the panel no longer takes focus at all. There is no focus to lose,
   * therefore no blur, therefore no race. Focus is granted by WINDOWS, when
   * the user engages: clicking inside the panel activates it the way clicking
   * any inactive window does, and `acceptFirstMouse` means that first click is
   * also delivered to the control under it rather than being swallowed by the
   * activation. We never call `focus()` on the user's behalf, which also means
   * we never yank the keyboard out of whatever they were typing into.
   *
   * It also never `show()`s. The window was composited once, off-screen, in
   * `create()`; opening is `positionFor()` moving that already-drawn surface to
   * the anchor. There is no show event, so the foreground app has nothing to
   * repaint across — which is the fix for the reported open flicker. See
   * `_reveal()`.
   *
   * The dismissal path this removes is replaced, not dropped: see
   * `_pollTransit` for the corridor rule and NEVER_ENGAGED_MAX_MS.
   */
  open(trayBounds, sendAnchor) {
    this.cancelHide('open');
    this.create();
    this._shownAt = Date.now();
    const wasVisible = this._open;
    // `positionFor()` moves the (already composited) window to the anchor. When
    // the panel was concealed off-screen, THIS is the move that brings it on
    // screen; when it was already open it re-anchors in place. Either way it is
    // a SetWindowPos on a live surface, not a show.
    const anchor = this.positionFor(trayBounds);
    if (anchor && typeof sendAnchor === 'function') {
      sendAnchor({ ...anchor, mode: this.pinned ? 'pin' : 'hover' });
    }
    this._reveal();
    this._transitBox = this._corridorFrom(anchor);
    log.trace('panel.show', {
      was: wasVisible,
      visible: this._open,
      pinned: this.pinned,
      anchor: anchor ? anchor.anchorSource : 'none',
      activated: false,
      corridor: this._transitBox ? 'measured' : 'none',
    });
    if (!wasVisible) this.onVisibilityChange(true);
    // Re-armed on every open, including a re-open of an already visible panel:
    // the pointer is back at the tray icon, so the transit grace starts again.
    if (!this.pinned) this._startPointerWatch();
  }

  /**
   * Bring the composited window to the anchor's z-order and mark it logically
   * open. NOT a `show()`: the window has been visible-to-the-compositor since
   * `create()`, so there is no show->composite transition to flash. See
   * `_open` and `OFFSCREEN`.
   *
   * `moveTop()` re-inserts the panel at the top of the always-on-top band with
   * no activation (SetWindowPos HWND_TOP), so a second tray click on a panel
   * that some other topmost window has covered raises it again without taking
   * focus. The defensive `showInactive()` is for the one path that can leave the
   * OS window genuinely hidden — a future caller, or an Electron that drops the
   * surface on renderer death — and it is a no-op on the normal path because the
   * window is already shown.
   */
  _reveal() {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.win.isVisible()) this.win.showInactive();
    this.win.moveTop();
    this._open = true;
    log.trace('panel.reveal', { via: 'move', visible: this._open, activated: false });
    // Tell the renderer to REPLAY its content entrance. Sent AFTER the window is
    // on screen and at the anchor; the renderer's `data-open` was left false by
    // the previous (off-screen) conceal, so this is a clean false->true grow-in
    // with no flash of the final state. This never animates the OS window — the
    // move above is instant. See contract.ts IPC.PANEL_VISIBILITY.
    this._signalVisibility(true);
  }

  /**
   * The counterpart to `_reveal()`: mark the panel logically hidden and move the
   * still-composited window off every display. NOT a `hide()` — hiding is the
   * transition whose re-show flashes, and the whole point of this window living
   * always-composited is never to pay that transition again. Off-screen it
   * paints nothing a user sees and, being far outside the virtual desktop,
   * catches no click a user can land, so no `setIgnoreMouseEvents` is needed to
   * make it click-safe. `skipTaskbar` already keeps it out of the taskbar and
   * Alt-Tab.
   */
  _conceal() {
    this._open = false;
    if (!this.win || this.win.isDestroyed()) return;
    // Parked at its current size: a fitted window keeps the panel's height
    // for the next open, a canvas window has only the one.
    const { width, height } = this.frame === 'fitted' ? this.win.getBounds() : this;
    this.win.setBounds({ x: OFFSCREEN.x, y: OFFSCREEN.y, width, height });
    log.trace('panel.conceal', { via: 'offscreen' });
    // The picture behind the glass is of a screen the panel has left.
    this._dropBackdrop();
    // The pointer is not over a panel that is off-screen; the next reveal
    // starts click-through until the pointer reaches the panel again.
    this.setPointerOverPanel(false);
    // Set the renderer's closed visual state AFTER the window is off-screen, so
    // it happens invisibly. This is what leaves `data-open` false for the next
    // reveal to animate against — the ordering the flash-free open depends on.
    this._signalVisibility(false);
  }

  /**
   * Tell the renderer the panel was revealed (true) or concealed (false) so it
   * can replay its CONTENT open animation on every open (contract.ts
   * IPC.PANEL_VISIBILITY). This is a notification only: the OS window is still
   * moved on/off screen instantly and is never itself animated. A boolean
   * crosses the wire; the renderer coerces it and drives `data-open`.
   */
  _signalVisibility(open) {
    this.send(IPC.PANEL_VISIBILITY, open === true);
    log.trace('panel.visibility', { open: open === true });
  }

  /**
   * Kept as a name, because `open()` IS the non-activating open now.
   *
   * `scripts/smoke-ipc.js` drives this to assert the property that used to be
   * the difference between the two methods. Leaving it as an alias means the
   * smoke test exercises the real path rather than a second one that could
   * drift away from it.
   */
  showInactive(trayBounds, sendAnchor) {
    this.open(trayBounds, sendAnchor);
  }

  /**
   * Pin: the panel stays on screen regardless of focus.
   *
   * Nothing dismisses it but an explicit close or unpin — no blur, no app
   * switch, no click elsewhere on the desktop — so the pointer watch is
   * stopped outright rather than merely ignored.
   *
   * Unlike `open()`, pin DELIBERATELY activates: the user reached for a control
   * that means "keep this and let me work in it", so it takes focus. That is
   * the one legitimate focus-steal in this class, and `show()`+`focus()` is how
   * it is done. `positionFor()` has already moved the composited window to the
   * anchor, so `show()` here activates an already-visible window rather than
   * running a fresh show->composite transition.
   */
  pin(trayBounds, sendAnchor) {
    this.cancelHide('pin');
    this._stopPointerWatch();
    this.create();
    this._shownAt = Date.now();
    this.pinned = true;
    const anchor = this.positionFor(trayBounds);
    if (anchor && typeof sendAnchor === 'function') sendAnchor({ ...anchor, mode: 'pin' });
    const wasVisible = this._open;
    this.win.show();
    this.win.focus();
    this._open = true;
    log.trace('panel.pin', { was: wasVisible, visible: this._open });
    // Keep the renderer's `data-open` in step. On the common path (pinning an
    // already-open panel) this is a no-op the renderer ignores; on the rare
    // pin-from-concealed it both plays the entrance and — more importantly —
    // stops a panel whose content is still in its closed (opacity 0) state from
    // being shown blank. pin activates, but this signal, like `_reveal`'s,
    // animates only the CONTENT.
    if (!wasVisible) this._signalVisibility(true);
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
    // `_shownAt` IS re-stamped here, and the reason is the opposite of the one
    // that used to be written here.
    //
    // It used to say "do not re-stamp, or the arming window blinds the panel
    // to a real blur". That window is gone: blur dismisses nothing now, and
    // the only thing `_shownAt` still feeds is the NEVER_ENGAGED_MAX_MS
    // backstop. Leaving it at the pin's timestamp would mean a panel pinned
    // for over a minute could be unpinned and then hidden on the very next
    // poll — the backstop firing for a panel the user just asked to keep,
    // before they could touch it. The minute starts when the panel becomes
    // dismissible again, which is now.
    this._shownAt = Date.now();
    // `seed: true` because there is no transit on an unpin: so
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
    this._transitBox = null;
    this.pinned = false;
    this.onPinChange(false);
    const wasVisible = this._open;
    if (wasVisible) {
      // Conceal by moving off-screen, NOT by `win.hide()`. A hidden window's
      // next show is the composite transition that flashes; a moved one has no
      // show to pay for. `_conceal()` clears `_open`, so `isVisible()` reads
      // false from here on.
      try { this.onBeforeConceal(); } catch (err) { log.warn(`panel: before-conceal hook failed: code=${(err && err.code) || 'UNKNOWN'}`); }
      this._conceal();
      this.onVisibilityChange(false);
    }
    log.trace('panel.hide', { reason, was: wasVisible, visible: this._open });
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
   * Focus was lost. NOTHING is dismissed on account of it.
   *
   * This method used to be a dismissal path, and it was the wrong shape twice.
   * The panel does not take focus when it opens (see `open()`), so a blur here
   * means one of:
   *
   *   - the shell handing focus back to whatever the user was using, on its
   *     own schedule, milliseconds to seconds after the tray click; or
   *   - the user clicking into another window AFTER engaging with the panel,
   *     in which case the pointer poll already owns the decision and will
   *     close the panel when the cursor leaves.
   *
   * Neither is evidence to hide on. The first is the reported flash; the
   * second is already handled by a rule that cannot be raced.
   *
   * The listener survives as a TRACE because the flash was diagnosed from this
   * line twice, and an event nobody records is one nobody can argue about. If
   * a panel is ever reported vanishing again, the log still says whether focus
   * moved and when.
   */
  _onBlur() {
    log.trace('panel.blur', {
      act: 'ignored',
      why: this.pinned ? 'pinned' : 'focus-is-not-a-dismissal-signal',
      pointerSeen: this._pointerSeen,
      sinceShown: this._shownAt === null ? null : Date.now() - this._shownAt,
    });
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

  /** The OS cursor in DIP screen space, or null when it will not say. */
  _cursorPoint() {
    if (!this.win || this.win.isDestroyed()) return null;
    try {
      const point = screen.getCursorScreenPoint();
      return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
    } catch {
      return null;
    }
  }

  /** true / false, or null when the OS would not say. */
  _pointerIsInside() {
    const point = this._cursorPoint();
    if (point === null) return null;
    return pointInRect(point, this.win.getBounds());
  }

  /**
   * The tray->panel corridor for this open, or null when the anchor could not
   * be measured.
   *
   * The bounding box of the icon and the panel, inflated. Because the panel is
   * placed adjacent to its icon, that box is the panel plus a short strip to
   * the tray — the shape of the journey, not of the screen.
   */
  _corridorFrom(anchor) {
    if (!anchor || !anchor.tray || !this.win || this.win.isDestroyed()) return null;
    const t = anchor.tray;
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) return null;
    const w = this.win.getBounds();
    const minX = Math.min(t.x, w.x) - TRANSIT_MARGIN_PX;
    const minY = Math.min(t.y, w.y) - TRANSIT_MARGIN_PX;
    const maxX = Math.max(t.x + t.width, w.x + w.width) + TRANSIT_MARGIN_PX;
    const maxY = Math.max(t.y + t.height, w.y + w.height) + TRANSIT_MARGIN_PX;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
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
    const point = this._cursorPoint();
    if (point === null) {
      log.trace('panel.poll', { act: 'skipped', why: 'no-cursor' });
      return;
    }
    const inside = pointInRect(point, this.win.getBounds());
    if (inside) {
      // Only the TRANSITION is traced. A resting pointer would otherwise
      // narrate itself four times a second and bury the sequence this log
      // exists to make readable.
      if (!this._pointerSeen) log.trace('panel.pointerLatch', { via: 'poll' });
      this._pointerSeen = true;
      this.cancelHide('pointer-inside');
      return;
    }
    // Never reached: the corridor rule owns it, not the leave rule.
    if (!this._pointerSeen) {
      this._pollTransit(point);
      return;
    }
    // Re-arming every 250 ms would reset the grace period forever and the timer
    // would never fire, so only start one when none is pending.
    if (!this._hideTimer) this.scheduleHide(LEAVE_GRACE_MS, 'pointer-left');
  }

  /**
   * The dismissal path for a panel the pointer has NEVER entered.
   *
   * This is what replaced `blur`. The question it answers is the one focus was
   * being asked to answer and could not: has the user gone somewhere else?
   * The cursor can say so directly, and unlike focus it is not handed around
   * by the shell on a schedule of its own.
   *
   *   inside the corridor   still on the way, or resting on the taskbar next
   *                         to the icon. Nothing happens.
   *   outside the corridor  they went somewhere else. Normal leave grace, so a
   *                         hand that overshoots and comes back is forgiven.
   *   never engaged at all  after NEVER_ENGAGED_MAX_MS, hide outright. The
   *                         cursor-parked-and-alt-tabbed case; no grace,
   *                         because a minute has already been the grace.
   */
  _pollTransit(point) {
    if (this._shownAt !== null && Date.now() - this._shownAt >= NEVER_ENGAGED_MAX_MS) {
      log.trace('panel.transit', { act: 'expired' });
      this.hide('never-engaged');
      return;
    }
    // No measurable anchor means no corridor. Then the backstop above is the
    // only rule, which is the honest answer: we cannot tell travelling from
    // leaving without knowing where the journey started.
    if (this._transitBox === null || pointInRect(point, this._transitBox)) {
      // Silent unless something was actually pending: an overshoot that comes
      // back must not narrate itself four times a second.
      this.cancelHide('transit-return');
      return;
    }
    if (!this._hideTimer) {
      log.trace('panel.transit', { act: 'left-corridor' });
      this.scheduleHide(LEAVE_GRACE_MS, 'left-corridor');
    }
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
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

/** Half-open on both axes, so the last pixel inside is inside. */
function pointInRect(point, rect) {
  if (!point || !rect) return false;
  return point.x >= rect.x && point.x < rect.x + rect.width
    && point.y >= rect.y && point.y < rect.y + rect.height;
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
/**
 * The window size for a work area: the preferred size, never more than the
 * work area minus the edge margin on both sides. A laptop at 150% scaling can
 * have a work area only ~680 DIP tall, where a fixed 720 would hang off it.
 */
function fitTo(width, height, work, margin = EDGE_MARGIN) {
  return {
    width: Math.max(1, Math.min(width, Math.round(work.width - 2 * margin))),
    height: Math.max(1, Math.min(height, Math.round(work.height - 2 * margin))),
  };
}

/**
 * The window rect for a size, next to the anchor on the taskbar's edge, kept
 * `margin` inside the work area on BOTH axes. Without the clamp the panel hangs
 * off the screen at a taskbar corner, where centring on the icon puts half of
 * it past the edge. A bottom (or top) taskbar holds the window's bottom (or
 * top) edge and centres it on the icon across; a side taskbar holds that side
 * and centres it on the icon down.
 */
function placeNear(anchorPoint, edge, work, { width, height }, margin = EDGE_MARGIN) {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const minX = work.x + margin;
  const maxX = work.x + work.width - width - margin;
  const minY = work.y + margin;
  const maxY = work.y + work.height - height - margin;
  let x;
  let y;
  if (edge === 'left' || edge === 'right') {
    x = clamp(edge === 'left' ? minX : maxX, minX, maxX);
    y = clamp(Math.round(anchorPoint.y - height / 2), minY, maxY);
  } else {
    x = clamp(Math.round(anchorPoint.x - width / 2), minX, maxX);
    y = clamp(edge === 'top' ? minY : maxY, minY, maxY);
  }
  return { x: Math.round(x), y: Math.round(y), width, height };
}

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
  FITTED_WIDTH,
  FITTED_MAX_HEIGHT,
  FITTED_GAP,
  FITTED_MIN_HEIGHT,
  fitTo,
  placeNear,
  LEAVE_GRACE_MS,
  POINTER_POLL_MS,
  TRANSIT_MARGIN_PX,
  NEVER_ENGAGED_MAX_MS,
  pointInRect,
  resolveRendererEntry,
  taskbarEdge,
  isPlausibleDipRect,
};
