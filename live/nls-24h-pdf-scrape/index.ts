/* nls-24h-pdf-scrape — keeps the 24h Nürburgring qualifier/race sessions
 * (the "24h Qualifiers" rounds referenced elsewhere as NLS4/NLS5) current in
 * public.stint9_schedule_windows, from the official Zeitplan PDF.
 * ===========================================================================
 * Unlike nls-schedule-scrape (which reads nuerburgring-langstrecken-serie.de's
 * HTML calendar), the 24h weekend's Zeitplan is only published as a PDF on
 * 24h-rennen.de. That domain sits behind Cloudflare bot-protection that blocks
 * EVERYTHING except direct static-file paths (confirmed: the homepage,
 * robots.txt, wp-sitemap.xml, and a directory listing under /wp-content/
 * uploads/ all 403/429; the exact PDF path itself 200s fine). That means this
 * function CANNOT auto-discover a new/renamed PDF URL the way
 * nls-schedule-scrape discovers new NLS round pages -- there's no crawlable
 * calendar/index page it can reach.
 *
 * So the PDF URL is DATA, not code: public.stint9_schedule_sources holds it
 * (key='24h_zeitplan'), so bumping it to a new year's (or a re-versioned)
 * URL is a one-line SQL update, no redeploy -- same principle as
 * stint9_schedule_windows itself. This function re-fetches that known URL
 * daily, so an in-place revision to the SAME PDF (e.g. V2 -> V3 published at
 * an unchanged URL, which does happen) is picked up automatically; a URL
 * change (new year, or a re-versioned filename) still needs that one manual
 * update to stint9_schedule_sources.
 *
 * The PDF covers the WHOLE 24h weekend (multiple days, multiple series
 * sharing the same page -- DHLM, Tourenwagen-Legenden, RCN). Only rows
 * belonging to "ADAC RAVENOL 24h Nürburgring" are extracted; the rest is
 * someone else's schedule on the same layout. Text extraction via `unpdf`
 * (WASM, works in Deno/edge runtimes) -- verified against the real 2026 PDF
 * before this was deployed (single/merged-line text with no newlines, hence
 * the position-based day/time-anchor parsing below rather than line-splitting).
 *
 * SAFETY: same as nls-schedule-scrape -- never DELETEs, only upserts on
 * (event_date, label); logs every run to stint9_schedule_scrape_log; only
 * writes if both a race-start ("Start Rennen") AND race-finish
 * ("Zieleinlauf") entry were found, since those two are combined into one
 * "race" window spanning Saturday 15:00 to Sunday 15:00 (a real 24h race).
 *
 * Deploy: mcp deploy_edge_function (name nls-24h-pdf-scrape, verify_jwt:false).
 * Schedule: pg_cron stint9_24h_pdf_autoscan, daily.
 * ===========================================================================
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getDocumentProxy, extractText } from 'npm:unpdf';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SOURCE_KEY = '24h_zeitplan';
const SERIES = 'ADAC RAVENOL 24h Nürburgring'; // the only series on this shared-weekend PDF we track

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// German session name -> our column. "Start Rennen"/"Zieleinlauf" are handled
// separately (paired into one "race" window), not through this map.
const LABEL_MAP: [string, string][] = [
  ['top qualifying 1', 'topquali1'], ['top qualifying 2', 'topquali2'], ['top qualifying 3', 'topquali3'],
  ['qualifying 1', 'quali1'], ['qualifying 2', 'quali2'], ['qualifying 3', 'quali3'],
  ['warm-up', 'warmup'],
  ['startaufstellung', 'startaufstellung'],
  ['open grid', 'opengrid'],
  ['formationsrunde', 'formation'],
];
function mapLabel(raw: string): string | null {
  const key = raw.toLowerCase().trim();
  for (const [k, v] of LABEL_MAP) if (key === k) return v;
  return null;
}

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
// ("HH:MM Uhr" / "HH:MM - HH:MM Uhr") and day-headers ("Freitag, 15. Mai
// 2026"), then slicing the description between one anchor and the next
// (whichever -- next time or next day-header -- comes first).
function parsePdfText(text: string): RawEntry[] {
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
    if (!desc.startsWith(SERIES)) continue;
    desc = desc.slice(SERIES.length).trim().replace(/^(GE|GP)\s+/, '').trim();
    const date = dayFor(t.pos);
    if (!date || !desc) continue;
    out.push({ date, start: t.start, end: t.end, name: desc });
  }
  return out;
}

type Session = { event_date: string; label: string; start_ts: string; end_ts: string | null };
function buildSessions(entries: RawEntry[]): Session[] {
  const out: Session[] = [];
  let raceStart: RawEntry | null = null, raceFinish: RawEntry | null = null;
  for (const e of entries) {
    const nameKey = e.name.toLowerCase();
    if (nameKey === 'start rennen') { raceStart = e; continue; }
    if (nameKey === 'zieleinlauf') { raceFinish = e; continue; }
    const label = mapLabel(e.name);
    if (!label) continue; // unrecognized session name -> skip rather than guess
    const start_ts = toInstant(e.date, e.start);
    if (!start_ts) continue;
    const end_ts = e.end ? toInstant(e.date, e.end) : null;
    out.push({ event_date: e.date, label, start_ts, end_ts });
  }
  // The 24h race itself: "Start Rennen" (Sat) paired with "Zieleinlauf" (Sun)
  // into one window, exactly like a normal round's single race session.
  if (raceStart && raceFinish) {
    const start_ts = toInstant(raceStart.date, raceStart.start);
    const end_ts = toInstant(raceFinish.date, raceFinish.start);
    if (start_ts && end_ts) out.push({ event_date: raceStart.date, label: 'race', start_ts, end_ts });
  }
  return out;
}

async function getSourceUrl(): Promise<string | null> {
  const res = await fetch(`${SB_URL}/rest/v1/stint9_schedule_sources?select=url&key=eq.${SOURCE_KEY}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.url ?? null;
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const url = await getSourceUrl();
    if (!url) { await logRun(false, { error: 'no source url configured' }); return Response.json({ ok: false, error: 'no source url in stint9_schedule_sources' }, { status: 500, headers: CORS }); }

    const pdfRes = await fetch(url);
    if (!pdfRes.ok) { await logRun(false, { error: `pdf fetch ${pdfRes.status}`, url }); return Response.json({ ok: false, error: `pdf fetch ${pdfRes.status}`, url }, { status: 502, headers: CORS }); }
    const buf = new Uint8Array(await pdfRes.arrayBuffer());
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });

    const entries = parsePdfText(text);
    const sessions = buildSessions(entries);
    if (!sessions.some(s => s.label === 'race')) {
      await logRun(false, { status: 'no_race_window_found', url, entriesFound: entries.length });
      return Response.json({ ok: false, status: 'no_race_window_found', entriesFound: entries.length, url }, { headers: CORS });
    }

    const written = await upsertSessions(sessions);
    await logRun(true, { url, sessionsWritten: written, labels: sessions.map(s => `${s.event_date}/${s.label}`) });
    return Response.json({ ok: true, sessionsWritten: written, sessions, url }, { headers: CORS });
  } catch (e) {
    await logRun(false, { error: String(e) });
    return Response.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
});
