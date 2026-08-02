#!/usr/bin/env node
/* tools/archive_event.mjs — snapshot one NLS event into public.stint9_events
 * and mirror every archived event to committed events/<slug>.json files.
 *
 * WHY a snapshot (not live joins): stint9_tyre_state / stint9_band_state carry
 * NO event_date at all — they are global / point-in-time (stint9_messages now
 * does carry event_date, added 2026-08-02, but is still a live-growing table
 * best captured as a snapshot too). The only faithful archive is a bundle
 * captured at one moment. The timing half is
 * stored either as a pre-built `db` (the baked SIM event, read from data.js) or
 * as raw `timing[]` rows (future live events) that index.html re-derives via
 * window.buildLiveDB — the same path LIVE mode already uses.
 *
 * Usage:
 *   node tools/archive_event.mjs --date=2026-06-20 --from-datajs
 *       archive the baked SIM event (timing DB from ../data.js) — slug/name
 *       resolved from public.stint9_event_rounds (2026-06-20 -> NLS6)
 *   node tools/archive_event.mjs --date=2026-08-01
 *       archive a live event (timing = raw stint9_live_timing rows for that date)
 *   (slug comes from stint9_event_rounds by date; override with --slug=NLSn)
 *   node tools/archive_event.mjs --sync-files
 *       (re-)write events/*.json + events/index.json from the stint9_events table
 *
 * Plain Node ≥18, no deps. Writes with the public publishable key (soft gate,
 * same as the rest of the dashboard). Run --sync-files then let the standing
 * "commit + push after every change" workflow deploy the committed backup files.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SB = 'https://esvvzgxqnfszhttdkuzc.supabase.co';
const KEY = 'sb_publishable_svmP7ATfuf9eK-jJGXjlYQ_qC8nONLU';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS_DIR = join(ROOT, 'events');

function arg(name, def = null) {
  const p = process.argv.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (!p) return def;
  const i = p.indexOf('=');
  return i === -1 ? true : p.slice(i + 1);
}

async function sbGet(path) {
  const r = await fetch(SB + '/rest/v1/' + path, { headers: H });
  if (!r.ok) throw new Error('GET ' + path + ' -> ' + r.status + ' ' + (await r.text()));
  return r.json();
}
async function sbUpsert(table, row) {
  const r = await fetch(SB + '/rest/v1/' + table, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error('UPSERT ' + table + ' -> ' + r.status + ' ' + (await r.text()));
}

// Slug from an EXPLICIT "NLS n" pattern only — NOT from the event name's own
// leading number ("1. ADAC Eifel-Trophy" is NOT NLS1). The NLS round number
// is not in the timing/schedule data; it comes from the stint9_event_rounds
// lookup (consulted in archiveOne), with this as the last-resort fallback.
function deriveSlug(name, label, date) {
  for (const s of [label, name]) {
    if (!s) continue;
    const r = String(s).match(/NLS\s*0*(\d{1,2})/i);
    if (r) return 'NLS' + r[1];
  }
  return 'EVT-' + date;
}
// Canonical date -> { slug, name } from public.stint9_event_rounds.
async function lookupRound(date) {
  try {
    const rows = await sbGet(`stint9_event_rounds?select=slug,name&event_date=eq.${encodeURIComponent(date)}`);
    return rows && rows[0] ? rows[0] : null;
  } catch { return null; }
}

// Load the baked SIM DB from data.js (single line: `const DB = {…};`).
async function loadDataJsDB() {
  const txt = await readFile(join(ROOT, 'data.js'), 'utf8');
  const m = txt.match(/const\s+DB\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!m) throw new Error('could not parse data.js');
  return JSON.parse(m[1]);
}

async function collectOverlay(date, win) {
  const enc = encodeURIComponent(date);
  const [fuel_state, fuel_notes, racenotes, tyre_state, band_state, weather, laptimes, live_status] =
    await Promise.all([
      sbGet(`stint9_fuel_state?select=car,state,updated_at&event_date=eq.${enc}`),
      sbGet(`stint9_fuel_notes?select=car,lap,note,updated_at&event_date=eq.${enc}&order=car,lap`),
      sbGet(`stint9_racenotes?select=car,lap,sector,kind,body,tod,nkey,meta&event_date=eq.${enc}&order=car,tod`),
      sbGet(`stint9_tyre_state?select=car,state,updated_at`),           // global (no event_date)
      sbGet(`stint9_band_state?select=band,active,texts,updated_at`),   // global (no event_date)
      sbGet(`stint9_weather?select=recorded_at,temp_c,weather_code,precip_prob&event_date=eq.${enc}&order=recorded_at`),
      sbGet(`stint9_laptimes?select=car,driver,lap,laptime_s,temp_c,weather_code&event_date=eq.${enc}&order=car,lap`),
      sbGet(`stint9_live_status?select=*&event_date=eq.${enc}`),
    ]);
  // messages: prefer the exact event_date match now that scraped rows carry one
  // (wige-scrape/vds-relay stamp it, same as stint9_live_timing). Fall back to
  // the old created_at-window heuristic only when the exact match is empty AND
  // a window is available — covers legacy/manual rows that predate the column.
  let messages = await sbGet(`stint9_messages?select=race_class,car,message,source,created_at,event_date&event_date=eq.${enc}&order=created_at`);
  if (!messages.length && win && win.start) {
    let q = `stint9_messages?select=race_class,car,message,source,created_at,event_date&event_date=is.null&created_at=gte.${encodeURIComponent(win.start)}`;
    if (win.end) q += `&created_at=lte.${encodeURIComponent(win.end)}`;
    messages = await sbGet(q + '&order=created_at');
  }
  return { fuel_state, fuel_notes, racenotes, tyre_state, band_state, weather, laptimes,
           live_status: live_status[0] || null, messages };
}

// Raw stint9_live_timing rows -> the shape buildLiveDB() expects.
async function collectTiming(date) {
  const enc = encodeURIComponent(date);
  const rows = await sbGet(`stint9_live_timing?select=car,lap,klass,s1,s2,s3,s4,s5,s1_kmh,s2_kmh,s3_kmh,s4_kmh,s5_kmh,lap_end_tod,lap_time,inpit,fastest,driver,vehicle&event_date=eq.${enc}&order=car,lap`);
  return rows.map(r => ({
    car: String(r.car), lap: r.lap, klass: r.klass,
    s: [r.s1, r.s2, r.s3, r.s4, r.s5], spd: [r.s1_kmh, r.s2_kmh, r.s3_kmh, r.s4_kmh, r.s5_kmh],
    tend: r.lap_end_tod, rt: r.lap_time, inpit: !!r.inpit, fast: !!r.fastest, drv: r.driver, veh: r.vehicle,
  }));
}

// Compact human-readable per-event fuel/tyre/notes file (the "NLS7_notes" ask).
// generated_at tracks the event's archived_at (NOT wall-clock) so the committed
// file is deterministic — it only changes when the underlying archive changes,
// which lets the auto-mirror workflow commit on real archives, not every run.
function notesExtract(slug, meta, o, archivedAt) {
  return {
    event: { slug, name: meta.name, date: meta.event_date, end: meta.event_end || null, label: meta.label },
    generated_at: archivedAt || null,
    fuel: (o.fuel_state || []).map(r => ({ car: r.car, state: r.state })),
    fuel_notes: (o.fuel_notes || []).map(r => ({ car: r.car, lap: r.lap, note: r.note })),
    tyres: (o.tyre_state || []).map(r => ({ car: r.car, state: r.state })),
    tyre_bands: (o.band_state || []).map(r => ({ band: r.band, active: r.active, texts: r.texts })),
    racenotes: (o.racenotes || []).map(r => ({ car: r.car, lap: r.lap, sector: r.sector, kind: r.kind, body: r.body })),
    messages: o.messages || [],
  };
}

async function writeFilesFromTable() {
  await mkdir(EVENTS_DIR, { recursive: true });
  const rows = await sbGet('stint9_events?select=slug,event_date,event_end,label,name,car_count,archived_at,bundle&order=event_date.desc');
  const index = [];
  for (const ev of rows) {
    const b = ev.bundle || {};
    const meta = { slug: ev.slug, event_date: ev.event_date, event_end: ev.event_end, label: ev.label, name: ev.name };
    await writeFile(join(EVENTS_DIR, `${ev.slug}.json`), JSON.stringify({ ...b, meta: { ...(b.meta || {}), ...meta, car_count: ev.car_count, archived_at: ev.archived_at } }));
    await writeFile(join(EVENTS_DIR, `${ev.slug}_notes.json`), JSON.stringify(notesExtract(ev.slug, meta, b.overlay || {}, ev.archived_at), null, 2));
    index.push({ slug: ev.slug, name: ev.name, label: ev.label, date: ev.event_date, end: ev.event_end,
                 car_count: ev.car_count, archived_at: ev.archived_at,
                 file: `events/${ev.slug}.json`, notes: `events/${ev.slug}_notes.json` });
  }
  // index.generated_at = the newest archived_at (deterministic — see notesExtract).
  const latest = index.reduce((a, e) => (e.archived_at && e.archived_at > a ? e.archived_at : a), '');
  await writeFile(join(EVENTS_DIR, 'index.json'), JSON.stringify({ generated_at: latest || null, events: index }, null, 2));
  console.log(`events/: wrote ${rows.length} event file(s) + index.json`);
}

async function archiveOne() {
  const date = arg('date');
  if (!date) throw new Error('--date=YYYY-MM-DD required (or use --sync-files)');
  const fromDataJs = !!arg('from-datajs');
  const label = arg('label', null);
  const win = { start: arg('win-start', null), end: arg('win-end', null) };

  let db = null, timing = null, name = arg('name', null), carCount = 0;
  if (fromDataJs) {
    db = await loadDataJsDB();
    name = name || (db.event && db.event.name) || '';
    carCount = (db.cars && db.cars.length) || Object.keys(db.legs || {}).length;
  } else {
    timing = await collectTiming(date);
    carCount = new Set(timing.map(r => r.car)).size;
    if (!timing.length) console.warn('⚠ no stint9_live_timing rows for ' + date + ' — timing will be empty');
  }
  const round = await lookupRound(date);          // canonical NLS round for this date
  if (round && round.name) name = arg('name', null) || round.name || name;
  const slug = arg('slug', null) || (round && round.slug) || deriveSlug(name, label, date);
  const overlay = await collectOverlay(date, win);
  const meta = { slug, event_date: date, event_end: arg('end', null), label, name,
                 car_count: carCount, archived_at: new Date().toISOString(),
                 source: fromDataJs ? 'data.js' : 'stint9_live_timing' };
  const bundle = { meta, db, timing, overlay,
                   weather: overlay.weather, laptimes: overlay.laptimes, live_status: overlay.live_status };
  // keep the big arrays only once (bundle.overlay already holds weather/laptimes)
  delete overlay.weather; delete overlay.laptimes; delete overlay.live_status;

  await sbUpsert('stint9_events', {
    slug, event_date: date, event_end: meta.event_end, label, name,
    car_count: carCount, bundle, updated_at: new Date().toISOString(),
  });
  console.log(`archived ${slug} (${name || date}) · ${carCount} cars · source=${meta.source}`);
  await writeFilesFromTable();
}

const run = arg('sync-files') ? writeFilesFromTable : archiveOne;
run().catch(e => { console.error(e.message || e); process.exit(1); });
