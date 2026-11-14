/* Keeps the app shell on the device so it opens at once, even with no signal. Data is kept by the app itself (engine.js).
   The saved shell is shown first and refreshed in the background, so a new version appears the next time the app opens. */
var CACHE = 'hanaro-shell-v21';
var SHELL = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'engine.js', 'manifest.webmanifest', 'icon-192.png', 'icon-180.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  // The saved copy opens at once; a fresh copy is fetched behind it and is used next time (the app says when it was updated).
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(r).then(function (hit) {
      var net = fetch(r).then(function (res) { if (res.ok) c.put(r, res.clone()); return res; });
      if (hit) { net.catch(function () {}); return hit; }
      return net.catch(function () { return c.match('index.html').then(function (x) { return x || Response.error(); }); });
    });
  }));
});
