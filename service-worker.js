const CACHE_NAME = 'lbc-v2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/backend.js',
  '/js/nightscout.js',
  '/js/dexcom.js',
  '/js/calculator.js',
  '/js/fooddata.js',
  '/js/storage.js',
  '/js/ui.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.json'
];

const API_ORIGINS = [
  'https://script.google.com',
  'https://share2.dexcom.com',
  'https://shareous1.dexcom.com'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const isApi = API_ORIGINS.some(o => e.request.url.startsWith(o)) ||
                url.pathname.startsWith('/api/');

  if (isApi) {
    e.respondWith(
      fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
