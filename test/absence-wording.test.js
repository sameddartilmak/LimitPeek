'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The two user-facing strings this change turns on live in renderer components
 * (meter.ts, panel.ts) whose DOM behaviour is exercised by the render suite,
 * which needs Electron. These source-level guards are the runnable fence under
 * `npm test`: they pin the WORDS themselves so a later edit cannot quietly
 * reintroduce the contradiction, following the same read-the-source precedent
 * as contract-mirror.test.js.
 */
const ROOT = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test.describe('the awaiting-report absence has its own honest wording', () => {
  test("meter.ts prints 'yeni veri bekleniyor', with a spoken variant", () => {
    const src = read('src/renderer/src/components/meter.ts');
    const at = src.indexOf("'awaiting-report'");
    assert.notEqual(at, -1, "meter.ts must give 'awaiting-report' its own copy entry");
    const block = src.slice(at, at + 320);
    assert.match(block, /figure:\s*'yeni veri bekleniyor'/, 'the printed figure word');
    assert.match(block, /spoken:[\s\S]*yeni veri bekleniyor/, 'a spoken variant accompanies it');
  });

  test('it is neither "bilinmiyor" nor "yenileniyor": those describe other states', () => {
    const src = read('src/renderer/src/components/meter.ts');
    // The pre-existing absences keep their words; the new one does not borrow them.
    assert.match(src, /'rolled-over':\s*\{[\s\S]*?figure:\s*'yenileniyor'/, 'rolled-over unchanged');
    assert.match(src, /'not-supplied':\s*\{[\s\S]*?figure:\s*'bildirilmiyor'/, 'not-supplied unchanged');
  });

  test("the contract and the renderer's allow-set both admit 'awaiting-report'", () => {
    assert.match(read('src/shared/contract.ts'), /\|\s*'awaiting-report'/, 'contract union');
    // An absence not in this set is dropped to 'no-capture' by the sanitizer.
    assert.match(read('src/renderer/src/sanitize.ts'), /'awaiting-report'/, 'sanitizer allow-set');
  });
});

test.describe('the refresh bubble no longer contradicts the row', () => {
  const src = read('src/renderer/src/components/panel.ts');

  test('the unconditional "your last measurement is below" promise is gone', () => {
    // The old copy asserted the values below were "aracı en son açtığınızdaki
    // ölçüm" for EVERY window, while a rolled-over window's row honestly showed
    // no figure — the two surfaces disagreed about one fact.
    assert.equal(
      src.includes('aracı en son') || src.includes('açtığınızdaki ölçüm'),
      false,
      'the blanket last-measurement promise must be removed',
    );
  });

  test('the replacement is calm and scoped to still-valid readings', () => {
    assert.match(src, /Antigravity açık değil/, 'still names the closed tool');
    assert.match(src, /bir sorun yok/, 'still reassures nothing is broken');
    assert.match(src, /yalnızca hâlâ geçerli olan son ölçümler/, 'only valid readings are shown');
    assert.match(src, /süresi dolmuş/, 'it names the expired-window case');
    assert.match(
      src,
      /güncel oranı için/,
      'an expired window is told to open the tool — matching the row it sits above',
    );
  });
});
