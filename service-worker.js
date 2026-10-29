const CACHE = "plb-pwa-v1";
const STATIC_FILES = [
  "./offline.html",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(STATIC_FILES))
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(async names => {
      await Promise.all(
        names
          .filter(name => name.startsWith("plb-pwa-") && name !== CACHE)
          .map(name => caches.delete(name))
      );
      await self.clients.claim();
    })
  );
});

self.addEventListener("fetch", event => {
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open(CACHE);
      return cache.match("./offline.html");
    })
  );
});
