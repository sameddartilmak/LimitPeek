'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * The taskbar strip page's whole surface (src/main/strip/strip.js): one
 * subscription and two fire-and-forget clicks. Not the panel's preload, and
 * deliberately much smaller: the strip draws what main sends and can ask for
 * nothing else — no snapshot, no settings, no setup.
 *
 * Channel names are inlined for the reason `preload.js` gives (a sandboxed
 * preload has a restricted module system); `test/contract-mirror.test.js`
 * holds them to `contract.ts` IPC_STRIP.
 */
const CH = {
  DATA: 'strip:data',
  OPEN: 'strip:open',
  MENU: 'strip:menu',
};

contextBridge.exposeInMainWorld('usageNotchStrip', {
  /** main -> page: `{ ground, tileWidth, tiles }`. Returns an unsubscribe. */
  onData: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, payload) => {
      try { cb(payload); } catch { /* a throwing callback must not kill the listener */ }
    };
    ipcRenderer.on(CH.DATA, listener);
    return () => ipcRenderer.removeListener(CH.DATA, listener);
  },
  /** Left click: open the panel, as a tray click does. */
  open: () => ipcRenderer.send(CH.OPEN),
  /** Right click: the tray icon's menu. */
  menu: () => ipcRenderer.send(CH.MENU),
});
