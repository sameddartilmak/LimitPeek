'use strict';
const { t } = require('../i18n');

/**
 * A provider's setup action, in the language main currently speaks.
 *
 * Exposed as a GETTER on each registry entry rather than stored text: the
 * snapshot copies `{ ...p.setupAction }` on every build, so a language change
 * followed by `collector.rebuild()` re-translates the label and detail without
 * a second registry per language (ADR-004 A1, ruling 3). `kind` is not text
 * and never changes.
 */
function setup(kind, labelKey, detailKey, detailParams) {
  return { kind, label: t(labelKey), detail: t(detailKey, detailParams) };
}

/**
 * The provider registry. A static array, on purpose: ADR-001 rules out a
 * dynamic plugin loader. Adding a provider is a code change and a review.
 *
 * Accents are used ONLY for the 2px spine and the monogram tile, never for the
 * meter (contract.ts, ProviderSnapshot.accent).
 *
 * `claude` and `antigravity` are wired: both publish a server-computed
 * percentage through a documented statusline hook, which is the only source
 * ADR-001 Decision 1 accepts. The others are read from the tools' own
 * local files; a tool that is not on this machine renders as a passive row
 * with no meter and no fabricated number (ADR-001 Decision 3).
 *
 * `enabledByDefault` is the shipped answer to "has the user ADDED this row to
 * the panel", used until they say otherwise (contract.ts,
 * `ProviderSnapshot.enabled`). It is deliberately NOT the same field as
 * `live`: `live` is ours to know — whether we can collect anything — while
 * enablement is the user's choice about what they want to look at. They happen
 * to coincide today, and writing them as one field would silently give a
 * future wired provider a row nobody asked for.
 *
 * `experimental` (contract.ts `ProviderSnapshot.experimental`): the provider's
 * local reader was written from the vendor's SOURCE and has not yet been
 * confirmed against a real install (ADR-003 Amendment 6, decision 4). True for
 * Kimi, Qwen Code and Grok Build until someone with the tool installed
 * confirms the format.
 *
 * Only FIRST-PARTY coding tools are listed: the model maker's own tool (owner
 * decision, 2026-09-28). Gemini CLI was removed that day — Google retired it
 * for consumers on 2026-06-18, and its replacement, Antigravity CLI, is read
 * by the Antigravity row.
 */
const PROVIDERS = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    accent: '#C96442',
    live: true,
    enabledByDefault: true,
    experimental: false,
    get setupAction() {
      return setup('install-bridge', 'provider.setup.connect', 'provider.claude.detail');
    },
  },
  {
    id: 'codex',
    displayName: 'Codex',
    accent: '#10A37F',
    live: true,
    enabledByDefault: false,
    experimental: false,
    // Codex writes its rate limits into its own session rollout, so there is
    // nothing for us to install — this chip only appears when Codex itself is
    // not on the machine, as an informational "not found", never an action.
    get setupAction() {
      return setup('not-installed', 'provider.setup.add', 'provider.codex.notFound');
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
    experimental: false,
    get setupAction() {
      return setup('install-bridge', 'provider.setup.connect', 'provider.antigravity.detail');
    },
  },
  {
    id: 'kimi',
    displayName: 'Kimi',
    accent: '#2B6BE8',
    // Rung 1 (ADR-003 A6): tokens only, unpriced, from ~/.kimi-code/sessions
    // wire journals. Passive "not installed" when the Kimi Code home is absent.
    live: true,
    enabledByDefault: false,
    experimental: true,
    get setupAction() {
      return setup('not-installed', 'provider.setup.add', 'provider.kimi.notFound');
    },
  },
  {
    id: 'qwen',
    displayName: 'Qwen Code',
    accent: '#6D5DFC',
    // Rung 1: tokens and a notional cost at Alibaba Cloud Model Studio rates,
    // from the tool's own content-free usage log (~/.qwen/usage). Passive "not
    // installed" when the Qwen home is absent. No gauge: Qwen Code writes no
    // plan-quota percentage anywhere this app may read.
    live: true,
    enabledByDefault: false,
    experimental: true,
    get setupAction() {
      return setup('not-installed', 'provider.setup.add', 'provider.qwen.notFound');
    },
  },
  {
    id: 'grok',
    displayName: 'Grok Build',
    accent: '#D946EF',
    // Rung 1: tokens and the cost xAI itself reported, from each session's
    // content-free usage.json under ~/.grok/sessions. Passive "not installed"
    // when the Grok home is absent. No gauge, for the same reason as Qwen Code.
    live: true,
    enabledByDefault: false,
    experimental: true,
    get setupAction() {
      return setup('not-installed', 'provider.setup.add', 'provider.grok.notFound');
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
