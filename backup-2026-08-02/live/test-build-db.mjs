/* test-build-db.mjs — prove live/build-db.js reproduces tools/gen_db.py's DB.
 *
 * Parses the real VLN sector CSV into raw rows (the exact shape the WIGE scraper
 * will upsert into public.stint9_live_timing), rebuilds the DB with buildLiveDB,
 * and diffs it against tools/newDB.json (the gen_db.py reference).
 *
 *   node live/test-build-db.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const buildLiveDB = require('./build-db.js');

const CSV = 'source/vln-2026-06-20-sektorzeiten.CSV';
const REF = 'tools/newDB.json';
const GEOM = 'tools/geom.json';

// ---- helpers mirroring gen_db.py ----
const tod = s => { const [h, m, rest] = s.trim().split(':'); return (+h) * 3600 + (+m) * 60 + parseFloat(rest); };
const sec = s => { s = s.trim(); if (!s) return null; let v = 0; for (const p of s.split(':')) v = v * 60 + parseFloat(p); return v; };
const numde = s => { s = s.trim(); return s ? parseFloat(s.replace(',', '.')) : null; };

// ---- parse CSV (cp1252, ';' delimited) into raw rows ----
function parseCsv() {
  const buf = readFileSync(CSV);
  const text = new TextDecoder('windows-1252').decode(buf);
  const lines = text.split(/\r?\n/).filter(l => l.length);
  const head = lines[0].split(';');
  const idx = {}; head.forEach((h, i) => idx[h.trim()] = i);
  const col = (cells, k) => { const i = idx[k]; return i == null ? '' : (cells[i] ?? ''); };
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = lines[li].split(';');
    const s = [1, 2, 3, 4, 5].map(k => sec(col(cells, 'SEKTOR' + k + '_ZEIT')));
    if (s.every(x => x === null)) continue;
    const drvNr = col(cells, 'FAHRER_NR').trim();
    const drv = (col(cells, 'FAHRER' + drvNr + '_NAME').trim() || col(cells, 'FAHRER1_NAME').trim());
    rows.push({
      car: col(cells, 'STNR').trim(),
      lap: parseInt(col(cells, 'RUNDE_NR'), 10),
      klass: col(cells, 'KLASSEKURZ').trim(),
      s,
      tend: tod(col(cells, 'TAGESZEIT')),
      rt: numde(col(cells, 'RUNDENZEIT_IN_SEKUNDEN')),
      inpit: col(cells, 'INPIT').trim() === 'J',
      fast: col(cells, 'DIESCHNELLSTE').trim() === 'J',
      drv,
      veh: col(cells, 'FAHRZEUG').trim(),
    });
  }
  return rows;
}

// ---- compare ----
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  ✗ ' + msg); fails++; } };
const near = (a, b, eps = 0.02) => a == null && b == null ? true : (a != null && b != null && Math.abs(a - b) <= eps);

const rows = parseCsv();
const geom = JSON.parse(readFileSync(GEOM, 'utf8'));
const ref = JSON.parse(readFileSync(REF, 'utf8'));
const got = buildLiveDB(rows, geom, ref.event);

console.log(`parsed ${rows.length} raw rows -> ${got.cars.length} cars`);

// cars
const refCars = new Set(Object.keys(ref.legs));
ok(got.cars.length === refCars.size, `car count ${got.cars.length} == ${refCars.size}`);
for (const c of got.cars) ok(refCars.has(c), `car ${c} present in ref`);

// classes + maxN
ok(JSON.stringify(Object.keys(got.classes).sort()) === JSON.stringify(Object.keys(ref.classes).sort()), 'class set matches');
for (const cls of Object.keys(ref.classes)) {
  ok(got.classMaxN[cls] === ref.classMaxN[cls], `classMaxN[${cls}] ${got.classMaxN[cls]} == ${ref.classMaxN[cls]}`);
  ok(JSON.stringify(got.classes[cls]) === JSON.stringify(ref.classes[cls]), `class members [${cls}] match`);
}

// pits
for (const c of got.cars) ok(JSON.stringify(got.pits[c]) === JSON.stringify(ref.pits[c]), `pits[${c}] match`);

// legs — boundary times within epsilon
let legCells = 0, legBad = 0;
for (const c of got.cars) {
  const a = got.legs[c], b = ref.legs[c];
  if (a.length !== b.length) { ok(false, `legs[${c}] length ${a.length} == ${b.length}`); continue; }
  for (let i = 0; i < a.length; i++) {
    legCells++;
    if (!(a[i][0] === b[i][0] && a[i][1] === b[i][1] && near(a[i][2], b[i][2]) && near(a[i][3], b[i][3]))) legBad++;
  }
}
ok(legBad === 0, `legs boundary times match (${legBad}/${legCells} off)`);

// chart — POSITIONS must match exactly (this is the whole point of LIVE ranking)
let posCells = 0, posBad = 0;
for (const c of got.cars) {
  const a = got.chart[c], b = ref.chart[c];
  if (a.length !== b.length) { ok(false, `chart[${c}] length ${a.length} == ${b.length}`); continue; }
  for (let i = 0; i < a.length; i++) { posCells++; if (a[i][1] !== b[i][1]) posBad++; }
}
ok(posBad === 0, `chart positions match exactly (${posBad}/${posCells} off)`);

// lappos — per-lap finishing positions
let lpBad = 0, lpCells = 0;
for (const c of got.cars) {
  for (const L of Object.keys(ref.lappos[c])) { lpCells++; if (got.lappos[c][L] !== ref.lappos[c][L]) lpBad++; }
}
ok(lpBad === 0, `lappos match (${lpBad}/${lpCells} off)`);

console.log(fails === 0
  ? `\n✅ PASS — build-db.js reproduces gen_db.py (${legCells} leg cells, ${posCells} positions verified)`
  : `\n❌ FAIL — ${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
