// Service worker: guarda la app para que funcione sin conexión. La API nunca se guarda en caché.
const VERSION = 'tackboard-1.1.3';
const SHELL = [
  './', 'index.html', 'privacy.html', 'terms.html', 'manifest.webmanifest',
  'css/app.css', 'css/fonts.css',
  'js/main.js', 'js/push.js', 'js/store.js', 'js/db.js', 'js/api.js', 'js/util.js', 'js/ui.js', 'js/drag.js', 'js/sheets.js', 'js/legal.js',
  'js/views/parts.js', 'js/views/today.js', 'js/views/board.js', 'js/views/calendar.js', 'js/views/settings.js', 'js/views/auth.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'fonts/ibm-plex-sans-latin-400-normal.woff2', 'fonts/ibm-plex-sans-latin-500-normal.woff2',
  'fonts/ibm-plex-sans-latin-600-normal.woff2', 'fonts/ibm-plex-sans-latin-700-normal.woff2',
  'fonts/ibm-plex-mono-latin-500-normal.woff2',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' se salta la caché HTTP del navegador: así una versión nueva nunca mezcla archivos de la anterior.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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

// Avisos push: el servidor envía {title, body, tag, url}. Siempre se muestra algo (iOS lo exige).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  const title = typeof d.title === 'string' && d.title ? d.title.slice(0, 120) : 'Tackboard';
  e.waitUntil(self.registration.showNotification(title, {
    body: typeof d.body === 'string' ? d.body.slice(0, 300) : '',
    tag: typeof d.tag === 'string' ? d.tag.slice(0, 64) : undefined,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: typeof d.url === 'string' && d.url.startsWith('/') ? d.url : '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let url = new URL(e.notification.data?.url || '/', self.location.origin);
  if (url.origin !== self.location.origin) url = new URL('/', self.location.origin);
  url = url.href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin) { c.navigate(url).catch(() => {}); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
