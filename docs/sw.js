/* Keeps the app shell on the device so it opens even with no signal. Data comes from the API and is saved by the app itself.
   Online, the newest files always win (so an update shows at once); the saved copy is used when the network is slow or off. */
var CACHE = 'hanaro-shell-v18';
var SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-180.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (c) {
    return new Promise(function (resolve) {
      var done = false;
      function use(x) { if (!done && x) { done = true; resolve(x); } }
      var timer = setTimeout(function () { c.match(r).then(use); }, 2500);
      fetch(r).then(function (res) {
        clearTimeout(timer);
        if (res.ok) c.put(r, res.clone());
        use(res);
      }).catch(function () {
        clearTimeout(timer);
        c.match(r).then(function (hit) { return hit || c.match('index.html'); }).then(function (hit) { if (!done) { done = true; resolve(hit || Response.error()); } });
      });
    });
  }));
});
