"use strict";
/* global self, caches */

// Cache only the application shell. API responses and handwritten content stay
// outside Cache Storage. IndexedDB remains the only local notebook data store.
const CACHE = "mycelium-ink-shell-v3";
const SHELL = [
  "/ink",
  "/public/ink-manifest.webmanifest",
  "/public/js/ink/strokes.js",
  "/public/js/ink/store.js",
  "/public/js/ink/archive.js",
  "/public/js/ink/canvas.js",
  "/public/js/ink/sync.js",
  "/public/js/ink/app.js",
  "/public/icons/apple-touch-icon.png",
  "/public/icons/icon-192.png",
  "/public/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  // Take over as soon as the new shell is cached, rather than waiting for every
  // client to close. Without this a new worker sits in "waiting" indefinitely:
  // an installed home-screen app gets resumed rather than relaunched, so "all
  // tabs closed" can mean days, which is long enough for a shipped fix to look
  // like it never shipped. Paired with the clients.claim() below, an update
  // lands on the next launch.
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith("mycelium-ink-shell-") && key !== CACHE)
    .map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname !== "/ink" && !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then((response) => {
    // Never replace the shell with a followed login redirect.
    if (response.ok && !response.redirected) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then((hit) => hit || caches.match("/ink"))));
});
