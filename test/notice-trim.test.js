'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * `trimMessage` in `src/renderer/src/format.ts`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The notice cap used to be `clean.slice(0, 159) + '…'`. The Antigravity
 * "CLI bulunamadı" message is 172 characters, so the cut landed mid-word and
 * removed the actionable half of the sentence: the user was left with a
 * diagnosis and no instruction, in a box they also could not dismiss.
 *
 * The cap itself is not the bug — it is a layout constraint and a longer
 * message would still eventually hit it. The bug is WHERE the cut falls, so
 * every property pinned here is about the boundary, not the length. Loaded
 * from SOURCE via the same helper `format.test.js` uses, so a stale `dist/`
 * cannot make these pass.
 */
const { formatModule } = require('./helpers/load-format');

let f;
const mod = formatModule();
test.before(async () => { f = await mod.load(); });
test.after(() => mod.cleanup());

/** Build a string of whole words that overruns the cap. */
function words(count, word = 'kelime') {
  return Array.from({ length: count }, () => word).join(' ');
}

/**
 * True when the trimmed result ends on a whole word of the original.
 *
 * Deliberately not "the last character is not a letter" — "üç…" ends on a
 * letter and is a perfectly good cut, while "değiştiril…" also ends on one and
 * is the bug. Only the source text can settle which, so the last token is
 * looked up in it.
 */
function endsOnAWholeWord(original, trimmed) {
  const body = trimmed.endsWith('…') ? trimmed.slice(0, -1) : trimmed;
  const tokens = body.split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (last === undefined) return false;
  // A word boundary on both sides in the ORIGINAL, punctuation allowed after.
  return new RegExp('(^|\\s)' + last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|\\s)').test(
    original,
  );
}

test.describe('nothing is trimmed that fits', () => {
  test('an empty or blank message is empty, not an ellipsis', () => {
    assert.equal(f.trimMessage(''), '');
    assert.equal(f.trimMessage('   \n  '), '');
  });

  test('surrounding whitespace is dropped but the text is untouched', () => {
    assert.equal(f.trimMessage('  Bağlantı kuruldu.  '), 'Bağlantı kuruldu.');
  });

  test('a message exactly at the cap is not truncated', () => {
    const exact = 'a'.repeat(f.NOTICE_MAX);
    assert.equal(f.trimMessage(exact), exact);
    assert.ok(!f.trimMessage(exact).endsWith('…'));
  });

  test('one character over the cap IS truncated', () => {
    const over = 'a'.repeat(f.NOTICE_MAX + 1);
    assert.notEqual(f.trimMessage(over), over);
  });
});

test.describe('the cut never lands inside a word', () => {
  test('a long run of whole words ends on a word, not a fragment', () => {
    const trimmed = f.trimMessage(words(60));
    assert.ok(trimmed.endsWith('…'), trimmed);
    const body = trimmed.slice(0, -1);
    // Every surviving token is the whole word, never a prefix of it.
    for (const token of body.split(' ')) assert.equal(token, 'kelime');
  });

  test('the result still respects the cap, ellipsis aside', () => {
    const trimmed = f.trimMessage(words(60));
    assert.ok(trimmed.slice(0, -1).length <= f.NOTICE_MAX, trimmed.length);
  });

  test('the trailing space before the cut is not left dangling', () => {
    const trimmed = f.trimMessage(words(60));
    assert.ok(!/\s…$/.test(trimmed), JSON.stringify(trimmed));
  });

  test('the real message that caused this: the instruction survives the cut', () => {
    // 172 characters, the length measured on the machine that reported it.
    const message =
      'Bu makinede Antigravity CLI bulunamadı. Kurulum için önce Antigravity ' +
      'CLI uygulamasını kurun, ardından bu düğmeye yeniden basın; hiçbir ' +
      'dosya oluşturulmadı ve hiçbir ayar değiştirilmedi.';
    assert.ok(message.length > f.NOTICE_MAX, message.length);
    const trimmed = f.trimMessage(message);
    // The old slice(0, 159) landed inside a word; nothing may now end on a
    // fragment of one.
    assert.ok(endsOnAWholeWord(message, trimmed), JSON.stringify(trimmed));
    // And the sentence that tells the user what to do is not the half dropped.
    assert.ok(/kurun/.test(trimmed), trimmed);
  });
});

test.describe('a whole sentence is preferred, and then claims nothing was lost', () => {
  test('cutting on a sentence boundary drops the ellipsis', () => {
    // Two sentences: the first ends well past a third of the budget, so the
    // boundary search takes it and the remaining text is complete.
    const first = words(14) + '.';
    assert.ok(first.length > Math.floor(f.NOTICE_MAX / 3), first.length);
    const trimmed = f.trimMessage(first + ' ' + words(20));
    assert.equal(trimmed, first);
    assert.ok(!trimmed.endsWith('…'), trimmed);
  });

  test('an early full stop does not throw away the rest of the budget', () => {
    // "Kısa." is far inside the first third; taking it would leave a notice of
    // five characters out of a hundred and sixty, which is a worse cut than
    // the character one this replaced.
    const trimmed = f.trimMessage('Kısa. ' + words(60));
    assert.ok(trimmed.length > 40, JSON.stringify(trimmed));
    assert.ok(trimmed.endsWith('…'), trimmed);
  });

  test('a bare terminator is punctuation, not a sentence to end on', () => {
    // A lone '.' sitting past the floor must not produce a one-character
    // notice consisting of the punctuation mark.
    const trimmed = f.trimMessage('. ' + words(60));
    assert.notEqual(trimmed, '.');
    assert.ok(trimmed.length > 10, JSON.stringify(trimmed));
  });

  test('a clause boundary is NOT a place to stop without an ellipsis', () => {
    // ';' and ':' promise that more follows. Ending on one and dropping the
    // ellipsis presents a half-message as a whole one — which is how the
    // Antigravity notice lost its instruction in the first place.
    const source =
      'Bu makinede Antigravity CLI bulunamadı. Kurulum için önce Antigravity ' +
      'CLI uygulamasını kurun, ardından bu düğmeye yeniden basın; hiçbir ' +
      'dosya oluşturulmadı ve hiçbir ayar değiştirilmedi.';
    const trimmed = f.trimMessage(source);
    assert.ok(!/[:;]$/.test(trimmed), JSON.stringify(trimmed));
    assert.ok(trimmed.endsWith('…'), JSON.stringify(trimmed));
    assert.ok(endsOnAWholeWord(source, trimmed), JSON.stringify(trimmed));
  });
});

test.describe('degenerate input still produces something renderable', () => {
  test('a single unbreakable token falls back to a hard cut rather than nothing', () => {
    const path = 'C:\\' + 'x'.repeat(400);
    const trimmed = f.trimMessage(path);
    assert.ok(trimmed.endsWith('…'), trimmed);
    assert.equal(trimmed.length, f.NOTICE_MAX + 1);
  });

  test('a message that is entirely one long word after a short prefix keeps the prefix', () => {
    const trimmed = f.trimMessage('Yol ' + 'x'.repeat(400));
    assert.equal(trimmed, 'Yol…');
  });

  test('the cap is a parameter, so the rule is not tied to one number', () => {
    // A boundary sitting exactly ON the cap is inside the budget: "bir iki üç"
    // is ten characters and the eleventh is the space that ends it.
    assert.equal(f.trimMessage('bir iki üç dört beş', 10), 'bir iki üç…');
  });

  test('newlines count as boundaries too', () => {
    const source = 'bir iki üç\ndört beş altı yedi sekiz';
    const trimmed = f.trimMessage(source, 14);
    assert.equal(trimmed, 'bir iki üç…');
    assert.ok(endsOnAWholeWord(source, trimmed), JSON.stringify(trimmed));
  });
});
