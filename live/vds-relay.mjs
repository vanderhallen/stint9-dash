/* vds-relay.mjs — VDS live-timing → Supabase bridge (STANDALONE, no browser, no auth).
 * ===========================================================================
 * NEW race-day path (2026-07-13). Replaces the Clerk-gated browser collector.
 *
 * livetiming.vdsmotorsport.com talks to a PUBLIC WebSocket:
 *     wss://livetiming.azurewebsites.net/
 * Subscribe with { eventId, eventPid:[0,4], clientLocalTime } and it pushes
 * leaderboard snapshots: { EXPORTID, SESSION, HEAT, TRACKNAME, RESULT:[car…] }.
 * No login, no cookie, so a plain Node process can consume it — the exact thing
 * live/stint9-api.md said a standalone scraper *couldn't* do with the stint9 API.
 *
 * VDS car fields are UPPERCASE but 1:1 with what we already store:
 *   STNR→car  CLASSNAME→klass  NAME→driver  CAR→vehicle  LAPS→lap
 *   LASTLAPTIME→lap_time  S1TIME..S5TIME→s1..s5  (S6..S9 exist for 24h/9-sector)
 * Target: public.stint9_live_timing (same table the LIVE view reads).
 *
 * USAGE
 *   node live/vds-relay.mjs --watch            # RACE-DAY: scan until an event is
 *                                              #   live, then auto-start the relay
 *   node live/vds-relay.mjs --watch --range 1-80
 *   node live/vds-relay.mjs <eventId>          # known id: subscribe + upsert
 *   EVENT_ID=24 node live/vds-relay.mjs        # eventId via env
 *   node live/vds-relay.mjs <eventId> --dry    # log + map, but DON'T write Supabase
 *   node live/vds-relay.mjs --detect 19 20 24  # one-shot: is any of these live now?
 *
 * WIGE note: livetiming.azurewebsites.net IS the WIGE timing backend (channels
 * [0,4], Origin livetiming.wige.de — see live/wige-scrape/config.ts); vdsmotorsport.com
 * and wige.de are just front-ends onto it, so this already reads WIGE directly.
 * If a distinct wige.de socket ever appears, set WIGE_WS_URL=wss://… and it is
 * tried FIRST; whichever endpoint yields a live snapshot is the one used.
 *
 * Requires Node >= 22 (global WebSocket + fetch). No npm deps.
 *
 * Every raw snapshot is appended to live/logs/vds-<eventId>-<date>.jsonl so the
 * FIRST live event doubles as ground-truth verification of the field shapes
 * flagged "verify on first live snapshot" below.
 * ===========================================================================
 */

const WS_URL = process.env.WS_URL || 'wss://livetiming.azurewebsites.net/';
// Endpoints tried in order. A real wige.de socket (if one ever exists) wins over
// the Azure/WIGE backend — implements "prefer WIGE if found".
const ENDPOINTS = [process.env.WIGE_WS_URL, WS_URL].filter(Boolean);
const SB_URL = process.env.SB_URL || 'https://esvvzgxqnfszhttdkuzc.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_svmP7ATfuf9eK-jJGXjlYQ_qC8nONLU';
const UPSERT_MIN_MS = Number(process.env.UPSERT_MIN_MS || 4000); // throttle writes

import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(HERE, 'logs');

// ---- CLI --------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const DETECT = args.includes('--detect');
const WATCH = args.includes('--watch');
// --range a-b  (inclusive) expands to a candidate eventId list for scan modes.
function parseRange() {
  const i = args.indexOf('--range');
  if (i >= 0 && args[i + 1]) {
    const m = args[i + 1].match(/^(\d+)-(\d+)$/);
    if (m) { const out = []; for (let n = +m[1]; n <= +m[2]; n++) out.push(String(n)); return out; }
  }
  return null;
}
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--range');
const EVENT_ID = process.env.EVENT_ID || (!DETECT && !WATCH ? positional[0] : undefined);
const DEFAULT_RANGE = parseRange() || (positional.length ? positional : Array.from({ length: 80 }, (_, i) => String(i + 1)));
const DETECT_IDS = DETECT ? (positional.length ? positional : ['19', '20', '21', '22', '23', '24', '25']) : [];
const POLL_MS = Number(process.env.WATCH_POLL_MS || 30000); // gap between scan sweeps

// ---- parsing helpers (shared shape with live/collector.js) ------------------
const p2 = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

// "1:23.456" | "83.456" | 83.456 | ""/null  ->  seconds | null
function secOrNull(v) {
  if (v == null || v === '' || v === '-') return null;
  if (Number.isFinite(+v)) return +v;
  let x = 0; for (const q of String(v).split(':')) x = x * 60 + parseFloat(q);
  return Number.isFinite(x) ? x : null;
}
// time-of-day (ISO | epoch-ms | "hh:mm:ss") -> seconds-of-day | null
function todSeconds(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d{1,2}:\d{2}:\d{2}/.test(v)) return secOrNull(v);
  const d = new Date(Number.isFinite(+v) ? +v : v);
  if (isNaN(d.getTime())) return null;
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
}

// P1-4: the lap's time-of-day is TOD on the message ROOT (numeric, epoch-ms),
// NOT a per-car field — verified by the stint9 owner against a season of NLS
// feed. We still probe these per-car keys first in case a future feed exposes a
// real per-car crossing time, but the true base is root TOD (snapshot time).
// Receipt time is only a last resort so a car still gets placed on track.
// Caveat: root TOD is the snapshot time, not the per-car line-crossing time.
const TOD_KEYS = ['TAGESZEIT', 'TIMEOFDAY', 'LASTLAPTIMEOFDAY', 'LASTPASSING', 'CROSSINGTIME'];
function lapEndTod(car, rootTodSecs) {
  for (const k of TOD_KEYS) if (car[k] != null && car[k] !== '') return todSeconds(car[k]);
  return rootTodSecs; // P1-4: root TOD (falls back to receipt time only if TOD absent)
}

function mapSnapshot(msg, ed) {
  // P1-4: base time-of-day from root TOD; receipt time only if the feed omits it.
  const rootTod = msg.TOD != null && msg.TOD !== '' ? todSeconds(msg.TOD) : todSeconds(Date.now());
  // P2: sector count from the feed, not hardcoded — NLS=5 today, 24h=9. The table
  // has s1..s5, so we cap at 5 here (a warning fires on first snapshot if >5 so we
  // know to widen the schema for the 9-sector case). NROFINTERMEDIATETIMES absent → 5.
  const nSectors = Math.max(1, Number(msg.NROFINTERMEDIATETIMES) || 5);
  const rows = [];
  for (const c of msg.RESULT || []) {
    const car = String(c.STNR ?? '').trim();
    const lap = Number(c.LAPS ?? c.LAP);
    if (!car || !Number.isFinite(lap)) continue;
    const sec = {};
    for (let k = 1; k <= 5; k++) sec['s' + k] = k <= nSectors ? secOrNull(c['S' + k + 'TIME']) : null;
    rows.push({
      event_date: ed, car, lap,
      klass: c.CLASSNAME ?? null,
      ...sec,
      lap_end_tod: lapEndTod(c, rootTod),
      lap_time: secOrNull(c.LASTLAPTIME),
      inpit: false,          // build-db reads inpit; PITSTOPCOUNT delta lands in pass 2 (needs per-car state)
      fastest: false,        // build-db recomputes the fastest flag
      driver: c.NAME ?? null,
      vehicle: c.CAR ?? null,
      updated_at: new Date().toISOString(),
    });
  }
  return rows;
}

// P1-2: WIGE serves multiple series at once, so "first live RESULT" can latch
// the wrong race. Only latch an event whose TRACKNAME matches NLS/Nordschleife.
// Override with TRACK_MATCH (e.g. TRACK_MATCH=. to accept anything, or a specific
// circuit). A manually pinned <eventId> (run/detect path) bypasses the scan entirely.
const TRACK_RE = new RegExp(process.env.TRACK_MATCH || 'n[uü]rburgring|nordschleife', 'i');
function acceptEvent(m) { return TRACK_RE.test(String(m.TRACKNAME || '')); }

async function upsert(rows) {
  if (!rows.length || DRY) return;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const res = await fetch(SB_URL + '/rest/v1/stint9_live_timing?on_conflict=event_date,car,lap', {
      method: 'POST',
      headers: {
        apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error('supabase ' + res.status + ': ' + (await res.text()).slice(0, 200));
  }
}

async function logRaw(eventId, msg) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(join(LOG_DIR, `vds-${eventId}-${today()}.jsonl`), JSON.stringify(msg) + '\n');
  } catch (e) { console.warn('[relay] log write failed:', e.message); }
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- detect mode ------------------------------------------------------------
async function detect() {
  log(`DETECT — probing eventIds ${DETECT_IDS.join(',')} on ${WS_URL}`);
  const ws = new WebSocket(WS_URL);
  const found = new Set();
  const timer = setTimeout(() => { log('detect: done (12s).'); ws.close(); process.exit(0); }, 12000);
  ws.addEventListener('open', () => {
    for (const id of DETECT_IDS) ws.send(JSON.stringify({ eventId: id, eventPid: [0, 4], clientLocalTime: Date.now() }));
  });
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.PID === 'LTS_TIMESYNC') return;
    if (m.PID === 'LTS_NOT_FOUND') return;
    const id = m.EXPORTID ?? '(?)';
    if (found.has(id)) return;
    found.add(id);
    log(`LIVE  event=${id}  SESSION=${m.SESSION}  HEAT=${m.HEAT}${m.HEATTYPE ? '[' + m.HEATTYPE + ']' : ''}  TRACK=${m.TRACKNAME}  cars=${(m.RESULT || []).length}`);
    if ((m.RESULT || []).length) log('       sample car0:', JSON.stringify(m.RESULT[0]).slice(0, 300));
  });
  ws.addEventListener('close', e => { clearTimeout(timer); if (!found.size) log(`detect: no live event among ${DETECT_IDS.join(',')} (all LTS_NOT_FOUND / closed ${e.code}).`); process.exit(0); });
  ws.addEventListener('error', e => log('detect error:', e.message || e.type));
}

// ---- watch mode: scan endpoints × eventIds until one goes live, then relay ---
const stat = { snapshots: 0, upserts: 0, rows: 0, lastUpsert: 0, notFound: 0, firstShown: false, driftWarned: false, ed: today() };
let activeUrl = ENDPOINTS[ENDPOINTS.length - 1]; // default = Azure/WIGE backend
let activeEventId = EVENT_ID;

// One scan sweep: subscribe to every candidate id on `url`, resolve the first
// live snapshot's {url, eventId, msg}, or null after `waitMs`.
function scanOnce(url, ids, waitMs = 12000) {
  return new Promise(resolve => {
    let ws, done = false;
    const rejected = new Set();
    const finish = v => { if (done) return; done = true; clearTimeout(t); try { ws && ws.close(); } catch {} resolve(v); };
    const t = setTimeout(() => finish(null), waitMs);
    try { ws = new WebSocket(url); } catch { return finish(null); }
    ws.addEventListener('open', () => { for (const id of ids) ws.send(JSON.stringify({ eventId: id, eventPid: [0, 4], clientLocalTime: Date.now() })); });
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.PID === 'LTS_TIMESYNC' || m.PID === 'LTS_NOT_FOUND') return;
      if (!Array.isArray(m.RESULT) || !m.RESULT.length) return;
      const id = String(m.EXPORTID ?? '');
      // P1-2: latch only on a track match; log every rejected candidate once so a
      // human can see what was passed over (concurrent series on the same socket).
      if (acceptEvent(m)) finish({ url, eventId: id, msg: m });
      else if (id && !rejected.has(id)) { rejected.add(id); log(`  scan: rejecting event=${id} TRACK="${m.TRACKNAME}" (no ${TRACK_RE.source} match)`); }
    });
    ws.addEventListener('error', () => finish(null));
    ws.addEventListener('close', () => finish(null));
  });
}

async function watch() {
  log(`WATCH start  endpoints=[${ENDPOINTS.join(', ')}]  ids=${DEFAULT_RANGE[0]}..${DEFAULT_RANGE[DEFAULT_RANGE.length - 1]} (${DEFAULT_RANGE.length})  sweep every ${POLL_MS / 1000}s  dry=${DRY}`);
  let sweeps = 0;
  for (;;) {
    for (const url of ENDPOINTS) {                    // WIGE_WS_URL first if set
      const hit = await scanOnce(url, DEFAULT_RANGE);
      if (hit && hit.eventId) {
        log(`LIVE FOUND  event=${hit.eventId}  SESSION=${hit.msg.SESSION}  HEAT=${hit.msg.HEAT}  TRACK=${hit.msg.TRACKNAME}  cars=${hit.msg.RESULT.length}  via ${url}`);
        activeUrl = url; activeEventId = hit.eventId;
        return startRelay();                          // hand off; never returns
      }
    }
    sweeps++;
    if (sweeps % 5 === 1) log(`no live event yet (sweep ${sweeps}) — retrying every ${POLL_MS / 1000}s…`);
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// ---- relay mode -------------------------------------------------------------
function run() {
  if (!activeEventId) { console.error('ERROR: no eventId. Use --watch to auto-find, or pass <eventId>.'); process.exit(1); }
  startRelay();
}
function startRelay() {
  log(`RELAY start  event=${activeEventId}  date=${stat.ed}  dry=${DRY}  via ${activeUrl}  -> ${DRY ? '(no writes)' : SB_URL}`);
  startWatchdog();
  connect();
}

// P2: stall watchdog. A silent socket (no data, not even a heartbeat) is the
// failure mode you don't notice from the dashboard until laps go missing. If
// NOTHING — including LTS_TIMESYNC — arrives for WATCHDOG_MS, force a reconnect.
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS || 60000);
let lastMsgAt = Date.now();
let currentWs = null;
let watchdogTimer = null;
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    const gap = Date.now() - lastMsgAt;
    if (gap > WATCHDOG_MS) {
      log(`watchdog: no message for ${Math.round(gap / 1000)}s — forcing reconnect`);
      lastMsgAt = Date.now();                    // reset so we don't re-trigger before the new socket opens
      try { currentWs && currentWs.close(); } catch {}  // close → 'close' handler → reconnect()
    }
  }, Math.min(WATCHDOG_MS, 15000));
}

let backoff = 1000;
function connect() {
  let ws;
  try { ws = new WebSocket(activeUrl); }
  catch (e) { log('WS construct failed:', e.message); return reconnect(); }
  currentWs = ws;
  lastMsgAt = Date.now();

  ws.addEventListener('open', () => {
    backoff = 1000;
    lastMsgAt = Date.now();
    // P2: re-send the subscribe frame on EVERY open, so a reconnect re-joins the feed.
    ws.send(JSON.stringify({ eventId: activeEventId, eventPid: [0, 4], clientLocalTime: Date.now() }));
    log(`connected — subscribed to event ${activeEventId} (channel [0,4])`);
  });

  ws.addEventListener('message', async ev => {
    lastMsgAt = Date.now();                              // any frame (incl. heartbeat) resets the watchdog
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.PID === 'LTS_TIMESYNC') return;                 // heartbeat
    if (m.PID === 'LTS_NOT_FOUND') {                      // event not live yet
      if (stat.notFound++ % 20 === 0) log(`event ${activeEventId} not live yet (LTS_NOT_FOUND) — staying subscribed…`);
      return;
    }
    if (!Array.isArray(m.RESULT)) return;                 // ignore anything without a leaderboard

    // P1-2: warn (once) if the feed starts reporting a different EXPORTID than the
    // one we latched — catches a feed-side event switch under our subscription.
    if (!stat.driftWarned && m.EXPORTID != null && String(m.EXPORTID) !== String(activeEventId)) {
      stat.driftWarned = true;
      log(`⚠ EXPORTID ${m.EXPORTID} != latched event ${activeEventId} — feed may have switched events; re-pin with <eventId> if wrong`);
    }

    stat.snapshots++;
    stat.ed = today();
    await logRaw(activeEventId, m);

    if (!stat.firstShown) {
      stat.firstShown = true;
      log(`FIRST snapshot  SESSION=${m.SESSION} HEAT=${m.HEAT} TRACK=${m.TRACKNAME} cars=${m.RESULT.length}`);
      log(`  root TOD: ${m.TOD ?? '(absent → receipt time)'}   NROFINTERMEDIATETIMES: ${m.NROFINTERMEDIATETIMES ?? '(absent → assuming 5)'}`);
      if (Number(m.NROFINTERMEDIATETIMES) > 5) log(`  ⚠ ${m.NROFINTERMEDIATETIMES} sectors but table has only s1..s5 — widen schema for 9-sector events`);
      if (m.RESULT[0]) {
        const c = m.RESULT[0];
        log('  car0 keys:', Object.keys(c).join(','));
        log('  per-car TOD field:', TOD_KEYS.find(k => c[k] != null && c[k] !== '') || `(none → using root TOD ${m.TOD ?? '/ receipt time'})`);
        log('  car0 raw:', JSON.stringify(c).slice(0, 400));
      }
    }

    // throttle Supabase writes
    const now = Date.now();
    if (now - stat.lastUpsert < UPSERT_MIN_MS) return;
    stat.lastUpsert = now;
    try {
      const rows = mapSnapshot(m, stat.ed);
      await upsert(rows);
      stat.upserts++; stat.rows = rows.length;
      log(`snapshot ${stat.snapshots}: ${rows.length} cars ${DRY ? 'mapped (dry)' : '-> Supabase'} (HEAT ${m.HEAT})`);
    } catch (e) { log('upsert error:', e.message); }
  });

  ws.addEventListener('error', e => log('WS error:', e.message || e.type));
  ws.addEventListener('close', e => { log(`connection closed (code ${e.code}${e.reason ? ': ' + e.reason : ''})`); reconnect(); });
}

let reconnectTimer = null;
function reconnect() {
  if (reconnectTimer) return;
  const wait = backoff;
  backoff = Math.min(backoff * 2, 30000);
  log(`reconnecting in ${wait} ms…`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
}

// Only auto-run when invoked as a script; stay inert (just export the mapper) when
// imported by a test so the replay harness can exercise mapSnapshot/acceptEvent.
const INVOKED_AS_SCRIPT = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (INVOKED_AS_SCRIPT) {
  process.on('SIGINT', () => { log('SIGINT — stats:', JSON.stringify(stat)); process.exit(0); });
  if (DETECT) detect(); else if (WATCH) watch(); else run();
}

export { mapSnapshot, acceptEvent, lapEndTod, secOrNull, todSeconds };
