/* nls-entrylist-scrape — builds/refreshes the per-event 2026 NLS ENTRY LIST
 * (car number, class, team, car brand/model, full driver roster) from the
 * official "Vorläufige Teilnehmerliste" PDF, straight from the same PDF host
 * nls-driver-scrape already reads results/grids from.
 * ===========================================================================
 * WHAT IT DOES
 *   1. Discovers every 2026 round from the NLS season calendar page (verbatim
 *      copy of nls-driver-scrape's parseCalendar — each edge function here is
 *      self-contained, no shared module, matching the existing repo convention).
 *   2. For EVERY round — past AND future, unlike nls-driver-scrape's results
 *      pass — downloads <base>/ergebnisse/<YYYY-MM-DD>s.pdf ("Vorläufige
 *      Teilnehmerliste"). This is the entry-list PDF nls-driver-scrape already
 *      references (entrylist_url) but never parses ("different layout, no
 *      results" — see its header). Unlike the results PDF, entry lists get
 *      published/updated in the days before each round, so a FUTURE round's
 *      car numbers, teams and driver lineups can already be known before it
 *      races. A round with no entry-list PDF yet (404) is simply skipped.
 *   3. Extracts POSITIONED text items with `unpdf`'s extractTextItems (real
 *      x/y per text run), not the plain extractText the other function uses.
 *      This PDF is a fixed-column FPDF table (Nr./rating | B-F-S role marker |
 *      Name | Wohnort | Liz.-Nr. | Fahrzeug); its underlying content-stream
 *      draws each COLUMN as its own multi-line run, so plain merged text comes
 *      out column-major within a car block (all names, then all towns, then
 *      all licenses...) with the last two columns even interleaved — useless
 *      for regex parsing. Reconstructing visual ROWS from real y-coordinates
 *      and classifying cells by fixed x-thresholds (verified against several
 *      real Teilnehmerliste PDFs) is what makes this parseable at all.
 *   4. A car's B (Bewerber/team) row opens its block; S (Sponsor) opens it
 *      instead when there is no separate B row, and also carries a wrapped
 *      Fahrzeug-column fragment when it appears mid-block ("...GT4" + "CS" on
 *      the next line). A "private" entry has no B/S row at all — its first F
 *      (Fahrer/driver) row both opens the block and is driver #1. Fahrzeug
 *      (car brand+model) text is accumulated across every row of the block,
 *      since it commonly wraps onto the first driver row (e.g. "Aston Martin
 *      Vantage GT3" + "EVO"). Class comes from the nearest class-header row
 *      above the block (marked by the literal "Teilnehmer: <n>" cell), and
 *      persists across page breaks — continuation pages repeat the column
 *      header but not the class line.
 *   5. Replaces stint9_nls_entries for each scraped event (delete-by-
 *      event_date then insert), so a re-scan picks up entry-list corrections
 *      as teams finalize lineups. No incremental skip: unlike results, entry
 *      lists are revised right up to race week and the PDFs are small
 *      (~100-200KB, a fraction of the results+lap-chart PDFs), so a full daily
 *      re-scan of every round in the season is cheap.
 *
 * WHAT THIS PDF DOES NOT GUARANTEE: it is a snapshot ("Vorläufige" = provisional,
 * dated in its own "Stand:" line, typically taken a few days before the round),
 * so a late entry added after that snapshot can appear in the RESULTS PDF
 * without ever having been in this one — a handful of cars per round (verified
 * against 2026-09-12: 3 of 108 raced cars were never in the entry list at all).
 * That gap is a real data-source limit, not a parser bug — such a car simply
 * won't show up in stint9_nls_entries for that round until nls-driver-scrape's
 * results pass adds it to stint9_nls_results instead.
 *
 * Deploy: mcp deploy_edge_function (name nls-entrylist-scrape, verify_jwt:false).
 * Schedule: pg_cron stint9_nls_entries_autoscan, daily.
 * ===========================================================================
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getDocumentProxy, extractTextItems } from 'npm:unpdf';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CALENDAR_URL = 'https://www.nuerburgring-langstrecken-serie.de/language/de/termine-adac-ravenol-nuerburgring-langstrecken-serie-2026/';
const PDF_BASE = 'https://www.nuerburgring-langstrecken-serie.de/wp-content/uploads/ergebnisse';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

/* ---------- calendar discovery (verbatim copy of nls-driver-scrape's parseCalendar) ---------- */
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
    const single = block.match(/<td>\s*(\d{2})\.(\d{2})\.(\d{4})\s*<\/td>/);
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

function foldKey(name: string): string {
  return name.toLowerCase()
    .normalize('NFD').replace(/\p{Mn}/gu, '')
    .replace(/['".,*]/g, '').replace(/\s+/g, ' ').trim();
}

// "Nachname, Vorname[*]" -> "Nachname Vorname", matching the driver_name
// convention already stored in stint9_nls_results (verified byte-for-byte
// against it for 116/117 comparable cars from a real round).
function cleanDriverName(raw: string): string {
  let name = raw.trim();
  name = name.replace(/^['"]|['"]$/g, '').replace(/\*+$/, '').trim();
  name = name.replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return name;
}

/* ---------- fixed-column x-thresholds (FPDF template; verified against
   several real Teilnehmerliste PDFs — Nr./rating≈59.5, B/F/S marker≈102,
   Name≈116, Wohnort≈294.8, Liz.-Nr.≈394, Fahrzeug≈470.5, all in PDF points) --- */
const COL_MARKER_MIN = 95, COL_MARKER_MAX = 112;
const COL_NAME_MIN = 112, COL_NAME_MAX = 280;
const COL_VEHICLE_MIN = 460;

type TextItem = { str: string; x: number; y: number };
type EntryDriver = { driver_key: string; driver_name: string };
type EntryRow = { event_date: string; car_no: number; class: string | null; team: string | null; car_model: string; drivers: EntryDriver[] };
type OpenCar = Omit<EntryRow, 'car_model'> & { modelParts: string[] };

// Reconstruct visual rows from positioned items (grouped by y, cells sorted by
// x) and classify each into the entry-list state machine described above.
export function parseEntries(pages: TextItem[][], eventDate: string): EntryRow[] {
  const rows: EntryRow[] = [];
  let curClass: string | null = null;
  let curCar: OpenCar | null = null;

  function flush() {
    if (curCar) {
      const { modelParts, ...rest } = curCar;
      rows.push({ ...rest, car_model: modelParts.join(' ').trim() });
    }
    curCar = null;
  }

  for (const items of pages) {
    const byY = new Map<number, { x: number; t: string }[]>();
    for (const it of items) {
      const t = (it.str || '').trim();
      if (!t) continue;
      const y = Math.round(it.y * 10) / 10;
      const arr = byY.get(y);
      if (arr) arr.push({ x: it.x, t }); else byY.set(y, [{ x: it.x, t }]);
    }
    // PDF coordinate space has its origin bottom-left (y grows upward), so a
    // descending sort walks the page top-to-bottom the way it reads visually.
    const ys = [...byY.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const cells = (byY.get(y) as { x: number; t: string }[]).sort((a, b) => a.x - b.x);
      const colA = cells.filter((c) => c.x < COL_MARKER_MIN).map((c) => c.t).join(' ');
      const marker = cells.find((c) => c.x >= COL_MARKER_MIN && c.x <= COL_MARKER_MAX && (c.t === 'B' || c.t === 'F' || c.t === 'S'))?.t ?? null;
      const colC = cells.filter((c) => c.x >= COL_NAME_MIN && c.x < COL_NAME_MAX).map((c) => c.t).join(' ');
      const colF = cells.filter((c) => c.x >= COL_VEHICLE_MIN).map((c) => c.t).join(' ');
      // unpdf merges each cell's full run into one string (unlike word-level
      // tokenizers), so the class-header's count cell reads "Teilnehmer: 20"
      // and the doc-level count cell "Teilnehmer: 121" — match by prefix.
      const hasTeiln = cells.some((c) => c.t.startsWith('Teilnehmer:'));

      if (colA.startsWith('Teilnehmer:')) continue; // doc-level participant count line

      let carNoHere: number | null = null;
      if (marker) { const n = parseInt(colA, 10); carNoHere = Number.isFinite(n) ? n : null; }

      if ((marker === 'B' || marker === 'S') && carNoHere != null) {
        // 'S' (Sponsor) acts as the entrant/team line when there is no
        // separate 'B' (Bewerber) row for that car — same as a 'B' opener.
        flush();
        curCar = { event_date: eventDate, car_no: carNoHere, class: curClass, team: colC || null, drivers: [], modelParts: colF ? [colF] : [] };
        continue;
      }
      if (marker === 'F') {
        if (carNoHere != null) {
          // private entry: no B/S row — this row both opens the block and is driver #1
          flush();
          curCar = { event_date: eventDate, car_no: carNoHere, class: curClass, team: null, drivers: [], modelParts: [] };
        }
        if (!curCar) continue;
        const name = cleanDriverName(colC);
        if (name) curCar.drivers.push({ driver_name: name, driver_key: foldKey(name) });
        if (colF) curCar.modelParts.push(colF);
        continue;
      }
      if (marker === 'S' && curCar && colF) {
        // mid-block secondary sponsor line can still carry a wrapped
        // Fahrzeug-column fragment (e.g. "...GT4" + "CS" split across rows)
        curCar.modelParts.push(colF);
        continue;
      }
      if (hasTeiln && colA) { curClass = colA; continue; }
      // else: page title/footer, table header, or a Wohnort/Liz.-Nr. wrap we don't need — ignore
    }
  }
  flush();
  return rows;
}

/* ---------- Supabase REST helpers (mirrors nls-driver-scrape) ---------- */
async function sbFetch(path: string, init: RequestInit) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function replaceEntries(eventDate: string, rows: EntryRow[]) {
  if (!rows.length) return 0;
  const del = await sbFetch(`stint9_nls_entries?event_date=eq.${eventDate}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!del.ok) throw new Error(`entries delete ${eventDate}: ${del.status}`);
  const res = await sbFetch('stint9_nls_entries', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
  if (!res.ok) throw new Error(`entries insert ${eventDate}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return rows.length;
}

async function logRun(ok: boolean, roundsChecked: number, detail: unknown) {
  try {
    const res = await sbFetch('stint9_nls_scrape_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ ok, races_checked: roundsChecked, detail: { kind: 'entries', ...(detail as object) } }]) });
    if (!res.ok) console.error('logRun failed:', res.status, await res.text());
  } catch (e) { console.error('logRun threw:', e); }
}

async function fetchPdfItems(url: string): Promise<TextItem[][] | null> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 stint9-dash' } });
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('pdf')) return null; // 404s on this host serve an HTML "not found" page, not a 404 status
  const buf = new Uint8Array(await res.arrayBuffer());
  const pdf = await getDocumentProxy(buf);
  const { items } = await extractTextItems(pdf);
  return items as unknown as TextItem[][];
}

// Ingest one round's entry list from <date>s.pdf into stint9_nls_entries.
async function ingestEntries(eventDate: string) {
  const url = `${PDF_BASE}/${eventDate}s.pdf`;
  let pages: TextItem[][] | null;
  try { pages = await fetchPdfItems(url); }
  catch (e) { return { eventDate, kind: 'entries', status: 'error', error: String(e) }; }
  if (!pages) return { eventDate, kind: 'entries', status: 'no_entrylist_pdf' };
  const rows = parseEntries(pages, eventDate);
  // Sanity gate mirroring nls-driver-scrape's parseResults/parseQuali: a real
  // NLS entry list has dozens of cars; a divergent layout that yields almost
  // nothing is skipped, not written.
  if (rows.length < 5) return { eventDate, kind: 'entries', status: 'unparseable_or_empty', cars: rows.length };
  const written = await replaceEntries(eventDate, rows);
  const drivers = new Set(rows.flatMap((r) => r.drivers.map((d) => d.driver_key))).size;
  return { eventDate, kind: 'entries', status: 'ok', cars: written, drivers };
}

if (import.meta.main) Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* no/invalid body */ }
  const onlyDate = url.searchParams.get('date') || (typeof body.date === 'string' ? body.date : null);

  const results: unknown[] = [];
  try {
    if (onlyDate) {
      // Fast path: a single date needs no calendar scan.
      try { results.push(await ingestEntries(onlyDate)); }
      catch (e) { results.push({ eventDate: onlyDate, kind: 'entries', status: 'error', error: String(e) }); }
      await logRun(true, results.length, { results });
      return Response.json({ ok: true, roundsChecked: results.length, results }, { headers: CORS });
    }

    const calRes = await fetch(CALENDAR_URL);
    if (!calRes.ok) throw new Error(`calendar fetch ${calRes.status}`);
    const rounds = parseCalendar(await calRes.text()).sort((a, b) => (a.eventDate < b.eventDate ? 1 : -1));
    const seen = new Set<string>();
    for (const r of rounds) {
      if (seen.has(r.eventDate)) continue; // de-dupe expanded double-header ranges
      seen.add(r.eventDate);
      // Unlike nls-driver-scrape's results pass, FUTURE rounds are included —
      // the whole point is to see next round's entries before it races.
      try { results.push(await ingestEntries(r.eventDate)); }
      catch (e) { results.push({ eventDate: r.eventDate, kind: 'entries', status: 'error', error: String(e) }); }
    }

    await logRun(true, results.length, { results });
    return Response.json({ ok: true, roundsChecked: results.length, results }, { headers: CORS });
  } catch (e) {
    await logRun(false, results.length, { error: String(e), results });
    return Response.json({ ok: false, error: String(e), results }, { status: 500, headers: CORS });
  }
});
