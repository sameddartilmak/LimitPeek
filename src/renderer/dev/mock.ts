/**
 * Fixtures for the dev harness. NOT shipped and NOT imported by the app.
 *
 * These are design fixtures for reviewing every row state without running
 * Electron. They are not a claim about which providers are wired: per ADR-001
 * only Claude is, and only Claude's percentages are server-computed truth.
 */

import type {
  AnchorPayload,
  ModelCost,
  ProviderSnapshot,
  SetupKind,
  Snapshot,
  WeeklyCost,
  WindowUsage,
} from '../../shared/contract.js';

const HOUR = 3_600_000;

export function iso(offsetMs: number, from = Date.now()): string {
  return new Date(from + offsetMs).toISOString();
}

function known(usedPercentage: number, resetsAt: string | null): WindowUsage {
  return { usedPercentage, certainty: 'known', resetsAt };
}

function unknown(resetsAt: string | null = null): WindowUsage {
  return { usedPercentage: null, certainty: 'unknown', resetsAt };
}

function estimated(mid: number, lo: number, hi: number, resetsAt: string | null): WindowUsage {
  return {
    usedPercentage: mid,
    certainty: 'estimated',
    resetsAt,
    confidenceLo: lo,
    confidenceHi: hi,
  };
}

function breakdown(billable: number) {
  // Deliberately skewed the way the real corpus is: cache_read dwarfs the rest
  // and is excluded from `billable`.
  return {
    input: Math.round(billable * 0.004),
    output: Math.round(billable * 0.09),
    cacheWrite: Math.round(billable * 0.906),
    cacheRead: Math.round(billable * 47),
    billable,
  };
}

// ------------------------------------------------------------ weekly cost
/**
 * The numbers are the real ones measured on this machine (ADR-002 + a live
 * scan): cache reads are 65% of the figure while being the cheapest class per
 * token, because there are 294 million of them.
 *
 * The two caveat paths are BOTH zero on this machine, so they are fixtures or
 * they are never seen until they matter. `unpricedCost()` reproduces exactly
 * the case ADR-002 amendment 2 describes — opus-4-8 priced at standard speed
 * and unpriced at fast — which is the one that would make a warning keyed on
 * `unpricedModels` (model only, no speed) contradict the table beside it.
 */
function modelCost(
  model: string,
  speed: string,
  pricedAs: string | null,
  usd: number | null,
  billable: number,
): ModelCost {
  return { model, speed, pricedAs, usd, tokens: breakdown(billable) };
}

function weeklyCost(patch: Partial<WeeklyCost> = {}): WeeklyCost {
  const anchored = patch.windowAnchored !== false;
  return {
    totalUsd: 226.8116,
    byClass: {
      input: 0.0172,
      output: 32.8177,
      cacheWrite5m: 20.2495,
      cacheWrite1h: 26.6909,
      cacheRead: 147.0362,
    },
    byModel: [
      modelCost('claude-opus-5', 'standard', 'claude-opus-5|standard', 226.7641, 7_220_675),
      modelCost(
        'claude-haiku-4-5-20251001',
        'standard',
        'claude-haiku-4-5|standard',
        0.0475,
        22_471,
      ),
    ],
    unpricedModels: [],
    fallbackWriteEvents: 0,
    // Live on this machine: 0 of 1.781 write events took the 1.25x fallback.
    cacheWriteEvents: 1_781,
    // Claude never has unrecorded writes (ADR-002 A3 rule 3 is Codex's).
    unrecordedWriteEvents: 0,
    // Every log was read (ADR-002 A3.15). Never inferred from a stale row.
    sourceIncomplete: false,
    // Claude has no Codex service tier (ADR-002 A3.17-18).
    assumedTierEvents: 0,
    fastRequestedEvents: 0,
    // The local tools' floor causes (Qwen Code, Antigravity, Grok Build); none for Claude.
    unrecordedCalls: false,
    longPromptFloorEvents: 0,
    toolTokenEvents: 0,
    partialUsageEvents: 0,
    pricesAsOf: '2026-06-24',
    windowStart: iso(-5 * 24 * HOUR),
    // Anchored means the window ends at the weekly reset, which is in the
    // FUTURE. That is what makes "son 7 gün" the wrong label.
    windowEnd: anchored ? iso(2 * 24 * HOUR) : iso(0),
    windowAnchored: anchored,
    ...patch,
  };
}

/** ADR-002 amendment 2: unpriced at one speed, priced at another. */
function unpricedCost(): WeeklyCost {
  return weeklyCost({
    byModel: [
      modelCost('claude-opus-5', 'standard', 'claude-opus-5|standard', 226.7641, 7_220_675),
      modelCost('claude-opus-4-8', 'standard', 'claude-opus-4-8|standard', 12.4, 480_000),
      // No published fast price for 4.8, so it is excluded, not guessed.
      modelCost('claude-opus-4-8', 'fast', null, null, 1_180_000),
      modelCost('claude-mystery-9', 'standard', null, null, 96_000),
    ],
    unpricedModels: ['claude-mystery-9', 'claude-opus-4-8'],
  });
}

/** The TTL breakdown went missing, so every write was priced at the 1.25x
 *  floor and the total understates 1-hour writes. */
function floorCost(): WeeklyCost {
  return weeklyCost({ fallbackWriteEvents: 1_412 });
}

const FIVE_H_RESET = () => iso(2 * HOUR + 14 * 60_000);
const SEVEN_D_RESET = () => iso(3 * 24 * HOUR + 5 * HOUR);

// --------------------------------------------------------------- providers

function claudeOk(pct5 = 62, pct7 = 41): ProviderSnapshot {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    accent: '#D97757',
    experimental: false,
    enabled: true,
    connected: true,
    status: 'ok',
    planLabel: 'Max 20x',
    fiveHour: known(pct5, FIVE_H_RESET()),
    sevenDay: known(pct7, SEVEN_D_RESET()),
    tokens: breakdown(1_240_000),
    weeklyTokens: breakdown(6_180_000),
    weeklyTokensWindowAnchored: true,
    weeklyTokenFloorCauses: [],
    burnRatePerHour: 84_000,
    byModel: [
      { model: 'claude-opus-5', billable: 910_000 },
      { model: 'claude-sonnet-4-5', billable: 330_000 },
    ],
    weeklyCost: weeklyCost(),
    setupAction: null,
  };
}

/** The first-run shape: connected, but no defensible denominator yet. */
function claudeUnknown(): ProviderSnapshot {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    accent: '#D97757',
    experimental: false,
    enabled: true,
    connected: true,
    status: 'ok',
    planLabel: null,
    fiveHour: unknown(),
    sevenDay: unknown(),
    tokens: breakdown(1_240_000),
    weeklyTokens: breakdown(6_180_000),
    weeklyTokensWindowAnchored: true,
    weeklyTokenFloorCauses: [],
    burnRatePerHour: 84_000,
    byModel: [{ model: 'claude-opus-5', billable: 1_240_000 }],
    weeklyCost: null,
    setupAction: {
      kind: 'install-bridge',
      label: 'Bağla',
      detail: 'Claude Code durum satırına küçük bir köprü eklenir; onayınız istenir.',
      consent: [
        'Şu dosya güncellenecek: C:\\Users\\ornek\\.claude\\settings.json',
        'Önce zaman damgalı bir yedek alınır. Köprü yalnızca kullanım yüzdesini ve sıfırlanma zamanını okur; hiçbir metin, dosya yolu veya kimlik bilgisi kaydetmez ve hiçbir ağ bağlantısı açmaz.',
        "Kendi durum satırınız varsa korunur: Claude Code'da aynen görünmeye devam eder. Köprü yalnızca arka planda limitleri kaydeder.",
      ],
    },
  };
}

function codexUnknown(): ProviderSnapshot {
  return {
    id: 'codex',
    displayName: 'Codex CLI',
    accent: '#7FB3D5',
    experimental: false,
    enabled: true,
    connected: true,
    status: 'ok',
    planLabel: null,
    fiveHour: unknown(),
    sevenDay: null,
    tokens: breakdown(96_400),
    weeklyTokens: breakdown(430_000),
    weeklyTokensWindowAnchored: false,
    // Codex records 0 cache writes on turns that read cache, so its COUNT is a
    // lower bound on essentially every row — and A3.16 means the reason has to
    // be on screen with it, never a bare "en az".
    weeklyTokenFloorCauses: ['unrecorded-writes'],
    burnRatePerHour: 12_300,
    byModel: [],
    weeklyCost: null,
    setupAction: null,
  };
}

function qwenLoading(): ProviderSnapshot {
  return {
    id: 'qwen',
    displayName: 'Qwen Code',
    accent: '#6D5DFC',
    experimental: true,
    enabled: true,
    connected: true,
    status: 'loading',
    planLabel: null,
    fiveHour: null,
    sevenDay: null,
    tokens: null,
    weeklyTokens: null,
    weeklyTokensWindowAnchored: null,
    weeklyTokenFloorCauses: [],
    burnRatePerHour: null,
    weeklyCost: null,
    setupAction: null,
  };
}

function antigravityError(): ProviderSnapshot {
  return {
    id: 'antigravity',
    displayName: 'Antigravity',
    accent: '#B892E8',
    experimental: false,
    enabled: true,
    connected: true,
    status: 'error',
    planLabel: null,
    fiveHour: known(100, FIVE_H_RESET()),
    sevenDay: known(96, SEVEN_D_RESET()),
    tokens: breakdown(2_100_000),
    weeklyTokens: breakdown(9_400_000),
    weeklyTokensWindowAnchored: true,
    weeklyTokenFloorCauses: [],
    burnRatePerHour: 148_000,
    errorCode: 'parse-failed',
    weeklyCost: null,
    setupAction: null,
  };
}

/**
 * ADR-001 amendment 2. The statusline only emits while a Claude Code session
 * is open, and the tray is looked at precisely when it is not. So a capture
 * from 39 minutes ago still describes a window that has not reset, and it is
 * shown — labelled with its capture time, plus the locally measured tokens
 * spent since. The percentage is NOT recomputed from that delta.
 */
function claudeStaleCapture(pct5 = 6, pct7 = 10): ProviderSnapshot {
  const capturedAt = iso(-39 * 60_000);
  return {
    id: 'claude',
    displayName: 'Claude Code',
    accent: '#D97757',
    experimental: false,
    enabled: true,
    connected: true,
    status: 'stale',
    planLabel: 'Max 20x',
    fiveHour: {
      usedPercentage: pct5,
      certainty: 'known',
      resetsAt: FIVE_H_RESET(),
      capturedAt,
      billableSinceCapture: 142_000,
    },
    sevenDay: {
      usedPercentage: pct7,
      certainty: 'known',
      resetsAt: SEVEN_D_RESET(),
      capturedAt,
      billableSinceCapture: 142_000,
    },
    tokens: breakdown(1_240_000),
    weeklyTokens: breakdown(6_180_000),
    weeklyTokensWindowAnchored: true,
    weeklyTokenFloorCauses: [],
    burnRatePerHour: 84_000,
    byModel: [{ model: 'claude-opus-5', billable: 1_240_000 }],
    weeklyCost: null,
    setupAction: null,
    lastGoodAt: capturedAt,
  };
}

/** The same row a second after its window rolled over: the renderer must drop
 *  the meter locally rather than wait up to 15s for main to say so. */
function claudeCaptureExpired2(): ProviderSnapshot {
  const base = claudeStaleCapture();
  const justPassed = iso(-2_000);
  return {
    ...base,
    id: 'codex',
    displayName: 'Codex CLI',
    accent: '#7FB3D5',
    experimental: false,
    fiveHour: { ...(base.fiveHour as NonNullable<typeof base.fiveHour>), resetsAt: justPassed },
    sevenDay: { ...(base.sevenDay as NonNullable<typeof base.sevenDay>), resetsAt: justPassed },
  };
}

function kimiPassive(): ProviderSnapshot {
  return {
    id: 'kimi',
    displayName: 'Kimi',
    accent: '#5FD3A6',
    experimental: true,
    enabled: true,
    connected: false,
    status: 'passive',
    planLabel: null,
    fiveHour: null,
    sevenDay: null,
    tokens: null,
    weeklyTokens: null,
    weeklyTokensWindowAnchored: null,
    weeklyTokenFloorCauses: [],
    burnRatePerHour: null,
    weeklyCost: null,
    setupAction: {
      kind: 'not-installed',
      label: 'Ekle',
      detail: 'Bu makinede bulunamadı.',
    },
  };
}

function passive(
  id: ProviderSnapshot['id'],
  displayName: string,
  accent: string,
  detail: string,
  kind: SetupKind = 'not-installed',
): ProviderSnapshot {
  return {
    id,
    displayName,
    accent,
    experimental: id === 'kimi' || id === 'qwen' || id === 'grok',
    // The shipped default: Claude is added, the other four are offered in
    // settings and are NOT rows in the main panel until the user adds them.
    enabled: false,
    connected: false,
    status: 'passive',
    planLabel: null,
    fiveHour: null,
    sevenDay: null,
    tokens: null,
    weeklyTokens: null,
    weeklyTokensWindowAnchored: null,
    weeklyTokenFloorCauses: [],
    burnRatePerHour: null,
    weeklyCost: null,
    setupAction: { kind, label: 'Ekle', detail },
  };
}

// --------------------------------------------------------------- scenarios

export type ScenarioId =
  | 'vitrin'
  | 'tam'
  | 'maliyet'
  | 'bayat-olcum'
  | 'ilk-calistirma'
  | 'yukleniyor'
  | 'tahmini'
  | 'bos'
  | 'hicbiri-ekli'
  | 'kopuk';

export interface Scenario {
  id: ScenarioId;
  label: string;
  /** null means: no snapshot has ever arrived (skeleton placeholders). */
  snapshot(): Snapshot | null;
  bridgeAvailable: boolean;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    // The website's live demo (scripts/build-site-demo.js): a healthy, typical
    // day across three tools, each in a different state of its limits.
    id: 'vitrin',
    label: 'Site demosu',
    bridgeAvailable: true,
    snapshot: () => ({
      generatedAt: iso(-15_000),
      pendingUsage: [],
      providers: [
        claudeOk(62, 41),
        {
          ...claudeOk(18, 57),
          id: 'codex',
          displayName: 'Codex CLI',
          accent: '#7FB3D5',
          planLabel: 'Plus',
          tokens: breakdown(640_000),
          weeklyTokens: breakdown(3_900_000),
          burnRatePerHour: 41_000,
          byModel: [{ model: 'gpt-5.5-codex', billable: 640_000 }],
          weeklyCost: null,
        },
        {
          ...claudeOk(84, 23),
          id: 'antigravity',
          displayName: 'Antigravity',
          accent: '#B892E8',
          planLabel: null,
          byModel: [{ model: 'gemini-3-pro', billable: 1_100_000 }],
          weeklyCost: null,
        },
      ],
    }),
  },
  {
    id: 'tam',
    label: 'Tüm durumlar',
    bridgeAvailable: true,
    // Well inside CADENCE.STALE_AFTER_MS, so the healthy rows stay healthy.
    snapshot: () => ({
      generatedAt: iso(-45_000),
      pendingUsage: [],
      providers: [
        claudeOk(),
        codexUnknown(),
        qwenLoading(),
        antigravityError(),
        kimiPassive(),
      ],
    }),
  },
  {
    // Every path in the cost block at once: an unpriced (model, speed) pair
    // beside a priced row for the SAME model, the 1.25x write fallback, and a
    // trailing (not anchored) window. All three are zero or absent on this
    // machine, so this scenario is the only place they are ever looked at.
    id: 'maliyet',
    label: 'Maliyet uyarıları',
    bridgeAvailable: true,
    snapshot: () => ({
      generatedAt: iso(-20_000),
      pendingUsage: [],
      providers: [
        {
          ...claudeOk(),
          weeklyCost: {
            ...unpricedCost(),
            fallbackWriteEvents: 1_412,
            windowAnchored: false,
            windowEnd: iso(0),
          },
        },
        { ...claudeOk(), id: 'codex', displayName: 'Codex', accent: '#10A37F',
          weeklyCost: floorCost() },
        kimiPassive(),
      ],
    }),
  },
  {
    id: 'ilk-calistirma',
    label: 'İlk açılış',
    bridgeAvailable: true,
    snapshot: () => ({
      generatedAt: iso(-4_000),
      pendingUsage: [],
      providers: [
        claudeUnknown(),
        passive('codex', 'Codex CLI', '#7FB3D5', 'Bulundu, henüz bağlı değil.'),
        passive('antigravity', 'Antigravity', '#B892E8', 'Bu makinede bulunamadı.'),
        passive('kimi', 'Kimi', '#5FD3A6', 'Bu makinede bulunamadı.'),
        passive('qwen', 'Qwen Code', '#6D5DFC', 'Bu makinede bulunamadı.'),
        passive('grok', 'Grok Build', '#D946EF', 'Bu makinede bulunamadı.'),
      ],
    }),
  },
  {
    id: 'yukleniyor',
    label: 'İlk tarama',
    bridgeAvailable: true,
    snapshot: () => null,
  },
  {
    id: 'tahmini',
    label: 'Tahmini (kullanılmıyor)',
    bridgeAvailable: true,
    snapshot: () => ({
      generatedAt: iso(-8_000),
      pendingUsage: [],
      providers: [
        {
          ...claudeOk(),
          fiveHour: estimated(62, 54, 71, FIVE_H_RESET()),
          sevenDay: estimated(41, 36, 48, SEVEN_D_RESET()),
        },
        {
          ...claudeOk(94, 81),
          id: 'codex',
          displayName: 'Codex',
          accent: '#10A37F',
          experimental: false,
          planLabel: 'Plus',
          tokens: breakdown(420_000),
          weeklyTokens: breakdown(1_890_000),
          weeklyTokensWindowAnchored: false,
          weeklyTokenFloorCauses: [],
          burnRatePerHour: 31_000,
          byModel: [],
        },
      ],
    }),
  },
  {
    id: 'bayat-olcum',
    label: 'Bayat ölçüm',
    bridgeAvailable: true,
    snapshot: () => ({
      generatedAt: iso(-6_000),
      pendingUsage: [],
      providers: [claudeStaleCapture(), claudeCaptureExpired2(), kimiPassive()],
    }),
  },
  {
    id: 'bos',
    label: 'Araç yok',
    bridgeAvailable: true,
    snapshot: () => ({ generatedAt: iso(-2_000), providers: [], pendingUsage: [] }),
  },
  {
    // The OTHER empty panel: five providers were found and the user removed
    // every row. Identical pixels to 'bos' unless the empty state says which
    // of the two it is, which is why both scenarios exist.
    id: 'hicbiri-ekli',
    label: 'Hiçbiri ekli değil',
    bridgeAvailable: true,
    snapshot: () => ({
      generatedAt: iso(-9_000),
      pendingUsage: [],
      providers: [
        { ...claudeOk(), enabled: false },
        { ...codexUnknown(), enabled: false },
        passive('antigravity', 'Antigravity', '#B892E8', 'Bu makinede bulunamadı.'),
        { ...kimiPassive(), enabled: false },
        passive('qwen', 'Qwen Code', '#6D5DFC', 'Bu makinede bulunamadı.'),
        passive('grok', 'Grok Build', '#D946EF', 'Bu makinede bulunamadı.'),
      ],
    }),
  },
  {
    id: 'kopuk',
    label: 'Servis yok',
    bridgeAvailable: false,
    snapshot: () => ({
      generatedAt: iso(-22 * 60_000),
      pendingUsage: [],
      providers: [claudeOk(62, 41), kimiPassive()],
    }),
  },
];

/** Nudges the live rows so the 400ms fill transition can be observed. */
export function drift(snapshot: Snapshot, step: number): Snapshot {
  return {
    generatedAt: new Date().toISOString(),
    pendingUsage: snapshot.pendingUsage,
    providers: snapshot.providers.map((provider) => {
      const bump = (usage: WindowUsage | null, amount: number): WindowUsage | null => {
        if (!usage || usage.usedPercentage === null) return usage;
        const next = Math.max(0, Math.min(100, usage.usedPercentage + amount));
        return { ...usage, usedPercentage: next };
      };
      // Tokens measured since a capture only ever RISE — that is the whole
      // point of billableSinceCapture as a floor. The fixture must move it, or
      // the harness cannot show a frozen delta, which is exactly how the
      // freeze bug survived review.
      const grow = (usage: WindowUsage | null): WindowUsage | null => {
        if (!usage || typeof usage.billableSinceCapture !== 'number') return usage;
        return {
          ...usage,
          billableSinceCapture: Math.round(usage.billableSinceCapture * (1 + Math.abs(step) * 4) + 90_000),
        };
      };
      return {
        ...provider,
        fiveHour: grow(bump(provider.fiveHour, step * 7)),
        sevenDay: grow(bump(provider.sevenDay, step * 2)),
      };
    }),
  };
}

// ----------------------------------------------------------------- anchors

const WINDOW_W = 480;
const WINDOW_H = 720;

/**
 * Tray anchor fixtures. The harness renders inside a browser tab, so these
 * describe a synthetic 1920x1080 display and place the fixed-size window the
 * way main would. Verified value on this machine: scaleFactor 1.25.
 */
export function anchorFor(
  edge: AnchorPayload['edge'],
  mode: AnchorPayload['mode'] = 'hover',
  scaleFactor = 1.25,
  trayOffset = 0,
  anchorSource: AnchorPayload['anchorSource'] = 'tray',
): AnchorPayload {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const workArea = { x: 0, y: 0, width: 1920, height: 1032 };

  let tray = { x: 1720 + trayOffset, y: 1040, width: 24, height: 24 };
  if (edge === 'top') tray = { x: 1720 + trayOffset, y: 8, width: 24, height: 24 };
  if (edge === 'left') tray = { x: 8, y: 600 + trayOffset, width: 24, height: 24 };
  if (edge === 'right') tray = { x: 1888, y: 600 + trayOffset, width: 24, height: 24 };

  const centreX = tray.x + tray.width / 2;
  const centreY = tray.y + tray.height / 2;

  // Main centres the window on the tray icon but must keep it inside the work
  // area. That clamp is what makes the tail go off-centre near a screen edge,
  // which is the normal case on Windows: the tray sits at the far right.
  const clampX = (x: number): number =>
    Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - WINDOW_W));
  const clampY = (y: number): number =>
    Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - WINDOW_H));

  let win = {
    x: clampX(Math.round(centreX - WINDOW_W / 2)),
    y: workArea.height - WINDOW_H,
    width: WINDOW_W,
    height: WINDOW_H,
  };
  if (edge === 'top') {
    win = { x: clampX(Math.round(centreX - WINDOW_W / 2)), y: 40, width: WINDOW_W, height: WINDOW_H };
  }
  if (edge === 'left') {
    win = { x: 40, y: clampY(Math.round(centreY - WINDOW_H / 2)), width: WINDOW_W, height: WINDOW_H };
  }
  if (edge === 'right') {
    win = {
      x: workArea.width - WINDOW_W,
      y: clampY(Math.round(centreY - WINDOW_H / 2)),
      width: WINDOW_W,
      height: WINDOW_H,
    };
  }

  return {
    tray,
    anchorSource,
    display: { id: 1, scaleFactor, bounds, workArea },
    window: win,
    edge,
    mode,
  };
}
