'use strict';
const { app, session } = require('electron');

/**
 * Process-wide hardening. ADR-001 constraints security F8 and F11.
 *
 * The strongest control here is the request filter: it CANCELS every request
 * that is not a local file. Usage Notch has no HTTP client in its dependency
 * tree, but a filter at the session layer means even an accidental
 * `<img src="https://...">` in the renderer, an embedded font URL, or a future
 * dependency's telemetry call produces zero outbound bytes.
 */

const ALLOWED_SCHEMES = ['file:', 'devtools:', 'blob:', 'data:'];

function isAllowed(url) {
  const i = url.indexOf(':');
  if (i < 0) return false;
  return ALLOWED_SCHEMES.includes(url.slice(0, i + 1).toLowerCase());
}

function applySessionHardening(sess) {
  sess.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowed(details.url) });
  });

  // Nothing in this app needs a device or a capability.
  sess.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  sess.setPermissionCheckHandler(() => false);
  if (typeof sess.setDevicePermissionHandler === 'function') {
    sess.setDevicePermissionHandler(() => false);
  }

  // Belt and braces alongside the renderer's own <meta> CSP.
  sess.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
          + "img-src 'self' data:; font-src 'self'; connect-src 'none'; "
          + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ],
      },
    });
  });
}

function applyProcessHardening() {
  // Never start crashReporter: it is the only Electron subsystem that uploads
  // by default once started. Not calling `crashReporter.start()` is the
  // guarantee; this switch removes the child-process uploader as well.
  app.commandLine.appendSwitch('disable-crash-reporter');
  app.commandLine.appendSwitch('disable-features', 'MediaRouter,Translate,OptimizationHints');

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

function applyAll() {
  applyProcessHardening();
  app.whenReady().then(() => applySessionHardening(session.defaultSession));
}

module.exports = { applyAll, applySessionHardening, applyProcessHardening, isAllowed };
