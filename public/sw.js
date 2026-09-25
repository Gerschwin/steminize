// Steminize service worker:
//  1. caches the app so it opens offline;
//  2. adds COOP/COEP headers so the page is "cross-origin isolated", which
//     enables multi-threaded WASM on hosts (like GitHub Pages) that can't set headers.
// Model files are stored separately by the app (Cache Storage "steminize-models-v1").

const APP_CACHE = 'steminize-app-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('steminize-app-') && k !== APP_CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      if (req.mode === 'navigate') {
        // Network first for the page itself so updates arrive; cache as fallback.
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone()).catch(() => {});
          return isolate(res);
        } catch {
          return isolate((await cache.match(req)) || (await cache.match('./')));
        }
      }
      // Hashed build assets never change: cache first.
      const hit = await cache.match(req);
      if (hit) return isolate(hit);
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return isolate(res);
    })(),
  );
});
