/* nls-schedule-scrape — Supabase Edge Function that keeps public.stint9_schedule_windows
 * current, automatically, straight from the official NLS calendar.
 * ===========================================================================
 * public.stint9_schedule_windows is the single source of truth for two things:
 *   1. index.html's race-day timetable/countdown reel
 *   2. the pg_cron job (stint9_wige_autoscan) that gates automatic WIGE polling
 * Both used to be manually-entered guesses (a "4h round template", per the
 * comment this replaced) that turned out wrong once the real Zeitplan for
 * NLS7 was published — the race was 6h (12:00-18:00), not 4h (12:00-16:00).
 * This function replaces that manual step with a direct read of the real page.
 *
 * Flow per invocation:
 *   1. Fetch the season calendar page, extract {date, url, roundNo} for every
 *      NLS round listed (regex over its <table> — see parseCalendar()).
 *   2. For each round whose date is upcoming (today .. +CALENDAR_HORIZON_DAYS),
 *      fetch its own event page and parse its "Zeitplan" table, if published
 *      (see parseZeitplan()).
 *   3. Upsert parsed sessions into stint9_schedule_windows, keyed on
 *      (event_date, label) — requires the unique constraint added alongside
 *      this function's first deploy (see the migration in RACEDAY.md history).
 *   4. Log the whole run (rounds seen, sessions written, any skip reasons) to
 *      stint9_schedule_scrape_log for visibility, since this runs unattended.
 *
 * SAFETY: never DELETEs. A round with no Zeitplan yet, an unparseable page, or
 * a network error just means nothing is written for that round this run —
 * existing rows (including a manual correction) are left alone. A round is
 * only written if its parse yields at least a "race" session, as a basic
 * sanity check against a garbled/partial parse.
 *
 * Schedule: pg_cron, once daily (see stint9_nls_schedule_autoscan in the
 * migration) — the Zeitplan for a round is typically published weeks/months
 * ahead and doesn't change hour-to-hour, so daily is frequent enough.
 *
 * Deploy: mcp deploy_edge_function (name nls-schedule-scrape, verify_jwt:false).
 * ===========================================================================
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CALENDAR_URL = 'https://www.nuerburgring-langstrecken-serie.de/language/de/termine-adac-ravenol-nuerburgring-langstrecken-serie-2026/';
const CALENDAR_HORIZON_DAYS = 120; // don't bother fetching event pages further out than this

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// German Zeitplan label (lowercased, parenthetical stripped) -> our column.
// startsWith match, so "rennen" also catches "rennen (6 stunden)" etc.
const LABEL_MAP: [string, string][] = [
  ['zeittraining', 'quali'], ['qualifying', 'quali'], ['quali', 'quali'],
  ['pitwalk', 'pitwalk'],
  ['gridwalk', 'lineup'],
  ['startaufstellung', 'startaufstellung'],
  ['boxengasse', 'pitlane'], ['pitlane', 'pitlane'],
  ['warm-up', 'formation'], ['einführungsrunde', 'formation'], ['formation', 'formation'],
  ['rennen', 'race'],
];
function mapLabel(raw: string): string | null {
  const key = raw.toLowerCase().replace(/\(.*?\)/g, '').trim();
  for (const [k, v] of LABEL_MAP) if (key.startsWith(k)) return v;
  return null; // unrecognized label -> skip that row rather than guess
}

// EU DST rule (applies to Germany): CEST (+02:00) from the last Sunday of
// March 01:00 UTC to the last Sunday of October 01:00 UTC; CET (+01:00)
// otherwise. Stable, well-defined rule -- no timezone DB needed in Deno.
function berlinOffsetHours(y: number, m: number, d: number): number {
  const lastSunday = (year: number, month: number) => { // month: 0=Jan
    const last = new Date(Date.UTC(year, month + 1, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const dstStart = Date.UTC(y, 2, lastSunday(y, 2), 1, 0, 0);   // last Sun of March, 01:00 UTC
  const dstEnd = Date.UTC(y, 9, lastSunday(y, 9), 1, 0, 0);     // last Sun of October, 01:00 UTC
  const t = Date.UTC(y, m - 1, d, 12, 0, 0); // midday, safely inside either side
  return (t >= dstStart && t < dstEnd) ? 2 : 1;
}
// "YYYY-MM-DD" + "HH:MM" (Berlin wall-clock) -> ISO instant.
function toInstant(dateStr: string, hm: string): string | null {
  const dm = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const [, y, mo, d] = dm.map(Number as unknown as (s: string) => number);
  const [, hh, mm] = tm.map(Number as unknown as (s: string) => number);
  const off = berlinOffsetHours(y, mo, d);
  const utcMs = Date.UTC(y, mo - 1, d, hh - off, mm, 0);
  return new Date(utcMs).toISOString();
}

type RoundRef = { eventDate: string; url: string; roundNo: string; title: string };
function parseCalendar(html: string): RoundRef[] {
  const out: RoundRef[] = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html))) {
    const block = m[1];
    const dm = block.match(/<td>\s*(\d{2})\.(\d{2})\.(\d{4})\s*<\/td>/);
    const am = block.match(/<a href="([^"]+)"[^>]*>\s*NLS(\d+)\s*:\s*([^<]*)</);
    if (!dm || !am) continue; // combined/irregular rows (e.g. "18.-19.04.2026") skipped, not guessed
    out.push({ eventDate: `${dm[3]}-${dm[2]}-${dm[1]}`, url: am[1], roundNo: am[2], title: am[3].trim() });
  }
  return out;
}

type Session = { label: string; start: string; end: string | null }; // start/end = "HH:MM"
function parseZeitplan(html: string): Session[] {
  const heading = html.indexOf('>Zeitplan<');
  if (heading < 0) return [];
  const tableStart = html.indexOf('<table', heading);
  const tableEnd = html.indexOf('</table>', tableStart);
  if (tableStart < 0 || tableEnd < 0) return [];
  const tableHtml = html.slice(tableStart, tableEnd);
  const out: Session[] = [];
  const trRe = /<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/g;
  let m;
  while ((m = trRe.exec(tableHtml))) {
    const label = mapLabel(m[2]);
    if (!label) continue;
    const decoded = m[1].replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-').trim();
    const range = decoded.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    const single = decoded.match(/^(\d{1,2}:\d{2})/);
    if (range) out.push({ label, start: range[1], end: range[2] });
    else if (single) out.push({ label, start: single[1], end: null });
  }
  return out;
}

async function upsertSessions(eventDate: string, sessions: Session[]): Promise<number> {
  const rows = sessions
    .map(s => ({ event_date: eventDate, label: s.label, start_ts: toInstant(eventDate, s.start), end_ts: s.end ? toInstant(eventDate, s.end) : null }))
    .filter(r => r.start_ts); // drop anything that failed to parse into a real instant
  if (!rows.length) return 0;
  const res = await fetch(`${SB_URL}/rest/v1/stint9_schedule_windows?on_conflict=event_date,label`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upsert ${eventDate}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return rows.length;
}

async function logRun(ok: boolean, roundsChecked: number, detail: unknown) {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/stint9_schedule_scrape_log`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      // column names must match the table exactly (ok, rounds_checked, detail) --
      // a silent mismatch here previously meant every log write 404/42703'd
      // and was swallowed by this same try/catch.
      body: JSON.stringify([{ ok, rounds_checked: roundsChecked, detail }]),
    });
    if (!res.ok) console.error('logRun insert failed:', res.status, await res.text());
  } catch (e) { console.error('logRun threw:', e); /* logging is best-effort, never block the actual scrape on it */ }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const rounds: Record<string, unknown>[] = [];
  try {
    const calRes = await fetch(CALENDAR_URL);
    if (!calRes.ok) throw new Error(`calendar fetch ${calRes.status}`);
    const calHtml = await calRes.text();
    const allRounds = parseCalendar(calHtml);

    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + CALENDAR_HORIZON_DAYS * 86400000).toISOString().slice(0, 10);
    const upcoming = allRounds.filter(r => r.eventDate >= today && r.eventDate <= horizon);

    for (const r of upcoming) {
      try {
        const pageRes = await fetch(r.url);
        if (!pageRes.ok) { rounds.push({ ...r, status: 'page_fetch_failed', http: pageRes.status }); continue; }
        const pageHtml = await pageRes.text();
        const sessions = parseZeitplan(pageHtml);
        if (!sessions.some(s => s.label === 'race')) { rounds.push({ ...r, status: 'no_zeitplan_yet', sessionsFound: sessions.length }); continue; }
        const written = await upsertSessions(r.eventDate, sessions);
        rounds.push({ ...r, status: 'ok', sessionsWritten: written, labels: sessions.map(s => s.label) });
      } catch (e) {
        rounds.push({ ...r, status: 'error', error: String(e) });
      }
    }

    await logRun(true, upcoming.length, { rounds });
    return Response.json({ ok: true, roundsChecked: upcoming.length, rounds }, { headers: CORS });
  } catch (e) {
    await logRun(false, rounds.length, { error: String(e), rounds });
    return Response.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
});
