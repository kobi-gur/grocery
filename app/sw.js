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

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(caches.match('./').then((hit) => hit ?? fetch(request)));
    return;
  }
  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
});
