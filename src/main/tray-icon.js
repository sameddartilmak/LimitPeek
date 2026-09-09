'use strict';
const { nativeImage } = require('electron');
const { drawDonut } = require('../core/donut');
const log = require('../core/log');

/**
 * Assembles the multi-representation tray image from raw BGRA buffers.
 *
 * Windows picks a representation by the DPI of the display the taskbar is on,
 * and that is frequently a fractional factor — 1.25 is this machine's. Only
 * the 1x buffer is passed as a bitmap; the others go in as PNG, which is what
 * `addRepresentation` takes.
 *
 * Every failure path returns null so the caller can keep the static PNG.
 * An app that loses its tray icon has effectively uninstalled itself.
 */
const REPRESENTATIONS = Object.freeze([
  { scaleFactor: 1, size: 16 },
  { scaleFactor: 1.25, size: 20 },
  { scaleFactor: 1.5, size: 24 },
  { scaleFactor: 2, size: 32 },
]);

function bitmap(size, spec, ground) {
  return nativeImage.createFromBitmap(drawDonut(size, spec, ground), { width: size, height: size });
}

/**
 * @param {{usedPercentage:number|null, accent:string, state:string}} spec
 * @param {'dark'|'light'} [ground] the taskbar the icon will sit on, from
 *   `nativeTheme.shouldUseDarkColors` — NOT from the user's in-app theme
 *   choice. The icon lives in the taskbar, so it matches what it sits on; a
 *   user on a light taskbar who prefers a dark panel still needs a legible
 *   icon.
 * @returns {import('electron').NativeImage|null} null => caller keeps the PNG
 */
function buildTrayImage(spec, ground = 'dark') {
  try {
    const base = bitmap(REPRESENTATIONS[0].size, spec, ground);
    if (base.isEmpty()) {
      log.warn('tray donut came back empty; keeping the static icon');
      return null;
    }
    for (const rep of REPRESENTATIONS.slice(1)) {
      try {
        const image = bitmap(rep.size, spec, ground);
        if (!image.isEmpty()) {
          base.addRepresentation({ scaleFactor: rep.scaleFactor, buffer: image.toPNG() });
        }
      } catch (err) {
        // One missing HiDPI representation is a scaled icon, not a broken one.
        log.warn(`tray representation ${rep.scaleFactor}x failed: code=${(err && err.code) || 'UNKNOWN'}`);
      }
    }
    return base;
  } catch (err) {
    log.warn(`tray donut could not be built: code=${(err && (err.code || err.name)) || 'UNKNOWN'}`);
    return null;
  }
}

module.exports = { buildTrayImage, REPRESENTATIONS };
