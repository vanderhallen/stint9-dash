/* STINT9 service worker.

   Design rule, and the reason this is safe on a live dashboard:

     1. It never touches a cross-origin request. Supabase, Leaflet and the
        Google fonts are returned to the browser untouched, so live timing
        data can never be served from a cache.
     2. Same-origin requests are network-first. While there is a network, the
        response is always the freshly deployed one — a stale index.html on
        the pit wall is not possible. The cache is only ever a fallback.

   Bump VERSION to drop every cached copy on the next deploy.
   Escape hatch: load any page with ?nosw=1 to unregister and wipe the caches. */

const VERSION = 'v1';
const CACHE = 'stint9-' + VERSION;

/* served from cache only when the network fails or hangs */
const PRECACHE = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];

/* a hung connection in the Eifel should not mean a blank screen: if a page
   navigation has not answered in this long, show the last good copy instead */
const NAV_TIMEOUT = 4000;

/* never cached — team-gated, and not something to keep on a shared tablet */
const NEVER = [/^\/admin\.html$/];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // one missing file must not fail the whole install, which would leave the
    // worker permanently stuck in "installing"
    await Promise.allSettled(PRECACHE.map(u => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k.startsWith('stint9-') && k !== CACHE ? caches.delete(k) : null));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // the important line: everything off this origin (Supabase above all) is
  // left entirely to the browser
  if (url.origin !== self.location.origin) return;
  if (NEVER.some(re => re.test(url.pathname))) return;

  event.respondWith(networkFirst(req, req.mode === 'navigate'));
});

async function networkFirst(req, isNav) {
  const cache = await caches.open(CACHE);

  const net = fetch(req).then(res => {
    // only store a complete, same-origin, successful response
    if (res && res.status === 200 && res.type === 'basic') {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  });

  if (isNav) {
    const cached = (await cache.match(req)) || (await cache.match('/'));
    if (cached) {
      const quick = await Promise.race([
        net.catch(() => null),
        new Promise(r => setTimeout(() => r(null), NAV_TIMEOUT))
      ]);
      // the cached shell still fetches its own live data once it boots
      return quick || cached;
    }
  }

  try {
    return await net;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}
