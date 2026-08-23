// ads.js - карусель на главной. Слайды лежат в ads.json в корне репозитория.
// Если файл недоступен или пуст, блок просто не показывается.
(function () {
  var box = document.getElementById('ads');
  if (!box) return;
  var track = document.getElementById('ads-track');
  var ticks = document.getElementById('ads-ticks');
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  fetch('ads.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (ads) {
      if (!Array.isArray(ads) || !ads.length) return;
      ads = ads.slice(0, 8);

      track.innerHTML = ads.map(function (a) {
        return '<div class="ad" data-url="' + esc(a.url || '') + '">' +
          '<div class="glow" style="background:' + esc(a.c1 || '#7B5CFF') + '"></div>' +
          '<div class="tag">' + esc(a.tag) + '</div>' +
          '<h3>' + esc(a.title) + '</h3>' +
          '<p>' + esc(a.text) + '</p>' +
          (a.url ? '<div class="cta"><svg viewBox="0 0 24 24" fill="none">' +
            '<path d="M7 17 17 7"/><path d="M9 7h8v8"/></svg></div>' : '') +
          '</div>';
      }).join('');
      ticks.innerHTML = ads.map(function () { return '<div class="t"><i></i></div>'; }).join('');
      box.hidden = false;

      var i = 0, timer = null, tickEls = [].slice.call(ticks.children);
      function show(n) {
        i = (n + ads.length) % ads.length;
        track.style.transform = 'translateX(' + (-i * 100) + '%)';
        tickEls.forEach(function (t, k) {
          t.className = 't' + (k < i ? ' done' : k === i ? ' on' : '');
        });
        clearTimeout(timer);
        if (ads.length > 1) timer = setTimeout(function () { show(i + 1); }, 6000);
      }
      show(0);

      // свайп
      var x0 = null;
      box.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
      box.addEventListener('touchend', function (e) {
        if (x0 === null) return;
        var dx = e.changedTouches[0].clientX - x0;
        if (Math.abs(dx) > 40) show(i + (dx < 0 ? 1 : -1));
        x0 = null;
      });

      // переход по слайду
      box.addEventListener('click', function (e) {
        var ad = e.target.closest('.ad');
        if (!ad || !ad.dataset.url) return;
        if (window.Telegram && Telegram.WebApp && Telegram.WebApp.openLink)
          Telegram.WebApp.openLink(ad.dataset.url);
        else window.open(ad.dataset.url, '_blank', 'noopener');
      });

      // вкладка в фоне - таймер не крутим
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) clearTimeout(timer); else show(i);
      });
    })
    .catch(function () { /* нет ads.json - живём без рекламы */ });
})();
