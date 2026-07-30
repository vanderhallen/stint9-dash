/* nls-driver-scrape — builds/refreshes the per-driver 2026 NLS database that
 * driver.html reads, straight from the official result PDFs.
 * ===========================================================================
 * WHAT IT DOES
 *   1. Discovers every 2026 round from the NLS season calendar page (same page
 *      and same parseCalendar() shape as nls-schedule-scrape), expanding any
 *      "DD.-DD.MM.YYYY" combined row into its individual dates.
 *   2. For each round whose date is <= today, downloads the official race
 *      result PDF  <base>/ergebnisse/<YYYY-MM-DD>r.pdf  (Offizielles Ergebnis
 *      Rennen). Results-only: only that PDF carries finishing positions / laps /
 *      best laps. A round with no results PDF yet is simply skipped this run.
 *   3. Extracts text with `unpdf` (WASM, works in edge runtime — same as
 *      nls-24h-pdf-scrape) and parses it into per-car blocks, then per-driver
 *      rows. Parser verified locally against the real 2026-06-20r.pdf
 *      (79/79 classified cars, 298 driver rows) before deploy.
 *   4. Also best-effort ingests the 24h Nürburgring race, whose result PDF URL
 *      is stored as DATA in stint9_nls_races (series='24h', a row you insert /
 *      update by hand — 24h-rennen.de is Cloudflare-locked so the URL can't be
 *      auto-discovered; see nls-24h-pdf-scrape header for the full rationale).
 *   5. Upserts stint9_nls_races (one row per race) and replaces
 *      stint9_nls_results for each scraped race (delete-by-event_date then
 *      insert, so a re-scan picks up late-published / corrected results).
 *
 * PER-DRIVER BEST LAP: the race result sheet lists only the CAR's fastest lap,
 * but the separate "Lap by Lap" chart (<date>rl.pdf) tags every lap with the
 * on-track driver's number, so parseLapChart() recovers each driver's own best
 * lap and set_fastest marks whoever set the car's fastest. If that chart is
 * missing for a round, all co-drivers fall back to the car's fastest lap.
 *
 * WHAT THE PDFs DO *NOT* CONTAIN (documented limits, surfaced on driver.html):
 *   - Driver age / birthdate: never printed anywhere -> no age field.
 *   - Championship points: not printed. pos_class is stored; "points in class"
 *     is derived on the client from a documented class-position scale.
 *
 * SAFETY: never throws the whole run on one bad race; each race is try/caught
 * and logged. A race only replaces its existing rows if the parse yielded at
 * least one driver row. Every run is logged to stint9_nls_scrape_log.
 *
 * Deploy: mcp deploy_edge_function (name nls-driver-scrape, verify_jwt:false).
 * Schedule: pg_cron stint9_nls_driver_autoscan, weekly.
 * ===========================================================================
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getDocumentProxy, extractText } from 'npm:unpdf';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CALENDAR_URL = 'https://www.nuerburgring-langstrecken-serie.de/language/de/termine-adac-ravenol-nuerburgring-langstrecken-serie-2026/';
const PDF_BASE = 'https://www.nuerburgring-langstrecken-serie.de/wp-content/uploads/ergebnisse';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

/* ---------- calendar discovery (mirrors nls-schedule-scrape) ---------- */
type RoundRef = { eventDate: string; roundNo: string; title: string };
function parseCalendar(html: string): RoundRef[] {
  const out: RoundRef[] = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html))) {
    const block = m[1];
    const am = block.match(/<a href="[^"]+"[^>]*>\s*NLS(\d+)\s*:\s*([^<]*)</);
    if (!am) continue;
    const roundNo = am[1], title = am[2].trim();
    // single date  "20.06.2026"
    const single = block.match(/<td>\s*(\d{2})\.(\d{2})\.(\d{4})\s*<\/td>/);
    // combined range "18.-19.04.2026" (double-header / special weekend)
    const range = block.match(/<td>\s*(\d{2})\.-(\d{2})\.(\d{2})\.(\d{4})\s*<\/td>/);
    if (range) {
      const [, d1, d2, mo, y] = range;
      for (const d of [d1, d2]) out.push({ eventDate: `${y}-${mo}-${d}`, roundNo, title });
    } else if (single) {
      out.push({ eventDate: `${single[3]}-${single[2]}-${single[1]}`, roundNo, title });
    }
  }
  return out;
}

/* ---------- nationality maps ---------- */
// German country name (as printed in the "Ort" column for foreign drivers) -> ISO-2.
const COUNTRIES: Record<string, string> = {
  'Schweiz': 'CH', 'Niederlande': 'NL', 'Vereinigtes Königreich': 'GB', 'Südafrika': 'ZA',
  'Irland': 'IE', 'Bulgarien': 'BG', 'Armenien': 'AM', 'Türkei': 'TR', 'Slowakei': 'SK',
  'Japan': 'JP', 'Luxemburg': 'LU', 'Norwegen': 'NO', 'Frankreich': 'FR', 'Südkorea': 'KR',
  'Vereinigte Arabische Emirate': 'AE', 'Dänemark': 'DK', 'Chile': 'CL', 'Vereinigte Staaten': 'US',
  'Argentinien': 'AR', 'Italien': 'IT', 'Kirgisistan': 'KG', 'Tschechien': 'CZ', 'Israel': 'IL',
  'Belgien': 'BE', 'Österreich': 'AT', 'Spanien': 'ES', 'Portugal': 'PT', 'Schweden': 'SE',
  'Finnland': 'FI', 'Polen': 'PL', 'Ungarn': 'HU', 'Kroatien': 'HR', 'Griechenland': 'GR',
  'Estland': 'EE', 'Litauen': 'LT', 'Lettland': 'LV', 'Rumänien': 'RO', 'Monaco': 'MC',
  'Liechtenstein': 'LI', 'Ecuador': 'EC', 'Brasilien': 'BR', 'Kanada': 'CA', 'Australien': 'AU',
  'Neuseeland': 'NZ', 'China': 'CN', 'Katar': 'QA', 'Saudi-Arabien': 'SA', 'Mexiko': 'MX',
  'Thailand': 'TH', 'Slowenien': 'SI', 'Indien': 'IN', 'Russland': 'RU', 'Ukraine': 'UA',
  'Deutschland': 'DE', 'Andorra': 'AD', 'Malta': 'MT', 'Zypern': 'CY', 'Island': 'IS',
  'Hongkong': 'HK', 'Singapur': 'SG', 'Indonesien': 'ID', 'Philippinen': 'PH', 'Venezuela': 'VE',
  'Uruguay': 'UY', 'Kolumbien': 'CO', 'Norwegia': 'NO',
};
// license prefix (2 letters before the first '-') -> ISO-2, fallback nationality source.
const LIC_PREFIX: Record<string, string> = {
  DE: 'DE', NL: 'NL', GB: 'GB', CH: 'CH', FR: 'FR', IT: 'IT', BE: 'BE', AT: 'AT', ES: 'ES',
  NO: 'NO', SE: 'SE', DK: 'DK', FI: 'FI', PL: 'PL', CZ: 'CZ', SK: 'SK', HU: 'HU', LU: 'LU',
  IE: 'IE', PT: 'PT', ZA: 'ZA', JP: 'JP', KR: 'KR', US: 'US', CA: 'CA', AU: 'AU', AR: 'AR',
  BR: 'BR', CL: 'CL', MC: 'MC', TR: 'TR', BG: 'BG', HR: 'HR', RO: 'RO', GR: 'GR', LI: 'LI',
  LT: 'LT', LV: 'LV', EE: 'EE', IL: 'IL', AE: 'AE', QA: 'QA', SA: 'SA', CN: 'CN', MX: 'MX',
  EC: 'EC', KG: 'KG', AM: 'AM', IN: 'IN', SG: 'SG', HK: 'HK',
};

/* ---------- car manufacturers (start of the "Fahrzeug" field) ---------- */
// Multi-word first so the alternation prefers the longer name. Both Title and
// UPPER/lower cases are generated (PDFs mix e.g. "Audi" and "AUDI").
const MANU_BASE = [
  'Mercedes-AMG', 'Aston Martin', 'Porsche', 'BMW', 'Mercedes', 'Audi', 'McLaren', 'Ferrari',
  'Mitsubishi', 'Toyota', 'Cupra', 'Hyundai', 'Renault', 'Ford', 'Lamborghini', 'Honda', 'KTM',
  'Opel', 'MINI', 'Mini', 'Alpine', 'Nissan', 'Lexus', 'Bentley', 'Chevrolet', 'Corvette',
  'Ginetta', 'Seat', 'Volkswagen', 'VW', 'Subaru', 'Dacia', 'Ligier', 'Donkervoort', 'Peugeot',
  'Skoda', 'Lada', 'MARC', 'Glickenhaus', 'Wolf',
];
const MANU_ALL = [...new Set(MANU_BASE.flatMap((x) => [x, x.toUpperCase(), x.toLowerCase()]))];
const MANU_ALT = MANU_ALL.map((m) => m.replace(/-/g, '\\-')).join('|');
// header: [pos] carNo CLASS(no comma/colon/period) MANUFACTURER model... laps totaltime
const HDR = new RegExp(
  '(?<![A-Za-z0-9&/\\-])(?:(\\d{1,3}) )?(\\d{1,3}) ([A-Z][^,:.]{0,18}?) (' + MANU_ALT +
    ')((?: [^,:.]{1,20}){0,6}?) (\\d{1,3}) (\\d{1,2}:\\d{2}(?::\\d{2})?\\.\\d{3})(?=\\s)',
  'g',
);

const RATINGS = new Set(['AM', 'PRO', 'PRO-AM', 'PRO/AM', 'SILVER', 'GOLD', 'PLATINUM', 'BRONZE']);

function timeToMs(t: string | null): number | null {
  if (!t) return null;
  const mm = t.match(/(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})/);
  if (!mm) return null;
  const h = +(mm[1] || 0), mi = +mm[2], s = +mm[3], ms = +mm[4];
  const total = (h * 3600 + mi * 60 + s) * 1000 + ms;
  return total > 0 ? total : null;
}

function isLicToken(t: string): boolean {
  return /\d/.test(t) || /^[A-Z]{1,3}-/.test(t);
}

// Trim a captured driver "name" down to the trailing name tokens: cut off
// everything up to and including the last token that is clearly NOT part of a
// personal name — a digit/quote/&/colon-bearing token (leaked team, speed,
// license, sponsor) or a driver-rating token (PRO / AM / PRO-AM ...).
function cleanName(s: string): string {
  s = (s || '').trim();
  const toks = s.split(/\s+/);
  let last = -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const bare = t.replace(/[.,]/g, '');
    if (/[0-9"&:]/.test(t) || RATINGS.has(bare) || bare === 'S' || bare === 'B') last = i;
  }
  let name = (last >= 0 ? toks.slice(last + 1) : toks).join(' ');
  name = name.replace(/^['"]|['"]$/g, '').replace(/\*+$/, '').trim();
  return name;
}

function foldKey(name: string): string {
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/['".,*]/g, '').replace(/\s+/g, ' ').trim();
}

type ParsedDriver = { name: string; ort: string; nationality: string | null; license: string | null };
// Parse the driver zone "Name, Ort License [RATING] Name, Ort License ..." into drivers.
function parseDrivers(zone: string): ParsedDriver[] {
  const parts = zone.split(', ');
  if (parts.length < 2) return [];
  const drivers: ParsedDriver[] = [];
  let curName = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const toks = parts[i].trim().split(/\s+/);
    let li = -1;
    for (let j = 0; j < toks.length; j++) if (isLicToken(toks[j])) { li = j; break; }
    let ort: string, license: string | null = null, nextName = '';
    if (li < 0) { ort = parts[i].trim(); } else {
      ort = toks.slice(0, li).join(' ');
      let j = li;
      const lic: string[] = [];
      // consume license token(s): licenses can be split by spaces, contain & / *DSQ
      while (j < toks.length && (isLicToken(toks[j]) || toks[j].startsWith('*') || /^[0-9]/.test(toks[j]))) {
        lic.push(toks[j]); j++;
      }
      license = lic.join(' ').replace(/\*+DSQ/gi, '').trim() || null;
      let rest = toks.slice(j);
      while (rest.length && RATINGS.has(rest[0].replace(/[.,]/g, ''))) rest = rest.slice(1);
      nextName = rest.join(' ');
    }
    ort = ort.replace(/,?\s*\*+DSQ$/i, '').replace(/,$/, '').trim();
    const licPrefix = license ? (license.match(/^([A-Z]{2})-/)?.[1] ?? '') : '';
    const nationality: string | null =
      COUNTRIES[ort] || (licPrefix && LIC_PREFIX[licPrefix]) || (ort ? 'DE' : null);
    const name = cleanName(curName);
    if (name) drivers.push({ name, ort, nationality, license });
    curName = nextName;
  }
  return drivers;
}

type ResultRow = {
  event_date: string; car_no: number; class: string; rating: string | null; class_full: string;
  team: string | null; car_model: string; driver_key: string; driver_name: string;
  nationality: string | null; license_no: string | null;
  pos_overall: number | null; pos_class: number | null; laps: number | null;
  best_lap_ms: number | null; set_fastest: boolean | null; status: string;
};

// Lap-by-lap chart (<date>rl.pdf) -> per car, per driver-NUMBER, that driver's
// fastest lap (ms). The chart tags every lap with the on-track driver's number
// in parentheses, e.g. "8:04.370 5(1)" = lap 5 by driver 1. Driver numbers are
// assigned in the same order drivers are printed on the result sheet, so number
// N maps to the Nth driver of that car as parseResults lists them. This is what
// lets each co-driver get their OWN best lap instead of sharing the car's.
export function parseLapChart(raw: string): Record<string, Record<string, number>> {
  const text = raw
    .replace(/No Entrant Driver/g, ' | ') // per-page column header -> block boundary
    .replace(/Datenservice:[\s\S]*?(?:Rheinbrohl|Meckenheim)/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // a car block starts at a boundary, then carNo, then non-lap text up to the first "(1)"
  const HDR = /(?:^|\)|\|)\s*(\d{1,3})\s+(?:(?!\d{1,2}:\d{2}\.\d{3})[^|])*?\(1\)/g;
  const heads: { carNo: string; idx: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = HDR.exec(text))) heads.push({ carNo: m[1], idx: m.index });
  const LAP = /(\d{1,2}:\d{2}\.\d{3}) (?:\d+|pit)\((\d+)\)/g;
  const byCar: Record<string, Record<string, number>> = {};
  for (let i = 0; i < heads.length; i++) {
    const seg = text.slice(heads[i].idx, i + 1 < heads.length ? heads[i + 1].idx : text.length);
    const acc = (byCar[heads[i].carNo] ??= {});
    let mm: RegExpExecArray | null;
    LAP.lastIndex = 0;
    while ((mm = LAP.exec(seg))) {
      const ms = timeToMs(mm[1]); const dn = mm[2];
      if (ms != null && (acc[dn] == null || ms < acc[dn])) acc[dn] = ms;
    }
  }
  return byCar;
}

// Split "SP9 PRO-AM" -> base "SP9" + rating "PRO-AM"; leave "CUP2"/"BMW M2" as base, rating null.
function splitClass(cls: string): { base: string; rating: string | null } {
  const m = cls.match(/^(.*?)\s+(PRO-AM|PRO\/AM|PRO|AM|SILVER|GOLD|PLATINUM|BRONZE)$/i);
  if (m) return { base: m[1].trim(), rating: m[2].toUpperCase().replace('/', '-') };
  return { base: cls.trim(), rating: null };
}

function cleanText(raw: string): string {
  return raw
    // Whole repeating page header/footer block: from the page title number
    // ("1. ADAC Eifel Trophy" / "2. Adenauer ADAC ...") through the column
    // header that always ends "...Gesamt Schnitt Rd." (also strips the first
    // page's header). Event-title-agnostic.
    .replace(/\d+\.\s+[A-ZÄÖÜ][\s\S]*?Fahrer, Ort Strafzeit Intervall Gesamt Schnitt Rd\./g, ' ')
    // any stray leftover footer/header fragments
    .replace(/Datenservice:[\s\S]*?(?:Rheinbrohl|Meckenheim)/g, ' ')
    .replace(/Seite \d+ \/ Gedruckt[\s\S]*?\d+:\d+/g, ' ')
    .replace(/nicht gestartet : \d+/g, ' ')
    // standalone status words that would otherwise glue onto a car number/class
    .replace(/\b(?:DNC|DNS|DNF)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Parse an Ergebnis PDF's text into result rows for one event. When a parsed
// lap chart (lapMap) is supplied, each driver gets their own best lap; otherwise
// every co-driver falls back to the car's single published fastest lap.
export function parseResults(rawText: string, eventDate: string, lapMap?: Record<string, Record<string, number>>): ResultRow[] {
  const text = cleanText(rawText);
  type Head = { idx: number; tsEnd: number; pos: number | null; carNo: number; cls: string; model: string; laps: number };
  const heads: Head[] = [];
  let m: RegExpExecArray | null;
  HDR.lastIndex = 0;
  while ((m = HDR.exec(text))) {
    heads.push({
      idx: m.index, tsEnd: m.index + m[0].length,
      pos: m[1] ? +m[1] : null, carNo: +m[2],
      cls: m[3].trim(), model: (m[4] + m[5]).trim(), laps: +m[6],
    });
  }
  const rows: ResultRow[] = [];
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k];
    const blockEnd = k + 1 < heads.length ? heads[k + 1].idx : text.length;
    const after = text.slice(h.tsEnd, blockEnd);
    const fl = after.match(/(\d{1,2}:\d{2}\.\d{3})/);
    const best = fl ? timeToMs(fl[1]) : null;
    // team: "B:Team lic" or sponsor-only "S:..."; first driver comes after.
    const teamM = after.match(/B:([^,]+?)\s+(?:[A-Z0-9][^\s]*\d[^\s]*|\d[^\s]*)\s/);
    const team = teamM ? teamM[1].trim() : null;
    // driver zone starts at first "Word, Cap"
    const dm = after.match(/([A-ZÀ-Þ'"][^,]{1,45}), [A-ZÀ-Þ"']/);
    const drivers = dm ? parseDrivers(after.slice(dm.index)) : [];
    const { base, rating } = splitClass(h.cls);
    const status = /\*+DSQ/i.test(after) ? 'dsq' : (h.pos !== null ? 'classified' : 'dnf');
    const carLaps = lapMap ? lapMap[String(h.carNo)] : undefined;
    const carMin = carLaps ? Math.min(...Object.values(carLaps)) : null;
    drivers.forEach((d, di) => {
      const driverLap = carLaps ? carLaps[String(di + 1)] : undefined; // driver number = list order
      const bestLap = driverLap != null ? driverLap : best;            // fall back to car fastest
      const setFastest = (carLaps && driverLap != null) ? (driverLap === carMin) : null;
      rows.push({
        event_date: eventDate, car_no: h.carNo, class: base, rating: rating, class_full: h.cls,
        team, car_model: h.model, driver_key: foldKey(d.name), driver_name: d.name,
        nationality: d.nationality, license_no: d.license,
        pos_overall: h.pos, pos_class: null, laps: h.laps, best_lap_ms: bestLap, set_fastest: setFastest, status,
      });
    });
  }
  // pos_class: rank classified cars within their base class by pos_overall.
  const byClass: Record<string, { car_no: number; pos: number }[]> = {};
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.pos_overall == null) continue;
    const key = r.class + '|' + r.car_no;
    if (seen.has(key)) continue;
    seen.add(key);
    (byClass[r.class] ??= []).push({ car_no: r.car_no, pos: r.pos_overall });
  }
  const classRank: Record<string, Record<number, number>> = {};
  for (const [cls, arr] of Object.entries(byClass)) {
    arr.sort((a, b) => a.pos - b.pos);
    classRank[cls] = {};
    arr.forEach((e, i) => { classRank[cls][e.car_no] = i + 1; });
  }
  for (const r of rows) {
    if (r.pos_overall != null) r.pos_class = classRank[r.class]?.[r.car_no] ?? null;
  }
  return rows;
}

/* ---------- Supabase REST helpers ---------- */
async function sbFetch(path: string, init: RequestInit) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function upsertRace(race: Record<string, unknown>) {
  const res = await sbFetch('stint9_nls_races?on_conflict=event_date', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([race]),
  });
  if (!res.ok) throw new Error(`upsertRace ${race.event_date}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function replaceResults(eventDate: string, rows: ResultRow[]) {
  if (!rows.length) return 0;
  const del = await sbFetch(`stint9_nls_results?event_date=eq.${eventDate}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!del.ok) throw new Error(`delete ${eventDate}: ${del.status}`);
  // chunked insert to stay well under payload limits
  for (let i = 0; i < rows.length; i += 500) {
    const res = await sbFetch('stint9_nls_results', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!res.ok) throw new Error(`insert ${eventDate}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return rows.length;
}

async function logRun(ok: boolean, racesChecked: number, detail: unknown) {
  try {
    const res = await sbFetch('stint9_nls_scrape_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ ok, races_checked: racesChecked, detail }]) });
    if (!res.ok) console.error('logRun failed:', res.status, await res.text());
  } catch (e) { console.error('logRun threw:', e); }
}

async function fetchPdfText(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 stint9-dash' } });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

// Ingest one race's official result PDF by (eventDate, series). Results-only:
// stats require finishing positions / laps / best laps, which only the Ergebnis
// PDF carries (the Starterliste entry-list PDF uses a different layout and has
// no results, so it is referenced but not parsed). Returns a log record.
async function ingestRace(eventDate: string, roundNo: string, title: string, series: string, explicitUrl?: string) {
  const resultsUrl = explicitUrl ?? `${PDF_BASE}/${eventDate}r.pdf`;
  const entryUrl = `${PDF_BASE}/${eventDate}s.pdf`;
  const text = await fetchPdfText(resultsUrl);
  if (!text) return { eventDate, series, status: 'no_results_pdf' };
  // Best-effort lap-by-lap chart for per-driver best laps (NLS only; the 24h
  // explicit-URL path has no known rl.pdf). A missing/bad chart just falls back
  // to the car's fastest lap for every co-driver.
  let lapMap: Record<string, Record<string, number>> | undefined;
  if (!explicitUrl) {
    try { const lt = await fetchPdfText(`${PDF_BASE}/${eventDate}rl.pdf`); if (lt) lapMap = parseLapChart(lt); }
    catch (_) { /* ignore, fall back */ }
  }
  const rows = parseResults(text, eventDate, lapMap);
  if (!rows.length) return { eventDate, series, status: 'parsed_zero' };
  // Sanity gate: a well-formed NLS result parses to ~2-4 drivers per car and a
  // healthy set of classified cars. A divergent layout (e.g. the 24h-Qualifiers
  // template) parses to a few "cars" swallowing hundreds of "drivers" — skip it
  // rather than pollute the DB. (Documented limit; such a race stays unlisted.)
  const carCount = new Set(rows.map((r) => `${r.car_no}`)).size;
  const perCar = rows.length / Math.max(1, carCount);
  if (carCount < 5 || perCar > 6) {
    return { eventDate, series, status: 'unparseable_format', carCount, driverRows: rows.length };
  }
  const written = await replaceResults(eventDate, rows);
  await upsertRace({
    event_date: eventDate, round_no: roundNo || null, title: title || null, series,
    results_url: resultsUrl, entrylist_url: entryUrl,
    has_results: true, driver_rows: written, scraped_at: new Date().toISOString(),
  });
  const drivers = new Set(rows.map((r) => r.driver_key)).size;
  return { eventDate, series, status: 'ok', driverRows: written, drivers, cars: carCount };
}

if (import.meta.main) Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const results: unknown[] = [];
  try {
    const today = new Date().toISOString().slice(0, 10);

    // 1) NLS rounds from the calendar
    const calRes = await fetch(CALENDAR_URL);
    if (!calRes.ok) throw new Error(`calendar fetch ${calRes.status}`);
    const rounds = parseCalendar(await calRes.text());
    const seen = new Set<string>();
    for (const r of rounds) {
      if (r.eventDate > today) continue;              // not raced yet
      if (seen.has(r.eventDate)) continue;             // de-dupe expanded ranges
      seen.add(r.eventDate);
      try { results.push(await ingestRace(r.eventDate, r.roundNo, r.title, 'NLS')); }
      catch (e) { results.push({ eventDate: r.eventDate, series: 'NLS', status: 'error', error: String(e) }); }
    }

    // 2) 24h best-effort: any pre-seeded series='24h' rows carrying an explicit results_url
    const h24 = await sbFetch("stint9_nls_races?series=eq.24h&select=event_date,round_no,title,results_url", { method: 'GET' });
    if (h24.ok) {
      const rows = await h24.json() as { event_date: string; round_no: string; title: string; results_url: string | null }[];
      for (const r of rows) {
        if (!r.results_url || r.event_date > today) continue;
        try { results.push(await ingestRace(r.event_date, r.round_no, r.title, '24h', r.results_url)); }
        catch (e) { results.push({ eventDate: r.event_date, series: '24h', status: 'error', error: String(e) }); }
      }
    }

    await logRun(true, results.length, { results });
    return Response.json({ ok: true, racesChecked: results.length, results }, { headers: CORS });
  } catch (e) {
    await logRun(false, results.length, { error: String(e), results });
    return Response.json({ ok: false, error: String(e), results }, { status: 500, headers: CORS });
  }
});
