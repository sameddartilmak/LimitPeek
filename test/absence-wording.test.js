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
 *
 * ADR-004 moved the words out of the components into the shared catalogs, so
 * the WORDS are pinned there and the components are pinned to the KEYS. Both
 * halves matter: a correct catalog entry that meter.ts no longer reads is the
 * same regression as a wrong word.
 */
const ROOT = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function catalog(lang, file) {
  return JSON.parse(read(`src/shared/i18n/${lang}/${file}`));
}

test.describe('the awaiting-report absence has its own honest wording', () => {
  test("meter.ts prints 'yeni veri bekleniyor', with a spoken variant", () => {
    const src = read('src/renderer/src/components/meter.ts');
    const at = src.indexOf("'awaiting-report'");
    assert.notEqual(at, -1, "meter.ts must give 'awaiting-report' its own copy entry");
    const block = src.slice(at, at + 320);
    assert.match(block, /figure:\s*t\('absence\.awaiting'\)/, 'the printed figure word');
    assert.match(block, /spoken:[\s\S]*t\('meter\.awaiting\.spoken'/, 'a spoken variant accompanies it');
    assert.equal(catalog('tr', 'common.json')['absence.awaiting'], 'yeni veri bekleniyor');
    assert.match(catalog('tr', 'renderer.json')['meter.awaiting.spoken'], /yeni veri bekleniyor/);
    assert.equal(catalog('en', 'common.json')['absence.awaiting'], 'awaiting new data');
  });

  test('it is neither "bilinmiyor" nor "yenileniyor": those describe other states', () => {
    const src = read('src/renderer/src/components/meter.ts');
    // The pre-existing absences keep their words; the new one does not borrow them.
    assert.match(src, /'rolled-over':\s*\{[\s\S]*?figure:\s*t\('absence\.resetting'\)/, 'rolled-over unchanged');
    assert.match(src, /'not-supplied':\s*\{[\s\S]*?figure:\s*t\('absence\.notReported'\)/, 'not-supplied unchanged');
    const tr = catalog('tr', 'common.json');
    assert.equal(tr['absence.resetting'], 'yenileniyor');
    assert.equal(tr['absence.notReported'], 'bildirilmiyor');
    assert.equal(tr['absence.unknown'], 'bilinmiyor');
    // Four absences, four different words, in both languages.
    for (const lang of ['tr', 'en']) {
      const c = catalog(lang, 'common.json');
      const words = ['absence.unknown', 'absence.notReported', 'absence.resetting', 'absence.awaiting']
        .map((key) => c[key]);
      assert.equal(new Set(words).size, 4, `${lang}: ${words}`);
    }
  });

  test("the contract and the renderer's allow-set both admit 'awaiting-report'", () => {
    assert.match(read('src/shared/contract.ts'), /\|\s*'awaiting-report'/, 'contract union');
    // An absence not in this set is dropped to 'no-capture' by the sanitizer.
    assert.match(read('src/renderer/src/sanitize.ts'), /'awaiting-report'/, 'sanitizer allow-set');
  });
});

test.describe('the refresh bubble no longer contradicts the row', () => {
  // The bubble's words live under a per-provider key; panel.ts must still be
  // the thing that prints that key.
  const panelSrc = read('src/renderer/src/components/panel.ts');
  const src = catalog('tr', 'renderer.json')['provider.antigravity.notRunning'];

  test('panel.ts renders the per-provider key', () => {
    assert.match(panelSrc, /t\('provider\.antigravity\.notRunning'\)/);
  });

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

  test('the toast is short, calm, and promises only what is always true', () => {
    // REWRITTEN 2026-09-24 at the owner's ask: the four-line paragraph became a
    // titled toast. The claim was narrowed further rather than dropped: it no
    // longer says what the row below shows at all, so it cannot contradict a
    // row whose expired window shows no figure. It says the tool is closed,
    // that opening it updates the numbers, and that nothing is wrong.
    const title = catalog('tr', 'renderer.json')['provider.antigravity.notRunning.title'];
    assert.equal(title, 'Antigravity kapalı');
    assert.match(src, /Açtığınızda/, 'opening the tool is the remedy');
    assert.match(src, /Bir sorun yok/, 'still reassures nothing is broken');
    assert.ok(src.length <= 80, `one short line, not a paragraph: ${src.length} chars`);
    assert.ok(panelSrc.includes("t('provider.antigravity.notRunning.title')"), 'panel.ts prints the title key');
  });

  test('the English makes the same claim', () => {
    const en = catalog('en', 'renderer.json')['provider.antigravity.notRunning'];
    assert.equal(catalog('en', 'renderer.json')['provider.antigravity.notRunning.title'], 'Antigravity is closed');
    assert.match(en, /when you open it/);
    assert.match(en, /Nothing is wrong/);
  });
});
