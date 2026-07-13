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
 *   node live/vds-relay.mjs <eventId>          # subscribe + upsert to Supabase
 *   EVENT_ID=24 node live/vds-relay.mjs        # eventId via env
 *   node live/vds-relay.mjs <eventId> --dry    # log + map, but DON'T write Supabase
 *   node live/vds-relay.mjs --detect 19 20 24  # probe which eventId is live now
 *
 * Requires Node >= 22 (global WebSocket + fetch). No npm deps.
 *
 * Every raw snapshot is appended to live/logs/vds-<eventId>-<date>.jsonl so the
 * FIRST live event doubles as ground-truth verification of the field shapes
 * flagged "verify on first live snapshot" below.
 * ===========================================================================
 */

const WS_URL = process.env.WS_URL || 'wss://livetiming.azurewebsites.net/';
const SB_URL = process.env.SB_URL || 'https://esvvzgxqnfszhttdkuzc.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_svmP7ATfuf9eK-jJGXjlYQ_qC8nONLU';
const UPSERT_MIN_MS = Number(process.env.UPSERT_MIN_MS || 4000); // throttle writes

import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(HERE, 'logs');

// ---- CLI --------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const DETECT = args.includes('--detect');
const positional = args.filter(a => !a.startsWith('--'));
const EVENT_ID = process.env.EVENT_ID || (!DETECT ? positional[0] : undefined);
const DETECT_IDS = DETECT ? (positional.length ? positional : ['19', '20', '21', '22', '23', '24', '25']) : [];

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

// VDS may expose the lap's time-of-day under one of several keys — take the
// first present. VERIFY on first live snapshot; falls back to receipt time so a
// car still gets placed on track (position will be slightly stale until fixed).
const TOD_KEYS = ['TAGESZEIT', 'TIMEOFDAY', 'TOD', 'LASTLAPTIMEOFDAY', 'LASTPASSING', 'CROSSINGTIME'];
function lapEndTod(car, receiptSecs) {
  for (const k of TOD_KEYS) if (car[k] != null && car[k] !== '') return todSeconds(car[k]);
  return receiptSecs; // fallback
}

function mapSnapshot(msg, ed) {
  const nowSecs = todSeconds(Date.now());
  const rows = [];
  for (const c of msg.RESULT || []) {
    const car = String(c.STNR ?? '').trim();
    const lap = Number(c.LAPS ?? c.LAP);
    if (!car || !Number.isFinite(lap)) continue;
    rows.push({
      event_date: ed, car, lap,
      klass: c.CLASSNAME ?? null,
      s1: secOrNull(c.S1TIME), s2: secOrNull(c.S2TIME), s3: secOrNull(c.S3TIME),
      s4: secOrNull(c.S4TIME), s5: secOrNull(c.S5TIME),
      lap_end_tod: lapEndTod(c, nowSecs),
      lap_time: secOrNull(c.LASTLAPTIME),
      inpit: false,          // build-db recomputes pit state; PITSTOPCOUNT delta TODO
      fastest: false,        // build-db recomputes the fastest flag
      driver: c.NAME ?? null,
      vehicle: c.CAR ?? null,
      updated_at: new Date().toISOString(),
    });
  }
  return rows;
}

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

// ---- relay mode -------------------------------------------------------------
const stat = { snapshots: 0, upserts: 0, rows: 0, lastUpsert: 0, notFound: 0, firstShown: false, ed: today() };

function run() {
  if (!EVENT_ID) { console.error('ERROR: no eventId. Usage: node live/vds-relay.mjs <eventId>  (or --detect).'); process.exit(1); }
  log(`RELAY start  event=${EVENT_ID}  date=${stat.ed}  dry=${DRY}  -> ${DRY ? '(no writes)' : SB_URL}`);
  connect();
}

let backoff = 1000;
function connect() {
  let ws;
  try { ws = new WebSocket(WS_URL); }
  catch (e) { log('WS construct failed:', e.message); return reconnect(); }

  ws.addEventListener('open', () => {
    backoff = 1000;
    ws.send(JSON.stringify({ eventId: EVENT_ID, eventPid: [0, 4], clientLocalTime: Date.now() }));
    log(`connected — subscribed to event ${EVENT_ID} (channel [0,4])`);
  });

  ws.addEventListener('message', async ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.PID === 'LTS_TIMESYNC') return;                 // heartbeat
    if (m.PID === 'LTS_NOT_FOUND') {                      // event not live yet
      if (stat.notFound++ % 20 === 0) log(`event ${EVENT_ID} not live yet (LTS_NOT_FOUND) — staying subscribed…`);
      return;
    }
    if (!Array.isArray(m.RESULT)) return;                 // ignore anything without a leaderboard

    stat.snapshots++;
    stat.ed = today();
    await logRaw(EVENT_ID, m);

    if (!stat.firstShown) {
      stat.firstShown = true;
      log(`FIRST snapshot  SESSION=${m.SESSION} HEAT=${m.HEAT} TRACK=${m.TRACKNAME} cars=${m.RESULT.length}`);
      if (m.RESULT[0]) {
        const c = m.RESULT[0];
        log('  car0 keys:', Object.keys(c).join(','));
        log('  TOD field detected:', TOD_KEYS.find(k => c[k] != null && c[k] !== '') || '(none → using receipt time)');
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

process.on('SIGINT', () => { log('SIGINT — stats:', JSON.stringify(stat)); process.exit(0); });

if (DETECT) detect(); else run();
