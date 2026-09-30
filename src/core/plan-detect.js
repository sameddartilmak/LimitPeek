'use strict';

/**
 * The plan a tool itself RECORDS for the signed-in account (owner, 2026-09-30:
 * "otomatikleştirsek çok iyi olur").
 *
 * WHAT CHANGED, AND WHAT DID NOT
 * ------------------------------
 * The plan used to be the user's statement only (`plan-labels.js`), because
 * nothing this app read carried it. Two tools do write it where we already
 * look, in fields that are not credentials:
 *
 *   Claude Code  `~/.claude.json` -> `oauthAccount.organizationRateLimitTier`
 *                ("default_claude_max_5x"), `userRateLimitTier` and
 *                `organizationType` ("claude_max", "claude_pro"). The same file
 *                the desktop reader opens for the organization id; the token
 *                file `~/.claude/.credentials.json` is still never opened.
 *   Codex        `plan_type` ("plus") inside the `rate_limits` of its own
 *                rollout `token_count` records, which the rate-limit reader
 *                already parses.
 *
 * It is still a LABEL and never a number: nothing computes from it, exactly as
 * before. A value we do not recognise maps to null (the row then shows the
 * user's own label, or nothing) — an unknown tier is not rendered raw, because
 * "default_claude_foo" printed beside a tool name would read as a plan name we
 * vouch for. The user's own choice in Settings always wins over this.
 */

/** Claude Code's recorded tier -> a plan name, or null when unrecognised. */
function claudePlanFrom(account) {
  if (!account || typeof account !== 'object') return null;
  const tiers = [account.userRateLimitTier, account.organizationRateLimitTier]
    .filter((v) => typeof v === 'string')
    .map((v) => v.toLowerCase());
  for (const tier of tiers) {
    if (/max_?20x/.test(tier)) return 'Max 20x';
    if (/max_?5x/.test(tier)) return 'Max 5x';
  }
  const type = typeof account.organizationType === 'string' ? account.organizationType.toLowerCase() : '';
  switch (type) {
    case 'claude_max': return 'Max';
    case 'claude_pro': return 'Pro';
    case 'claude_team': return 'Team';
    case 'claude_enterprise': return 'Enterprise';
    default: return null;
  }
}

const CODEX_PLANS = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Business',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

/** Codex's recorded `plan_type` -> a plan name, or null when unrecognised. */
function codexPlanFrom(planType) {
  if (typeof planType !== 'string') return null;
  const key = planType.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CODEX_PLANS, key) ? CODEX_PLANS[key] : null;
}

/**
 * One row's plan fields: the user's own label wins; otherwise the tool's.
 * `planDetected` travels as well, so Settings can offer "Otomatik (Max 5x)".
 */
function planFields(userLabel, detected) {
  const user = typeof userLabel === 'string' && userLabel ? userLabel : null;
  const tool = typeof detected === 'string' && detected ? detected : null;
  if (user) return { planLabel: user, planSource: 'user', planDetected: tool };
  if (tool) return { planLabel: tool, planSource: 'tool', planDetected: tool };
  return { planLabel: null, planSource: null, planDetected: null };
}

module.exports = { claudePlanFrom, codexPlanFrom, planFields, CODEX_PLANS };
