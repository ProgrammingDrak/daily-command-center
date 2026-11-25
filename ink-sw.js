"use strict";
/* global self, caches, Response */
// Private journal bodies, API responses, and media never enter Cache Storage.
const CACHE = "mycelium-ink-shell-v10";
const SHELL = [
  "/library", "/library/notebook", "/public/ink-manifest.webmanifest",
  "/public/css/tokens.css", "/public/css/dashboard.css", "/public/css/core-ui.css",
  "/public/css/ui-optimization.css", "/public/css/completion-memories.css",
  "/public/css/journal-sketchbook.css", "/public/css/library.css",
  "/public/js/vendor/marked.min.js", "/public/js/vendor/purify.min.js",
  "/public/js/ink/strokes.js", "/public/js/ink/store.js", "/public/js/ink/archive.js",
  "/public/js/ink/render-worker.js", "/public/js/ink/canvas.js", "/public/js/ink/shapes.js",
  "/public/js/ink/sync.js", "/public/js/ink/app.js", "/public/js/journal-notebook.js",
  "/public/js/journal-sketchbook.js", "/public/js/journal-drafts.js",
  "/public/js/library-workspace.js", "/public/js/core-ui.js", "/public/js/completion-memories.js", "/public/js/journal-blocks.js",
  "/public/fonts/Poppins-Regular.ttf", "/public/fonts/Poppins-Medium.ttf",
  "/public/fonts/Poppins-SemiBold.ttf", "/public/fonts/Poppins-Bold.ttf",
  "/public/icons/favicon.ico", "/public/icons/icon-192.png", "/public/icons/icon-512.png"
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    for (const url of SHELL) {
      const response = await fetch(url, { cache:"reload", credentials:"same-origin" });
      if (!response.ok || response.redirected) throw new Error("Incomplete Library shell: " + url);
      await cache.put(url,response);
    }
  }));
});
self.addEventListener("message", event => {
  if (event.data?.type === "ACTIVATE_LIBRARY_UPDATE") self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith("mycelium-ink-shell-") && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  const alias = url.pathname === "/ink" || url.pathname === "/ink.html";
  if (!alias && !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && !response.redirected && !alias)
      caches.open(CACHE).then(cache => cache.put(url.pathname,response.clone()));
    return response;
  }).catch(() => caches.match(alias ? "/library" : url.pathname).then(hit => hit || Response.error())));
});
