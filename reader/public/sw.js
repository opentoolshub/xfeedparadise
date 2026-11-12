// Paradise Reader service worker: caches the app shell, and keeps only the
// most recently loaded first page of posts (plus account summary) so the
// reader opens offline. Sign-out and delete-all remove the data cache.
const SHELL = 'xfr-shell-v1';
const DATA = 'xfr-data';
const SHELL_FILES = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('xfr-shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function markCached(response) {
  const headers = new Headers(response.headers);
  headers.set('x-reader-cache', 'hit');
  return new Response(await response.blob(), { status: response.status, headers });
}

async function networkFirstData(request, slot) {
  const cache = await caches.open(DATA);
  try {
    const response = await fetch(request);
    if (response.status === 401) {
      await caches.delete(DATA);
    } else if (response.ok) {
      await cache.put(slot, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(slot);
    if (cached) return markCached(cached);
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) return;

  if (url.pathname === '/v1/items') {
    // Only the first page of a view is kept (one slot), never older pages.
    if (url.searchParams.has('cursor')) return;
    event.respondWith(networkFirstData(request, '/__last/items'));
    return;
  }
  if (url.pathname === '/v1/me') {
    event.respondWith(networkFirstData(request, '/__last/me'));
    return;
  }
  if (url.pathname.startsWith('/v1/')) return;

  // App shell: serve from cache, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const key = request.mode === 'navigate' ? '/' : request;
    const cached = await cache.match(key);
    const network = fetch(request).then(response => {
      if (response.ok && SHELL_FILES.includes(url.pathname === '/index.html' ? '/' : url.pathname)) cache.put(key, response.clone());
      return response;
    });
    if (cached) {
      event.waitUntil(network.catch(() => {}));
      return cached;
    }
    return network;
  })());
});
