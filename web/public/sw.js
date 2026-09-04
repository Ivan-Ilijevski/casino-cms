/*
  The whole point of this worker is to exist.

  Chrome only offers "install to home screen" — which is what gets the POS tablet
  a fullscreen launch with no status bar and no URL bar — when the origin has a
  registered service worker with a fetch handler. So this file is what makes
  `display: "fullscreen"` in the manifest actually reachable.

  What it deliberately does NOT do: cache HTML, or anything under /api/. A staff
  terminal serving a stale app shell or a stale balance is a far worse failure
  than a slow reload. The only thing cached is Vite's /assets/ output, whose
  filenames are content hashes — a rebuild produces new names, so the cache can
  never shadow a deploy. Everything else falls through to the network untouched.
*/

const CACHE = 'cms-assets-v1'

self.addEventListener('install', () => {
  // Nothing to precache; take over as soon as the browser will let us.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      // Bumping CACHE above is how you wipe accumulated old asset hashes.
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith('/assets/')) return

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit
      return fetch(req).then((res) => {
        // Only a clean same-origin 200 is worth keeping; opaque and error
        // responses would poison the cache for the life of that filename.
        if (res.ok && res.type === 'basic') {
          const copy = res.clone()
          void caches.open(CACHE).then((c) => c.put(req, copy))
        }
        return res
      })
    })
  )
})
