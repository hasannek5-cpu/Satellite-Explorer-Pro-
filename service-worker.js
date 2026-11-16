
/* ============================================
   SATELLITE EXPLORER PRO
   SERVICE WORKER VERSION 2.0
   GitHub Pages Compatible
   Offline Cache + Auto Update
============================================ */

const CACHE_NAME = 'satellite-explorer-v2';

const APP_FILES = [
  './',
  './index.html',
  './manifest.json',
  './style.css',
  './app.js',
  './earth-analysis.js',
  './icon-192.png',
  './icon-512.png'
];


/* ============================================
   INSTALL
============================================ */

self.addEventListener('install', event => {

  event.waitUntil(

    (async () => {

      const cache = await caches.open(CACHE_NAME);

      // Cache available application files.
      // A missing optional file won't cancel installation.

      await Promise.allSettled(

        APP_FILES.map(async file => {

          const response = await fetch(file, {
            cache: 'reload'
          });

          if (!response.ok) {
            throw new Error('Failed to cache: ' + file);
          }

          await cache.put(file, response);

        })

      );

      await self.skipWaiting();

    })()

  );

});


/* ============================================
   ACTIVATE
============================================ */

self.addEventListener('activate', event => {

  event.waitUntil(

    (async () => {

      const keys = await caches.keys();

      await Promise.all(

        keys
          .filter(key =>
            key.startsWith('satellite-explorer-') &&
            key !== CACHE_NAME
          )
          .map(key => caches.delete(key))

      );

      await self.clients.claim();

      console.log(
        'Satellite Explorer Pro Service Worker activated:',
        CACHE_NAME
      );

    })()

  );

});


/* ============================================
   FETCH
   NETWORK FIRST + OFFLINE FALLBACK
============================================ */

self.addEventListener('fetch', event => {

  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Only handle same-origin requests.

  if (url.origin !== self.location.origin) {
    return;
  }

  // Do not cache API or dynamic requests.

  if (
    url.pathname.includes('/api/') ||
    url.pathname.includes('/.git/')
  ) {
    return;
  }

  event.respondWith(

    (async () => {

      const cache = await caches.open(CACHE_NAME);

      try {

        const response = await fetch(request);

        // Cache successful same-origin responses.

        if (
          response &&
          response.status === 200 &&
          response.type === 'basic'
        ) {

          await cache.put(
            request,
            response.clone()
          );

        }

        return response;

      } catch (error) {

        console.warn(
          'Network unavailable. Loading cached content:',
          request.url
        );

        // Try exact cached request.

        const cached = await cache.match(request);

        if (cached) {
          return cached;
        }

        // Offline page fallback.

        if (request.mode === 'navigate') {

          const offlinePage = await cache.match('./index.html');

          if (offlinePage) {
            return offlinePage;
          }

        }

        // Resource unavailable.

        return new Response(
          'این بخش در حالت آفلاین در دسترس نیست.',
          {
            status: 503,
            statusText: 'Offline',
            headers: {
              'Content-Type': 'text/plain; charset=utf-8'
            }
          }
        );

      }

    })()

  );

});


/* ============================================
   MESSAGE
   FORCE UPDATE SUPPORT
============================================ */

self.addEventListener('message', event => {

  if (
    event.data &&
    event.data.action === 'SKIP_WAITING'
  ) {

    self.skipWaiting();

  }

});


/* ============================================
   STATUS
============================================ */

console.log(
  'Satellite Explorer Pro SW v2.0 loaded.'
);
