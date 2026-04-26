/* Minimal service worker — no offline caching, just enables PWA install prompt
   and provides a hook for future push notifications. */
self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
    /* Pass-through — let the network handle everything. */
});
