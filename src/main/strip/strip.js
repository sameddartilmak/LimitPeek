'use strict';
/*
 * The taskbar strip page (src/main/taskbar-strip.js opens it). It draws what
 * main sends and nothing else: the tiles arrive already decided — which tools,
 * which windows, the rounded figure, the ramp colour and the words — so this
 * file only checks the shapes and builds the DOM with textContent. A left
 * click asks main to open the panel; a right click asks for the tray menu.
 */
(function () {
  var api = window.usageNotchStrip;
  var root = document.getElementById('strip');
  var LOGOS = { claude: 1, codex: 1, antigravity: 1, kimi: 1, qwen: 1, grok: 1 };
  var HEX = /^#[0-9A-Fa-f]{6}$/;

  function text(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function row(r) {
    var pct = typeof r.percent === 'number' && isFinite(r.percent) ? Math.max(0, Math.min(100, r.percent)) : 0;
    var line = document.createElement('div');
    line.className = 'tile__row';
    var label = document.createElement('span');
    label.className = 'tile__label';
    label.textContent = text(r.label, 6);
    var bar = document.createElement('span');
    bar.className = 'tile__bar';
    var fill = document.createElement('span');
    fill.className = 'tile__fill';
    fill.style.display = 'block';
    fill.style.width = pct + '%';
    if (HEX.test(r.colour)) fill.style.background = r.colour;
    bar.appendChild(fill);
    line.appendChild(label);
    line.appendChild(bar);
    // The figure and the time left, already worded by main ("%22", "1sa 37dk").
    var figure = document.createElement('span');
    figure.className = 'tile__pct';
    figure.textContent = text(r.percentText, 8);
    var left = document.createElement('span');
    left.className = 'tile__left';
    left.textContent = text(r.left, 16);
    line.appendChild(figure);
    line.appendChild(left);
    return line;
  }

  function tile(t, width) {
    var el = document.createElement('div');
    el.className = 'tile';
    el.style.width = (width - 4) + 'px';
    el.title = text(t.title, 200);
    var logo = document.createElement('span');
    logo.className = 'tile__logo';
    if (LOGOS[t.id] === 1) logo.setAttribute('data-logo', t.id);
    var rows = document.createElement('div');
    rows.className = 'tile__rows';
    (Array.isArray(t.rows) ? t.rows.slice(0, 2) : []).forEach(function (r) {
      if (r && typeof r === 'object') rows.appendChild(row(r));
    });
    el.appendChild(logo);
    el.appendChild(rows);
    return el;
  }

  function draw(data) {
    if (!data || typeof data !== 'object') return;
    document.body.setAttribute('data-ground', data.ground === 'light' ? 'light' : 'dark');
    var width = typeof data.tileWidth === 'number' && data.tileWidth > 20 && data.tileWidth < 400 ? data.tileWidth : 180;
    var tiles = Array.isArray(data.tiles) ? data.tiles.slice(0, 8) : [];
    while (root.firstChild) root.removeChild(root.firstChild);
    tiles.forEach(function (t) {
      if (t && typeof t === 'object') root.appendChild(tile(t, width));
    });
  }

  if (!api) return;
  api.onData(draw);
  document.addEventListener('click', function (e) {
    if (e.button === 0) api.open();
  });
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    api.menu();
  });
})();
