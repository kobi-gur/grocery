// Offline app shell. The deploy workflow stamps the build, so every deploy installs a fresh cache.
// Supabase requests pass straight through; offline writes are queued by app.js.
const CACHE = 'grocery-__BUILD__';
const SHELL = [
  './',
  'index.html',
  'app.js',
  'manifest.json',
  'icon.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js',
];
// Product images survive deploys, oldest out first, so storage on the phone stays small.
const THUMBS = 'grocery-thumbs';
const THUMBS_MAX = 200;

const isThumb = (url) => url.hostname === 'images.openfoodfacts.org'
  || (url.hostname === 'res.cloudinary.com' && url.pathname.startsWith('/shufersal/'));

async function storeThumb(cache, request, response) {
  await cache.put(request, response);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - THUMBS_MAX)).map((key) => cache.delete(key)));
}

async function respondThumb(event) {
  const cache = await caches.open(THUMBS);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const response = await fetch(event.request);
  if (response.ok) event.waitUntil(storeThumb(cache, event.request, response.clone()));
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== THUMBS).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (isThumb(new URL(request.url))) {
    event.respondWith(respondThumb(event));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(caches.match('./').then((hit) => hit ?? fetch(request)));
    return;
  }
  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
});
