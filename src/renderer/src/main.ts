/**
 * Renderer entry point.
 *
 * Nothing here touches Node. The only capability this document has beyond DOM
 * is whatever the preload put on `window.usageNotch`, and createBridge() copes
 * with that object being absent.
 */

import { mountApp } from './app.js';
import { createBridge } from './bridge.js';
import { installSmoothScroll } from './smooth-scroll.js';

function start(): void {
  const container = document.getElementById('app');
  if (!container) throw new Error('renderer: #app is missing');
  mountApp(container, createBridge());
  installSmoothScroll(window);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
