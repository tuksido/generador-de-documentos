const CACHE_NAME = 'docugen-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept API calls with the service worker cache
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Handle navigation requests (loading or reloading the web app)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // If server returns 502, 503, or 504 while Render is spinning up, fallback to cached index.html
          if (!res.ok && (res.status === 502 || res.status === 503 || res.status === 504)) {
            return caches.match('/index.html').then((cached) => cached || res);
          }
          // Cache successful index.html for instant cold-start fallback
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone));
          return res;
        })
        .catch(() => {
          // If network is completely unreachable or times out, serve cached index.html
          return caches.match('/index.html');
        })
    );
    return;
  }

  // Cache static assets (JS, CSS, images) with stale-while-revalidate or cache-first
  if (
    req.method === 'GET' &&
    (url.pathname.startsWith('/assets/') ||
      url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.png') ||
      url.pathname.endsWith('.jpg') ||
      url.pathname.endsWith('.svg') ||
      url.pathname.endsWith('.webmanifest'))
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
            }
            return res;
          })
          .catch(() => cached);
      })
    );
  }
});
