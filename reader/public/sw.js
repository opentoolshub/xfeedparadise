// Paradise Reader service worker: caches the app shell, and keeps only the
// most recently loaded first page of posts (plus account summary) so the
// reader opens offline. Sign-out and delete-all remove the data cache.
const SHELL = 'xfr-shell-v2';
const DATA = 'xfr-data';
const SHELL_FILES = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('xfr-shell-') && key !== SHELL) await caches.delete(key);
    await caches.delete(DATA);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) return;

  // Private feed responses stay network-only, including across account switches.
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
