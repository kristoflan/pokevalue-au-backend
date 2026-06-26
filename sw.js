// PokéValue AU — Service Worker
// Caches the app shell for offline use and fast loads

const CACHE_NAME = 'pokevalue-au-v1';
const STATIC_ASSETS = [
  '/pokevalue-au.html',
  '/manifest.json',
];

// Install — cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first for API calls, cache first for static assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go network-first for backend API and card data APIs
  const isApi = url.hostname.includes('onrender.com') ||
                url.hostname.includes('pokemontcg.io') ||
                url.hostname.includes('ebay.com');

  if (isApi) {
    // Network only for live data — don't cache API responses
    event.respondWith(fetch(event.request).catch(() => new Response('Offline', { status: 503 })));
    return;
  }

  // Cache first for static assets (HTML, manifest, icons)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses for static assets
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
