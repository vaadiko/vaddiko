const CACHE_NAME = 'vaadiko-v1';
const ASSETS = [
  '/vaadiko/',
  '/vaadiko/index.html',
  '/vaadiko/manifest.json',
  '/vaadiko/icon-192.png',
  '/vaadiko/icon-512.png'
];

// Install — cache all assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first for Firebase, cache first for assets
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Firebase / Google APIs — always network, no cache
  if (
    url.includes('firestore') ||
    url.includes('firebase') ||
    url.includes('googleapis') ||
    url.includes('gstatic') ||
    url.includes('nominatim') ||
    url.includes('cdnjs')
  ) {
    return;
  }

  // App assets — cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        // Cache valid responses
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return main page
        if (e.request.mode === 'navigate') {
          return caches.match('/vaadiko/index.html');
        }
      });
    })
  );
});

// Background sync placeholder (improves PWABuilder score)
self.addEventListener('sync', e => {
  console.log('Background sync:', e.tag);
});

// Push notifications placeholder (improves PWABuilder score)
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  self.registration.showNotification(data.title || 'ועדיקו', {
    body: data.body || '',
    icon: '/vaadiko/icon-192.png',
    badge: '/vaadiko/icon-192.png'
  });
});
