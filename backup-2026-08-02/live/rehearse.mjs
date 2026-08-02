/* rehearse.mjs — end-to-end LIVE rehearsal against the real Supabase.
 *
 * Pushes a mid-race snapshot (from the 2026-06-20 CSV) into stint9_live_timing
 * under TODAY's date via the public write path, reads it back via the anon read
 * path the dashboard uses, and runs the real buildLiveDB — verifying the exact
 * pipeline the LIVE loop depends on, no live event or secret needed.
 *
 *   node live/rehearse.mjs [--min 90]     (# race-minutes of data to load)
 *   node live/rehearse.mjs --clean        (delete today's rehearsal rows)
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const buildLiveDB = require('./build-db.js');

const SB = 'https://esvvzgxqnfszhttdkuzc.supabase.co';
const KEY = 'sb_publishable_svmP7ATfuf9eK-jJGXjlYQ_qC8nONLU';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const p = n => String(n).padStart(2, '0');
const ED = (() => { const d = new Date(); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

async function clean() {
  const r = await fetch(`${SB}/rest/v1/stint9_live_timing?event_date=eq.${ED}`, { method: 'DELETE', headers: H });
  console.log('cleaned event_date=' + ED + ' ->', r.status);
}
if (process.argv.includes('--clean')) { await clean(); process.exit(0); }

// ---- parse CSV into raw rows (same as the collector produces) ----
const tod = s => { const [h, m, r] = s.trim().split(':'); return (+h) * 3600 + (+m) * 60 + parseFloat(r); };
const sec = s => { s = s.trim(); if (!s) return null; let v = 0; for (const q of s.split(':')) v = v * 60 + parseFloat(q); return v; };
const numde = s => { s = s.trim(); return s ? parseFloat(s.replace(',', '.')) : null; };
const buf = readFileSync('source/vln-2026-06-20-sektorzeiten.CSV');
const lines = new TextDecoder('windows-1252').decode(buf).split(/\r?\n/).filter(l => l.length);
const head = lines[0].split(';'); const idx = {}; head.forEach((h, i) => idx[h.trim()] = i);
const col = (c, k) => { const i = idx[k]; return i == null ? '' : (c[i] ?? ''); };
let rows = [];
for (let li = 1; li < lines.length; li++) {
  const c = lines[li].split(';');
  const s = [1, 2, 3, 4, 5].map(k => sec(col(c, 'SEKTOR' + k + '_ZEIT')));
  if (s.every(x => x === null)) continue;
  const dn = col(c, 'FAHRER_NR').trim();
  rows.push({
    event_date: ED, car: col(c, 'STNR').trim(), lap: parseInt(col(c, 'RUNDE_NR'), 10), klass: col(c, 'KLASSEKURZ').trim(),
    s1: s[0], s2: s[1], s3: s[2], s4: s[3], s5: s[4],
    lap_end_tod: tod(col(c, 'TAGESZEIT')), lap_time: numde(col(c, 'RUNDENZEIT_IN_SEKUNDEN')),
    inpit: col(c, 'INPIT').trim() === 'J', fastest: col(c, 'DIESCHNELLSTE').trim() === 'J',
    driver: (col(c, 'FAHRER' + dn + '_NAME').trim() || col(c, 'FAHRER1_NAME').trim()), vehicle: col(c, 'FAHRZEUG').trim(),
  });
}
const t0 = Math.min(...rows.map(r => r.lap_end_tod));
const cutoff = t0 + (+arg('min', 90)) * 60;
const snap = rows.filter(r => r.lap_end_tod <= cutoff);
console.log(`snapshot: ${snap.length}/${rows.length} laps up to +${arg('min', 90)}min, event_date=${ED}`);

// ---- WRITE via public path (batches) ----
await clean();
for (let i = 0; i < snap.length; i += 500) {
  const r = await fetch(`${SB}/rest/v1/stint9_live_timing?on_conflict=event_date,car,lap`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(snap.slice(i, i + 500)),
  });
  if (!r.ok) { console.error('write failed', r.status, (await r.text()).slice(0, 200)); process.exit(1); }
}
console.log('write OK (public publishable key)');

// ---- READ back via the anon path the dashboard uses ----
const rr = await fetch(`${SB}/rest/v1/stint9_live_timing?select=car,lap,klass,s1,s2,s3,s4,s5,lap_end_tod,lap_time,inpit,fastest,driver,vehicle&event_date=eq.${ED}&order=car,lap`, { headers: H });
const back = await rr.json();
console.log('read back:', back.length, 'rows');

// ---- run the real buildLiveDB (exactly what the LIVE loop does) ----
const raw = back.map(r => ({ car: String(r.car), lap: r.lap, klass: r.klass, s: [r.s1, r.s2, r.s3, r.s4, r.s5], tend: r.lap_end_tod, rt: r.lap_time, inpit: !!r.inpit, fast: !!r.fastest, drv: r.driver, veh: r.vehicle }));
const geom = JSON.parse(readFileSync('tools/geom.json', 'utf8'));
const DB = buildLiveDB(raw, geom, { name: 'REHEARSAL', date: ED });

// sanity: biggest class, its leader at the latest boundary
const bigCls = Object.keys(DB.classes).sort((a, b) => DB.classes[b].length - DB.classes[a].length)[0];
let leader = null, lb = 1e9;
for (const car of DB.classes[bigCls]) {
  const ch = DB.chart[car]; if (!ch || !ch.length) continue;
  const last = ch[ch.length - 1];              // latest boundary for this car
  if (last[1] === 1 && last[2] < lb) { lb = last[2]; leader = car; }
}
const onTrack = DB.cars.filter(c => { const ch = DB.chart[c]; return ch && ch.length; }).length;
console.log('\n=== buildLiveDB result ===');
console.log('cars:', DB.cars.length, ' classes:', Object.keys(DB.classes).length, ' on-track:', onTrack);
console.log('tmin..tmax:', DB.tmin?.toFixed?.(0), '..', DB.tmax?.toFixed?.(0));
console.log(`biggest class ${bigCls}: ${DB.classes[bigCls].length} cars, current P1 = #${leader} (${DB.name[leader] || ''})`);
console.log('sample legs for leader:', (DB.legs[leader] || []).length, 'boundaries; pits:', JSON.stringify(DB.pits[leader] || []));
const okCls = Object.keys(DB.classes).length > 0, okCars = DB.cars.length > 0, okLeader = !!leader;
console.log('\n' + (okCls && okCars && okLeader
  ? '✅ REHEARSAL PASS — public write -> anon read -> buildLiveDB all OK. Open the dashboard and click LIVE to view this snapshot.'
  : '❌ REHEARSAL FAIL — see above'));
process.exit(okCls && okCars && okLeader ? 0 : 1);
