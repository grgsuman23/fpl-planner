// App shell cached for offline use; data is always fetched fresh when online.
const CACHE = 'fpl-planner-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'app-config.js', 'manifest.json', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // network first, fall back to cache (keeps last data available offline)
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request.url.split('?')[0], copy)); return r;
  }).catch(() => caches.match(e.request.url.split('?')[0])));
});
