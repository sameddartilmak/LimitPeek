/* Usage Notch legal pages (privacy, terms, refund): the only script. It picks
 * TR/EN before first paint and keeps <html lang> and the title in step with
 * the radio. Without it the CSS still switches language from the radio.
 * No network, no storage. */
(function () {
  'use strict';

  var root = document.documentElement;

  function browserLanguage() {
    return String(navigator.language || '').toLowerCase().indexOf('tr') === 0 ? 'tr' : 'en';
  }
  function applyLanguage(next) {
    if (next !== 'tr' && next !== 'en') return;
    root.setAttribute('lang', next);
    root.setAttribute('data-lang', next);
    var title = root.getAttribute('data-title-' + next);
    if (title) document.title = title;
    var radio = document.getElementById('lang-' + next);
    if (radio && !radio.checked) radio.checked = true;
  }
  applyLanguage(browserLanguage());

  document.addEventListener('DOMContentLoaded', function () {
    applyLanguage(root.getAttribute('data-lang'));
    Array.prototype.forEach.call(document.querySelectorAll('input[name="lang"]'), function (r) {
      r.addEventListener('change', function (e) { if (e.target.checked) applyLanguage(e.target.value); });
    });
  });
})();
