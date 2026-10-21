'use strict';
/*
 * The taskbar strip page (src/main/taskbar-strip.js opens it). It draws what
 * main sends and nothing else: the tiles arrive already decided — which tools,
 * which windows, the rounded figure, the ramp colour and the words — so this
 * file only checks the shapes and builds the DOM with textContent. A left
 * click asks main to open the panel; a right click asks for the tray menu.
 *
 * One page, three LAYERS (data.layer, taskbar-strip.js):
 *   'full'     the visible top-level window draws and takes the mouse — the
 *              fallback when the display layer is not up;
 *   'input'    the same window, its tiles laid out but invisible: it takes the
 *              clicks, shows the native tooltip and reports the hovered tile;
 *   'display'  rendered offscreen and shown inside the taskbar
 *              (taskbar-display.js), at `data.scale`, with the hovered tile lit.
 *
 * Two looks (data.style, Görünüm → Şerit stili):
 *   'plain' per row: label, a mini bar, the figure, the time left (default);
 *   'rings' two small concentric rings after the logo — five-hour outside,
 *           weekly inside, the bar's ramp colour and track — and per row the
 *           figure and the time left, in the same order (outer ring first).
 *           SVG, so the rings stay crisp at the taskbar's zoom.
 */
(function () {
  var api = window.usageNotchStrip;
  var root = document.getElementById('strip');
  var LOGOS = { claude: 1, codex: 1, antigravity: 1, kimi: 1, qwen: 1, grok: 1 };
  var HEX = /^#[0-9A-Fa-f]{6}$/;
  var SVG = 'http://www.w3.org/2000/svg';
  /**
   * The rings' geometry in CSS px (the page is zoomed to the taskbar scale):
   * a 28px box, 4px strokes, the inner ring 1.5px clear of the outer one.
   * pathLength 100 lets the sweep be the rounded figure itself.
   */
  var RING_BOX = 28;
  var RINGS = { fiveHour: 12, sevenDay: 6.5 };
  var RING_W = 4;

  function text(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function pctOf(r) {
    return typeof r.percent === 'number' && isFinite(r.percent) ? Math.max(0, Math.min(100, r.percent)) : 0;
  }

  function circle(radius, cls) {
    var c = document.createElementNS(SVG, 'circle');
    var mid = String(RING_BOX / 2);
    c.setAttribute('class', cls);
    c.setAttribute('cx', mid);
    c.setAttribute('cy', mid);
    c.setAttribute('r', String(radius));
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke-width', String(RING_W));
    return c;
  }

  /** One ring per row the tile has: its track, and the sweep from twelve o'clock. */
  function rings(rows) {
    var box = document.createElementNS(SVG, 'svg');
    box.setAttribute('class', 'tile__rings');
    box.setAttribute('viewBox', '0 0 ' + RING_BOX + ' ' + RING_BOX);
    box.setAttribute('aria-hidden', 'true');
    rows.forEach(function (r) {
      var radius = RINGS[r.kind];
      if (!radius) return;
      box.appendChild(circle(radius, 'tile__track'));
      var pct = pctOf(r);
      if (pct <= 0) return;
      var sweep = circle(radius, 'tile__sweep');
      sweep.setAttribute('pathLength', '100');
      sweep.setAttribute('stroke-dasharray', pct + ' 100');
      sweep.setAttribute('stroke-linecap', pct >= 100 ? 'butt' : 'round');
      sweep.setAttribute('transform', 'rotate(-90 ' + RING_BOX / 2 + ' ' + RING_BOX / 2 + ')');
      if (HEX.test(r.colour)) sweep.setAttribute('stroke', r.colour);
      box.appendChild(sweep);
    });
    return box;
  }

  /** Ring look: the figure and the time left; the ring itself is the bar. */
  function ringRow(r) {
    var line = document.createElement('div');
    line.className = 'tile__row';
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

  function row(r) {
    var pct = pctOf(r);
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

  var hovered = -1;

  function tile(t, width, index, lit, ring) {
    var el = document.createElement('div');
    el.className = lit ? 'tile tile--hover' : 'tile';
    el.addEventListener('mouseenter', function () { report(index); });
    el.addEventListener('mouseleave', function () { report(-1); });
    el.style.width = (width - 4) + 'px';
    el.title = text(t.title, 200);
    var logo = document.createElement('span');
    logo.className = 'tile__logo';
    if (LOGOS[t.id] === 1) logo.setAttribute('data-logo', t.id);
    var rows = document.createElement('div');
    rows.className = 'tile__rows';
    var list = (Array.isArray(t.rows) ? t.rows.slice(0, 2) : []).filter(function (r) {
      return r && typeof r === 'object';
    });
    list.forEach(function (r) {
      rows.appendChild(ring ? ringRow(r) : row(r));
    });
    el.appendChild(logo);
    if (ring) el.appendChild(rings(list));
    el.appendChild(rows);
    return el;
  }

  function report(index) {
    if (index === hovered || !api || typeof api.hover !== 'function') return;
    hovered = index;
    api.hover(index);
  }

  function draw(data) {
    if (!data || typeof data !== 'object') return;
    var layer = data.layer === 'input' || data.layer === 'display' ? data.layer : 'full';
    document.body.setAttribute('data-layer', layer);
    // The offscreen page draws in physical pixels: zoomed by the taskbar's scale.
    var scale = layer === 'display' && typeof data.scale === 'number' && data.scale >= 1 && data.scale <= 4 ? data.scale : 1;
    document.documentElement.style.zoom = String(scale);
    var lit = layer === 'display' && Number.isInteger(data.hover) ? data.hover : -1;
    document.body.setAttribute('data-ground', data.ground === 'light' ? 'light' : 'dark');
    var ring = data.style === 'rings';
    document.body.setAttribute('data-style', ring ? 'rings' : 'plain');
    var width = typeof data.tileWidth === 'number' && data.tileWidth > 20 && data.tileWidth < 400 ? data.tileWidth : 180;
    var tiles = Array.isArray(data.tiles) ? data.tiles.slice(0, 8) : [];
    while (root.firstChild) root.removeChild(root.firstChild);
    tiles.forEach(function (t, i) {
      if (t && typeof t === 'object') root.appendChild(tile(t, width, i, i === lit, ring));
    });
  }

  if (!api) return;
  api.onData(draw);
  // The RELEASE opens the panel, not a full click. While the taskbar is the
  // foreground (after any click on it: the clock, the ^ arrow, Start) the
  // press goes to the taskbar and only the release reaches this page, so a
  // 'click' never fired and the strip stopped opening anything until another
  // app was clicked (owner, 2026-10-20; the trace showed one strip.click in
  // six minutes of clicking). main coalesces a release and a covered-click
  // report that arrive together.
  document.addEventListener('mouseup', function (e) {
    if (e.button === 0) api.open();
  });
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    api.menu();
  });
})();
