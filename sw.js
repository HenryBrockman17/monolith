/* App-shell cache: same-origin static files only. GitHub API requests are
   never cached — data always comes from the network (or the app's own queue). */
const CACHE = 'monolith-shell-v4';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './js/app.js', './js/api.js', './js/auth.js', './js/cal.js', './js/crypto.js',
  './js/gh.js', './js/oauth.js', './js/stats.js', './js/store.js',
  './js/render/charts.js', './js/render/dashboard.js', './js/render/grid.js',
  './js/render/modals.js', './js/render/util.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // API calls pass through
  /* stale-while-revalidate: serve cache instantly, refresh in the background */
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request).then(resp => {
        if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
        return resp;
      }).catch(() => cached);
      return cached || fresh;
    }),
  );
});
