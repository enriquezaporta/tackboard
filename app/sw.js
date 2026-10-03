// Service worker: guarda la app para que funcione sin conexión. La API nunca se guarda en caché.
const VERSION = 'tackboard-1.0.0';
const SHELL = [
  './', 'index.html', 'privacy.html', 'terms.html', 'manifest.webmanifest',
  'css/app.css', 'css/fonts.css',
  'js/main.js', 'js/store.js', 'js/db.js', 'js/api.js', 'js/util.js', 'js/ui.js', 'js/drag.js', 'js/sheets.js', 'js/legal.js',
  'js/views/parts.js', 'js/views/today.js', 'js/views/board.js', 'js/views/calendar.js', 'js/views/settings.js', 'js/views/auth.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'fonts/ibm-plex-sans-latin-400-normal.woff2', 'fonts/ibm-plex-sans-latin-500-normal.woff2',
  'fonts/ibm-plex-sans-latin-600-normal.woff2', 'fonts/ibm-plex-sans-latin-700-normal.woff2',
  'fonts/ibm-plex-mono-latin-500-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    // Páginas: primero la red (para recibir versiones nuevas) y, sin conexión, la copia guardada.
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  })));
});
