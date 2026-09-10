/**
 * Panel state. A single object, one subscriber list, no framework.
 *
 * Staleness is derived here from `Snapshot.generatedAt` rather than trusted
 * from a flag, so a main process that stops pushing degrades visibly instead
 * of freezing a confident-looking number on screen.
 */

import type {
  AnchorPayload,
  ProviderSnapshot,
  RefreshNotice,
  Snapshot,
  ThemeChoice,
} from '../../shared/contract.js';
import { CADENCE } from '../../shared/contract.js';
import { DEFAULT_THEME } from './theme.js';

/** An open consent prompt. Set only while the user is being asked. */
export interface ConsentRequest {
  providerId: string;
  providerName: string;
  label: string;
  detail: string;
}

/**
 * Which view the panel shows.
 *
 * In-panel, not a second window: one window keeps the tray anchor, the open /
 * close lifecycle and the design language. `settings` lists EVERY provider so
 * the user can add or remove rows; `main` lists only the added ones.
 */
export type PanelView = 'main' | 'settings';

export type Freshness =
  | 'pending' // bridge is up, but no snapshot has landed yet
  | 'live'
  | 'aging'
  | 'stale'
  | 'offline';

export interface PanelState {
  snapshot: Snapshot | null;
  /** Newest tray geometry from main. Null until the first ANCHOR push. */
  anchor: AnchorPayload | null;
  /** True once a snapshot has arrived; drives skeleton vs. content. */
  hasData: boolean;
  bridgeAvailable: boolean;
  open: boolean;
  pinned: boolean;
  refreshing: boolean;
  /** Provider ids whose setup action is currently running. */
  busy: readonly string[];
  /** Transient, renderer-side message shown above the footer. */
  notice: string | null;
  /**
   * A notice about the last EXPLICIT refresh — not about the data. Set from
   * `Snapshot.refreshNotices` on a `requestRefresh()` reply and never from a
   * push, so it describes one action the user just took (pressing Yenile) and
   * does not become a standing claim. Cleared at the start of the next refresh
   * and on dismissal. Drives the calm "Antigravity açık değil" bubble.
   */
  refreshNotice: RefreshNotice | null;
  /**
   * Set while a setup action is waiting for explicit consent. Nothing is sent
   * to main until the user confirms, so this is the gate that makes
   * runSetup(id, true) safe.
   */
  consent: ConsentRequest | null;
  /**
   * The user's pending reorder, as provider ids.
   *
   * `Snapshot.providers` arrives in user order and the renderer never sorts
   * it. This is the ONE exception, and it is not a sort: it is the move the
   * user just made, held between the gesture and main's next snapshot so the
   * row does not spring back for a frame. It is cleared the moment main agrees
   * (or visibly disagrees) — see reconcileOrder() in app.ts.
   */
  order: readonly string[] | null;
  /** Which view is on screen. Never persisted; a fresh open starts on 'main'. */
  view: PanelView;
  /**
   * The user's pending add/remove, per provider id.
   *
   * Same shape of exception as `order`: `ProviderSnapshot.enabled` is main's
   * truth and is never second-guessed, but between the gesture and main's
   * answer the switch must show what the user just did. Cleared as soon as
   * main agrees — or visibly reverted when it says `{ok:false}`, which the
   * contract defines as "nothing changed anywhere".
   */
  enabledOverride: Readonly<Record<string, boolean>>;
  /** Provider ids whose setEnabled call is still in flight. */
  enabledPending: readonly string[];
  /**
   * The provider whose toggle was just put back because main refused. Held
   * briefly so the revert is SEEN and not merely described in the notice.
   */
  revertedId: string | null;
  /**
   * The theme the UI is currently showing.
   *
   * Optimistic, exactly like `enabledOverride`: the palette flips on the
   * gesture and main is asked afterwards. It is NOT the document's resolved
   * theme — that is theme.ts's business and can be 'dark' while this says
   * 'system'. This is the CHOICE, which is the thing the radio group reflects.
   */
  theme: ThemeChoice;
  /** True while a setTheme call is in flight. */
  themePending: boolean;
  /**
   * Set when main refused a theme change and the choice was put back. Held
   * briefly so the revert is SEEN, the same way `revertedId` works for the
   * provider switches.
   */
  themeReverted: boolean;
}

const INITIAL: PanelState = {
  snapshot: null,
  anchor: null,
  hasData: false,
  bridgeAvailable: false,
  open: false,
  pinned: false,
  refreshing: false,
  busy: [],
  notice: null,
  refreshNotice: null,
  consent: null,
  order: null,
  view: 'main',
  enabledOverride: {},
  enabledPending: [],
  revertedId: null,
  theme: DEFAULT_THEME,
  themePending: false,
  themeReverted: false,
};

type Listener = (state: PanelState) => void;

export class Store {
  private state: PanelState = INITIAL;
  private readonly listeners = new Set<Listener>();

  get(): PanelState {
    return this.state;
  }

  set(patch: Partial<PanelState>): void {
    let changed = false;
    const next = { ...this.state };
    for (const key of Object.keys(patch) as Array<keyof PanelState>) {
      const value = patch[key];
      if (value !== undefined && next[key] !== value) {
        (next as Record<string, unknown>)[key] = value;
        changed = true;
      }
    }
    if (!changed) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  setSnapshot(snapshot: Snapshot): void {
    this.set({ snapshot, hasData: true });
  }

  setAnchor(anchor: AnchorPayload): void {
    // Main is the source of truth for pinned mode; the pin button only asks.
    this.set({ anchor, pinned: anchor.mode === 'pin' });
  }

  markBusy(providerId: string, busy: boolean): void {
    const current = this.state.busy;
    const next = busy
      ? current.includes(providerId)
        ? current
        : [...current, providerId]
      : current.filter((id) => id !== providerId);
    if (next !== current) this.set({ busy: next });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * "Is this provider ADDED?" — main's `enabled`, unless the user has just
 * flipped the switch and we are still waiting for the answer.
 *
 * It lives here, exported, because more than one surface depends on it and a
 * second surface that restates the condition WILL drift: that is exactly how
 * the panel and the tray icon ended up with different state thresholds
 * (STATE_THRESHOLDS in contract.ts:26), which put a green icon next to an
 * amber row. Every place that asks "is this row in the main panel" calls this.
 */
export function enabledOf(state: PanelState, provider: ProviderSnapshot): boolean {
  return state.enabledOverride[provider.id] ?? provider.enabled;
}

/**
 * Freshness thresholds. Chosen so the header marker is SILENT during normal
 * operation (main is expected to push well inside a minute) and unmistakable
 * once the numbers on screen stop being answerable for — see the escalation
 * table in components/header.ts, which is the only thing that renders these.
 */
export function freshnessOf(
  generatedAt: string | null,
  bridgeAvailable: boolean,
  now: number,
): { level: Freshness; ageMs: number } {
  if (!bridgeAvailable) return { level: 'offline', ageMs: 0 };
  if (!generatedAt) return { level: 'pending', ageMs: 0 };
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t)) return { level: 'pending', ageMs: 0 };

  // Thresholds come from CADENCE in the contract, not from a local guess, so
  // both lanes agree on one number. 'live' is anything inside the cadence main
  // guarantees while idle; 'stale' is past the budget it publishes.
  const ageMs = Math.max(0, now - t);
  if (ageMs < CADENCE.IDLE_MS) return { level: 'live', ageMs };
  if (ageMs < CADENCE.STALE_AFTER_MS) return { level: 'aging', ageMs };
  return { level: 'stale', ageMs };
}

/**
 * Whether the renderer should stop presenting `ok` rows at full confidence.
 *
 * This is derived here rather than trusted from the row's own status, because
 * a main process that has stopped pushing will keep saying `ok` forever. The
 * only thing the renderer can independently verify is how old the snapshot is.
 */
export function shouldDegrade(level: Freshness): boolean {
  return level === 'stale' || level === 'offline';
}
