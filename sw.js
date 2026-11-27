/**
 * Service worker — the whole app must work with the radio off.
 *
 * Strategy: precache the entire shell at install time (HTML, CSS, JS, fonts,
 * icons, the wllama wasm) and then serve cache-first. The .gguf model is *not*
 * here: it lives in OPFS (see js/model-store.js), which is a better home for a
 * multi-hundred-megabyte file than the Cache API.
 *
 * Bump SHELL_VERSION whenever a shell file changes; the old cache is deleted on
 * activate.
 */

const SHELL_VERSION = 'v8';
const CACHE = `bubble-plush-${SHELL_VERSION}`;

/** Everything needed to boot with no network. */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/app.css',
  './js/main.js',
  './js/config.js',
  './js/db.js',
  './js/model-store.js',
  './js/llm.js',
  './js/ui.js',
  './vendor/wllama/index.js',
  './vendor/wllama/single-thread/wllama.wasm',
  './assets/fonts/outfit-latin.woff2',
  './assets/fonts/inter-latin.woff2',
  './assets/icons/favicon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Add entries one by one: a single 404 must not abort the whole install.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(url).catch((error) => console.warn('[sw] could not cache', url, error))
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only same-origin GETs. Nothing else should exist in this app.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the exact cached page if we have it, otherwise try the
  // network, and only fall back to the app shell when offline. (Falling back
  // unconditionally would hand index.html to *any* URL — including its relative
  // asset paths, which would then resolve against the wrong directory.)
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const exact = await caches.match(request);
        if (exact) return exact;
        try {
          return await fetch(request);
        } catch {
          return (await caches.match('./index.html')) ?? new Response('Offline', { status: 503 });
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;

      const response = await fetch(request);
      // Opportunistically cache anything else same-origin we happen to load.
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    })()
  );
});
