/* nls-24h-pdf-scrape — keeps the 24h Nürburgring PDF-published Zeitplans
 * current in public.stint9_schedule_windows.
 * ===========================================================================
 * There are TWO separate, differently-named PDFs on 24h-rennen.de that this
 * function tracks, each its own real event with its own session vocabulary:
 *   - '24h_zeitplan' = the main ADAC RAVENOL 24h Nürburgring race weekend
 *     itself (a 4-day weekend, its own on-site qualifying + the 24h race).
 *   - '24h_qualifiers_zeitplan' = the SEPARATE standalone "ADAC 24h
 *     Qualifiers" event (2 days, 2x4h races) held months earlier -- THIS is
 *     the one referred to elsewhere as NLS4/NLS5 (it's what the NLS calendar
 *     lists as "ADAC 24h Qualifiers (2x4h)"). Confirmed by fetching and
 *     reading both PDFs directly: the first find (24h_zeitplan) was
 *     initially assumed to BE the NLS4/5 source, which was wrong -- it's the
 *     race weekend, not the qualifiers. Both are real, useful data (WIGE
 *     polling should cover both), so both get written, neither replaces the
 *     other.
 *
 * Unlike nls-schedule-scrape (which reads nuerburgring-langstrecken-serie.de's
 * HTML calendar), 24h-rennen.de sits behind Cloudflare bot-protection that
 * blocks EVERYTHING except direct static-file paths (confirmed: the homepage,
 * robots.txt, wp-sitemap.xml, wp-json/, and a directory listing under
 * /wp-content/uploads/ all 403/429; the exact PDF path itself, and /feed/,
 * 200 fine). That means this function CANNOT auto-discover a new/renamed PDF
 * URL by crawling the site the way nls-schedule-scrape discovers new NLS
 * round pages -- there's no crawlable index it can reach. (A scheduled AGENT
 * using web search CAN find new PDF URLs, since search engines' own crawlers
 * get through Cloudflare where a direct fetch can't -- see the recurring
 * schedule task that checks for a new PDF version and updates the source
 * rows below; this function only re-parses whatever URL is already there.)
 *
 * So each PDF's URL is DATA, not code: public.stint9_schedule_sources holds
 * both (keys above), so bumping either to a new year's (or re-versioned) URL
 * is a one-line SQL update, no redeploy -- same principle as
 * stint9_schedule_windows itself. This function re-fetches both known URLs
 * daily, so an in-place revision to the SAME PDF (e.g. V2 -> V3 published at
 * an unchanged URL, which does happen) is picked up automatically.
 *
 * Each PDF covers its own weekend but ALSO lists other series sharing the
 * same days (DHLM, Tourenwagen-Legenden, RCN) -- only rows matching that
 * source's own SERIES name are extracted. Text extraction via `unpdf` (WASM,
 * works in Deno/edge runtimes) -- verified against both real 2026 PDFs with
 * local Deno runs before any of this was deployed.
 *
 * SAFETY: same as nls-schedule-scrape -- never DELETEs, only upserts on
 * (event_date, label); logs every run to stint9_schedule_scrape_log; a
 * source only writes if its own "requiredLabels" were all found (see SOURCES
 * below) -- a basic sanity check against a garbled/partial parse.
 *
 * Deploy: mcp deploy_edge_function (name nls-24h-pdf-scrape, verify_jwt:false).
 * Schedule: pg_cron stint9_24h_pdf_autoscan, daily.
 * ===========================================================================
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getDocumentProxy, extractText } from 'npm:unpdf';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

type SourceConfig = {
  series: string;                 // exact prefix this source's sessions start with in the PDF
  labelMap: [string, string][];   // exact (lowercased, parenthetical-stripped) session name -> our column
  pairRace?: { startName: string; finishName: string; label: string }; // e.g. "Start Rennen"+"Zieleinlauf" -> one "race" window
  requiredLabels: string[];       // must ALL be present (post-mapping/pairing) or nothing is written for this source
};
const SOURCES: Record<string, SourceConfig> = {
  '24h_zeitplan': {
    series: 'ADAC RAVENOL 24h Nürburgring',
    labelMap: [
      ['top qualifying 1', 'topquali1'], ['top qualifying 2', 'topquali2'], ['top qualifying 3', 'topquali3'],
      ['qualifying 1', 'quali1'], ['qualifying 2', 'quali2'], ['qualifying 3', 'quali3'],
      ['warm-up', 'warmup'],
      ['startaufstellung', 'startaufstellung'],
      ['open grid', 'opengrid'],
      ['formationsrunde', 'formation'],
    ],
    pairRace: { startName: 'start rennen', finishName: 'zieleinlauf', label: 'race' },
    requiredLabels: ['race'],
  },
  '24h_qualifiers_zeitplan': {
    series: 'ADAC 24h Nürburgring Qualifiers',
    labelMap: [
      ['test- und einstellfahrten', 'test'],
      ['qualifying rennen 1', 'qualirennen1'],
      ['qualifying rennen 2', 'qualirennen2'],
      ['top qualifying', 'topquali'],
      ['startaufstellung', 'startaufstellung'],
      ['formationsrunde', 'formation'],
      ['rennen 1', 'race1'],
      ['rennen 2', 'race2'],
    ],
    requiredLabels: ['race1', 'race2'], // the two NLS4/NLS5-scored races
  },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const MONTHS: Record<string, string> = {
  januar: '01', februar: '02', märz: '03', april: '04', mai: '05', juni: '06', juli: '07',
  august: '08', september: '09', oktober: '10', november: '11', dezember: '12',
};

// Same EU DST rule as nls-schedule-scrape (kept duplicated -- edge functions
// are deployed independently, no shared module between them here).
function berlinOffsetHours(y: number, m: number, d: number): number {
  const lastSunday = (year: number, month: number) => {
    const last = new Date(Date.UTC(year, month + 1, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const dstStart = Date.UTC(y, 2, lastSunday(y, 2), 1, 0, 0);
  const dstEnd = Date.UTC(y, 9, lastSunday(y, 9), 1, 0, 0);
  const t = Date.UTC(y, m - 1, d, 12, 0, 0);
  return (t >= dstStart && t < dstEnd) ? 2 : 1;
}
function toInstant(dateStr: string, hm: string): string | null {
  const dm = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const [, y, mo, d] = dm.map(Number as unknown as (s: string) => number);
  const [, hh, mm] = tm.map(Number as unknown as (s: string) => number);
  const off = berlinOffsetHours(y, mo, d);
  return new Date(Date.UTC(y, mo - 1, d, hh - off, mm, 0)).toISOString();
}

type RawEntry = { date: string; start: string; end: string | null; name: string };

// The PDF's text layer merges into one long line (no page-position newlines
// preserved), so entries are located by scanning for time-anchors
// ("HH:MM Uhr" / "HH:MM - HH:MM Uhr") and day-headers ("Freitag, 17. April
// 2026"), then slicing the description between one anchor and the next
// (whichever -- next time or next day-header -- comes first).
function parsePdfText(text: string, series: string): RawEntry[] {
  const yearMatch = text.match(/\b(20\d{2})\b/);
  const defaultYear = yearMatch ? yearMatch[1] : String(new Date().getFullYear());

  const dayRe = /(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})?/g;
  const days: { pos: number; date: string }[] = [];
  let dm: RegExpExecArray | null;
  while ((dm = dayRe.exec(text))) {
    const mon = MONTHS[dm[3].toLowerCase()];
    if (!mon) continue;
    const year = dm[4] || defaultYear;
    days.push({ pos: dm.index, date: `${year}-${mon}-${dm[2].padStart(2, '0')}` });
  }
  const dayFor = (pos: number): string | null => {
    let d: string | null = null;
    for (const x of days) { if (x.pos <= pos) d = x.date; else break; }
    return d;
  };

  const timeRe = /(\d{1,2}:\d{2})\s*(?:[–-]\s*(\d{1,2}:\d{2}))?\s*Uhr/g;
  const times: { pos: number; start: string; end: string | null; descStart: number }[] = [];
  let tm: RegExpExecArray | null;
  while ((tm = timeRe.exec(text))) {
    times.push({ pos: tm.index, start: tm[1], end: tm[2] || null, descStart: tm.index + tm[0].length });
  }

  const out: RawEntry[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const nextTimePos = i + 1 < times.length ? times[i + 1].pos : text.length;
    const nextDay = days.find(d => d.pos > t.pos);
    const descEnd = Math.min(nextTimePos, nextDay ? nextDay.pos : text.length);
    let desc = text.slice(t.descStart, descEnd).trim();
    const star = desc.indexOf('*'); // footnote marker -- guards the very last entry
    if (star >= 0) desc = desc.slice(0, star).trim();
    if (!desc.startsWith(series)) continue;
    desc = desc.slice(series.length).trim().replace(/^(GE|GP|NO)\s+/, '').trim();
    const date = dayFor(t.pos);
    if (!date || !desc) continue;
    out.push({ date, start: t.start, end: t.end, name: desc });
  }
  return out;
}

type Session = { event_date: string; label: string; start_ts: string; end_ts: string | null };
function buildSessions(entries: RawEntry[], cfg: SourceConfig): Session[] {
  const mapLabel = (raw: string): string | null => {
    const key = raw.toLowerCase().replace(/\(.*?\)/g, '').trim();
    for (const [k, v] of cfg.labelMap) if (key === k) return v;
    return null;
  };
  const out: Session[] = [];
  let pairStart: RawEntry | null = null, pairFinish: RawEntry | null = null;
  for (const e of entries) {
    const nameKey = e.name.toLowerCase().replace(/\(.*?\)/g, '').trim();
    if (cfg.pairRace) {
      if (nameKey === cfg.pairRace.startName) { pairStart = e; continue; }
      if (nameKey === cfg.pairRace.finishName) { pairFinish = e; continue; }
    }
    const label = mapLabel(e.name);
    if (!label) continue; // unrecognized session name -> skip rather than guess
    const start_ts = toInstant(e.date, e.start);
    if (!start_ts) continue;
    const end_ts = e.end ? toInstant(e.date, e.end) : null;
    out.push({ event_date: e.date, label, start_ts, end_ts });
  }
  if (cfg.pairRace && pairStart && pairFinish) {
    const start_ts = toInstant(pairStart.date, pairStart.start);
    const end_ts = toInstant(pairFinish.date, pairFinish.start);
    if (start_ts && end_ts) out.push({ event_date: pairStart.date, label: cfg.pairRace.label, start_ts, end_ts });
  }
  return out;
}

async function getSources(): Promise<{ key: string; url: string }[]> {
  const res = await fetch(`${SB_URL}/rest/v1/stint9_schedule_sources?select=key,url&key=in.(${Object.keys(SOURCES).join(',')})`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) return [];
  return await res.json();
}

async function upsertSessions(sessions: Session[]): Promise<number> {
  if (!sessions.length) return 0;
  const res = await fetch(`${SB_URL}/rest/v1/stint9_schedule_windows?on_conflict=event_date,label`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(sessions),
  });
  if (!res.ok) throw new Error(`upsert: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return sessions.length;
}

async function logRun(ok: boolean, detail: unknown) {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/stint9_schedule_scrape_log`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify([{ ok, rounds_checked: 1, detail }]),
    });
    if (!res.ok) console.error('logRun insert failed:', res.status, await res.text());
  } catch (e) { console.error('logRun threw:', e); }
}

async function runSource(key: string, url: string): Promise<Record<string, unknown>> {
  const cfg = SOURCES[key];
  if (!cfg) return { key, status: 'unknown_source_key' };
  try {
    const pdfRes = await fetch(url);
    if (!pdfRes.ok) return { key, url, status: 'pdf_fetch_failed', http: pdfRes.status };
    const buf = new Uint8Array(await pdfRes.arrayBuffer());
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });

    const entries = parsePdfText(text, cfg.series);
    const sessions = buildSessions(entries, cfg);
    const foundLabels = new Set(sessions.map(s => s.label));
    if (!cfg.requiredLabels.every(l => foundLabels.has(l))) {
      return { key, url, status: 'required_labels_missing', required: cfg.requiredLabels, found: [...foundLabels] };
    }
    const written = await upsertSessions(sessions);
    return { key, url, status: 'ok', sessionsWritten: written, labels: sessions.map(s => `${s.event_date}/${s.label}`) };
  } catch (e) {
    return { key, url, status: 'error', error: String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const sources = await getSources();
    if (!sources.length) { await logRun(false, { error: 'no sources configured' }); return Response.json({ ok: false, error: 'no sources in stint9_schedule_sources' }, { status: 500, headers: CORS }); }

    const results = [];
    for (const s of sources) results.push(await runSource(s.key, s.url));

    const ok = results.every(r => r.status === 'ok' || r.status === 'required_labels_missing');
    await logRun(ok, { results });
    return Response.json({ ok, results }, { headers: CORS });
  } catch (e) {
    await logRun(false, { error: String(e) });
    return Response.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
});
