/* FoodRush Service Worker v1 */
const CACHE_NAME = 'foodrush-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700;800&family=Inter:wght@300;400;500;600&display=swap'
];

// Install — cache static assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching static assets');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — stale-while-revalidate for HTML/CSS, network-first for API
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // API calls — network only (don't cache live data)
  if (url.hostname.includes('api.learnwithadarsh')) {
    return; // let browser handle normally
  }

  // Fonts — cache first
  if (url.hostname.includes('fonts.g')) {
    e.respondWith(
      caches.match(request).then(cached => cached ||
        fetch(request).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
          return res;
        })
      )
    );
    return;
  }

  // HTML/assets — stale-while-revalidate
  e.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return res;
      }).catch(() => cached); // fallback to cached if offline

      return cached || networkFetch;
    })
  );
});
