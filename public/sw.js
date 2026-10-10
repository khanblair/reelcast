// ReelCast service worker.
//
// Deliberately tiny: it keeps a few static install assets (manifest + app icons) available offline and does
// nothing else. It must never touch pages. HTML documents, Next.js RSC payloads, /_next/* chunks and /api/*
// are per-deploy and per-user, and caching them cache-first served stale page shells that no longer matched the
// deployed JavaScript (so they never hydrated) and left signed-in pages in a shared on-device cache.
// Anything not listed in STATIC_ASSETS falls through to the network untouched.
//
// Bump CACHE_NAME whenever STATIC_ASSETS changes: activation deletes every other cache, which is also how the
// old worker's cached HTML (reelcast-v2 and earlier) is purged on existing installs.
const CACHE_NAME = "reelcast-v3";
const STATIC_ASSETS = [
  "/manifest.json",
  "/icons/icon.svg",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon.ico",
];
const STATIC_PATHS = new Set(STATIC_ASSETS);

// Install: precache the static assets, then take over from any older worker straight away.
// One missing asset must not stop the worker from installing, so add them individually.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.allSettled(STATIC_ASSETS.map((asset) => cache.add(asset))))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete every other cache (including the old page-HTML caches), then control open pages.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

// Fetch: cache-first for the exact static assets above; every other request is left to the browser.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!STATIC_PATHS.has(url.pathname)) return;

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
