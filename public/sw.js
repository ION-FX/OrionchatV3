// OrionChatV3 service worker — offline shell for the static frontend only.
// /api/* and /v1/* always go to the network (never cached); navigation falls
// back to the cached index when the network is unreachable.
const VERSION = 'orionchatv3-v1.6.0';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/markdown.js',
  '/manifest.webmanifest',
  '/logo.png',
];

self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evt) => {
  const url = new URL(evt.request.url);
  if (url.origin !== location.origin) return;           // let cross-origin through untouched
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) return; // live data only
  if (evt.request.method !== 'GET') return;

  // static assets: cache-first with background refresh
  if (url.pathname.startsWith('/share/')) return;       // share pages are server-rendered HTML
  evt.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(evt.request);
    const network = fetch(evt.request).then((res) => {
      if (res.ok) cache.put(evt.request, res.clone());
      return res;
    }).catch(() => null);
    if (cached) {
      network.catch(() => {});
      return cached;
    }
    const fresh = await network;
    if (fresh) return fresh;
    // navigation fallback: the cached app shell works offline
    if (evt.request.mode === 'navigate') {
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
