/* Service-worker self-test — drives real headless Chrome over the DevTools
   Protocol and asserts the guarantees sw.js is supposed to give. No npm deps:
   node ≥ 22 has a global WebSocket.

   Run it from the repo root after any change to sw.js. Full instructions are in
   README §17 ("PWA"); the short version:

     python3 -m http.server 8791 --bind 127.0.0.1 &                  # the site
     mkdir -p /tmp/sw-other && echo '{"ok":1}' > /tmp/sw-other/ping.json
     python3 -m http.server 8792 --bind 127.0.0.1 --directory /tmp/sw-other &
     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        --headless=new --remote-debugging-port=9222 \
        --user-data-dir=/tmp/sw-chrome --no-first-run about:blank &
     node tools/sw-selftest.mjs

   Port 8792 is a second origin standing in for Supabase: it proves the worker
   leaves cross-origin traffic alone without needing the real backend.        */

const ORIGIN = process.env.SW_ORIGIN || 'http://127.0.0.1:8791';
const OTHER = process.env.SW_OTHER || 'http://127.0.0.1:8792';
const CDP = process.env.SW_CDP || 'http://127.0.0.1:9222';
const ROOT = process.cwd(); // the probe file is written here, so run from the repo root

const targets = await (await fetch(`${CDP}/json/list`)).json();
let page = targets.find(t => t.type === 'page');
if (!page) page = await (await fetch(`${CDP}/json/new?about:blank`)).json();

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method) {
    events.push(m);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function navigate(url) {
  const before = events.length;
  await send('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    if (events.slice(before).some(e => e.method === 'Page.loadEventFired')) return;
    await sleep(100);
  }
}

const offline = flag => send('Network.emulateNetworkConditions',
  { offline: flag, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

const { writeFileSync, rmSync } = await import('node:fs');
writeFileSync(`${ROOT}/swprobe.txt`, 'FIRST\n');

// ------------------------------------------------------------- clean slate
await navigate(`${ORIGIN}/?nosw=1`);
await sleep(500);
await evaluate(`(async()=>{const rs=await navigator.serviceWorker.getRegistrations();await Promise.all(rs.map(r=>r.unregister()));const ks=await caches.keys();await Promise.all(ks.map(k=>caches.delete(k)));return true})()`);

// 1. activates
await navigate(`${ORIGIN}/`);
let state = null;
for (let i = 0; i < 60; i++) {
  state = await evaluate(`(async()=>{const r=await navigator.serviceWorker.getRegistration();return r&&r.active?r.active.state:null})()`);
  if (state === 'activated') break;
  await sleep(250);
}
check('service worker activates', state === 'activated', 'state=' + state);

// 2. controls the page on the next load
await navigate(`${ORIGIN}/`);
await sleep(800);
check('controls the page after reload', (await evaluate(`!!navigator.serviceWorker.controller`)) === true);

// 3. precache populated
const cached = await evaluate(`(async()=>{const ks=await caches.keys();const n=ks.find(k=>k.startsWith('stint9-'));if(!n)return null;const c=await caches.open(n);return (await c.keys()).map(r=>new URL(r.url).pathname)})()`);
check('precache populated', Array.isArray(cached) && cached.includes('/'), (cached || []).length + ' entries');

// 4. THE important one: cross-origin (i.e. Supabase) is never intercepted
events.length = 0;
await evaluate(`fetch('${OTHER}/ping.json',{mode:'no-cors',cache:'no-store'}).then(()=>1).catch(()=>1)`);
await sleep(600);
const cross = events.filter(e => e.method === 'Network.responseReceived' && e.params.response.url.startsWith(OTHER));
check('cross-origin (Supabase stand-in) bypasses the worker',
  cross.length > 0 && !cross.some(e => e.params.response.fromServiceWorker),
  cross.length + ' response(s)');

// 5. same-origin non-image does go through it
events.length = 0;
await evaluate(`fetch('/manifest.json',{cache:'no-store'}).then(()=>1)`);
await sleep(600);
check('same-origin request is handled by the worker',
  events.some(e => e.method === 'Network.responseReceived'
    && e.params.response.url.endsWith('/manifest.json')
    && e.params.response.fromServiceWorker));

// 5b. regression guard: images must NOT be intercepted, or the gap-gauge car
// blinks once per animation frame (see README §17.9)
events.length = 0;
await evaluate(`fetch('/icons/icon-192.png',{cache:'no-store'}).then(()=>1)`);
await sleep(600);
const imgHits = events.filter(e => e.method === 'Network.responseReceived'
  && e.params.response.url.endsWith('/icons/icon-192.png'));
check('images bypass the worker (no per-frame blink)',
  imgHits.length > 0 && !imgHits.some(e => e.params.response.fromServiceWorker),
  imgHits.length + ' response(s)');

// 6. network-first: a redeploy is picked up immediately, cache never goes stale
await evaluate(`fetch('/swprobe.txt',{cache:'no-store'}).then(r=>r.text())`);
await sleep(300);
writeFileSync(`${ROOT}/swprobe.txt`, 'SECOND\n');
await sleep(300);
const probe = await evaluate(`fetch('/swprobe.txt',{cache:'no-store'}).then(r=>r.text())`);
check('online: network wins, cache never goes stale', probe.trim() === 'SECOND', 'got "' + probe.trim() + '"');

// 7 + 8. offline behaviour
await offline(true);
await navigate(`${ORIGIN}/`);
await sleep(1200);
const shell = await evaluate(`({title:document.title,len:document.body.innerText.length})`);
check('offline: shell still renders from cache',
  shell && shell.title === 'STINT9 Add-on' && shell.len > 50,
  `title="${shell && shell.title}", ${shell && shell.len} chars`);
const off = await evaluate(`fetch('/swprobe.txt').then(r=>r.text()).catch(()=>'THREW')`);
check('offline: cached copy is served as fallback', off.trim() === 'SECOND', 'got "' + off.trim() + '"');
await offline(false);

// 9. the escape hatch
await navigate(`${ORIGIN}/?nosw=1`);
await sleep(4000); // it reloads once on purpose — see README §17
const after = await evaluate(`(async()=>{const rs=await navigator.serviceWorker.getRegistrations();const ks=await caches.keys();return {regs:rs.length,caches:ks.length}})()`);
check('?nosw=1 unregisters and wipes caches',
  after && after.regs === 0 && after.caches === 0, JSON.stringify(after));

try { rmSync(`${ROOT}/swprobe.txt`); } catch {}

const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
ws.close();
process.exit(failed ? 1 : 0);
