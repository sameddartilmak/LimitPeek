/* Usage Notch landing page — the only script. No dependencies, no network, no
 * storage, no innerHTML (all text goes through textContent).
 *
 *   1. language   TR/EN before first paint, <html lang> kept in step
 *   2. motion     html.sdt when CSS scroll-driven animations exist; otherwise
 *                 html.sdt-js (a rAF-throttled scroll handler writes --p) and
 *                 html.js-io (IntersectionObserver entrances)
 *   3. nav        CTA slides in after the hero; active section gets a pill
 *   4. release    the RELEASE CONFIG block; renders nothing while empty
 *   5. demo       the interactive panel: tray, pin, close, theme, language,
 *                 reorder (drag + Alt+arrows), disclosures, settings view.
 *                 Everything it does exists in the app (src/renderer).
 *   6. moves      sticky "three moves": the marker crossing mid-viewport
 *                 sets the active step
 *   7. wheel      sticky picker wheel: same mechanism, five items
 *
 * Native scroll only: nothing here captures wheel/touch or snaps. */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* =========================================================== strings */
  var S = {
    tr: {
      title: 'Usage Notch — Yapay zekâ limitlerin, bir bakışta tepside',
      description: 'Usage Notch, Claude Code, Codex ve Antigravity’nin 5 saatlik ve haftalık limitlerini Windows tepsisindeki küçük bir panelde gösterir. Doğrulayamadığı yüzdeyi göstermez.',
      settings: 'Ayarlar', settingsClose: 'Ayarları kapat',
      pinOff: 'Paneli ekranda tut', pinOn: 'Paneli ekranda tutmayı bırak',
      close: 'Paneli kapat', refresh: 'Şimdi yenile', back: 'Ayarlardan çık, kullanım listesine dön',
      rows: 'Araçlar, tepsi sırasına göre', grip: '{name}: sırayı değiştir',
      refreshing: 'Yenileniyor', refreshText: 'Yenile',
      modeHover: 'imleç ayrılınca kapanır', modePinned: 'ekranda kalıyor', scan: 'Son tarama {time}',
      moved: '{name} {position}. sıraya taşındı, {total} araç içinde.', nowTray: 'Tepsi simgesi artık bu aracı gösteriyor.',
      atTop: '{name} zaten en üstte.', atBottom: '{name} zaten en altta.',
      five: '5 saatlik limit', week: 'Haftalık limit', unknown: 'bilinmiyor', notReported: 'bildirilmiyor',
      noProviders: 'Panelde sağlayıcı yok', pct: '%{n}',
      whereOn: 'Ana panelde', whereOff: 'Ana panelde değil', connected: 'bağlı',
      notSupported: '{name} bu sürümde henüz desteklenmiyor', experimental: 'deneysel',
      sections: 'Bölümler', steps: 'Adımlar'
    },
    en: {
      title: 'Usage Notch — Your AI usage limits, at a glance in the tray',
      description: 'Usage Notch shows the 5-hour and weekly limits of Claude Code, Codex and Antigravity in one small panel in the Windows tray. It never shows a percentage it cannot verify.',
      settings: 'Settings', settingsClose: 'Close settings',
      pinOff: 'Keep the panel on screen', pinOn: 'Stop keeping the panel on screen',
      close: 'Close the panel', refresh: 'Refresh now', back: 'Leave settings and return to the usage list',
      rows: 'Tools, in tray order', grip: '{name}: change order',
      refreshing: 'Refreshing', refreshText: 'Refresh',
      modeHover: 'closes when the pointer leaves', modePinned: 'stays on screen', scan: 'Last scan {time}',
      moved: '{name} moved to position {position} of {total}.', nowTray: 'The tray icon now shows this tool.',
      atTop: '{name} is already at the top.', atBottom: '{name} is already at the bottom.',
      five: '5-hour limit', week: 'Weekly limit', unknown: 'unknown', notReported: 'not reported',
      noProviders: 'No providers in the panel', pct: '{n}%',
      whereOn: 'On the main panel', whereOff: 'Not on the main panel', connected: 'connected',
      notSupported: '{name} is not supported in this version yet', experimental: 'experimental',
      sections: 'Sections', steps: 'Steps'
    }
  };
  var lang = 'tr';
  function t(key, params) {
    var s = (S[lang] && S[lang][key]) || S.tr[key] || key;
    if (params) for (var k in params) s = s.split('{' + k + '}').join(String(params[k]));
    return s;
  }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }

  /* ========================================================= language */
  var langListeners = [];
  function browserLanguage() {
    return String(navigator.language || '').toLowerCase().indexOf('tr') === 0 ? 'tr' : 'en';
  }
  function applyLanguage(next) {
    if (next !== 'tr' && next !== 'en') return;
    lang = next;
    root.setAttribute('lang', next);
    root.setAttribute('data-lang', next);
    document.title = t('title');
    var desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', t('description'));
    var radio = document.getElementById('lang-' + next);
    if (radio && !radio.checked) radio.checked = true;
    for (var i = 0; i < langListeners.length; i++) langListeners[i]();
  }
  applyLanguage(browserLanguage());

  /* =========================================================== motion */
  // ?nosdt forces the JS fallback path, for testing it in a browser that
  // supports scroll-driven animations.
  var forceFallback = /[?&]nosdt\b/.test(location.search);
  var scrollDriven = !forceFallback && !!(window.CSS && CSS.supports && CSS.supports('animation-timeline: view()'));
  if (!reduce) {
    if (scrollDriven) root.classList.add('sdt');
    else {
      root.classList.add('sdt-js');
      if ('IntersectionObserver' in window) root.classList.add('js-io');
    }
  }

  function onReady() {
    applyLanguage(root.getAttribute('data-lang'));
    each(document.querySelectorAll('input[name="lang"]'), function (r) {
      r.addEventListener('change', function (e) { if (e.target.checked) applyLanguage(e.target.value); });
    });
    langListeners.push(function () {
      each(document.querySelectorAll('[data-i18n-aria="sections"], [data-i18n-aria="steps"]'), function (el) {
        el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
      });
    });
    if (root.classList.contains('js-io')) observeOnce(document.querySelectorAll('.rise'));
    renderRelease();
    setupNav();
    var demoEl = document.getElementById('demo');
    if (demoEl) setupDemo(demoEl);
    setupMoves();
    setupWheel();
    if (root.classList.contains('sdt-js')) setupProgress();
    applyLanguage(lang);
  }

  function observeOnce(nodes) {
    try {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
      for (var i = 0; i < nodes.length; i++) io.observe(nodes[i]);
    } catch (err) {
      root.classList.remove('js-io'); // never leave content hidden
    }
  }

  /* A zero-height line across the middle of the viewport: the marker it
   * crosses wins. IntersectionObserver, so no scroll handler at all. */
  function midline(nodes, onHit) {
    if (!('IntersectionObserver' in window) || !nodes.length) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) onHit(en.target); });
    }, { rootMargin: '-50% 0px -50% 0px', threshold: 0 });
    each(nodes, function (n) { io.observe(n); });
  }

  /* ============================================================== nav */
  function setupNav() {
    var top = document.getElementById('topbar');
    var cta = document.getElementById('nav-cta');
    var heroCta = document.getElementById('hero-cta');
    if (!top || !cta) return;
    function measure() { top.style.setProperty('--cta-w', cta.offsetWidth + 'px'); }
    measure();
    langListeners.push(measure);
    window.addEventListener('resize', measure);
    if (!('IntersectionObserver' in window)) { top.classList.add('is-past'); return; }
    if (heroCta) {
      new IntersectionObserver(function (entries) {
        var en = entries[entries.length - 1];
        top.classList.toggle('is-past', !en.isIntersecting && en.boundingClientRect.top < 0);
      }, { threshold: 0 }).observe(heroCta);
    }
    var links = document.querySelectorAll('[data-sec]');
    var sections = ['how', 'details', 'tools', 'install', 'faq'].map(function (id) { return document.getElementById(id); }).filter(Boolean);
    var on = {};
    function paint() {
      var current = null;
      sections.forEach(function (s) { if (on[s.id]) current = s.id; });
      each(links, function (a) {
        var hit = a.getAttribute('data-sec') === current;
        a.classList.toggle('is-active', hit);
        if (hit) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
      });
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { on[en.target.id] = en.isIntersecting; });
      paint();
    }, { rootMargin: '-45% 0px -54% 0px', threshold: 0 });
    sections.forEach(function (s) { io.observe(s); });
  }

  /* ====================================================== release meta */
  var LABELS = { version: ['Sürüm', 'Version'], fileName: ['Dosya adı', 'File name'], size: ['Boyut', 'Size'], sha256: ['SHA-256', 'SHA-256'], verify: ['Doğrulama', 'Verify'] };
  function bilingual(pair) {
    var f = document.createDocumentFragment();
    [['tr', 0], ['en', 1]].forEach(function (p) {
      var s = document.createElement('span'); s.className = 'l-' + p[0]; s.lang = p[0]; s.textContent = pair[p[1]]; f.appendChild(s);
    });
    return f;
  }
  function addRow(list, key, value, asCode) {
    var dt = document.createElement('dt'); dt.appendChild(bilingual(LABELS[key]));
    var dd = document.createElement('dd');
    if (asCode) { var c = document.createElement('code'); c.textContent = value; dd.appendChild(c); } else { dd.textContent = value; }
    list.appendChild(dt); list.appendChild(dd);
  }
  function clean(v) { return typeof v === 'string' ? v.trim() : ''; }
  function renderRelease() {
    var block = document.getElementById('release-config');
    var list = document.getElementById('release-meta');
    if (!block || !list) return;
    var cfg; try { cfg = JSON.parse(block.textContent); } catch (err) { return; }
    if (!cfg || typeof cfg !== 'object') return;
    var version = clean(cfg.version), fileName = clean(cfg.fileName), size = clean(cfg.size);
    var sha = clean(cfg.sha256).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) sha = ''; // a malformed hash is not shown
    if (version) addRow(list, 'version', version, false);
    if (fileName) addRow(list, 'fileName', fileName, true);
    if (size) addRow(list, 'size', size, false);
    if (sha) addRow(list, 'sha256', sha, true);
    if (sha && fileName) {
      // PowerShell single-quoted literal: the only escape is '' for a quote.
      addRow(list, 'verify', "Get-FileHash -LiteralPath '" + fileName.replace(/'/g, "''") + "' -Algorithm SHA256", true);
    }
    if (list.childNodes.length > 0) list.hidden = false;
  }

  /* ============================================================ theme */
  var lightMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function systemTheme() { return lightMq && lightMq.matches ? 'light' : 'dark'; }
  function onSystemTheme(fn) {
    if (!lightMq) return;
    if (lightMq.addEventListener) lightMq.addEventListener('change', fn); else if (lightMq.addListener) lightMq.addListener(fn);
  }

  /* ============================================================= demo */
  function setupDemo(demo) {
    var $ = function (id) { return document.getElementById(id); };
    var tray = $('demo-tray'), anchor = $('demo-anchor'), panel = $('demo-panel');
    var pinBtn = $('demo-pin'), closeBtn = $('demo-close'), settingsBtn = $('demo-settings-btn'), backBtn = $('demo-back');
    var listView = $('demo-list'), settingsView = $('demo-settings'), rowsEl = $('demo-rows');
    var live = $('demo-live'), tip = $('demo-tip'), sweep = $('demo-sweep');
    var track = demo.querySelector('.donut__track');
    var refreshBtn = $('demo-refresh');
    var state = { open: true, pinned: false, theme: 'dark' };
    var leaveTimer = 0, tipTimer = 0, refreshTimer = 0;
    var CIRC = 53.41; // 2 * PI * 8.5, the donut radius

    function announce(msg) {
      live.textContent = '';
      window.setTimeout(function () { live.textContent = msg; }, 30);
    }

    /* ---- open / close / pin ------------------------------------------ */
    function setOpen(open) {
      state.open = open;
      demo.setAttribute('data-open', open ? 'true' : 'false');
      tray.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) anchor.removeAttribute('inert'); else anchor.setAttribute('inert', '');
      window.clearTimeout(leaveTimer);
      if (!open && panel.contains(document.activeElement)) tray.focus();
    }
    panel.setAttribute('tabindex', '-1');
    tray.addEventListener('click', function () { hideTip(); setOpen(!state.open); });
    closeBtn.addEventListener('click', function () { setOpen(false); });
    pinBtn.addEventListener('click', function () {
      state.pinned = !state.pinned;
      demo.setAttribute('data-pinned', state.pinned ? 'true' : 'false');
      pinBtn.setAttribute('aria-pressed', state.pinned ? 'true' : 'false');
      window.clearTimeout(leaveTimer);
      relabel();
    });
    // The app's close rule: an unpinned panel that the pointer entered closes
    // shortly after the pointer leaves it. Mouse only; touch has no "leave".
    panel.addEventListener('pointerenter', function () { window.clearTimeout(leaveTimer); });
    panel.addEventListener('pointerleave', function (e) {
      if (e.pointerType !== 'mouse' || state.pinned || !state.open || dragging) return;
      leaveTimer = window.setTimeout(function () { setOpen(false); }, 700);
    });
    tray.addEventListener('pointerenter', function () { window.clearTimeout(leaveTimer); });
    demo.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (demo.getAttribute('data-view') === 'settings') { showView('list'); settingsBtn.focus(); e.preventDefault(); return; }
      if (state.open && anchor.contains(document.activeElement)) { setOpen(false); tray.focus(); e.preventDefault(); return; }
      hideTip();
    });

    /* ---- tooltip (hover/focus only, like the native tray tooltip) ------ */
    function showTip() { window.clearTimeout(tipTimer); tipTimer = window.setTimeout(function () { demo.setAttribute('data-tip', 'true'); }, 350); }
    function hideTip() { window.clearTimeout(tipTimer); demo.removeAttribute('data-tip'); }
    tray.addEventListener('pointerenter', showTip);
    tray.addEventListener('pointerleave', hideTip);
    tray.addEventListener('focus', showTip);
    tray.addEventListener('blur', hideTip);

    /* ---- views -------------------------------------------------------- */
    function showView(view) {
      demo.setAttribute('data-view', view);
      listView.hidden = view !== 'list';
      settingsView.hidden = view !== 'settings';
      settingsBtn.setAttribute('aria-expanded', view === 'settings' ? 'true' : 'false');
      relabel();
    }
    settingsBtn.addEventListener('click', function () {
      var toSettings = demo.getAttribute('data-view') !== 'settings';
      showView(toSettings ? 'settings' : 'list');
      (toSettings ? backBtn : settingsBtn).focus();
    });
    backBtn.addEventListener('click', function () { showView('list'); settingsBtn.focus(); });
    $('demo-empty-open').addEventListener('click', function () { showView('settings'); backBtn.focus(); });

    /* ---- disclosures (cost, per-period models) ------------------------- */
    demo.addEventListener('click', function (e) {
      var btn = e.target.closest('.cost__toggle, .usage__toggle');
      if (!btn || !demo.contains(btn)) return;
      var target = document.getElementById(btn.getAttribute('aria-controls'));
      var open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (target) target.hidden = !open;
      if (btn.classList.contains('cost__toggle')) btn.parentNode.setAttribute('data-expanded', open ? 'true' : 'false');
    });

    /* ---- accordion: at most one section open --------------------------- */
    var triggers = settingsView.querySelectorAll('.acc__trigger');
    each(triggers, function (trig) {
      trig.addEventListener('click', function () {
        var opening = trig.getAttribute('aria-expanded') !== 'true';
        each(triggers, function (other) {
          var isOn = other === trig && opening;
          other.setAttribute('aria-expanded', isOn ? 'true' : 'false');
          document.getElementById(other.getAttribute('aria-controls')).hidden = !isOn;
        });
      });
    });

    /* ---- grain, theme, language radios -------------------------------- */
    settingsView.addEventListener('change', function (e) {
      var el = e.target;
      if (el.name === 'demo-grain') {
        each(settingsView.querySelectorAll('.usage'), function (ul) { ul.hidden = ul.getAttribute('data-grain') !== el.value; });
      } else if (el.name === 'demo-theme') {
        state.theme = el.value; paintTheme();
      } else if (el.name === 'demo-lang') {
        applyLanguage(el.value === 'system' ? browserLanguage() : el.value);
        document.getElementById('demo-lang-' + el.value).checked = true;
      }
    });
    function paintTheme() { demo.setAttribute('data-theme', state.theme === 'system' ? systemTheme() : state.theme); }
    onSystemTheme(paintTheme);
    paintTheme();
    // The page's own TR/EN switch is an explicit choice, so the demo shows it.
    each(document.querySelectorAll('input[name="lang"]'), function (r) {
      r.addEventListener('change', function () { var d = document.getElementById('demo-lang-' + r.value); if (d) d.checked = true; });
    });

    /* ---- model management switches ------------------------------------ */
    var items = settingsView.querySelectorAll('.settings__item');
    function rowFor(id) { return rowsEl.querySelector('.row[data-id="' + id + '"]'); }
    each(items, function (item) {
      item.querySelector('.switch').addEventListener('click', function () {
        var sw = item.querySelector('.switch');
        var isOn = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', isOn ? 'true' : 'false');
        rowFor(item.getAttribute('data-for')).hidden = !isOn;
        paintSettings(); paintTray();
      });
    });
    function paintSettings() {
      each(items, function (item) {
        var isOn = item.querySelector('.switch').getAttribute('aria-checked') === 'true';
        var name = item.querySelector('.settings__name').textContent;
        item.setAttribute('data-enabled', isOn ? 'true' : 'false');
        var conn = item.getAttribute('data-connected');
        var how = conn === 'true' ? t('connected')
          : conn === 'experimental' ? t('experimental')
          : t('notSupported', { name: name });
        item.querySelector('.settings__meta').textContent = (isOn ? t('whereOn') : t('whereOff')) + ' · ' + how;
      });
      var any = visibleRows().length > 0;
      $('demo-empty').hidden = any;
      rowsEl.hidden = !any;
    }

    /* ---- reorder ------------------------------------------------------ */
    function visibleRows() { return Array.prototype.filter.call(rowsEl.children, function (r) { return !r.hidden; }); }
    // FLIP: measure, move in the DOM, then animate each row from its old
    // position with a transform. Instant under reduced motion.
    function moveRow(row, toIndex) {
      var rows = visibleRows();
      var before = new Map(rows.map(function (r) { return [r, r.getBoundingClientRect().top]; }));
      var others = rows.filter(function (r) { return r !== row; });
      var ref = others[toIndex] || null;
      if (ref) rowsEl.insertBefore(row, ref); else rowsEl.appendChild(row);
      if (!reduce) {
        rows.forEach(function (r) {
          if (r.classList.contains('is-dragging')) return;
          var dy = before.get(r) - r.getBoundingClientRect().top;
          if (!dy) return;
          r.style.transition = 'none';
          r.style.transform = 'translateY(' + dy + 'px)';
          r.getBoundingClientRect(); // commit the start frame
          r.style.transition = '';
          r.style.transform = '';
        });
      }
      paintTray();
    }
    function announceMove(row, wasTop) {
      var rows = visibleRows();
      var pos = rows.indexOf(row) + 1;
      var msg = t('moved', { name: row.getAttribute('data-name'), position: pos, total: rows.length });
      if (pos === 1 && !wasTop) msg += ' ' + t('nowTray');
      announce(msg);
    }
    rowsEl.addEventListener('keydown', function (e) {
      var grip = e.target.closest('.grip');
      if (!grip || !e.altKey || e.ctrlKey || e.metaKey) return;
      var row = grip.closest('.row');
      var rows = visibleRows();
      var from = rows.indexOf(row), to;
      if (e.key === 'ArrowUp') to = from - 1;
      else if (e.key === 'ArrowDown') to = from + 1;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = rows.length - 1;
      else return;
      e.preventDefault();
      if (to < 0) { announce(t('atTop', { name: row.getAttribute('data-name') })); return; }
      if (to >= rows.length) { announce(t('atBottom', { name: row.getAttribute('data-name') })); return; }
      if (to === from) return;
      var wasTop = from === 0;
      moveRow(row, to);
      grip.focus();
      announceMove(row, wasTop);
    });
    var dragging = null;
    rowsEl.addEventListener('pointerdown', function (e) {
      var grip = e.target.closest('.grip:not(.grip--static)');
      if (!grip || e.button !== 0) return;
      var row = grip.closest('.row');
      dragging = { row: row, id: e.pointerId, wasTop: visibleRows()[0] === row, moved: false };
      grip.setPointerCapture(e.pointerId);
      row.classList.add('is-dragging');
      e.preventDefault();
    });
    rowsEl.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerId !== dragging.id) return;
      var others = visibleRows().filter(function (r) { return r !== dragging.row; });
      var index = others.length;
      for (var i = 0; i < others.length; i++) {
        var r = others[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { index = i; break; }
      }
      if (visibleRows().indexOf(dragging.row) !== index) { moveRow(dragging.row, index); dragging.moved = true; }
    });
    function endDrag(e) {
      if (!dragging || e.pointerId !== dragging.id) return;
      var d = dragging; dragging = null;
      d.row.classList.remove('is-dragging');
      if (d.moved) announceMove(d.row, d.wasTop);
    }
    rowsEl.addEventListener('pointerup', endDrag);
    rowsEl.addEventListener('pointercancel', endDrag);

    /* ---- tray icon + tooltip follow the first row ---------------------- */
    function pct(n) { return t('pct', { n: n }); }
    function paintTray() {
      var rows = visibleRows();
      var lead = rows[0] || null;
      each(rowsEl.querySelectorAll('.grip'), function (g) { g.removeAttribute('data-tray'); });
      var lines = [];
      if (!lead) {
        lines = ['Usage Notch', t('noProviders')];
        demo.removeAttribute('data-dot');
        setRing(null, 'none');
      } else {
        var grip = lead.querySelector('.grip'); if (grip) grip.setAttribute('data-tray', 'true');
        var isLive = lead.getAttribute('data-live') === 'true';
        var p5 = lead.getAttribute('data-p5'), p7 = lead.getAttribute('data-p7');
        demo.setAttribute('data-dot', isLive ? lead.getAttribute('data-id') : '');
        // The tray draws the 5-hour figure, or the weekly one when there is
        // no 5-hour figure (src/core/tray-spec.js).
        if (isLive && p5) setRing(+p5, lead.getAttribute('data-s5'));
        else if (isLive && p7) setRing(+p7, lead.getAttribute('data-s7'));
        else setRing(null, 'none');
        lines.push('Usage Notch — ' + lead.getAttribute('data-name'));
        lines.push(t('five') + ': ' + (isLive && p5 ? pct(p5) + ' (' + lead.getAttribute('data-r5-' + lang) + ')' : t('unknown')));
        var weekText = isLive && p7 ? pct(p7) + ' (' + lead.getAttribute('data-r7-' + lang) + ')'
          : (isLive ? t('notReported') : t('unknown'));
        lines.push(t('week') + ': ' + weekText);
      }
      while (tip.firstChild) tip.removeChild(tip.firstChild);
      lines.forEach(function (line) { var s = document.createElement('span'); s.textContent = line; tip.appendChild(s); });
    }
    function setRing(value, st) {
      sweep.setAttribute('data-state', st);
      if (value === null) {
        // The no-data ring: four 14-degree gaps (src/core/donut.js).
        sweep.setAttribute('stroke-dasharray', '0 ' + CIRC);
        track.setAttribute('stroke-dasharray', '11.27 2.08');
        track.setAttribute('transform', 'rotate(-83 12 12)');
      } else {
        sweep.setAttribute('stroke-dasharray', (CIRC * value / 100).toFixed(2) + ' ' + CIRC);
        track.removeAttribute('stroke-dasharray');
        track.removeAttribute('transform');
      }
    }

    /* ---- footer: refresh + last scan, taskbar clock ------------------- */
    var scanAt = new Date();
    function fmtTime(d) { return new Intl.DateTimeFormat(lang === 'tr' ? 'tr-TR' : 'en-US', { hour: 'numeric', minute: '2-digit' }).format(d); }
    function paintScan() {
      var scan = $('demo-scan');
      while (scan.firstChild) scan.removeChild(scan.firstChild);
      scan.textContent = t('scan', { time: fmtTime(scanAt) });
      var clock = $('demo-clock');
      if (clock) clock.textContent = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date());
    }
    refreshBtn.addEventListener('click', function () {
      if (refreshBtn.getAttribute('aria-busy') === 'true') return;
      refreshBtn.setAttribute('aria-busy', 'true');
      setBtnText(refreshBtn, t('refreshing'));
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(function () {
        scanAt = new Date();
        refreshBtn.removeAttribute('aria-busy');
        setBtnText(refreshBtn, t('refreshText'));
        paintScan();
      }, 800);
    });
    function setBtnText(btn, text) { while (btn.firstChild) btn.removeChild(btn.firstChild); btn.textContent = text; }

    /* ---- labels that live in attributes -------------------------------- */
    function relabel() {
      each(demo.querySelectorAll('[data-i18n-aria]'), function (el) {
        el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
      });
      pinBtn.setAttribute('aria-label', state.pinned ? t('pinOn') : t('pinOff'));
      settingsBtn.setAttribute('aria-label', demo.getAttribute('data-view') === 'settings' ? t('settingsClose') : t('settings'));
      each(demo.querySelectorAll('[data-i18n-grip]'), function (g) {
        g.setAttribute('aria-label', t('grip', { name: g.closest('.row').getAttribute('data-name') }));
      });
      var mode = $('demo-mode');
      while (mode.firstChild) mode.removeChild(mode.firstChild);
      mode.textContent = state.pinned ? t('modePinned') : t('modeHover');
      if (refreshBtn.getAttribute('aria-busy') !== 'true') setBtnText(refreshBtn, t('refreshText'));
      paintSettings(); paintTray(); paintScan();
    }
    langListeners.push(relabel);
    relabel();
    setOpen(true);
  }

  /* ============================================================ moves */
  function setupMoves() {
    var stack = document.getElementById('stack');
    if (!stack) return;
    var links = document.querySelectorAll('.steps__a');
    function setStep(n) {
      if (stack.getAttribute('data-step') === n) return;
      stack.setAttribute('data-step', n);
      each(links, function (a) {
        if (a.getAttribute('data-step') === n) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current');
      });
    }
    midline(document.querySelectorAll('.smark[data-step]'), function (m) { setStep(m.getAttribute('data-step')); });
  }

  /* ============================================================ wheel */
  // A picker wheel. One number drives it: t, the continuous index (0..4) of
  // the item on the centre line. With CSS scroll-driven animations the CSS
  // animates --t itself; otherwise this writes --t. Either way the same
  // formula picks the active item (the one nearest the centre), so the
  // illustration and description follow the moving list.
  var WHEEL_REST = 0.06; // first/last items rest at centre for 6% of the range
  var WHEEL_HOLD = 0.08; // hysteresis band, in items, around each midpoint
  function wheelT(p, n) {
    var q = Math.max(0, Math.min(1, (p - WHEEL_REST) / (1 - 2 * WHEEL_REST)));
    return q * (n - 1);
  }
  function setupWheel() {
    var section = document.getElementById('details');
    var list = document.getElementById('wheel');
    var desc = document.getElementById('wheel-desc');
    if (!section || !list || !desc) return;
    var items = list.querySelectorAll('.wheel__item');
    var n = items.length;
    var arts = document.querySelectorAll('.art[data-i]');
    // The visible description is a clone of the (visually hidden) line inside
    // each item; screen readers read the originals, in order.
    each(items, function (li) {
      var line = li.querySelector('.wheel__line');
      if (!line) return;
      var p = line.cloneNode(true);
      p.className = '';
      p.setAttribute('data-i', li.getAttribute('data-i'));
      desc.appendChild(p);
    });
    var lines = desc.querySelectorAll('p');
    var active = 0;
    function setActive(a) {
      if (a === active) return;
      active = a;
      list.setAttribute('data-active', String(a));
      each(items, function (li) {
        var on = +li.getAttribute('data-i') === a;
        li.classList.toggle('is-active', on);
        var link = li.querySelector('.wheel__link');
        if (on) link.setAttribute('aria-current', 'true'); else link.removeAttribute('aria-current');
      });
      each(lines, function (p) { p.classList.toggle('is-on', +p.getAttribute('data-i') === a); });
      each(arts, function (el) { el.classList.toggle('is-on', +el.getAttribute('data-i') === a); });
    }

    // Geometry is measured on load and resize only; the scroll handler reads
    // scrollY and writes, never measures.
    var geo = { top: 0, span: 1 };
    var writeT = !root.classList.contains('sdt') && !reduce;
    var ticking = false;
    function measure() {
      geo.top = section.getBoundingClientRect().top + window.scrollY;
      geo.span = Math.max(1, section.offsetHeight - window.innerHeight);
      update();
    }
    function update() {
      ticking = false;
      var p = (window.scrollY - geo.top) / geo.span;
      var t = wheelT(p, n);
      if (writeT) section.style.setProperty('--t', t.toFixed(4));
      // Hysteresis: keep the current item until t is clearly past the
      // midpoint to a neighbour, so resting between two items never flickers.
      var cur = active - 1;
      if (active === 0 || t > cur + 0.5 + WHEEL_HOLD || t < cur - 0.5 - WHEEL_HOLD) setActive(Math.round(t) + 1);
    }
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }, { passive: true });
    window.addEventListener('resize', measure);
    if ('ResizeObserver' in window) new ResizeObserver(measure).observe(document.body);

    // An item link scrolls the page so that item sits on the centre line.
    each(items, function (li) {
      li.querySelector('.wheel__link').addEventListener('click', function (e) {
        e.preventDefault();
        var i = +li.getAttribute('data-i') - 1;
        var y = geo.top + geo.span * (WHEEL_REST + (1 - 2 * WHEEL_REST) * i / (n - 1));
        window.scrollTo({ top: Math.round(y), behavior: reduce ? 'auto' : 'smooth' });
      });
    });
    measure();
  }

  /* ======================================= scroll progress (fallback) */
  // Only when CSS scroll-driven animations are missing. Geometry is cached
  // outside the scroll handler; the handler reads scrollY, and one rAF writes
  // --p. No layout reads while scrolling.
  function setupProgress() {
    var stages = [document.getElementById('how')].filter(Boolean);
    var geo = [];
    var ticking = false;
    function cache() {
      var y = window.scrollY, vh = window.innerHeight;
      geo = stages.map(function (el) {
        var top = el.getBoundingClientRect().top + y;
        return { el: el, top: top, span: Math.max(1, el.offsetHeight - vh) };
      });
      update();
    }
    function update() {
      ticking = false;
      var y = window.scrollY;
      geo.forEach(function (g) {
        var p = Math.max(0, Math.min(1, (y - g.top) / g.span));
        g.el.style.setProperty('--p', p.toFixed(4));
      });
    }
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }, { passive: true });
    window.addEventListener('resize', cache);
    if ('ResizeObserver' in window) new ResizeObserver(cache).observe(document.body);
    cache();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
})();
