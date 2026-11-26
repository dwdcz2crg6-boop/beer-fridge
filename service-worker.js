// Offline support.
// - App files: network-first (so a refresh always picks up new versions), cache fallback offline.
// - Pinned CDN libraries (barcode reader, QR code): cache-first; their URLs are versioned.
// - Label images (data/labels): cache-first. A changed label gets a new file name.
// - Third-party APIs (Open Food Facts, Open Brewery DB, geocoding): not intercepted.
const VERSION = 'fridge-v11-2026-11-26';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './data/beverages.json',
  './js/app.js',
  './js/art.js',
  './js/catalog.js',
  './js/coverflow.js',
  './js/lookup.js',
  './js/scanner.js',
  './js/share.js',
  './js/store.js',
  './js/suggest.js',
  './js/taxonomy.js',
  './js/util.js',
  './js/wheel.js',
];
const CDN = /^https:\/\/(cdn|fastly)\.jsdelivr\.net\/npm\/(barcode-detector|zxing-wasm|qrcode-generator)@/;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => Promise.all(CORE.map(url => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    // Always revalidate: static hosts send max-age (GitHub Pages: 10 min), and a stale
    // HTTP-cache copy could mix an old index.html with new scripts right after a deploy.
    let response = await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
    if (response.redirected) response = await fetch(request); // navigations can't take a followed redirect
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) event.respondWith(url.pathname.includes('/data/labels/') ? cacheFirst(request) : networkFirst(request));
  else if (CDN.test(request.url)) event.respondWith(cacheFirst(request));
});
