/* Caches the heavy, immutable assets so the ~3.4 MB first load is paid once and the app
 * then works offline. Bump CACHE_NAME whenever the card database or opencv build changes. */

const CACHE_NAME = 'tarot-helper-v3';

const PRECACHE = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/camera.js',
  'js/reading.js',
  'js/recognizer.core.js',
  'vendor/opencv.js',
  'data/cards.json',
  'data/card_db.json',
  'data/card_db.bin',
  'data/card_sig.bin',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // Thumbnails are fetched lazily and cached on demand, so a miss here is not fatal.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => hit))
  );
});
