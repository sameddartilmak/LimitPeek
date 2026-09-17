'use strict';
/* Placeholder renderer. Exercises the preload surface end to end so the main
   process can be verified without the real panel. textContent only, never
   innerHTML, per ADR-001 security F8.

   LANGUAGE-NEUTRAL (ADR-004). This page is the dev fallback when the real
   renderer build is missing, it runs sandboxed with connect-src none, and it
   cannot load the catalogs. So it carries no words of its own: the setup
   label and detail arrive already translated in the snapshot, numbers and
   clocks follow the format locale main resolved, and every other slot is a
   symbol or the neutral vocabulary the bridges use (5h, /h). */
(function () {
  var rows = document.getElementById('rows');
  var stamp = document.getElementById('stamp');
  var prefs = null;
  try { prefs = window.usageNotch && window.usageNotch.initialPreferences(); } catch (e) { prefs = null; }
  var locale = (prefs && prefs.formatLocale) || undefined;
  if (prefs && prefs.resolvedLanguage) document.documentElement.lang = prefs.resolvedLanguage;

  function fmt(n) {
    if (typeof n !== 'number') return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  function render(snapshot) {
    rows.textContent = '';
    (snapshot.providers || []).forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'row';

      var spine = document.createElement('div');
      spine.className = 'spine';
      spine.style.background = p.accent;
      row.appendChild(spine);

      var mid = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.displayName;
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = p.tokens
        ? fmt(p.tokens.billable) + ' · ' + (p.burnRatePerHour === null ? '—' : fmt(p.burnRatePerHour) + '/h')
        : (p.setupAction ? p.setupAction.detail : p.status);
      mid.appendChild(name);
      mid.appendChild(meta);
      row.appendChild(mid);

      var right = document.createElement('div');
      right.className = 'right';
      var five = p.fiveHour;
      if (five && five.certainty === 'known' && five.usedPercentage !== null) {
        var pct = document.createElement('div');
        pct.className = 'pct';
        pct.textContent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(Math.round(five.usedPercentage) / 100);
        right.appendChild(pct);
        var rs = document.createElement('div');
        rs.className = 'meta';
        rs.textContent = five.resetsAt ? new Date(five.resetsAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) : '';
        right.appendChild(rs);
      } else {
        var unk = document.createElement('div');
        unk.className = 'unk';
        unk.textContent = p.setupAction ? p.setupAction.label : '—';
        right.appendChild(unk);
      }
      row.appendChild(right);
      rows.appendChild(row);
    });
    stamp.textContent = '↻ ' + new Date(snapshot.generatedAt).toLocaleTimeString(locale);
  }

  if (window.usageNotch) {
    window.usageNotch.onSnapshot(render);
    window.usageNotch.requestRefresh().then(render).catch(function () {});
    document.addEventListener('pointerenter', function () { window.usageNotch.panelOpened(); });
    document.body.addEventListener('mouseenter', function () { window.usageNotch.panelOpened(); });
    document.body.addEventListener('mouseleave', function () { window.usageNotch.close(); });
  }
}());
