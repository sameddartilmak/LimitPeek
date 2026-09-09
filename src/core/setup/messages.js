'use strict';
const { antigravityHomeOverridden } = require('../paths');

/**
 * The setup notices for BOTH providers, and the budget they have to fit.
 *
 * A user pressed the connect button and got a sentence cut off mid-word: the
 * renderer caps a notice at 160 characters and appends an ellipsis, and the
 * half that disappeared was the half telling them what to do. The message was
 * 172 characters, and the overflow was an absolute filesystem path embedded in
 * the sentence body.
 *
 * Two rules came out of that, and they are why this module exists:
 *
 *   1. These strings FIT BY CONSTRUCTION. `fitNotice` assembles them
 *      most-important-clause-first and stops before the cap, so the cap never
 *      gets to choose what to delete. Same degradation ladder as
 *      `buildTooltip` — a hard cut lands mid-word, and mid-word is where the
 *      instruction lives.
 *
 *   2. An absolute path is not conversation. It goes in the log. It appears in
 *      a notice only where it IS the payload — the command to chain, or the
 *      directory an override redirected us to — and even then it is shortened
 *      from the left, because the tail of a path is the part that identifies
 *      it.
 *
 * One source for each string, because the same sentence previously existed in
 * both `setup/antigravity-bridge.js` and `main/bridge-install.js` and only one
 * copy would have been fixed.
 *
 * Provider-agnostic on purpose. This module started out Antigravity-only, and
 * the Claude path shipped the IDENTICAL overflow: its "already configured"
 * notice measured 194 characters with a real packaged bridge path, so the cut
 * landed 34 characters inside the command the user had to copy. The same
 * defect in two places is one defect; it gets one fix.
 */

/** `trimMessage` in the renderer caps a notice here. */
const NOTICE_MAX = 160;

/**
 * Builds a notice from one clause that must survive and any number that may
 * give way.
 *
 * The split is the correction that matters. An earlier version treated every
 * clause as droppable, and on a long install path it dropped the chaining
 * COMMAND — the one thing the user had to copy — while keeping the sentence
 * explaining why they needed it. The instruction is the payload; the
 * explanation is the courtesy.
 *
 * Optional clauses are dropped whole. Slicing a sentence leaves something that
 * reads as a bug, and slicing a path or a command leaves something that looks
 * runnable and is not.
 *
 * `required` is emitted even when it alone exceeds the cap: a notice the
 * renderer then truncates is still visible, and the full text is always in the
 * log. An empty notice is the one outcome with no recovery.
 */
function fitNotice(required, optional = [], max = NOTICE_MAX) {
  let out = String(required || '');
  for (const part of optional) {
    if (!part) continue;
    const next = out ? `${out} ${part}` : part;
    if (next.length > max) continue;
    out = next;
  }
  return out;
}

/**
 * A path short enough to sit in a sentence, trimmed from the LEFT.
 *
 * The tail identifies a path — `...\\bridge\\antigravity-statusline.mjs` is
 * recognisable, `C:\\Users\\someone\\AppData\\Roa...` is not.
 */
function shortPath(p, max = 52) {
  const text = String(p || '');
  return text.length <= max ? text : `…${text.slice(-(max - 1))}`;
}

/**
 * Said when the `agy` CLI is not on this machine.
 *
 * The framing matters and it changed: this row shows a real five-hour figure
 * from the IDE's own state store WITHOUT the CLI. So the absence of `agy` is
 * not "this provider does not work" — it is "the weekly window is the part you
 * do not get". The older wording said the first thing, and it will be plainly
 * false to anyone looking at the five-hour figure while reading it.
 */
function cliNotFound(homeDir) {
  return fitNotice(
    'Antigravity CLI (agy) bulunamadı; hiçbir dosya oluşturulmadı.',
    [
      // Ahead of the hint: a redirected install is the failure that makes the
      // rest of the sentence untrustworthy.
      overrideClause(homeDir),
      'Beş saatlik limit yine de görünür; agy yalnızca haftalık limit için gerekir.',
    ],
  );
}

/**
 * Said on a successful install.
 *
 * The override clause outranks the restart hint on purpose: a "Bağlandı" for a
 * statusLine written where `agy` never looks is the failure this clause exists
 * to prevent, and it is worth more than a reminder to restart.
 */
function installed(homeDir) {
  return fitNotice('Bağlandı.', [
    overrideClause(homeDir),
    'Antigravity CLI oturumunu yeniden başlatın; yüzde birkaç saniye içinde görünür.',
  ]);
}

/**
 * Said when a `statusLine` is already configured. Used by both providers.
 *
 * The command IS the payload here, so it is the clause that must survive; the
 * explanation is the one that gives way. A notice that truncates exactly the
 * instruction it exists to deliver is not a notice.
 *
 * It deliberately does not name the provider: the notice is rendered on that
 * provider's own row, and the 20 characters "Claude Code" would cost are 20
 * characters of the command. (`agy` also accepts `stack_with_default: true`,
 * which renders a second line below the built-in one — the doc's own
 * alternative to chaining by hand.)
 */
function statusLineExists(command) {
  return fitNotice(
    `Zaten bir statusLine tanımlı; şunu elle zincirleyin: ${command}`,
    ['Üzerine yazmıyoruz.'],
  );
}

/**
 * Names a non-default CLI home, shortened. The FULL path goes to the log at
 * the call site — this clause exists so the user is never told "Bağlandı"
 * about a directory `agy` may not read, not to be a complete record.
 */
function overrideClause(homeDir) {
  if (!homeDir || !antigravityHomeOverridden(homeDir)) return '';
  return `UYARI: ANTIGRAVITY_CLI_DIR ayarlı: ${shortPath(homeDir)}`;
}

module.exports = { NOTICE_MAX, fitNotice, shortPath, cliNotFound, installed, statusLineExists, overrideClause };
