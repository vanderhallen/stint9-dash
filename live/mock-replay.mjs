/* mock-replay.mjs — raceday rehearsal without a live event.
 *
 * Streams the real VLN sector CSV into public.stint9_live_timing at an
 * accelerated pace, as if it were arriving live. Open the dashboard, flip to
 * LIVE, and watch the maps/positions fill in exactly as they will on race day.
 * This is the end-to-end test of: table -> dashboard LIVE loop -> build-db.js.
 *
 * Writes with the public publishable key (anon insert/update is allowed on this
 * table, same as the collector) — no secret needed:
 *   node live/mock-replay.mjs [--speed 60] [--date YYYY-MM-DD]
 *
 * --speed 60  = 60x real time (1 race minute per real second). Default 120.
 * --date      = event_date to write under. Default = today (matches LIVE header).
 */
import { readFileSync } from 'node:fs';

const SB_URL = 'https://esvvzgxqnfszhttdkuzc.supabase.co';
// service-role key if provided (env), else the public publishable key.
const KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_publishable_svmP7ATfuf9eK-jJGXjlYQ_qC8nONLU';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const SPEED = +arg('speed', 120);
const today = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; };
const EVENT_DATE = arg('date', today());

const tod = s => { const [h,m,r] = s.trim().split(':'); return (+h)*3600+(+m)*60+parseFloat(r); };
const sec = s => { s = s.trim(); if (!s) return null; let v=0; for (const p of s.split(':')) v=v*60+parseFloat(p); return v; };
const numde = s => { s = s.trim(); return s ? parseFloat(s.replace(',','.')) : null; };

// parse CSV -> rows sorted by lap-end time-of-day (the order they "happen")
const buf = readFileSync('source/vln-2026-06-20-sektorzeiten.CSV');
const lines = new TextDecoder('windows-1252').decode(buf).split(/\r?\n/).filter(l => l.length);
const head = lines[0].split(';'); const idx = {}; head.forEach((h,i) => idx[h.trim()] = i);
const col = (c, k) => { const i = idx[k]; return i == null ? '' : (c[i] ?? ''); };
const rows = [];
for (let li = 1; li < lines.length; li++) {
  const c = lines[li].split(';');
  const s = [1,2,3,4,5].map(k => sec(col(c, 'SEKTOR'+k+'_ZEIT')));
  if (s.every(x => x === null)) continue;
  const dn = col(c, 'FAHRER_NR').trim();
  rows.push({
    event_date: EVENT_DATE, car: col(c,'STNR').trim(), lap: parseInt(col(c,'RUNDE_NR'),10),
    klass: col(c,'KLASSEKURZ').trim(),
    s1:s[0], s2:s[1], s3:s[2], s4:s[3], s5:s[4],
    lap_end_tod: tod(col(c,'TAGESZEIT')), lap_time: numde(col(c,'RUNDENZEIT_IN_SEKUNDEN')),
    inpit: col(c,'INPIT').trim()==='J', fastest: col(c,'DIESCHNELLSTE').trim()==='J',
    driver: (col(c,'FAHRER'+dn+'_NAME').trim() || col(c,'FAHRER1_NAME').trim()),
    vehicle: col(c,'FAHRZEUG').trim(),
  });
}
rows.sort((a,b) => a.lap_end_tod - b.lap_end_tod);
const t0 = rows[0].lap_end_tod;
console.log(`replaying ${rows.length} laps under event_date=${EVENT_DATE} at ${SPEED}x (Ctrl-C to stop)`);

async function upsert(batch) {
  const res = await fetch(`${SB_URL}/rest/v1/stint9_live_timing?on_conflict=event_date,car,lap`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer '+KEY, 'Content-Type':'application/json',
               Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) console.error('upsert', res.status, await res.text());
}

// walk the rows in race-time order, flushing each ~2s of race time as a batch
const start = Date.now();
let i = 0;
async function tick() {
  const raceElapsed = (Date.now() - start) / 1000 * SPEED;      // race-seconds since start
  const cutoff = t0 + raceElapsed;
  const batch = [];
  while (i < rows.length && rows[i].lap_end_tod <= cutoff) batch.push(rows[i++]);
  if (batch.length) { await upsert(batch); process.stdout.write(`\r${i}/${rows.length} laps sent`); }
  if (i < rows.length) setTimeout(tick, 1000);
  else console.log('\ndone — full race replayed.');
}
tick();
