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
 * Three looks (data.style, Görünüm → Şerit stili):
 *   'plain' per row: label, a mini bar, the figure, the time left (default);
 *   'rings' "Halkalı": a thick double ring after the logo (five-hour outside,
 *           weekly inside, the bar's ramp colour on the bar's track), then the
 *           lead row's figure large in its state colour and its time left;
 *   'fill'  "Dolgulu": the tile's own ground filled to the lead row's figure
 *           in its ramp colour, that figure and its time left on top, and the
 *           weekly figure in a small chip at the right.
 * The lead row is the tile's first: the five-hour window, or the weekly one
 * for a tool that publishes only that (its label then opens the time left,
 * so a bare figure is never read as the five-hour one). The rings are SVG,
 * so they stay crisp at the taskbar's zoom; the coloured words take the
 * text step of their state (strip.css), never the ramp the fills use.
 */
(function () {
  var api = window.usageNotchStrip;
  var root = document.getElementById('strip');
  var LOGOS = { claude: 1, codex: 1, antigravity: 1, kimi: 1, qwen: 1, grok: 1 };
  var HEX = /^#[0-9A-Fa-f]{6}$/;
  var SVG = 'http://www.w3.org/2000/svg';
  var STATES = { calm: 1, watch: 1, ember: 1, spent: 1 };
  /**
   * "Halkalı" in CSS px (the page is zoomed to the taskbar scale): a 32px
   * box, 5px strokes, the inner ring 2px clear of the outer one. A tile with
   * one window draws that one ring at the outer size. pathLength 100 lets the
   * sweep be the rounded figure itself.
   */
  var RING_BOX = 32;
  var RING_W = 5;
  var RING_OUTER = 13.5;
  var RING_INNER = 6.5;

  function text(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function pctOf(r) {
    return typeof r.percent === 'number' && isFinite(r.percent) ? Math.max(0, Math.min(100, r.percent)) : 0;
  }

  function span(cls, value) {
    var el = document.createElement('span');
    el.className = cls;
    if (value) el.textContent = value;
    return el;
  }

  /** The state step main sent for this row, for the words' colour. */
  function stateOf(r) {
    return typeof r.state === 'string' && STATES[r.state] === 1 ? r.state : null;
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
    rows.forEach(function (r, i) {
      var radius = i === 0 ? RING_OUTER : RING_INNER;
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

  /**
   * The lead row's words, for "Halkalı" and "Dolgulu": the figure large with
   * its window's name beside it ("%62 5sa"), the time left under it.
   */
  function lead(r, colourFigure) {
    var box = span('tile__lead');
    var line = span('tile__bigline');
    var figure = span('tile__big', text(r.percentText, 8));
    var state = stateOf(r);
    if (colourFigure && state) figure.setAttribute('data-state', state);
    line.appendChild(figure);
    var label = text(r.label, 6);
    if (label) line.appendChild(span('tile__tag', label));
    box.appendChild(line);
    box.appendChild(span('tile__sub', text(r.left, 16)));
    return box;
  }

  /**
   * "Dolgulu": the weekly figure in a chip with its name ("7g %41"), in its
   * state colour, and its time left under it.
   */
  function chip(r) {
    var box = span('tile__wk');
    var el = span('tile__chip');
    var label = text(r.label, 6);
    if (label) el.appendChild(span('tile__tag', label));
    el.appendChild(document.createTextNode(text(r.percentText, 8)));
    var state = stateOf(r);
    if (state) el.setAttribute('data-state', state);
    box.appendChild(el);
    var left = text(r.left, 16);
    if (left) box.appendChild(span('tile__sub', left));
    return box;
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

  function tile(t, width, index, lit, style) {
    var el = document.createElement('div');
    el.className = lit ? 'tile tile--hover' : 'tile';
    el.addEventListener('mouseenter', function () { report(index); });
    el.addEventListener('mouseleave', function () { report(-1); });
    el.style.width = (width - 4) + 'px';
    el.title = text(t.title, 200);
    var logo = document.createElement('span');
    logo.className = 'tile__logo';
    if (LOGOS[t.id] === 1) logo.setAttribute('data-logo', t.id);
    var list = (Array.isArray(t.rows) ? t.rows.slice(0, 2) : []).filter(function (r) {
      return r && typeof r === 'object';
    });
    if (style === 'fill' && list.length > 0) {
      // The ground itself is the bar: filled to the lead figure, in its ramp
      // colour at the alpha strip.css names, under everything else.
      var ground = span('tile__ground');
      ground.style.width = pctOf(list[0]) + '%';
      if (HEX.test(list[0].colour)) ground.style.background = list[0].colour;
      el.appendChild(ground);
    }
    el.appendChild(logo);
    if (style === 'rings' && list.length > 0) {
      el.appendChild(rings(list));
      el.appendChild(lead(list[0], true));
    } else if (style === 'fill' && list.length > 0) {
      el.appendChild(lead(list[0], false));
      if (list[1]) el.appendChild(chip(list[1]));
    } else {
      var rows = document.createElement('div');
      rows.className = 'tile__rows';
      list.forEach(function (r) { rows.appendChild(row(r)); });
      el.appendChild(rows);
    }
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
    var style = data.style === 'rings' || data.style === 'fill' ? data.style : 'plain';
    document.body.setAttribute('data-style', style);
    var width = typeof data.tileWidth === 'number' && data.tileWidth > 20 && data.tileWidth < 400 ? data.tileWidth : 180;
    var tiles = Array.isArray(data.tiles) ? data.tiles.slice(0, 8) : [];
    while (root.firstChild) root.removeChild(root.firstChild);
    tiles.forEach(function (t, i) {
      if (t && typeof t === 'object') root.appendChild(tile(t, width, i, i === lit, style));
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
