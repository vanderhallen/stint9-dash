/* Rewind audit — proves the dashboard renders the SAME clock the same way no
   matter how it got there. SIM lets you drag the scrubber backwards, and any
   panel that keeps a forward-only accumulator instead of deriving itself from T
   goes on showing a part of the race that hasn't happened yet (the bug the
   racenote feed, the SNAP reel and the VIDEO reel count all had — README §20).

   It renders one clock T2 two ways and diffs the DOM:
     A) fresh load, scrub straight to T2
     B) fresh load, scrub to a late clock, then back to T2
   Any panel where A ≠ B is carrying state a scrub back doesn't rewind. It also
   flags panels that render identically at an early and a late clock — the
   "ignores T altogether" flavour of the same defect (most of those are correct:
   static schedules, hidden boxes).

   Drives real headless Chrome over the DevTools Protocol. No npm deps: node ≥ 22
   has a global WebSocket. Run from the repo root:

     python3 -m http.server 8791 --bind 127.0.0.1 &                  # the site
     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        --headless=new --remote-debugging-port=9222 \
        --user-data-dir=/tmp/rw-chrome --no-first-run about:blank &
     node tools/rewind-audit.mjs

   RW_EVENT picks the archived event to replay (default NLS7 — a full 6h race, so
   the two clocks are far apart). RW_EARLY / RW_LATE are fractions of the replay. */

const ORIGIN = process.env.RW_ORIGIN || 'http://127.0.0.1:8791';
const CDP = process.env.RW_CDP || 'http://127.0.0.1:9222';
const EVENT = process.env.RW_EVENT || 'NLS7';
const EARLY = parseFloat(process.env.RW_EARLY || '0.35');
const LATE = parseFloat(process.env.RW_LATE || '0.85');

// every panel that is supposed to be a function of the clock
const PANELS = ['rn-feed', 'rn-summary', 'cmpbody', 'gapchart', 'dots', 'carbadge', 'predsvg',
  'miniEv', 'gapgauge', 'fuelmini', 'fuelpanel', 'fuellog', 'sectabwrap', 'lapchart', 'flowsvg',
  'sectorsvg', 'ltgraph', 'stintsvg', 'compsvg', 'gridtablewrap', 'snaptablewrap', 'drvtablewrap',
  'p1compsvg', 'p1barsvg', 'gridwrap', 'code60banner', 'feedbanner', 'clock', 'msglist',
  'vr-count', 'vr-car', 'champreel', 'timetable', 'm_stand'];
// #gridclock is a live countdown to the next race weekend — it is *meant* to move
// with the wall clock, so it can never match between two runs.
const IGNORE = new Set(['gridclock']);
// STINT hands each driver a palette colour the first time that driver is drawn
// (stintDrvColor), so which colour a driver gets depends on how far the replay has
// been — but a colour, once given, is never reassigned, so nothing changes on screen
// mid-session. Compare its geometry and labels, not its palette indices.
const NORMALIZE = { stintsvg: s => s.replace(/fill="#[0-9a-f]{3,6}"/gi, 'fill=*') };

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
  } else if (m.method) events.push(m);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}
async function navigate(url) {
  const before = events.length;
  await send('Page.navigate', { url });
  for (let i = 0; i < 150; i++) {
    if (events.slice(before).some(e => e.method === 'Page.loadEventFired')) return;
    await sleep(100);
  }
}
await send('Page.enable');
await send('Runtime.enable');

// One run: load, enter as a guest, pause, walk the scrubber through `path`
// (fractions of the replay, in order), then snapshot every panel.
async function run(path) {
  await navigate(`${ORIGIN}/index.html?event=${encodeURIComponent(EVENT)}&nosw=1`);
  await sleep(3500);
  await evaluate(`(()=>{const m=document.getElementById('loginModal');if(m&&m.classList.contains('on'))document.getElementById('optDemo').click();return true})()`);
  await sleep(2500);
  // the race-control board fetches from Supabase — wait for it, or an unlanded
  // fetch looks exactly like a rewind difference
  for (let i = 0; i < 75; i++) {
    if (!await evaluate(`/No race-control messages/.test(document.getElementById('msglist').textContent)`)) break;
    await sleep(400);
  }
  await evaluate(`document.getElementById('play').click()`);   // pause playback
  await sleep(300);
  for (const f of path) {
    await evaluate(`(()=>{const s=document.getElementById('scrub');s.value=String(+s.min+${f}*(+s.max-+s.min));s.dispatchEvent(new Event('input'));return true})()`);
    // settle: the reels only repaint on the 300ms thumbnail tick
    for (let i = 0; i < 12; i++) {
      await sleep(200);
      await evaluate(`(()=>{document.getElementById('scrub').dispatchEvent(new Event('input'));return true})()`);
    }
  }
  return evaluate(`(()=>{const ids=${JSON.stringify(PANELS)};const o={};
    ids.forEach(id=>{const el=document.getElementById(id);o[id]=el?(el.innerHTML||el.textContent||''):'(missing)';});
    // the mini-map keeps a per-car <g> cache; hidden ones still hold whatever they
    // last showed, so compare only what is actually on screen
    const mg=document.getElementById('miniG');
    o['miniG(visible)']=mg?Array.from(mg.children).filter(g=>g.style.visibility!=='hidden').map(g=>g.outerHTML).join(''):'(missing)';
    return o;})()`);
}

console.log(`replaying ${EVENT}: rendering ${EARLY} directly, then via ${LATE}\n`);
const A = await run([EARLY]);
const B = await run([LATE, EARLY]);
const C = await run([LATE]);

// the race-control board is the one panel fed by a network fetch; if it never landed
// there is nothing to compare, and an empty board must not read as a rewind bug
const noMsgs = [A, B, C].some(s => /No race-control messages/.test(s.msglist || ''));
if (noMsgs) IGNORE.add('msglist');

let bad = 0;
for (const id of Object.keys(A)) {
  if (IGNORE.has(id)) continue;
  const norm = NORMALIZE[id] || (x => x);
  const a = norm(A[id]), b = norm(B[id]);
  if (a === b) continue;
  bad++;
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  console.log(`FAIL  ${id} differs after a rewind (${a.length} vs ${b.length} chars)`);
  console.log(`        direct : …${a.slice(Math.max(0, i - 50), i + 90).replace(/\s+/g, ' ')}`);
  console.log(`        rewound: …${b.slice(Math.max(0, i - 50), i + 90).replace(/\s+/g, ' ')}`);
}
if (noMsgs) console.log('SKIP  msglist — the race-control fetch never landed, nothing to compare');
if (!bad) console.log(`PASS  all ${Object.keys(A).length} panels render ${EARLY} identically however the clock got there`);

console.log('\npanels that render the same at both clocks (T-independent — each must be deliberate):');
for (const id of Object.keys(A)) if (!IGNORE.has(id) && A[id] === C[id]) console.log(`      ${id}`);

ws.close();
process.exit(bad ? 1 : 0);
