const CACHE_NAME = 'stadium-light-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/control.html',
  '/manifest.json',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png'
];

// Install – cache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate – clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch – network first for HTML, cache fallback
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Don't cache WebSocket or API-like requests
  if (url.pathname.startsWith('/api') || event.request.headers.get('upgrade') === 'websocket') {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Optionally update cache
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('/')))
  );
});
