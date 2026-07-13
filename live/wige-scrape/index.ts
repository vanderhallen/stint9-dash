/* wige-scrape — Supabase Edge Function powering the LIVE "Update" button.
 * ===========================================================================
 * Per invocation it opens the WIGE timing WebSocket (the same Azure backend that
 * vdsmotorsport.com / wige.de use — see ../vds-relay.mjs), scans a range of
 * eventIds (or a given one), collects one leaderboard snapshot, then upserts:
 *   - public.stint9_live_timing   (one row per car|lap)
 *   - public.stint9_live_status   (single row/day the LIVE header badge reads)
 *
 * Serverless: no laptop/relay needed — the button (or pg_cron) drives it. The
 * long-running relay (../raceday.sh) is the continuous path; this is the on-demand
 * / fallback path. Both write the identical tables.
 *
 * Deploy: mcp deploy_edge_function (name wige-scrape, verify_jwt:false) or
 *         `supabase functions deploy wige-scrape --project-ref esvvzgxqnfszhttdkuzc`.
 * Secrets SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 * Optional WIGE_WS_URL secret overrides the endpoint (a real wige.de socket wins).
 *
 * Call:  POST/GET ?eventId=24        (known id, skips the scan)
 *        POST/GET ?range=1-80        (scan window; default 1-80)
 * ===========================================================================
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const WS_URL = Deno.env.get('WIGE_WS_URL') || 'wss://livetiming.azurewebsites.net/';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const COLLECT_MS = 7000; // socket collection window per call

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const p2 = (n: number) => String(n).padStart(2, '0');
function eventDate(): string { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }

// "1:23.4" | "83.4" | 83.4 | ""/null -> seconds | null
function secOrNull(v: unknown): number | null {
  if (v == null || v === '' || v === '-') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (Number.isFinite(+v)) return +v;
  let x = 0; for (const q of String(v).split(':')) x = x * 60 + parseFloat(q);
  return Number.isFinite(x) ? x : null;
}
function todSeconds(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d{1,2}:\d{2}:\d{2}/.test(v)) return secOrNull(v);
  const d = new Date(typeof v === 'string' && !Number.isFinite(+v) ? v : Number(v));
  if (isNaN(d.getTime())) return null;
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
}
// VDS lap time-of-day: first present candidate key, else receipt time. VERIFY on
// first live snapshot (kept identical to ../vds-relay.mjs).
const TOD_KEYS = ['TAGESZEIT', 'TIMEOFDAY', 'TOD', 'LASTLAPTIMEOFDAY', 'LASTPASSING', 'CROSSINGTIME'];
// deno-lint-ignore no-explicit-any
function lapEndTod(c: any, receipt: number | null): number | null {
  for (const k of TOD_KEYS) if (c[k] != null && c[k] !== '') return todSeconds(c[k]);
  return receipt;
}

type TimingRow = {
  event_date: string; car: string; lap: number; klass: string | null;
  s1: number | null; s2: number | null; s3: number | null; s4: number | null; s5: number | null;
  lap_end_tod: number | null; lap_time: number | null;
  inpit: boolean; fastest: boolean; driver: string | null; vehicle: string | null;
};
type Meta = { event_id: string; session: string | null; heat: string | null; track: string | null };

// deno-lint-ignore no-explicit-any
function mapCar(c: any, ed: string, receipt: number | null): TimingRow | null {
  const car = String(c.STNR ?? '').trim();
  const lap = Number(c.LAPS ?? c.LAP);
  if (!car || !Number.isFinite(lap)) return null;
  return {
    event_date: ed, car, lap,
    klass: c.CLASSNAME ?? null,
    s1: secOrNull(c.S1TIME), s2: secOrNull(c.S2TIME), s3: secOrNull(c.S3TIME),
    s4: secOrNull(c.S4TIME), s5: secOrNull(c.S5TIME),
    lap_end_tod: lapEndTod(c, receipt),
    lap_time: secOrNull(c.LASTLAPTIME),
    inpit: false, fastest: false,
    driver: c.NAME ?? null, vehicle: c.CAR ?? null,
  };
}

// Open the socket, subscribe to ids, gather one snapshot for COLLECT_MS.
async function collect(ids: string[]): Promise<{ meta: Meta | null; rows: TimingRow[] }> {
  const ed = eventDate();
  const receipt = todSeconds(Date.now());
  const timing = new Map<string, TimingRow>(); // car|lap -> row (later frames win)
  let meta: Meta | null = null;
  await new Promise<void>((resolve) => {
    let ws: WebSocket;
    const done = () => { try { ws.close(); } catch { /* noop */ } resolve(); };
    const timer = setTimeout(done, COLLECT_MS);
    try { ws = new WebSocket(WS_URL); } catch { clearTimeout(timer); return resolve(); }
    ws.onopen = () => { for (const id of ids) ws.send(JSON.stringify({ eventId: id, eventPid: [0, 4], clientLocalTime: Date.now() })); };
    ws.onmessage = (ev) => {
      // deno-lint-ignore no-explicit-any
      let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.PID === 'LTS_TIMESYNC' || m.PID === 'LTS_NOT_FOUND') return;
      if (!Array.isArray(m.RESULT) || !m.RESULT.length) return;
      if (!meta) meta = { event_id: String(m.EXPORTID ?? ''), session: m.SESSION ?? null, heat: (m.HEAT ?? null) + (m.HEATTYPE ? ` [${m.HEATTYPE}]` : ''), track: m.TRACKNAME ?? null };
      for (const c of m.RESULT) { const r = mapCar(c, ed, receipt); if (r) timing.set(`${r.car}|${r.lap}`, r); }
    };
    ws.onerror = () => { clearTimeout(timer); done(); };
  });
  return { meta, rows: [...timing.values()] };
}

async function upsert(table: string, rows: unknown[], onConflict: string) {
  if (!rows.length) return 0;
  const res = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return rows.length;
}

function idRange(spec: string | null): string[] {
  const m = spec?.match(/^(\d+)-(\d+)$/);
  if (m) { const out: string[] = []; for (let n = +m[1]; n <= +m[2] && out.length < 200; n++) out.push(String(n)); return out; }
  return Array.from({ length: 80 }, (_, i) => String(i + 1));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const ed = eventDate();
  try {
    const url = new URL(req.url);
    let eventId = url.searchParams.get('eventId') ?? '';
    let range = url.searchParams.get('range');
    if (req.method === 'POST') { try { const b = await req.json(); eventId = b.eventId ?? eventId; range = b.range ?? range; } catch { /* no body */ } }

    const ids = eventId ? [eventId] : idRange(range);
    const { meta, rows } = await collect(ids);

    const nT = await upsert('stint9_live_timing', rows, 'event_date,car,lap');
    await upsert('stint9_live_status', [{
      event_date: ed, live: !!meta, event_id: meta?.event_id ?? eventId ?? null,
      session: meta?.session ?? null, heat: meta?.heat ?? null, track: meta?.track ?? null,
      cars: rows.length, updated_at: new Date().toISOString(),
    }], 'event_date');

    return Response.json(
      { ok: true, live: !!meta, event_date: ed, event: meta?.event_id ?? null, track: meta?.track ?? null, heat: meta?.heat ?? null, cars: rows.length, timing: nT },
      { headers: CORS },
    );
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
});
