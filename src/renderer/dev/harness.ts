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

import type {
  AnchorPayload,
  LanguageChoice,
  Preferences,
  Snapshot,
  ThemeChoice,
} from '../../shared/contract.js';
import { mountApp, type AppHandle } from '../src/app.js';
import type { Bridge, SetupResult } from '../src/bridge.js';
import { el, on, setAttr } from '../src/dom.js';
import { defaultFormatLocale, fallbackLanguage } from '../src/sanitize.js';
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
/** Same, for setAutostart(): `{ok:false}` must put the switch back. */
let failAutostart = false;
/** Same, for setPlanLabel(): `{ok:false}` must put the previous label back. */
let failPlanLabel = false;
/**
 * The harness's stand-in for main's persisted preferences. It survives a
 * remount, so switching scenario does not silently reset the theme — which is
 * exactly what main's on-disk settings do.
 */
let prefs: Preferences = {
  theme: 'system',
  language: 'system',
  resolvedLanguage: 'tr',
  formatLocale: 'tr-TR',
  autostart: true,
  autostartByWindows: false,
  // A fresh install, so the first-run card can be reviewed.
  setupCoachDismissed: false,
  trayView: 'tray',
  stripAvailable: true,
  stripNoRoom: false,
  transparency: 45,
  systemReducedTransparency: false,
  // A browser page has no acrylic and no fitted window: the canvas look.
  material: 'none',
  frame: 'canvas',
  stripStyle: 'plain',
};
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

    onPanelVisibility() {
      // There is no main process here, so nothing reveals or conceals the
      // panel: the app-start entrance opens it and it stays open for the
      // harness. Present only to satisfy the Bridge contract.
      return () => {};
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

    async disconnectProvider(providerId: string, confirmed: boolean): Promise<SetupResult> {
      log(`disconnectProvider("${providerId}", confirmed=${confirmed})`);
      return { ok: true, message: 'Claude Code bağlantısı kaldırıldı.' };
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
          base = { generatedAt: new Date().toISOString(), providers: ordered, pendingUsage: base.pendingUsage };
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
          pendingUsage: base.pendingUsage,
        };
        pushSnapshot?.(base);
      }
      log('setEnabled() -> ok');
      return true;
    },

    /**
     * The plan the user says they are on. Mirrors main: whitespace collapsed,
     * invisibles stripped, capped at 24 — so the harness shows the same
     * normalisation the real channel performs, and the control can be seen
     * correcting itself to what was actually stored.
     */
    async setPlanLabel(id: string, label: string): Promise<boolean> {
      log(`setPlanLabel("${id}", ${JSON.stringify(label)})`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (failPlanLabel) {
        log('setPlanLabel() -> hata');
        return false;
      }
      const stored = String(label ?? '')
        .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 24);
      if (base) {
        base = {
          generatedAt: new Date().toISOString(),
          providers: base.providers.map((p) => (p.id === id ? { ...p, planLabel: stored || null } : p)),
          pendingUsage: base.pendingUsage,
        };
        pushSnapshot?.(base);
      }
      log(`setPlanLabel() -> ok ${JSON.stringify(stored)}`);
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
      prefs = { ...prefs, theme: next };
      prefsCb?.(prefs);
      log('setTheme() -> ok');
      return true;
    },

    /** Mirrors setTheme: persist, then push; `failAutostart` refuses. */
    async setSetupCoachDismissed(dismissed: boolean): Promise<boolean> {
      log(`setSetupCoachDismissed(${dismissed})`);
      prefs = { ...prefs, setupCoachDismissed: dismissed };
      prefsCb?.(prefs);
      return true;
    },

    /** Persist, then push. A browser has no taskbar: the strip is "unavailable". */
    async setTrayView(view: 'tray' | 'strip'): Promise<boolean> {
      log(`setTrayView(${view})`);
      prefs = { ...prefs, trayView: view, stripAvailable: view !== 'strip' };
      prefsCb?.(prefs);
      return true;
    },

    /**
     * Persist, then push, like setTrayView. A page has no window glass; with
     * &material=acrylic it says the glass is there above 0, as main would.
     */
    async setTransparency(level: number): Promise<boolean> {
      log(`setTransparency(${level})`);
      prefs = { ...prefs, transparency: level, material: glassParam && level > 0 ? 'acrylic' : 'none' };
      prefsCb?.(prefs);
      return true;
    },

    /** Persist, then push. There is no strip here to redraw. */
    async setStripStyle(stripStyle: 'plain' | 'rings' | 'fill'): Promise<boolean> {
      log(`setStripStyle(${stripStyle})`);
      prefs = { ...prefs, stripStyle };
      prefsCb?.(prefs);
      return true;
    },

    async setAutostart(enabled: boolean): Promise<boolean> {
      log(`setAutostart(${enabled})`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (failAutostart) {
        log('setAutostart() -> hata');
        return false;
      }
      prefs = { ...prefs, autostart: enabled };
      prefsCb?.(prefs);
      log('setAutostart() -> ok');
      return true;
    },

    /**
     * Stands in for main: persist, RESOLVE, push. 'system' resolves with
     * ADR-004's rule on the browser language, and en uses en-US, so the
     * harness exercises the same push-driven rebuild the app does.
     */
    async setLanguage(next: LanguageChoice): Promise<boolean> {
      log(`setLanguage("${next}")`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const resolvedLanguage = next === 'system' ? fallbackLanguage(navigator.language) : next;
      prefs = {
        ...prefs,
        language: next,
        resolvedLanguage,
        formatLocale: defaultFormatLocale(resolvedLanguage),
      };
      prefsCb?.(prefs);
      log('setLanguage() -> ok');
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

    setPointerOverPanel(over: boolean) {
      // A browser page has no click-through window; only note it.
      document.body.setAttribute('data-pointer-over-panel', over ? 'true' : 'false');
    },
    setPanelHeight(height: number) {
      // No window to size; only note it.
      document.body.setAttribute('data-panel-height', String(Math.round(height)));
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

const autostartFailToggle = el(
  'button',
  { type: 'button', class: 'hx-btn', 'aria-pressed': 'false' },
  'Başlangıç hatası',
) as HTMLButtonElement;
on(autostartFailToggle, 'click', () => {
  failAutostart = !failAutostart;
  setAttr(autostartFailToggle, 'aria-pressed', failAutostart ? 'true' : 'false');
  log(`setAutostart hatası: ${failAutostart}`);
});

controls.appendChild(
  group(
    'Önizleme',
    driftToggle,
    motionToggle,
    orderFailToggle,
    enabledFailToggle,
    themeFailToggle,
    autostartFailToggle,
  ),
);
controls.appendChild(logBox);

/**
 * URL parameters, for screenshots of a given state without clicking through:
 *   ?s=<scenario id>  &theme=light|dark  &lang=en  &coach=done
 *   &view=settings  &tab=providers|usage|general  &expand=<provider id>
 *   &tp=0..100 (Görünüm → "Saydamlık"; 0 is the opaque panel)
 *   &rtsys=1 (Windows asks for less transparency: opaque, the slider disabled)
 *   &frame=fitted  &material=acrylic (the Windows 11 window and its glass)
 *   &strip=plain|rings|fill (the strip chosen, in that style, as if this
 *           machine could show it, so Görünüm → "Şerit stili" is on screen)
 *   &shot=1 (the panel alone, no controls)
 *   &bare=1 (with shot: a transparent page, so the site's desktop scene shows
 *           around the panel, as the real transparent window does)
 */
const params = new URLSearchParams(window.location.search);
const themeParam = params.get('theme');
if (themeParam === 'light' || themeParam === 'dark') prefs = { ...prefs, theme: themeParam };
const langParam = params.get('lang');
if (langParam === 'en' || langParam === 'zh') {
  prefs = { ...prefs, language: langParam, resolvedLanguage: langParam, formatLocale: defaultFormatLocale(langParam) };
}
if (params.get('coach') === 'done') prefs = { ...prefs, setupCoachDismissed: true };
// ?tp=<0..100> / ?rtsys=1: the slider at a level, or Windows asking for less.
const tpParam = params.get('tp');
if (tpParam !== null && /^\d{1,3}$/.test(tpParam)) prefs = { ...prefs, transparency: Math.min(100, Number(tpParam)) };
if (params.get('rtsys') === '1') prefs = { ...prefs, systemReducedTransparency: true };
// ?frame=fitted / ?material=acrylic: the Windows 11 window, panel edge to edge
// (with bare=1 the page behind stands in for the desktop under the glass).
if (params.get('frame') === 'fitted') prefs = { ...prefs, frame: 'fitted' };
const glassParam = params.get('material') === 'acrylic';
if (glassParam && prefs.transparency > 0) prefs = { ...prefs, material: 'acrylic' };
const stripParam = params.get('strip');
if (stripParam === 'plain' || stripParam === 'rings' || stripParam === 'fill') {
  prefs = { ...prefs, trayView: 'strip', stripAvailable: true, stripStyle: stripParam };
}
if (params.get('shot') === '1') document.body.classList.add('hx--shot');
if (params.get('bare') === '1') document.body.classList.add('hx--bare');
if (params.get('bare') === '1' && window.parent !== window) {
  // Framed in the site: a wheel turn the panel cannot use itself (no
  // scrollable box under the pointer with room in that direction) scrolls the
  // page around the frame, or the visitor's wheel stops dead on the demo.
  const canScroll = (start: EventTarget | null, dy: number): boolean => {
    for (let el = start instanceof Element ? start : null; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy !== 'auto' && oy !== 'scroll') || el.scrollHeight <= el.clientHeight) continue;
      if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
    }
    return false;
  };
  window.addEventListener('wheel', (event) => {
    if (event.ctrlKey || canScroll(event.target, event.deltaY)) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    // 'instant': the site sets smooth scrolling, and a smooth scroll restarted
    // on every wheel tick crawls and stutters instead of following the wheel.
    try {
      window.parent.scrollBy({ top: event.deltaY * unit, left: event.deltaX * unit, behavior: 'instant' });
    } catch { /* not same-origin */ }
  }, { passive: true });
}
remount(SCENARIOS.find((s) => s.id === params.get('s')) ?? (SCENARIOS[0] as Scenario));
window.setTimeout(() => {
  const click = (selector: string): void => {
    (document.querySelector(selector) as HTMLElement | null)?.click();
  };
  if (params.get('view') === 'settings') click('.iconbtn--settings');
  const tab = params.get('tab');
  if (tab) click(`.tabs__tab[data-tab="${tab}"]`);
  const expand = params.get('expand');
  if (expand) click(`.row[data-provider="${expand}"] .row__more`);
}, 300);
