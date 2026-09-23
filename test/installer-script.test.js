'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * `build/installer.nsh` is compiled by makensis, not by node, so nothing else in
 * this suite can fail when it breaks — and it breaks silently, in two ways that
 * both end with a stored API key left on disk after an uninstall the user asked
 * for (ADR-003 Amendment 5, K12).
 *
 * 1. THE BOM IS LOAD-BEARING. electron-builder `!include`s this file by path, so
 *    makensis reads it directly, and NSIS 3 only decodes a source file as UTF-8
 *    when it starts with a BOM. Measured against the exact toolchain
 *    electron-builder downloads (makensis 3.0.4.1), compiling
 *    `MessageBox MB_OK "kaldırıldı klasörü silinemedi"` with `Unicode true`
 *    and `SetCompress off` so the string table is readable:
 *      with a BOM    -> the Unicode string table holds U+0131 / U+00F6 (correct)
 *      without a BOM -> it holds "kaldÄ±rÄ±ldÄ± klasÃ¶rÃ¼" (mojibake)
 *    An editor that "cleans up" the BOM therefore turns the Turkish warning into
 *    garbage with no build error: makensis exits 0, and electron-builder's
 *    `checkMakensisOutput` only fails on `^Error:` lines.
 *
 * 2. THE DELETION MUST STAY VERIFIED. `RMDir /r` does not abort the section when
 *    it fails, so the removal has to be checked afterwards and reported. These
 *    tests pin the shape, not the wording.
 */
const ROOT = path.join(__dirname, '..');
const NSH = path.join(ROOT, 'build', 'installer.nsh');
const SECRETS = '$LOCALAPPDATA\\UsageNotch\\secrets';
const BOM = 0xfeff;

function raw() {
  return fs.readFileSync(NSH);
}

function text() {
  // Drop the BOM so every assertion below is about the script, not the prefix.
  const decoded = raw().toString('utf8');
  return decoded.charCodeAt(0) === BOM ? decoded.slice(1) : decoded;
}

/**
 * Code only. The comment block in installer.nsh quotes `${ifNot} ${isUpdated}`
 * and electron-builder's own if/else while documenting the --delete-app-data
 * exception, so a naive count over the whole file finds guards that do not
 * exist. NSIS line comments start with `;`.
 */
function code() {
  return text()
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(';'))
    .join('\n');
}

test('installer.nsh keeps its UTF-8 BOM, which is the only reason makensis decodes the Turkish message', () => {
  assert.deepEqual(
    [...raw().subarray(0, 3)],
    [0xef, 0xbb, 0xbf],
    'build/installer.nsh lost its UTF-8 BOM; makensis will read it as the system code page and the '
      + 'Turkish uninstall warning will compile to mojibake with no build error',
  );
});

test('every non-ASCII character in installer.nsh is one the BOM can account for', () => {
  const nonAscii = [...new Set([...text()].filter((c) => c.codePointAt(0) > 0x7f))];
  // Not a ban: this documents WHY the BOM above is required. If the file ever
  // becomes pure ASCII the BOM is no longer load-bearing and this test says so,
  // rather than leaving a rule nobody can explain.
  assert.ok(
    nonAscii.length > 0,
    'installer.nsh is pure ASCII now; the BOM requirement above is no longer load-bearing, so either '
      + 'delete both tests or say why the BOM stays',
  );
});

test('the stored key is only ever removed on a real uninstall, never during an upgrade', () => {
  const body = code();
  const guard = body.indexOf('${ifNot} ${isUpdated}');
  assert.ok(guard > 0, "the ${ifNot} ${isUpdated} guard is gone; an upgrade would now delete the user's key");

  const removal = body.indexOf(`RMDir /r "${SECRETS}"`);
  assert.ok(removal > 0, `nothing removes ${SECRETS} any more; an uninstall would leave a credential behind`);
  assert.ok(removal > guard, 'the secrets removal moved outside the isUpdated guard; every upgrade would drop the key');

  // One guard, so there is no second unguarded branch hiding below it.
  assert.equal(
    body.split('${ifNot} ${isUpdated}').length - 1,
    1,
    'more than one isUpdated guard: check by hand which branch the secrets removal is in',
  );
});

test('the removal is verified and reported, not merely issued', () => {
  const body = code();
  const removal = body.indexOf(`RMDir /r "${SECRETS}"`);
  const check = body.indexOf(`\${FileExists} "${SECRETS}\\*.*"`);
  assert.ok(
    check > removal,
    'RMDir /r is no longer followed by a FileExists check; a locked file would leave a DPAPI credential '
      + 'on disk with nothing to notice it (RMDir /r does not abort the section)',
  );
  assert.match(
    body,
    /RMDir \/r \/REBOOTOK/,
    'the /REBOOTOK retry is gone; leftovers are no longer scheduled for removal at the next boot',
  );
  assert.match(body, /DetailPrint/, 'nothing reports the outcome of the removal');
  assert.match(
    body,
    /MessageBox/,
    'the only channel that reaches a human is gone: DetailPrint goes to a log inside $INSTDIR, which is '
      + 'deleted seconds later',
  );
});

test('the failure message exists in both languages the product ships', () => {
  const body = code();
  // $LANGUAGE 1055 is Turkish. Asserted by id rather than by name because the
  // LangString route is unavailable: electron-builder only reads its own
  // templates/nsis/messages.yml, never a project file.
  assert.match(body, /\$LANGUAGE == 1055/, 'the Turkish branch is gone; Turkish users would get English only');
  // FOUR now, not two: two outcomes x two languages. `/REBOOTOK` queues the
  // leftovers under HKLM, which a per-user, non-elevated uninstall may be
  // refused, so "it will go at the next restart" is false on that path and the
  // two outcomes need different copy.
  assert.equal(
    (body.match(/MessageBox MB_ICONEXCLAMATION\|MB_OK/g) || []).length,
    4,
    'expected four MessageBox calls: scheduled and not-scheduled, one per language each',
  );
  assert.match(body, /secrets\b/, 'the message no longer names the folder the user has to delete');
});

test('the outcome of the /REBOOTOK retry is branched on, not assumed', () => {
  const body = code();
  // NSIS raises the reboot flag only when something was really queued. Without
  // this branch the dialog promises a deletion that may never happen — the
  // false reassurance K12 exists to prevent, on the one path where a DPAPI
  // credential survives an uninstall the user asked for.
  assert.match(
    body,
    /\$\{if\} \$\{RebootFlag\}/,
    'nothing distinguishes a scheduled removal from one that could not be scheduled',
  );
  const scheduled = body.match(/next time you restart Windows|yeniden başlattığınızda/g) || [];
  assert.equal(scheduled.length, 2, 'the restart promise must appear once per language, and only on the scheduled path');
});

test('the deferral is judged by a false-to-true transition, not by the sticky global flag', () => {
  const body = code();
  // ${RebootFlag} is GLOBAL and STICKY: it is not ours, nothing resets it, and
  // anything earlier in the uninstall can raise it. Reading it only AFTER the
  // /REBOOTOK call therefore takes the scheduled branch — making exactly the
  // false promise security F1 is about — whenever a reboot was already pending
  // for an unrelated reason. Only a false -> true transition is evidence about
  // our own deferral, so the prior state has to be captured first.
  const capture = body.indexOf('StrCpy $R6 "0"');
  const call = body.indexOf('RMDir /r /REBOOTOK');
  const decide = body.indexOf('StrCpy $R8 "scheduled"');
  assert.ok(capture > 0, 'the reboot flag state is no longer captured before the /REBOOTOK call');
  assert.ok(call > capture, 'the capture must happen before the deferral is attempted, or it proves nothing');
  assert.ok(decide > call, 'the outcome must be decided after the call');
  assert.match(
    body,
    /\$R6 == "0"/,
    'the prior reboot-flag state dropped out of the test, so a reboot pending for any other reason would '
      + 'report this removal as scheduled when it was not',
  );
  // Decided once, then reported. Two independent ${RebootFlag} reads could
  // disagree, and the dialog must not say something the log did not.
  const reportDetail = body.indexOf('${if} $R8 == "scheduled"');
  assert.ok(reportDetail > decide, 'the outcome must be reported from the single decision, not re-derived');
});

test('every failure message points at revocation, which is the remedy that always works', () => {
  const body = code();
  // Deleting the folder removes the local copy; revoking the token removes what
  // the copy can do. Only the second works whether or not the file went, so it
  // belongs in BOTH outcomes rather than only in the one where deletion failed.
  const boxes = body.match(/MessageBox MB_ICONEXCLAMATION\|MB_OK "[^"]*"/g) || [];
  assert.equal(boxes.length, 4, 'expected to find all four messages to check');
  for (const box of boxes) {
    assert.match(
      box,
      /revoke the token at GitHub|GitHub'dan iptal/,
      `a failure message omits revocation: ${box.slice(0, 90)}`,
    );
  }
});

test('the not-scheduled message promises nothing about a restart', () => {
  const body = code();
  const boxes = body.match(/MessageBox MB_ICONEXCLAMATION\|MB_OK "[^"]*"/g) || [];
  const unscheduled = boxes.filter((b) => !/next time you restart Windows|yeniden başlattığınızda/.test(b));
  assert.equal(unscheduled.length, 2, 'expected one not-scheduled message per language');
  for (const box of unscheduled) {
    // It must say the deletion did NOT happen, with no "yet" and no future
    // tense: on this path the folder may survive indefinitely.
    assert.match(box, /could not be deleted:|silinemedi:/, box.slice(0, 90));
    assert.doesNotMatch(box, /could not be deleted yet|henüz silinemedi/, 'this path has no later to wait for');
  }
});
