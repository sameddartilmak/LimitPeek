'use strict';
/*
 * The uninstall question, drawn in the app's own look (uninstall-prompt.js
 * opens it). No preload and no IPC: the words arrive in the URL hash, already
 * translated by main, and the answer goes back as the document title, which
 * main reads from `page-title-updated`. Nothing here can reach the disk.
 */
(function () {
  var data = {};
  try { data = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch (e) { data = {}; }
  var text = data.text || {};
  var root = document.documentElement;
  root.setAttribute('lang', data.lang || 'tr');
  root.setAttribute('data-theme', data.theme === 'light' ? 'light' : 'dark');

  function set(id, value) { var el = document.getElementById(id); if (el) el.textContent = value || ''; }
  set('un-title', text.title);
  set('un-lead', text.lead);
  set('un-keep-note', text.untouched);
  set('un-keep-label', text.keepData);
  set('un-cancel', text.cancel);
  set('un-remove', text.remove);
  var list = document.getElementById('un-list');
  (text.items || []).forEach(function (item) {
    var li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  });

  function answer(choice) {
    var keep = document.getElementById('un-keep').checked;
    document.title = 'usage-notch-uninstall:' + choice + ':' + (keep ? 'keep' : 'delete');
  }
  document.getElementById('un-cancel').addEventListener('click', function () { answer('cancel'); });
  document.getElementById('un-remove').addEventListener('click', function () { answer('remove'); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') answer('cancel'); });
  // The safe answer has the focus, as in every question the panel asks.
  document.getElementById('un-cancel').focus();
})();
