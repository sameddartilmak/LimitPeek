/**
 * The single seam between the renderer and the main process.
 *
 * We run with contextIsolation:true, nodeIntegration:false, sandbox:true, so
 * there are no Node APIs here and no `require`. The only thing that exists is
 * what the preload exposed through contextBridge as `window.usageNotch`, and
 * its shape is fixed by `UsageNotchApi` in the contract — named methods only,
 * no generic invoke(channel, args) passthrough.
 *
 * There is exactly one fallback: if the object is missing entirely (preload
 * failed to load), we return a null bridge so the panel still paints and says
 * so. We do NOT probe for alternative method names any more; a shape mismatch
 * is an integration bug and must surface, not be silently absorbed.
 */

import type {
  AnchorPayload,
  Preferences,
  Snapshot,
  ThemeChoice,
  UsageNotchApi,
} from '../../shared/contract.js';
import { sanitizeAnchor, sanitizePreferences, sanitizeSnapshot } from './sanitize.js';

export interface SetupResult {
  ok: boolean;
  message: string;
}

export interface Bridge {
  /** False when no preload API was found. Drives the footer notice. */
  readonly available: boolean;
  /** Synchronous, for the first frame. Never awaits a scan. */
  initialSnapshot(): Snapshot | null;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  onAnchor(listener: (anchor: AnchorPayload) => void): () => void;
  /**
   * Subscribe to panel reveal (true) / conceal (false) from main. The renderer
   * replays its content open animation off this, so it plays on every open. A
   * preload that does not expose it degrades to a no-op subscription: the panel
   * still opens, it just does not re-animate.
   */
  onPanelVisibility(listener: (open: boolean) => void): () => void;
  panelOpened(): void;
  requestRefresh(): Promise<Snapshot | null>;
  /**
   * `confirmed` must be true for any action that writes outside the app's own
   * userData. The renderer only passes true after an explicit user gesture on
   * a confirm control that showed `SetupAction.detail` first.
   */
  runSetup(providerId: string, confirmed: boolean): Promise<SetupResult>;
  /**
   * Persist the user's provider order (IPC.SET_ORDER, 'providers:set-order').
   * Resolves false on any failure, including a preload that does not expose
   * it — the caller reverts visibly rather than pretending it stuck.
   */
  setOrder(ids: readonly string[]): Promise<boolean>;
  /**
   * Add a provider to the main panel, or remove it (IPC.SET_ENABLED). Same
   * all-or-nothing promise as setOrder: `false` means main persisted NOTHING,
   * so the caller must put the switch back rather than hope.
   */
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
  /**
   * Preferences main already holds, SYNCHRONOUSLY. Same reason as
   * initialSnapshot(): the theme has to be on the document in frame one, and
   * anything awaited is a visible flash of the other palette.
   *
   * Null means "main said nothing usable" — not "dark". The caller falls back
   * to its own default rather than adopting a value nobody chose.
   */
  initialPreferences(): Preferences | null;
  onPreferences(listener: (prefs: Preferences) => void): () => void;
  /**
   * Persist the theme choice (IPC.SET_THEME). Same all-or-nothing promise as
   * setOrder/setEnabled: `false` means main wrote NOTHING, so the caller puts
   * the previous choice back rather than leaving the panel in a theme that
   * will not survive a restart.
   */
  setTheme(theme: ThemeChoice): Promise<boolean>;
  close(): void;
  /** Asks main to switch to pinned mode. Main is the source of truth and
   *  answers by pushing a new anchor with mode:'pin'. */
  pin(): void;
}

function getApi(): UsageNotchApi | null {
  try {
    const candidate = (globalThis as { usageNotch?: unknown }).usageNotch;
    return candidate && typeof candidate === 'object' ? (candidate as UsageNotchApi) : null;
  } catch {
    return null;
  }
}

function nullBridge(): Bridge {
  return {
    available: false,
    initialSnapshot: () => null,
    onSnapshot: () => () => {},
    onAnchor: () => () => {},
    onPanelVisibility: () => () => {},
    panelOpened: () => {},
    requestRefresh: async () => null,
    runSetup: async () => ({ ok: false, message: 'Arka plan servisine ulaşılamıyor.' }),
    setOrder: async () => false,
    setEnabled: async () => false,
    initialPreferences: () => null,
    onPreferences: () => () => {},
    setTheme: async () => false,
    close: () => {},
    pin: () => {},
  };
}

/** A missing method is an integration bug, not a runtime condition. Report it
 *  once, loudly enough for a developer, without breaking the panel. */
function missing(name: string): void {
  console.error(`usageNotch.${name} is missing; preload does not match UsageNotchApi`);
}

export function createBridge(): Bridge {
  const api = getApi();
  if (!api) return nullBridge();

  return {
    available: true,

    initialSnapshot(): Snapshot | null {
      if (typeof api.initialSnapshot !== 'function') {
        missing('initialSnapshot');
        return null;
      }
      try {
        return sanitizeSnapshot(api.initialSnapshot());
      } catch {
        return null;
      }
    },

    onSnapshot(listener): () => void {
      if (typeof api.onSnapshot !== 'function') {
        missing('onSnapshot');
        return () => {};
      }
      try {
        return api.onSnapshot((payload) => {
          const clean = sanitizeSnapshot(payload);
          if (clean) listener(clean);
        });
      } catch {
        return () => {};
      }
    },

    onAnchor(listener): () => void {
      if (typeof api.onAnchor !== 'function') {
        missing('onAnchor');
        return () => {};
      }
      try {
        return api.onAnchor((payload) => {
          const clean = sanitizeAnchor(payload);
          if (clean) listener(clean);
        });
      } catch {
        return () => {};
      }
    },

    onPanelVisibility(listener): () => void {
      if (typeof api.onPanelVisibility !== 'function') {
        missing('onPanelVisibility');
        return () => {};
      }
      try {
        // Coerced to a strict boolean here: main sends `true`/`false`, but a
        // dropped or malformed payload must resolve to "closed" rather than
        // leave the panel animating toward an undefined state.
        return api.onPanelVisibility((payload) => listener(payload === true));
      } catch {
        return () => {};
      }
    },

    panelOpened(): void {
      try {
        api.panelOpened();
      } catch {
        /* a dead channel must never break the UI */
      }
    },

    async requestRefresh(): Promise<Snapshot | null> {
      try {
        return sanitizeSnapshot(await api.requestRefresh());
      } catch {
        return null;
      }
    },

    async runSetup(providerId: string, confirmed: boolean): Promise<SetupResult> {
      try {
        const result = await api.runSetup(providerId, confirmed);
        if (result && typeof result === 'object') {
          return {
            ok: result.ok === true,
            message: typeof result.message === 'string' ? result.message : '',
          };
        }
      } catch {
        /* fall through */
      }
      return { ok: false, message: 'Kurulum tamamlanamadı.' };
    },

    /**
     * The contract is explicit that `{ok:false}` means main wrote NOTHING, so
     * a false here is a real instruction to put the rows back — never a
     * "probably worked". Every failure path collapses to false for that
     * reason, including a preload that does not expose the method yet.
     */
    async setOrder(ids: readonly string[]): Promise<boolean> {
      if (typeof api.setOrder !== 'function') {
        missing('setOrder');
        return false;
      }
      try {
        // Copy: the array crosses a structured clone, and handing over the
        // caller's own array means a later mutation could be observed
        // mid-flight.
        const result = await api.setOrder(ids.map(String));
        return !!result && result.ok === true;
      } catch {
        return false;
      }
    },

    /** Mirrors setOrder: any failure is a real instruction to revert. */
    async setEnabled(id: string, enabled: boolean): Promise<boolean> {
      if (typeof api.setEnabled !== 'function') {
        missing('setEnabled');
        return false;
      }
      try {
        const result = await api.setEnabled(String(id), enabled === true);
        return !!result && result.ok === true;
      } catch {
        return false;
      }
    },

    /**
     * Synchronous by contract. A preload that has not caught up yet is an
     * integration bug, reported once — but it must not throw here, because
     * this runs before the panel exists and a throw would leave a blank
     * window instead of a dark-themed one.
     */
    initialPreferences(): Preferences | null {
      if (typeof api.initialPreferences !== 'function') {
        missing('initialPreferences');
        return null;
      }
      try {
        return sanitizePreferences(api.initialPreferences());
      } catch {
        return null;
      }
    },

    onPreferences(listener): () => void {
      if (typeof api.onPreferences !== 'function') {
        missing('onPreferences');
        return () => {};
      }
      try {
        return api.onPreferences((payload) => {
          const clean = sanitizePreferences(payload);
          if (clean) listener(clean);
        });
      } catch {
        return () => {};
      }
    },

    /** Mirrors setOrder: any failure is a real instruction to revert. */
    async setTheme(theme: ThemeChoice): Promise<boolean> {
      if (typeof api.setTheme !== 'function') {
        missing('setTheme');
        return false;
      }
      try {
        const result = await api.setTheme(theme);
        return !!result && result.ok === true;
      } catch {
        return false;
      }
    },

    close(): void {
      try {
        api.close();
      } catch {
        /* ignore */
      }
    },

    pin(): void {
      try {
        api.pin();
      } catch {
        /* ignore */
      }
    },
  };
}
