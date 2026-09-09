/**
 * Dev harness. Mounts the real panel against a mock bridge so every row state
 * and every tray anchor can be reviewed without running Electron.
 *
 * This file is never bundled into the app: index.html loads src/main.ts only,
 * and build.mjs --prod does not emit it. The harness uses the same mountApp()
 * as production, so what you see here is the shipping renderer.
 *
 * The mock bridge implements UsageNotchApi exactly as the contract declares
 * it, so a shape drift in the real preload shows up here first.
 */

import type { AnchorPayload, Preferences, Snapshot, ThemeChoice } from '../../shared/contract.js';
import { mountApp, type AppHandle } from '../src/app.js';
import type { Bridge, SetupResult } from '../src/bridge.js';
import { el, on, setAttr } from '../src/dom.js';
import { SCENARIOS, anchorFor, drift, type Scenario } from './mock.js';

const stage = document.getElementById('stage');
const controls = document.getElementById('controls');
if (!stage || !controls) throw new Error('harness: markup is missing');

let app: AppHandle | null = null;
let pushSnapshot: ((snapshot: Snapshot) => void) | null = null;
let pushAnchor: ((anchor: AnchorPayload) => void) | null = null;
let driftTimer: number | null = null;
let driftStep = 0;
let liveDrift = false;
let current: Scenario = SCENARIOS[0] as Scenario;
let edge: AnchorPayload['edge'] = 'bottom';
let mode: AnchorPayload['mode'] = 'hover';
let scaleFactor = 1.25;
let trayOffset = 0;
let anchorSource: AnchorPayload['anchorSource'] = 'tray';
/** Makes the mock setOrder() fail, so the visible revert can be reviewed. */
let failOrder = false;
/** Same, for setEnabled(): `{ok:false}` must put the switch back. */
let failEnabled = false;
/** Same, for setTheme(): `{ok:false}` must put the previous palette back. */
let failTheme = false;
/**
 * The harness's stand-in for main's persisted preferences. It survives a
 * remount, so switching scenario does not silently reset the theme — which is
 * exactly what main's on-disk settings do.
 */
let prefs: Preferences = { theme: 'system' };
let prefsCb: ((p: Preferences) => void) | null = null;

const logBox = el('div', { class: 'hx-log', role: 'log', 'aria-label': 'Köprü çağrıları' });

function log(message: string): void {
  const line = el(
    'div',
    { class: 'hx-log__line' },
    `${new Date().toLocaleTimeString('tr-TR')}  ${message}`,
  );
  logBox.insertBefore(line, logBox.firstChild);
  while (logBox.childElementCount > 9) logBox.removeChild(logBox.lastElementChild as Node);
}

function currentAnchor(): AnchorPayload {
  return anchorFor(edge, mode, scaleFactor, trayOffset, anchorSource);
}

function makeBridge(scenario: Scenario): Bridge {
  let base = scenario.snapshot();
  return {
    available: scenario.bridgeAvailable,

    initialSnapshot: () => base,

    onSnapshot(listener) {
      pushSnapshot = (snapshot) => {
        base = snapshot;
        listener(snapshot);
      };
      return () => {
        pushSnapshot = null;
      };
    },

    onAnchor(listener) {
      pushAnchor = listener;
      // Main pushes fresh geometry on every open, so do the same here.
      window.setTimeout(() => listener(currentAnchor()), 0);
      return () => {
        pushAnchor = null;
      };
    },

    panelOpened() {
      log('panelOpened()');
    },

    async requestRefresh(): Promise<Snapshot | null> {
      log('requestRefresh() -> bekleniyor');
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (!scenario.bridgeAvailable) {
        log('requestRefresh() -> servis yok');
        return null;
      }
      const next = base ? drift(base, 0.15) : (SCENARIOS[0] as Scenario).snapshot();
      if (next) base = next;
      log('requestRefresh() -> yeni anlık görüntü');
      return next;
    },

    async runSetup(providerId: string, confirmed: boolean): Promise<SetupResult> {
      log(`runSetup("${providerId}", confirmed=${confirmed})`);
      if (!confirmed) {
        return { ok: false, message: 'Onay verilmedi; hiçbir dosya değiştirilmedi.' };
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
      log(`runSetup("${providerId}") -> ok`);
      return { ok: true, message: 'Köprü kuruldu. İlk ölçüm birkaç saniye içinde gelecek.' };
    },

    /**
     * Mirrors what main promises: persist the order, then re-emit an ordered
     * snapshot. `failOrder` lets the harness exercise the revert path, which
     * is the branch that is otherwise never seen until it happens in the wild.
     */
    async setOrder(ids: readonly string[]): Promise<boolean> {
      log(`setOrder([${ids.join(', ')}])`);
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (failOrder) {
        log('setOrder() -> hata');
        return false;
      }
      if (base) {
        const byId = new Map(base.providers.map((p) => [p.id as string, p]));
        const ordered = ids
          .map((id) => byId.get(id))
          .filter((p): p is NonNullable<typeof p> => p !== undefined);
        if (ordered.length === base.providers.length) {
          base = { generatedAt: new Date().toISOString(), providers: ordered };
          pushSnapshot?.(base);
        }
      }
      log('setOrder() -> ok');
      return true;
    },

    /**
     * Mirrors main: persist, then re-emit a snapshot carrying the new flag.
     * `failEnabled` exercises the branch where main wrote nothing.
     */
    async setEnabled(id: string, enabled: boolean): Promise<boolean> {
      log(`setEnabled("${id}", ${enabled})`);
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (failEnabled) {
        log('setEnabled() -> hata');
        return false;
      }
      if (base) {
        base = {
          generatedAt: new Date().toISOString(),
          providers: base.providers.map((p) => (p.id === id ? { ...p, enabled } : p)),
        };
        pushSnapshot?.(base);
      }
      log('setEnabled() -> ok');
      return true;
    },

    initialPreferences: () => prefs,

    onPreferences(listener) {
      prefsCb = listener;
      return () => {
        prefsCb = null;
      };
    },

    /**
     * Mirrors main: persist, then push the new preferences back. `failTheme`
     * exercises the branch where main wrote nothing and the renderer has to
     * put the previous palette back on screen.
     */
    async setTheme(next: ThemeChoice): Promise<boolean> {
      log(`setTheme("${next}")`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (failTheme) {
        log('setTheme() -> hata');
        return false;
      }
      prefs = { theme: next };
      prefsCb?.(prefs);
      log('setTheme() -> ok');
      return true;
    },

    close() {
      log('close()');
      // Re-open so the harness stays usable after testing Esc.
      window.setTimeout(() => remount(current), 400);
    },

    pin() {
      // Main owns the mode and answers with a new anchor. Mirror that here.
      mode = mode === 'pin' ? 'hover' : 'pin';
      log(`pin() -> mod: ${mode}`);
      setAttr(modeToggle, 'aria-pressed', mode === 'pin' ? 'true' : 'false');
      pushAnchor?.(currentAnchor());
    },
  };
}

function remount(scenario: Scenario): void {
  current = scenario;
  if (app) app.destroy();
  pushSnapshot = null;
  pushAnchor = null;
  driftStep = 0;
  while (stage!.firstChild) stage!.removeChild(stage!.firstChild);
  app = mountApp(stage as HTMLElement, makeBridge(scenario));
  for (const button of scenarioButtons) {
    setAttr(button, 'aria-pressed', button.dataset.scenario === scenario.id ? 'true' : 'false');
  }
  log(`senaryo: ${scenario.label}`);
}

function setDrift(enabled: boolean): void {
  liveDrift = enabled;
  if (driftTimer !== null) {
    window.clearInterval(driftTimer);
    driftTimer = null;
  }
  if (!enabled) return;
  driftTimer = window.setInterval(() => {
    const snapshot = current.snapshot();
    if (!snapshot || !pushSnapshot) return;
    driftStep += 1;
    pushSnapshot(drift(snapshot, Math.sin(driftStep / 3) * 0.6));
  }, 2500);
}

// ------------------------------------------------------------------ chrome

const scenarioButtons: HTMLButtonElement[] = SCENARIOS.map((scenario) => {
  const button = el(
    'button',
    {
      type: 'button',
      class: 'hx-btn',
      'aria-pressed': 'false',
      'data-scenario': scenario.id,
    },
    scenario.label,
  ) as HTMLButtonElement;
  on(button, 'click', () => remount(scenario));
  return button;
});

const EDGES: Array<AnchorPayload['edge']> = ['bottom', 'top', 'left', 'right'];
const edgeButtons: HTMLButtonElement[] = EDGES.map((value) => {
  const button = el(
    'button',
    { type: 'button', class: 'hx-btn', 'aria-pressed': value === 'bottom' ? 'true' : 'false' },
    value,
  ) as HTMLButtonElement;
  on(button, 'click', () => {
    edge = value;
    for (const other of edgeButtons) {
      setAttr(other, 'aria-pressed', other.textContent === value ? 'true' : 'false');
    }
    log(`anchor edge: ${value}`);
    pushAnchor?.(currentAnchor());
  });
  return button;
});

const modeToggle = el(
  'button',
  { type: 'button', class: 'hx-btn', 'aria-pressed': 'false' },
  'Sabit mod',
) as HTMLButtonElement;
on(modeToggle, 'click', () => {
  mode = mode === 'pin' ? 'hover' : 'pin';
  setAttr(modeToggle, 'aria-pressed', mode === 'pin' ? 'true' : 'false');
  log(`mod: ${mode}`);
  pushAnchor?.(currentAnchor());
});

const sourceToggle = el(
  'button',
  { type: 'button', class: 'hx-btn', 'aria-pressed': 'false' },
  'İmleç konumu',
) as HTMLButtonElement;
on(sourceToggle, 'click', () => {
  anchorSource = anchorSource === 'tray' ? 'cursor' : 'tray';
  setAttr(sourceToggle, 'aria-pressed', anchorSource === 'cursor' ? 'true' : 'false');
  log(`anchorSource: ${anchorSource}`);
  pushAnchor?.(currentAnchor());
});

const scaleToggle = el(
  'button',
  { type: 'button', class: 'hx-btn' },
  'Ölçek 1,25',
) as HTMLButtonElement;
on(scaleToggle, 'click', () => {
  scaleFactor = scaleFactor === 1.25 ? 1 : scaleFactor === 1 ? 1.5 : 1.25;
  scaleToggle.textContent = `Ölçek ${scaleFactor.toLocaleString('tr-TR')}`;
  log(`scaleFactor: ${scaleFactor}`);
  pushAnchor?.(currentAnchor());
});

// Drag the notional tray icon so the tail clamp can be exercised.
const trayRange = el('input', {
  type: 'range',
  class: 'hx-range',
  min: '-700',
  max: '190',
  value: '0',
  'aria-label': 'Tepsi simgesi yatay konumu',
}) as HTMLInputElement;
trayRange.addEventListener('input', () => {
  trayOffset = Number(trayRange.value);
  pushAnchor?.(currentAnchor());
});

const driftToggle = el(
  'button',
  { type: 'button', class: 'hx-btn', 'aria-pressed': 'false' },
  'Canlı akış',
) as HTMLButtonElement;
on(driftToggle, 'click', () => {
  const next = !liveDrift;
  setDrift(next);
  setAttr(driftToggle, 'aria-pressed', next ? 'true' : 'false');
});

const orderFailToggle = el(
  'button',
  { type: 'button', class: 'hx-btn', 'aria-pressed': 'false' },
  'Sıralama hatası',
) as HTMLButtonElement;
on(orderFailToggle, 'click', () => {
  failOrder = !failOrder;
  setAttr(orderFailToggle, 'aria-pressed', failOrder ? 'true' : 'false');
  log(`setOrder hatası: ${failOrder}`);
});

const motionToggle = el(
  'button',
  { type: 'button', class: 'hx-btn', 'aria-pressed': 'false' },
  'Hareketi azalt',
) as HTMLButtonElement;
on(motionToggle, 'click', () => {
  const next = document.documentElement.getAttribute('data-reduce-motion') !== 'true';
  setAttr(document.documentElement, 'data-reduce-motion', next ? 'true' : null);
  setAttr(motionToggle, 'aria-pressed', next ? 'true' : 'false');
});

function group(label: string, ...children: HTMLElement[]): HTMLElement {
  return el(
    'div',
    { class: 'hx-section' },
    el('div', { class: 'hx-section__label' }, label),
    el('div', { class: 'hx-group' }, ...children),
  );
}

controls.appendChild(group('Senaryo', ...scenarioButtons));
controls.appendChild(group('Tepsi kenarı', ...edgeButtons));
controls.appendChild(group('Pencere', modeToggle, scaleToggle, sourceToggle));
controls.appendChild(group('Tepsi konumu', trayRange));
const enabledFailToggle = el(
  'button',
  { type: 'button', class: 'hx-btn', 'aria-pressed': 'false' },
  'Ayar hatası',
) as HTMLButtonElement;
on(enabledFailToggle, 'click', () => {
  failEnabled = !failEnabled;
  setAttr(enabledFailToggle, 'aria-pressed', failEnabled ? 'true' : 'false');
  log(`setEnabled hatası: ${failEnabled}`);
});

const themeFailToggle = el(
  'button',
  { type: 'button', class: 'hx-btn', 'aria-pressed': 'false' },
  'Tema hatası',
) as HTMLButtonElement;
on(themeFailToggle, 'click', () => {
  failTheme = !failTheme;
  setAttr(themeFailToggle, 'aria-pressed', failTheme ? 'true' : 'false');
  log(`setTheme hatası: ${failTheme}`);
});

controls.appendChild(
  group('Önizleme', driftToggle, motionToggle, orderFailToggle, enabledFailToggle, themeFailToggle),
);
controls.appendChild(logBox);

remount(SCENARIOS[0] as Scenario);
