// Service Worker: macht RUN OR DIE offline spielbar.
// Das Spiel ist eine einzige HTML-Datei plus zwei versionierte CDN-Module —
// alles wird beim Install vorgeladen.
const CACHE = 'runordie-v2'; // v2: Online-Modus (bis 4 Spieler)
const ASSETS = [
  './',
  './index.html',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await c.addAll(ASSETS.filter((a) => a.startsWith('./')));
      // CDN-Module tolerant vorladen: schlägt eins fehl, füllt es der
      // Fetch-Handler beim nächsten Online-Spiel nach
      await Promise.allSettled(ASSETS.filter((a) => !a.startsWith('./')).map((a) => c.add(a)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // Nur eigene alte Versionen löschen: auf fl4p.github.io teilen sich
      // alle Projektseiten denselben Cache-Origin
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('runordie-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const sameOrigin = new URL(e.request.url).origin === location.origin;

  if (sameOrigin) {
    // Spiel-Dateien: Netz zuerst (damit Updates ankommen), Cache als Offline-Fallback
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          if (resp.ok) { // keine 404/500 einlagern
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return resp;
        })
        .catch(() =>
          caches.match(e.request, { ignoreSearch: true })
            .then((r) => r || caches.match('./index.html'))
        )
    );
  } else {
    // CDN-Module: versioniert und unveränderlich -> Cache zuerst.
    // Nur OK-Antworten einlagern — ein gecachter 503 oder eine
    // Captive-Portal-Seite würde sonst für immer ausgeliefert.
    e.respondWith(
      caches.match(e.request).then(
        (r) => r || fetch(e.request).then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return resp;
        })
      )
    );
  }
});
