/**
 * Tray anchor geometry.
 *
 * Main creates ONE transparent window at a fixed size and never moves or
 * resizes it while the panel animates. Every offset and the tail position are
 * computed here, in the DOM, from the AnchorPayload it pushes on each open.
 *
 * Coordinate spaces — the thing that makes this class of bug
 * ------------------------------------------------------------------
 * Electron reports `Tray.getBounds()`, `BrowserWindow.getBounds()` and
 * `Display.bounds/workArea` all in DIP (device-independent pixels), and CSS
 * pixels in the renderer are the same unit while zoomFactor is 1. So the
 * subtraction `tray.x - window.x` is already correct in CSS px and must NOT be
 * multiplied by `scaleFactor`. Multiplying is the classic mixed-DPI bug and it
 * is silent: at 1.25 the tail lands a quarter of the panel away from the icon.
 *
 * `scaleFactor` is used for exactly one thing: snapping the tail centre to a
 * whole DEVICE pixel, so a 2px tail does not straddle two physical pixels and
 * render as two half-intensity columns at 1.25x.
 */

import type { AnchorPayload } from '../../shared/contract.js';

/** Keep the panel this far from the window edge, leaving room for its shadow. */
const CANVAS_MARGIN = 12;
/** The tail must stay this far from the panel's rounded corners. */
const TAIL_INSET = 22;
/** Tail size, matching --tail-h / --tail-w in panel.css. */
export const TAIL = { width: 16, height: 8 };

export type Axis = 'vertical' | 'horizontal';

export interface PanelPlacement {
  /** Offsets in CSS px from the window's top-left, for the panel box. */
  left: number;
  top: number | null;
  bottom: number | null;
  /** Tail centre, in CSS px relative to the PANEL's own top-left. */
  tailOffset: number;
  /** Which side of the panel the tail hangs off. */
  tailSide: 'top' | 'bottom' | 'left' | 'right';
  /** Which way the panel grows, so the open animation has the right origin. */
  origin: string;
  axis: Axis;
  mode: 'hover' | 'pin';
  /** True when the tail hit its clamp and no longer points at the icon. */
  tailClamped: boolean;
  /**
   * Where the anchor rect came from. 'cursor' means main could not read a real
   * tray rect — most often because Windows 11 filed the icon into the
   * hidden-icons overflow, where it reports zero size. The tail is dimmed then,
   * because it is pointing at a guess.
   */
  anchorSource: 'tray' | 'cursor';
  /** True when the panel does not fit the window canvas at all. */
  overflows: boolean;
}

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

/** Round to a whole device pixel so hairlines and the tail stay crisp. */
function snapToDevicePixel(value: number, scaleFactor: number): number {
  const s = scaleFactor > 0 ? scaleFactor : 1;
  return Math.round(value * s) / s;
}

/**
 * @param panel  the panel's own measured size in CSS px
 * @param anchor geometry pushed by main
 */
export function placePanel(
  anchor: AnchorPayload,
  panel: { width: number; height: number },
): PanelPlacement {
  const { tray, window: win, display, edge, mode, anchorSource } = anchor;
  const scale = display.scaleFactor;

  // Tray centre expressed relative to the window's top-left. Same unit (DIP),
  // so this is a plain subtraction — see the header comment.
  const trayCentreX = tray.x + tray.width / 2 - win.x;
  const trayCentreY = tray.y + tray.height / 2 - win.y;

  const vertical = edge === 'bottom' || edge === 'top';
  const axis: Axis = vertical ? 'vertical' : 'horizontal';

  if (vertical) {
    // Panel sits above the taskbar (edge 'bottom') or below it (edge 'top'),
    // and slides horizontally to line its tail up with the icon.
    const minLeft = CANVAS_MARGIN;
    const maxLeft = win.width - panel.width - CANVAS_MARGIN;
    const idealLeft = trayCentreX - panel.width / 2;
    const left = snapToDevicePixel(clamp(idealLeft, minLeft, maxLeft), scale);

    const idealTail = trayCentreX - left;
    const tailOffset = snapToDevicePixel(
      clamp(idealTail, TAIL_INSET, panel.width - TAIL_INSET),
      scale,
    );

    const tailSide = edge === 'bottom' ? 'bottom' : 'top';
    return {
      left,
      top: edge === 'top' ? CANVAS_MARGIN + TAIL.height : null,
      bottom: edge === 'bottom' ? CANVAS_MARGIN + TAIL.height : null,
      tailOffset,
      tailSide,
      // The panel grows away from the taskbar, so the scaleY origin is the
      // edge nearest the tray icon.
      origin: edge === 'bottom' ? `${tailOffset}px 100%` : `${tailOffset}px 0%`,
      axis,
      mode,
      anchorSource,
      tailClamped: Math.abs(idealTail - tailOffset) > 0.5,
      overflows: panel.width + 2 * CANVAS_MARGIN > win.width ||
        panel.height + 2 * CANVAS_MARGIN + TAIL.height > win.height,
    };
  }

  // Side taskbar: the panel hangs off the left or right edge and slides
  // vertically instead.
  const minTop = CANVAS_MARGIN;
  const maxTop = win.height - panel.height - CANVAS_MARGIN;
  const idealTop = trayCentreY - panel.height / 2;
  const top = snapToDevicePixel(clamp(idealTop, minTop, maxTop), scale);

  const idealTail = trayCentreY - top;
  const tailOffset = snapToDevicePixel(
    clamp(idealTail, TAIL_INSET, panel.height - TAIL_INSET),
    scale,
  );

  const left =
    edge === 'left'
      ? CANVAS_MARGIN + TAIL.height
      : win.width - panel.width - CANVAS_MARGIN - TAIL.height;

  return {
    left: snapToDevicePixel(left, scale),
    top,
    bottom: null,
    tailOffset,
    tailSide: edge === 'left' ? 'left' : 'right',
    origin: edge === 'left' ? `0% ${tailOffset}px` : `100% ${tailOffset}px`,
    axis,
    mode,
    anchorSource,
    tailClamped: Math.abs(idealTail - tailOffset) > 0.5,
    overflows:
      panel.height + 2 * CANVAS_MARGIN > win.height ||
      panel.width + 2 * CANVAS_MARGIN + TAIL.height > win.width,
  };
}

/**
 * The tallest a fitted panel is before main has said so in an anchor
 * (`AnchorPayload.maxHeight`). Mirrors FITTED_MAX_HEIGHT in
 * src/main/panel-window.js; the first open's anchor corrects it on a smaller
 * work area.
 */
export const FITTED_MAX_HEIGHT = 680;

/**
 * A 'fitted' window (Preferences.frame) IS the panel: the panel fills it from
 * the edge nearest the taskbar, so a height change that reaches the window a
 * frame late shows on the far side, and there is no tail to aim. `tailSide`
 * still names the taskbar's side, which is where the entrance slides in from.
 */
export function fittedPlacement(anchor: AnchorPayload | null): PanelPlacement {
  const edge = anchor ? anchor.edge : 'bottom';
  const vertical = edge === 'bottom' || edge === 'top';
  return {
    left: 0,
    top: edge === 'bottom' ? null : 0,
    bottom: edge === 'bottom' ? 0 : null,
    tailOffset: 0,
    tailSide: edge,
    origin: edge === 'top' ? '50% 0%' : edge === 'left' ? '0% 50%' : edge === 'right' ? '100% 50%' : '50% 100%',
    axis: vertical ? 'vertical' : 'horizontal',
    mode: anchor ? anchor.mode : 'hover',
    anchorSource: anchor ? anchor.anchorSource : 'cursor',
    tailClamped: false,
    overflows: false,
  };
}

/**
 * Fallback used before the first anchor arrives, and in the dev harness where
 * there is no tray. Bottom-centred, which is what a bottom taskbar gives.
 */
export function defaultPlacement(canvas: { width: number; height: number }): PanelPlacement {
  return {
    left: Math.round((canvas.width - 360) / 2),
    top: null,
    bottom: CANVAS_MARGIN + TAIL.height,
    tailOffset: 180,
    tailSide: 'bottom',
    origin: '180px 100%',
    axis: 'vertical',
    mode: 'hover',
    // No anchor has arrived, so there is no tray rect to be pointing at.
    anchorSource: 'cursor',
    tailClamped: false,
    overflows: false,
  };
}
