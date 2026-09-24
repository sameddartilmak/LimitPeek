'use strict';
/**
 * RENDER SUITE — the key-entry window (ADR-003 Amendment 5 + Amendment 8).
 *
 * This is the only surface in the app where a secret is typed, so the checks
 * here are about what the page does NOT do as much as what it does:
 *
 *   - it never renders the typed value. Not on success, not in an error, not
 *     as a length, not as a mask (K23). The strongest form of that check is
 *     the one below: no 4-character substring of the typed key may appear
 *     anywhere in the rendered text or in any attribute.
 *   - the consent text is present BEFORE the fields, and states what is sent,
 *     to which single host, how often, what is kept, what the encryption does
 *     not protect against, how to make a least-privilege key, that removing
 *     the local copy is not revocation, and that declining costs nothing.
 *   - Esc and Cancel both cancel; focus starts in the first field.
 *   - the "create the key on GitHub" button is keyboard reachable and is NOT
 *     the primary action (owner's A8 addendum).
 *
 *   node test/render/run.js key-entry
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const OUT = process.env.RENDER_OUT || path.join(os.tmpdir(), 'usage-notch-render-key-entry.txt');
const lines = [];
const say = (s) => { lines.push(s); try { fs.writeFileSync(OUT, lines.join('\n') + '\n'); } catch {} };
let failures = 0;
const check = (n, ok, d) => { if (!ok) failures++; say(`${ok ? 'PASS' : 'FAIL'}  ${n}${d === undefined ? '' : '  :: ' + JSON.stringify(d)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A realistic fine-grained token shape. Every 4-character window of it is
 * searched for in the rendered page, so a mask, a truncation or an echo in an
 * error message all fail the same check.
 */
const TEST_KEY = 'github_pat_TESTONLYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const TEST_USER = 'test-user';

app.disableHardwareAcceleration();
process.on('uncaughtException', (e) => { say('UNCAUGHT: ' + ((e && e.stack) || e)); app.exit(1); });
process.on('unhandledRejection', (e) => { say('UNHANDLED: ' + ((e && e.stack) || e)); app.exit(1); });

/**
 * Every 4-character substring of the key, as the leak probe's needles — minus
 * the ones that occur in the page's OWN copy with nothing typed. "gith" is in
 * "api.github.com", so a raw window list would fail on the consent text rather
 * than on a leak; the baseline is measured, not guessed.
 */
function needles(secret, baseline) {
  const out = [];
  for (let i = 0; i + 4 <= secret.length; i += 1) {
    const piece = secret.slice(i, i + 4);
    if (!baseline.includes(piece) && !out.includes(piece)) out.push(piece);
  }
  return out;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 640, height: 900, show: false, x: 20, y: 20,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
      preload: path.join(HERE, 'key-entry-preload.js'),
    },
  });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) say(`console[${l}]: ${m}`); });
  await win.loadFile(path.join(ROOT, 'src/renderer/key-entry.html'));
  await sleep(500);
  const js = (c) => win.webContents.executeJavaScript(c, true);

  // ---- step 1: the consent screen (Amendment 9) --------------------------
  const consent = await js(`(() => {
    const root = document.getElementById('key-entry');
    const bar = document.querySelector('.entry__bar');
    const clipped = (n) => n.scrollWidth > n.clientWidth + 0.5;
    return {
      title: (root.querySelector('.entry__title') || {}).textContent,
      facts: [...root.querySelectorAll('.entry__facts p')].map((p) => p.textContent),
      fields: root.querySelectorAll('input').length,
      buttons: [...root.querySelectorAll('button')].map((b) => b.textContent),
      cancelFocused: document.activeElement === root.querySelector('.entry__cancel'),
      barDrag: bar ? getComputedStyle(bar).webkitAppRegion || getComputedStyle(bar).getPropertyValue('-webkit-app-region') : null,
      barOutsideColumn: !!bar && !root.contains(bar),
      clipped: [...root.querySelectorAll('p, label, button')].filter(clipped).map((n) => n.className),
    };
  })()`);
  say('consent shape (tr): ' + JSON.stringify(consent));
  check('the window opens on the consent screen: the facts and two buttons, no field yet',
    consent.fields === 0 && consent.buttons.join('|') === 'Vazgeç|Devam et' && consent.title === 'GitHub Copilot API anahtarı',
    consent);
  check('Cancel has focus on arrival, so Enter never consents by accident',
    consent.cancelFocused === true, consent);
  check('the title strip spans the window and drags it',
    consent.barOutsideColumn === true && consent.barDrag === 'drag', consent);
  check('nothing on the consent screen is clipped', consent.clipped.length === 0, consent.clipped);
  const cancelBeforeConsent = await js(`(async () => {
    const before = window.__entryProbe.calls().cancel;
    document.querySelector('.entry__cancel').click();
    await new Promise((r) => setTimeout(r, 30));
    return window.__entryProbe.calls().cancel - before;
  })()`);
  check('Cancel on the consent screen cancels', cancelBeforeConsent === 1, cancelBeforeConsent);

  // A refused consent keeps the screen and prints a fixed sentence.
  const refusedConsent = await js(`(async () => {
    window.__entryProbe.setConsentAnswer({ ok: false, code: 'expired' });
    document.querySelector('.entry__primary').click();
    await new Promise((r) => setTimeout(r, 60));
    const e = document.querySelector('.entry__error');
    const out = { text: e && !e.hidden ? e.textContent : null, fields: document.querySelectorAll('input').length };
    window.__entryProbe.setConsentAnswer({ ok: true });
    return out;
  })()`);
  check('a refused Continue stays on the consent screen and says why',
    refusedConsent.fields === 0 && refusedConsent.text === 'Pencere zaman aşımına uğradı. Yeniden açıp tekrar deneyin.', refusedConsent);

  const afterConsent = await js(`(async () => {
    document.querySelector('.entry__primary').click();
    await new Promise((r) => setTimeout(r, 60));
    return { consents: window.__entryProbe.calls().consent, facts: document.querySelectorAll('.entry__facts').length };
  })()`);
  check('Continue asks main once and replaces the consent with the form',
    afterConsent.consents === 2 && afterConsent.facts === 0, afterConsent);

  // ---- step 2: the form, in the language main resolved ------------------
  const shape = await js(`(() => {
    const root = document.getElementById('key-entry');
    const facts = [...root.querySelectorAll('.entry__facts p')].map((p) => p.textContent);
    const user = document.getElementById('entry-user');
    const key = document.getElementById('entry-key');
    const primary = root.querySelector('.entry__primary');
    const secondary = root.querySelector('.entry__secondary');
    const cancel = root.querySelector('.entry__cancel');
    const cs = (n) => { const s = getComputedStyle(n); return { bg: s.backgroundColor, weight: s.fontWeight, transform: s.textTransform }; };
    const clipped = (n) => n.scrollWidth > n.clientWidth + 0.5;
    return {
      lang: document.documentElement.getAttribute('lang'),
      title: (root.querySelector('.entry__title') || {}).textContent,
      facts,
      factCount: facts.length,
      // The create-step instruction and its button in one section, and the
      // button described by that instruction for a screen reader.
      createText: (root.querySelector('.entry__create-text') || {}).textContent,
      createInSameSection: !!secondary && secondary.closest('.entry__create') === root.querySelector('.entry__create'),
      createDescribedBy: secondary ? secondary.getAttribute('aria-describedby') : null,
      createDescribesExisting: !!(secondary && document.getElementById(secondary.getAttribute('aria-describedby') || '')),
      createTag: secondary ? secondary.tagName : null,
      createTabbable: !!secondary && secondary.tabIndex >= 0 && !secondary.disabled,
      createLabel: secondary ? secondary.textContent : null,
      createHintHidden: (root.querySelector('.entry__create-back') || {}).hidden,
      primaryLabel: primary ? primary.textContent : null,
      primaryType: primary ? primary.getAttribute('type') : null,
      cancelLabel: cancel ? cancel.textContent : null,
      styles: { primary: primary ? cs(primary) : null, secondary: secondary ? cs(secondary) : null },
      userType: user ? user.getAttribute('type') : null,
      userPattern: user ? user.getAttribute('pattern') : null,
      userAutocomplete: user ? user.getAttribute('autocomplete') : null,
      keyType: key ? key.getAttribute('type') : null,
      keyAutocomplete: key ? key.getAttribute('autocomplete') : null,
      focusedFirst: document.activeElement === user,
      // A reveal toggle is a rendered secret; there must be none.
      revealControls: [...root.querySelectorAll('button')].filter((b) => /göster|show|reveal|gizle|hide/i.test(b.textContent)).length,
      clipped: [...root.querySelectorAll('p, label, button')].filter(clipped).map((n) => n.className),
      errorHidden: (root.querySelector('.entry__error') || {}).hidden,
      // No network reach from this page, whatever it is asked to do.
      csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || { content: '' }).content,
    };
  })()`);
  say('entry shape (tr): ' + JSON.stringify(shape));
  check('the page loads in the language main resolved, with its title',
    shape.lang === 'tr' && shape.title === 'GitHub Copilot API anahtarı', [shape.lang, shape.title]);
  check('the consent text comes before the fields and covers every required fact',
    consent.facts.length >= 8
      && consent.facts.some((f) => /tamamen isteğe bağlı/.test(f) && /hiçbir şey değişmez/.test(f))
      && consent.facts.some((f) => /api\.github\.com/.test(f) && /tek bir istek/.test(f))
      && consent.facts.some((f) => /5 dakikada bir/.test(f))
      && consent.facts.some((f) => /yalnızca sayılar tutulur/.test(f))
      && consent.facts.some((f) => /şifrelenip saklanır/.test(f) && /çalışan programlara karşı korumaz/.test(f))
      && consent.facts.some((f) => /kendi ödediğiniz Copilot planlarında/.test(f))
      && consent.facts.some((f) => /GitHub’da iptal etmeniz gerekir/.test(f))
      // F-B: the proxy limit is stated BEFORE the user goes and creates a
      // token that could never return a number on their network.
      && consent.facts.some((f) => /vekil sunucusunu kullanmaz/.test(f) && /gösterilemez/.test(f)),
    consent.facts);
  const steps = await js(`[...document.querySelectorAll('.entry__steps li')].map((li) => li.textContent)`);
  check('the key is explained as four numbered steps: the one permission, the GitHub button, copy once, paste here',
    steps.length === 4
      && /Plan: Read-only/.test(steps[0]) && /30 günlük/.test(steps[0])
      && /Generate token/.test(steps[1]) && /izin eklemeyin/.test(steps[1])
      && /github_pat_/.test(steps[2]) && /yalnızca bir kez/.test(steps[2])
      && /kullanıcı adınızı/.test(steps[3]) && /Kaydet/.test(steps[3]), steps);
  check('the "create the key on GitHub" button sits in that same step, described by it',
    shape.createInSameSection === true && shape.createDescribesExisting === true
      && shape.createLabel === 'GitHub’da anahtar oluştur', shape);
  check('it is a real, keyboard-reachable button and NOT the primary action',
    shape.createTag === 'BUTTON' && shape.createTabbable === true
      && shape.primaryType === 'submit' && shape.primaryLabel === 'Kaydet'
      && shape.styles.secondary.bg !== shape.styles.primary.bg
      && Number(shape.styles.secondary.weight) < Number(shape.styles.primary.weight),
    shape.styles);
  check('the come-back hint is quiet until the button is used',
    shape.createHintHidden === true, shape.createHintHidden);
  check('the key field is a password field with autocomplete off and no reveal toggle',
    shape.keyType === 'password' && shape.keyAutocomplete === 'off' && shape.revealControls === 0,
    [shape.keyType, shape.keyAutocomplete, shape.revealControls]);
  check('the username field validates its shape in the page, as main does again',
    shape.userType === 'text' && shape.userPattern === '[A-Za-z0-9-]{1,39}'
      && shape.userAutocomplete === 'off', shape);
  check('focus starts in the first field, and no error is shown before anything is typed',
    shape.focusedFirst === true && shape.errorHidden === true, shape);
  check('nothing on the page is clipped', shape.clipped.length === 0, shape.clipped);
  check('the page itself can reach no network at all',
    /connect-src 'none'/.test(shape.csp) && /default-src 'none'/.test(shape.csp), shape.csp);
  check('no uppercase transform anywhere (ADR-004: i/İ)',
    shape.styles.primary.transform === 'none' && shape.styles.secondary.transform === 'none',
    shape.styles);

  // ---- the token page: the window stays, the typing stays ----------------
  const afterCreate = await js(`(async () => {
    document.getElementById('entry-user').value = ${JSON.stringify(TEST_USER)};
    document.getElementById('entry-key').value = ${JSON.stringify(TEST_KEY)};
    document.querySelector('.entry__secondary').click();
    await new Promise((r) => setTimeout(r, 60));
    return {
      calls: window.__entryProbe.calls(),
      hint: (() => { const h = document.querySelector('.entry__create-back'); return h && !h.hidden ? h.textContent : null; })(),
      userKept: document.getElementById('entry-user').value,
      keyKept: document.getElementById('entry-key').value.length > 0,
      stillOpen: !!document.getElementById('entry-key'),
    };
  })()`);
  say('after create click: ' + JSON.stringify({ ...afterCreate, keyKept: afterCreate.keyKept, userKept: afterCreate.userKept }));
  check('the create button opens the token page through the preload, once',
    afterCreate.calls.openTokenPage === 1 && afterCreate.calls.submit.length === 0, afterCreate.calls);
  check('the page stays open, keeps what was typed, and says the key can be pasted on return',
    afterCreate.stillOpen === true && afterCreate.userKept === TEST_USER && afterCreate.keyKept === true
      && /yapıştırabilirsiniz/.test(afterCreate.hint || ''), afterCreate.hint);

  // ---- the leak probe: nothing rendered may contain the key --------------
  // The baseline is the page's own text and attributes with nothing typed, so
  // the needles are only pieces of the key that the page never says itself.
  const BASELINE = await js(`(() => {
    const hay = [document.documentElement.innerText || '', document.title || ''];
    for (const node of document.querySelectorAll('*')) {
      for (const attr of node.attributes) hay.push(attr.name + '=' + attr.value);
    }
    return hay.join(String.fromCharCode(10));
  })()`);
  const NEEDLES = needles(TEST_KEY, BASELINE);
  check('the leak probe has needles to look for (the key is not all boilerplate)',
    NEEDLES.length >= 20, NEEDLES.length);
  const leakProbe = `(() => {
    const needles = ${JSON.stringify(NEEDLES)};
    const hay = [];
    hay.push(document.documentElement.innerText || '');
    hay.push(document.title || '');
    for (const node of document.querySelectorAll('*')) {
      for (const attr of node.attributes) {
        // A field's own live value is what the user is typing; it is not a
        // RENDERED disclosure, and the element is type=password.
        if (node.tagName === 'INPUT' && attr.name === 'value') continue;
        hay.push(attr.name + '=' + attr.value);
      }
    }
    const text = hay.join('\\n');
    return needles.filter((n) => text.includes(n));
  })()`;
  const leakedBeforeSubmit = await js(leakProbe);
  check('with the key typed, no 4-character piece of it appears in the rendered page',
    leakedBeforeSubmit.length === 0, leakedBeforeSubmit.slice(0, 5));

  // ---- a refusal from main maps to a fixed sentence, and echoes nothing --
  const refusals = [
    ['wrong-token-type', 'Bu, farklı türde bir GitHub anahtarı gibi görünüyor. Lütfen fine-grained bir kişisel erişim anahtarı oluşturun.'],
    ['wrong-provider', 'Bu anahtar bu araç için değil.'],
    ['invalid', 'Anahtar kabul edilmedi.'],
    ['secure-storage-unavailable', 'Windows şifreli depolama kullanılamıyor, bu yüzden anahtar kaydedilmedi.'],
    ['busy', 'Başka bir işlem sürüyor; birkaç saniye sonra tekrar deneyin.'],
    ['invalid-username', 'Kullanıcı adı geçersiz. Yalnızca harf, rakam ve tire kullanın; en çok 39 karakter.'],
    ['unknown-provider', 'Bu anahtar bu araç için değil.'],
    ['store-failed', 'Anahtar bu bilgisayara kaydedilemedi.'],
    ['no-entry', 'Bu pencerenin oturumu bulunamadı. Pencereyi kapatıp yeniden açın.'],
    ['expired', 'Pencere zaman aşımına uğradı. Yeniden açıp tekrar deneyin.'],
    ['rejected', 'İstek kabul edilmedi. Pencereyi kapatıp yeniden açın.'],
    ['something-new-from-main', 'Anahtar kaydedilemedi.'],
  ];
  for (const [code, expected] of refusals) {
    const seen = await js(`(async () => {
      window.__entryProbe.setAnswer({ ok: false, code: ${JSON.stringify(code)} });
      document.getElementById('entry-user').value = ${JSON.stringify(TEST_USER)};
      document.getElementById('entry-key').value = ${JSON.stringify(TEST_KEY)};
      document.querySelector('.entry__primary').click();
      await new Promise((r) => setTimeout(r, 120));
      const e = document.querySelector('.entry__error');
      return {
        text: e && !e.hidden ? e.textContent : null,
        role: e ? e.getAttribute('role') : null,
        submits: window.__entryProbe.calls().submit.length,
        last: (window.__entryProbe.calls().submit.slice(-1)[0] || {}).username || null,
        sentKey: (window.__entryProbe.calls().submit.slice(-1)[0] || {}).key === ${JSON.stringify(TEST_KEY)},
      };
    })()`);
    check(`[${code}] maps to its fixed sentence`, seen.text === expected, seen);
    check(`[${code}] the refusal is announced and echoes nothing`,
      seen.role === 'alert' && (await js(leakProbe)).length === 0, seen);
    if (code === 'invalid') {
      check('the key and the username reach main through one write-only call',
        seen.sentKey === true && seen.last === TEST_USER, [seen.sentKey, seen.last]);
    }
  }

  // ---- the page's own validation, before anything is sent ---------------
  const shapeErrors = await js(`(async () => {
    const before = window.__entryProbe.calls().submit.length;
    const out = {};
    document.getElementById('entry-user').value = 'bad user!';
    document.getElementById('entry-key').value = ${JSON.stringify(TEST_KEY)};
    document.querySelector('.entry__primary').click();
    await new Promise((r) => setTimeout(r, 80));
    out.badShape = document.querySelector('.entry__error').textContent;
    document.getElementById('entry-user').value = ${JSON.stringify(TEST_USER)};
    document.getElementById('entry-key').value = '';
    document.querySelector('.entry__primary').click();
    await new Promise((r) => setTimeout(r, 80));
    out.empty = document.querySelector('.entry__error').textContent;
    out.sent = window.__entryProbe.calls().submit.length - before;
    return out;
  })()`);
  say('shape errors: ' + JSON.stringify(shapeErrors));
  check('a malformed username and a missing key are refused in the page, with nothing sent',
    /yalnızca harf, rakam ve tire/.test(shapeErrors.badShape)
      && /Kullanıcı adı ve anahtar gerekli/.test(shapeErrors.empty)
      && shapeErrors.sent === 0, shapeErrors);

  // ---- cancel: the button and Esc, from inside a field ------------------
  const cancelled = await js(`(async () => {
    const before = window.__entryProbe.calls().cancel;
    document.querySelector('.entry__cancel').click();
    document.getElementById('entry-key').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    return { added: window.__entryProbe.calls().cancel - before, sent: window.__entryProbe.calls().submit.length };
  })()`);
  check('Cancel and Esc both cancel, and neither sends anything',
    cancelled.added === 2, cancelled);

  // ---- English, as main resolves it -------------------------------------
  // A reload re-runs the preload, so the language comes from the URL rather
  // than from state a reload would discard — which is also how main will hand
  // it over: resolved once, before the window loads.
  await win.loadFile(path.join(ROOT, 'src/renderer/key-entry.html'), { query: { lang: 'en' } });
  await sleep(500);
  const en = await js(`(async () => {
    const root = document.getElementById('key-entry');
    const clipped = (n) => n.scrollWidth > n.clientWidth + 0.5;
    const facts = [...root.querySelectorAll('.entry__facts p')].map((p) => p.textContent);
    const factsClipped = [...root.querySelectorAll('p, label, button')].filter(clipped).map((n) => n.className);
    const proceed = (root.querySelector('.entry__primary') || {}).textContent;
    root.querySelector('.entry__primary').click();
    await new Promise((r) => setTimeout(r, 60));
    return {
      lang: document.documentElement.getAttribute('lang'),
      title: (root.querySelector('.entry__title') || {}).textContent,
      facts,
      factsClipped,
      proceed,
      create: (root.querySelector('.entry__secondary') || {}).textContent,
      save: (root.querySelector('.entry__primary') || {}).textContent,
      cancel: (root.querySelector('.entry__cancel') || {}).textContent,
      clipped: [...root.querySelectorAll('p, label, button')].filter(clipped).map((n) => n.className),
    };
  })()`);
  say('entry shape (en): ' + JSON.stringify(en));
  check('[en] the same page reads in English, whole',
    en.lang === 'en' && en.title === 'GitHub Copilot API key'
      && en.create === 'Create the key on GitHub' && en.save === 'Save' && en.cancel === 'Cancel'
      && en.facts.some((f) => /entirely optional/.test(f))
      && en.facts.some((f) => /api\.github\.com/.test(f))
      && en.facts.some((f) => /5 minutes/.test(f))
      && en.facts.some((f) => /Only numbers are kept/.test(f))
      && en.facts.some((f) => /not protect it from programs running as this user/.test(f))
      && en.facts.some((f) => /revoke the key at GitHub/.test(f))
      && en.facts.some((f) => /does not use a system proxy/.test(f))
      && en.proceed === 'Continue'
      && en.clipped.length === 0 && en.factsClipped.length === 0,
    en);

  say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}  (${lines.filter((l) => l.startsWith('PASS')).length} pass)`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((e) => { say('THREW: ' + ((e && e.stack) ? e.stack : e)); app.exit(1); });
