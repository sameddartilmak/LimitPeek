/**
 * The panel's Liquid Glass (owner, 2026-11-02: "apple'daki liquid glass varya
 * onu istiyorum"; the mockup approved: scratchpad liquid/mock.html).
 *
 * Main clears the window (panel-material.js) and, as the panel opens, hands
 * over a picture of the screen region it is about to cover (IPC.BACKDROP,
 * win32 captureScreen). This draws the glass from that picture, behind the
 * whole panel:
 *
 *   - the screen behind, softened a little (a small blur) and a touch more
 *     saturated, as through thick glass;
 *   - bent like a lens towards the edges: within LENS_BAND of the rim each
 *     pixel is read from further inside, so what is behind the edge seems
 *     pulled outward, the way a rounded slab of glass refracts;
 *   - a tint, a soft shine top-left and a bright rim (glass.css), drawn by CSS
 *     over the picture.
 *
 * Done here, in plain arrays, not with an SVG filter: a displacement map
 * needs an `<feImage href>`, and dom.ts allows no href anywhere — a
 * guardrail worth more than a shorter file. The work is one pass over the
 * panel's own pixels per picture and per resize; main sends a new picture
 * only when the screen under the panel changed (panel-window.js, LIVE).
 *
 * The picture follows the screen while the panel is open (main copies the
 * region under it again and sends it when it changed). It lives only in this
 * page's memory and is dropped when the panel closes (main sends null).
 *
 * Purely decorative: aria-hidden, no pointer events, and absent unless the
 * window really is clear (`html[data-material="acrylic"][data-frame="fitted"]`,
 * glass.css). With no picture yet the CSS tint is drawn alone, thicker, so
 * the first frame is never a bare desktop behind the text.
 */

import type { BackdropPayload } from '../../../shared/contract.js';
import { el } from '../dom.js';

/** The glass's corner radius, in CSS px: Apple's wide, soft corner. */
export const GLASS_RADIUS = 22;
/** How far in from the rim the lens bends, in CSS px. */
export const LENS_BAND = 26;
/** How far the rim reads from, at the very edge, in CSS px. */
export const LENS_DEPTH = 18;
/** The softening: a box blur this wide each side, run twice, in CSS px. */
export const BLUR_RADIUS = 2;
/** Saturation over the picture (1 is unchanged). */
export const SATURATION = 1.45;

export interface GlassHandle {
  /** The layer itself; app.ts puts it first in <body>, outside the animated panel. */
  el: HTMLElement;
  /** A new picture, a move of the old one, or null: drop it. */
  apply(backdrop: BackdropPayload | null): void;
  destroy(): void;
}

/**
 * The picture main sent, as an RGBA source in the WINDOW's coordinates:
 * `scale` physical pixels per CSS px, and where the window's top-left falls
 * inside it.
 */
interface Source {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  scale: number;
  originX: number;
  originY: number;
}

export function createGlass(): GlassHandle {
  const canvas = el('canvas', { class: 'glass__shot' }) as HTMLCanvasElement;
  const root = el(
    'div',
    { class: 'glass', 'aria-hidden': 'true', 'data-ready': 'false' },
    canvas,
    el('div', { class: 'glass__tint' }),
    el('div', { class: 'glass__shine' }),
    el('div', { class: 'glass__rim' }),
  );

  let source: Source | null = null;
  let frame = 0;

  function draw(): void {
    frame = 0;
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!source || !ctx || typeof ctx.createImageData !== 'function') return;
    const cssW = Math.max(1, Math.round(window.innerWidth));
    const cssH = Math.max(1, Math.round(window.innerHeight));
    const out = refract(source, cssW, cssH);
    canvas.width = out.width;
    canvas.height = out.height;
    const image = ctx.createImageData(out.width, out.height);
    image.data.set(out.rgba);
    ctx.putImageData(image, 0, 0);
    root.setAttribute('data-ready', 'true');
  }

  function schedule(): void {
    if (frame || typeof requestAnimationFrame !== 'function') return;
    frame = requestAnimationFrame(draw);
  }

  function drop(): void {
    source = null;
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    frame = 0;
    // A zero-sized canvas frees its pixels; nothing of the screen is kept.
    canvas.width = 0;
    canvas.height = 0;
    root.setAttribute('data-ready', 'false');
  }

  const onResize = (): void => schedule();
  window.addEventListener('resize', onResize);

  return {
    el: root,
    apply(backdrop) {
      if (backdrop === null) {
        drop();
        return;
      }
      if (backdrop.image) {
        source = {
          rgba: rgbaOfBgra(backdrop.image.bgra),
          width: backdrop.image.pixelWidth,
          height: backdrop.image.pixelHeight,
          scale: backdrop.image.pixelWidth / backdrop.width,
          originX: 0,
          originY: 0,
        };
      }
      if (!source) return;
      // Where the window's top-left is inside the picture, in its pixels: the
      // picture's own top-left is at (x, y) in the window's CSS px.
      source.originX = Math.round(-backdrop.x * source.scale);
      source.originY = Math.round(-backdrop.y * source.scale);
      schedule();
    },
    destroy() {
      drop();
      window.removeEventListener('resize', onResize);
    },
  };
}

/** Windows' B, G, R, x rows -> RGBA with a full alpha. */
export function rgbaOfBgra(bgra: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2];
    out[i + 1] = bgra[i + 1];
    out[i + 2] = bgra[i];
    out[i + 3] = 255;
  }
  return out;
}

/**
 * The glass for a window of `cssW` x `cssH` CSS px, from `src`: the window's
 * region cut out of the picture, softened, bent at the rim and saturated.
 * Pure, so it is tested without a canvas. Reads outside the picture clamp to
 * its edge.
 */
export function refract(src: Source, cssW: number, cssH: number): { width: number; height: number; rgba: Uint8ClampedArray } {
  const s = src.scale > 0 && Number.isFinite(src.scale) ? src.scale : 1;
  const w = Math.max(1, Math.round(cssW * s));
  const h = Math.max(1, Math.round(cssH * s));
  const n = w * h;

  // 1. The window's region, clamped into the picture, one plane per channel
  //    (the blur below runs a plane at a time with no per-pixel branching).
  const red = new Float32Array(n);
  const green = new Float32Array(n);
  const blue = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const sy = clamp(y + src.originY, 0, src.height - 1);
    const row = sy * src.width;
    for (let x = 0; x < w; x++) {
      const i = (row + clamp(x + src.originX, 0, src.width - 1)) * 4;
      const o = y * w + x;
      red[o] = src.rgba[i];
      green[o] = src.rgba[i + 1];
      blue[o] = src.rgba[i + 2];
    }
  }

  // 2. Softened: a box blur, twice, close to a small Gaussian.
  const r = Math.max(1, Math.round(BLUR_RADIUS * s));
  const scratch = new Float32Array(n);
  for (const plane of [red, green, blue]) {
    for (let pass = 0; pass < 2; pass++) {
      blurRows(plane, scratch, w, h, r);
      blurColumns(scratch, plane, w, h, r);
    }
  }

  // 3. Bent at the rim, then saturated. Only the band along the rim reads
  //    from elsewhere; inside it every pixel reads straight through.
  const rgba = new Uint8ClampedArray(n * 4);
  const radius = GLASS_RADIUS * s;
  const band = LENS_BAND * s;
  const depth = LENS_DEPTH * s;
  const cx = w / 2;
  const cy = h / 2;
  const reach = band + radius;
  for (let y = 0; y < h; y++) {
    const inRows = y >= reach && y < h - reach;
    for (let x = 0; x < w; x++) {
      let i = y * w + x;
      if (!inRows || x < reach || x >= w - reach) {
        const px = x + 0.5 - cx;
        const py = y + 0.5 - cy;
        // Signed distance to the rounded rect's edge: negative inside.
        const qx = Math.abs(px) - (cx - radius);
        const qy = Math.abs(py) - (cy - radius);
        const ox = qx > 0 ? qx : 0;
        const oy = qy > 0 ? qy : 0;
        const d = Math.min(qx > qy ? qx : qy, 0) + Math.sqrt(ox * ox + oy * oy) - radius;
        const t = clamp01(1 + d / band);
        if (t > 0) {
          const nx = px / cx;
          const ny = py / cy;
          const k = (t * t * depth) / (Math.sqrt(nx * nx + ny * ny) || 1);
          // Read from further in: the edge's picture is pulled outward.
          i = clamp(Math.round(y - k * ny), 0, h - 1) * w + clamp(Math.round(x - k * nx), 0, w - 1);
        }
      }
      const rv = red[i];
      const gv = green[i];
      const bv = blue[i];
      const grey = 0.2126 * rv + 0.7152 * gv + 0.0722 * bv;
      const o = (y * w + x) * 4;
      rgba[o] = grey + (rv - grey) * SATURATION;
      rgba[o + 1] = grey + (gv - grey) * SATURATION;
      rgba[o + 2] = grey + (bv - grey) * SATURATION;
      rgba[o + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

/** One plane's rows box-blurred into `out`, edges clamped: a running sum. */
function blurRows(src: Float32Array, out: Float32Array, w: number, h: number, r: number): void {
  const span = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      out[row + x] = sum / span;
      sum += src[row + (x + r + 1 < w ? x + r + 1 : w - 1)] - src[row + (x - r > 0 ? x - r : 0)];
    }
  }
}

/** One plane's columns box-blurred into `out`, edges clamped. */
function blurColumns(src: Float32Array, out: Float32Array, w: number, h: number, r: number): void {
  const span = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / span;
      sum += src[(y + r + 1 < h ? y + r + 1 : h - 1) * w + x] - src[(y - r > 0 ? y - r : 0) * w + x];
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
