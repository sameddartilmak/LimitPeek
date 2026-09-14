'use strict';

/**
 * The provider registry. A static array, on purpose: ADR-001 rules out a
 * dynamic plugin loader. Adding a provider is a code change and a review.
 *
 * Accents are used ONLY for the 2px spine and the monogram tile, never for the
 * meter (contract.ts, ProviderSnapshot.accent).
 *
 * `claude` and `antigravity` are wired: both publish a server-computed
 * percentage through a documented statusline hook, which is the only source
 * ADR-001 Decision 1 accepts. The other four are present because the user
 * asked to see every tool with an "Ekle" affordance; they render as passive
 * rows with no meter and no fabricated number (ADR-001 Decision 3).
 *
 * `enabledByDefault` is the shipped answer to "has the user ADDED this row to
 * the panel", used until they say otherwise (contract.ts,
 * `ProviderSnapshot.enabled`). It is deliberately NOT the same field as
 * `live`: `live` is ours to know — whether we can collect anything — while
 * enablement is the user's choice about what they want to look at. They happen
 * to coincide today, and writing them as one field would silently give a
 * future wired provider a row nobody asked for.
 */
const PROVIDERS = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    accent: '#C96442',
    live: true,
    enabledByDefault: true,
    setupAction: {
      kind: 'install-bridge',
      label: 'Bağla',
      detail: 'Claude Code durum satırına bir köprü eklenir; yalnızca kullanım yüzdesi ve sıfırlanma zamanı okunur.',
    },
  },
  {
    id: 'codex',
    displayName: 'Codex',
    accent: '#10A37F',
    live: true,
    enabledByDefault: false,
    setupAction: {
      // Codex writes its rate limits into its own session rollout, so there is
      // nothing for us to install — this chip only appears when Codex itself is
      // not on the machine, as an informational "not found", never an action.
      kind: 'not-installed',
      label: 'Ekle',
      detail: 'Codex bu makinede bulunamadı.',
    },
  },
  {
    id: 'gemini',
    displayName: 'Gemini',
    accent: '#4386F5',
    live: false,
    enabledByDefault: false,
    setupAction: {
      kind: 'not-installed',
      label: 'Ekle',
      detail: 'Gemini bu sürümde henüz desteklenmiyor.',
    },
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    accent: '#8B5CF6',
    live: false,
    enabledByDefault: false,
    setupAction: {
      kind: 'not-installed',
      label: 'Ekle',
      detail: 'GitHub Copilot bu sürümde henüz desteklenmiyor.',
    },
  },
  {
    id: 'antigravity',
    // `live` without `enabledByDefault`: we can collect this provider, but the
    // user never asked to see it. This is the exact split the comment above
    // describes, and antigravity is the first row to actually use it.
    displayName: 'Antigravity',
    accent: '#E8B84B',
    live: true,
    enabledByDefault: false,
    setupAction: {
      kind: 'install-bridge',
      label: 'Bağla',
      detail: 'Antigravity CLI kurulu değilse indirilip kurulur (onayınızla), sonra durum '
        + 'satırına köprü eklenir; yalnızca kalan kota oranı ve sıfırlanma zamanı okunur.',
    },
  },
  {
    id: 'kimi',
    displayName: 'Kimi',
    accent: '#2B6BE8',
    live: false,
    enabledByDefault: false,
    setupAction: {
      kind: 'not-installed',
      label: 'Ekle',
      detail: 'Kimi bu sürümde henüz desteklenmiyor.',
    },
  },
];

const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

/** Shipped enablement, by id. Frozen: it is a default, never a live value. */
const DEFAULT_ENABLED = Object.freeze(
  PROVIDERS.reduce((acc, p) => { acc[p.id] = p.enabledByDefault === true; return acc; }, {}),
);

function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

function isProviderId(id) {
  return typeof id === 'string' && PROVIDER_IDS.includes(id);
}

module.exports = { PROVIDERS, PROVIDER_IDS, DEFAULT_ENABLED, getProvider, isProviderId };
