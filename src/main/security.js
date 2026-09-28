'use strict';
const { app, session } = require('electron');

const log = require('../core/log');

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

/**
 * A `file:` URL that names a REMOTE AUTHORITY is a network fetch wearing a
 * local scheme (security review of Phase B, F5): `file://server/share/x` is an
 * SMB round trip, and on the sessions this module hardens "it is a file URL"
 * was the whole check. So the authority has to be empty, and a path that
 * begins with `//` is refused too, because Windows resolves `\\host\share` from
 * exactly that shape.
 *
 * Parsed rather than pattern-matched: `file:////server/share` and
 * `FILE://server/share` are the same request to Chromium and must be the same
 * answer here.
 */
function isLocalFileUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.host !== '') return false;
  return !parsed.pathname.startsWith('//');
}

function isAllowed(url) {
  if (typeof url !== 'string') return false;
  const i = url.indexOf(':');
  if (i < 0) return false;
  const scheme = url.slice(0, i + 1).toLowerCase();
  if (!ALLOWED_SCHEMES.includes(scheme)) return false;
  // The other three carry no authority that could reach a host: `data:` and
  // `blob:` are in-process, and `devtools:` is Chromium's own.
  return scheme === 'file:' ? isLocalFileUrl(url) : true;
}

/**
 * Every session this app creates resolves DIRECT (ADR-001 Amendment 2026-09-22,
 * ruling 2).
 *
 * WHY THIS IS NOT THE CONTROL, AND WHY IT IS STILL HERE
 * ----------------------------------------------------
 * The first OS-level measurement of the packaged app found 4 DNS datagrams
 * within 0.87 s of launch, resolving `wpad`, plus loopback fetches of
 * http://wpad/wpad.dat — Chromium's proxy auto-discovery, from the
 * NetworkService child. Host resolution and PAC fetches are NOT URLRequests, so
 * the block-all `onBeforeRequest` below never saw them and every in-process test
 * passed while it was happening.
 *
 * `setProxy` is per session and cannot be called before the session exists,
 * which is already inside the window WPAD ran in. So the control is the
 * process-global switch in `applyProcessHardening` — measured at zero — and this
 * is belt and braces for any session created later in the process's life
 * (anything a future change adds).
 *
 * `{ mode: 'direct' }` is a literal, in one place, on purpose: `'system'` here
 * would put WPAD back, and a variable would make which mode ships depend on a
 * caller. A test asserts both.
 */
function setDirectProxy(sess) {
  if (!sess || typeof sess.setProxy !== 'function') return;
  try {
    const applied = sess.setProxy({ mode: 'direct' });
    if (applied && typeof applied.catch === 'function') {
      applied.catch((err) => log.warn(`proxy could not be set to direct: code=${(err && err.code) || 'UNKNOWN'}`));
    }
  } catch (err) {
    log.warn(`proxy could not be set to direct: code=${(err && err.code) || 'UNKNOWN'}`);
  }
}

/**
 * DNS-over-HTTPS and Chromium's built-in resolver, pinned OFF (security F9).
 *
 * Nothing in this codebase said anything about host resolution before this line.
 * Electron's `secureDnsMode` defaults to 'automatic' and `enableBuiltInResolver`
 * defaults to disabled on Windows, so DoH does not fire today — and the OS-level
 * audit corroborates it: plain UDP/53 to the LAN resolver, not TCP/443 to a DoH
 * provider. But a default is not a decision. A DoH lookup is a host resolution,
 * not a URLRequest, so a future Electron default flip would put our traffic on a
 * third-party HTTPS endpoint silently and completely invisibly to the block-all
 * filter in `applySessionHardening` — the same blind spot that let `wpad` ship.
 *
 * IT RUNS AFTER `ready`, unlike the command-line switches in
 * `applyProcessHardening`. `configureHostResolver` throws if called earlier, so
 * this is a PIN AGAINST FUTURE DRIFT and NOT a control over the first moments of
 * the process: whatever Chromium resolves during startup is governed by
 * `no-proxy-server` and by there being no host to look up, never by this call.
 *
 * Guarded exactly like `setDirectProxy`: an absent method is tolerated, nothing
 * throws, and a failure logs a fixed code — never a raw error string (ADR-001
 * security F3).
 */
function pinHostResolver() {
  if (typeof app.configureHostResolver !== 'function') return;
  try {
    app.configureHostResolver({ enableBuiltInResolver: false, secureDnsMode: 'off' });
  } catch (err) {
    log.warn(`host resolver could not be pinned: code=${(err && err.code) || 'UNKNOWN'}`);
  }
}

function applySessionHardening(sess) {
  // BEFORE the request filter, and before anything else that could touch the
  // network: proxy resolution is the one piece of outbound traffic the filter
  // cannot see.
  setDirectProxy(sess);

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

/**
 * `defaultSession`? Its listener is registered ONCE, from `applyAll()`, and is
 * never re-registered (Amendment 5, K14a): doing it a second time — even with
 * identical code — is the shape of the edit that removes the global block, so it
 * is refused structurally rather than by review.
 */
function isDefaultSession(sess) {
  try {
    return sess === session.defaultSession;
  } catch {
    // Before `ready` there is no default session to compare against.
    return false;
  }
}

function applyProcessHardening() {
  // Never start crashReporter: it is the only Electron subsystem that uploads
  // by default once started. Not calling `crashReporter.start()` is the
  // guarantee; this switch removes the child-process uploader as well.
  app.commandLine.appendSwitch('disable-crash-reporter');
  app.commandLine.appendSwitch('disable-features', 'MediaRouter,Translate,OptimizationHints');

  /**
   * THE control for proxy auto-discovery (ADR-001 Amendment 2026-09-22).
   *
   * Chromium's NetworkService starts resolving `wpad` — 4 DNS datagrams and a
   * loopback fetch of http://wpad/wpad.dat — within 0.87 s of launch, before any
   * session exists to call `setProxy` on, and through a channel the session
   * request filter cannot see at all. devops measured this switch at ZERO
   * outbound events over five minutes, and per-session DIRECT alone could not be
   * made to win that race.
   *
   * A SECOND, INDEPENDENT REASON this switch is the control and not belt and
   * braces (security review F4): `setDirectProxy` never awaits `setProxy` (it
   * only attaches a `.catch`), so a session can be used before DIRECT has
   * actually been applied, which is harmless only because this switch has
   * already made the process default direct. Per-session control could
   * therefore never have been the control; do not "simplify" this line away on
   * the strength of the `setProxy` calls.
   *
   * It is a command-line switch and therefore must be appended BEFORE `ready`,
   * which is why it lives here: `applyAll()` runs at require time in
   * `src/main/index.js`, before the app is ready.
   */
  app.commandLine.appendSwitch('no-proxy-server');

  /**
   * EVERY session, not just the default one (ADR-003 Amendment 5: "hardening
   * today covers defaultSession only").
   *
   * A session with no request filter is a session with no outbound block, and
   * the app makes no network request of its own on ANY session, so every one
   * gets the same block-all filter. Registered before `ready`, so a session
   * created during startup cannot slip through.
   */
  app.on('session-created', (sess) => {
    if (isDefaultSession(sess)) return;
    applySessionHardening(sess);
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

function applyAll() {
  applyProcessHardening();
  app.whenReady().then(() => {
    // After `ready`, which is the whole reason it is not up with the switches.
    pinHostResolver();
    applySessionHardening(session.defaultSession);
  });
}

module.exports = {
  applyAll,
  applySessionHardening,
  applyProcessHardening,
  isAllowed,
  isLocalFileUrl,
  setDirectProxy,
  pinHostResolver,
};
