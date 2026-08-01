/* wige-scrape — Supabase Edge Function powering the LIVE feed / "Update" button.
 * ===========================================================================
 * Per invocation it opens the WIGE timing WebSocket (the same Azure backend that
 * vdsmotorsport.com / wige.de use — see ../vds-relay.mjs), subscribes to the live
 * NLS eventId, collects leaderboard + race-control snapshots, then upserts:
 *   - public.stint9_live_timing   (one row per car|lap)
 *   - public.stint9_messages      (race-control messages, channel [3], deduped)
 *   - public.stint9_live_status   (single row/day the LIVE header badge reads)
 *
 * Two modes (see the docs on ../LIVE-DATA-FLOW.md / ../RACEDAY.md):
 *
 *   ONE-SHOT (default — the ⟳ Update button):
 *     open socket, gather for COLLECT_MS (~7s), one upsert, return. Fast; the
 *     browser's ⟳ stays responsive. This is the historical behaviour.
 *
 *   HOLD (opt-in via ?hold=1 — pg_cron):
 *     hold ONE socket open for HOLD_MS (~149s, just under the free-plan 150s Edge
 *     Function wall-clock cap) and flush changed rows to Supabase every FLUSH_MS
 *     (~5s). This lands LIVE data ~every 5s instead of once per cron minute
 *     WITHOUT any extra WIGE connects — density comes from holding the one socket
 *     longer, not from connecting more often (WIGE rate-limits fresh connects, not
 *     held sockets; see ../LIVE-TROUBLESHOOTING.md Lesson 1). A freshness guard
 *     (GUARD_STALE_MS) makes an overlapping cron fire — or a running vds-relay —
 *     stand down, so only ONE collector is ever connected at a time.
 *
 * Deploy: mcp deploy_edge_function (name wige-scrape, verify_jwt:false) or
 *         `supabase functions deploy wige-scrape --project-ref esvvzgxqnfszhttdkuzc`.
 * Secrets SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 * Optional WIGE_WS_URL secret overrides the endpoint (a real wige.de socket wins).
 *
 * Enable HOLD mode on the cron (do this BETWEEN sessions — deploying alone changes
 * nothing at runtime since hold is opt-in). Add ?hold=1 to the URL the
 * `stint9_wige_autoscan` job POSTs to; the 60s cron then just respawns the single
 * ~149s holder (competing fires exit cheaply via the guard, before touching WIGE):
 *   -- in the job command: .../functions/v1/wige-scrape?hold=1
 *
 * Call:  POST/GET ?eventId=24        (known id, skips discovery)
 *        POST/GET ?hold=1            (hold mode; discovers the live id)
 *        POST/GET ?range=1-80        (legacy scan window; one-shot only)
 * ===========================================================================
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const WS_URL = Deno.env.get('WIGE_WS_URL') || 'wss://livetiming.azurewebsites.net/';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const COLLECT_MS = 7000;       // one-shot (⟳ button) socket window — unchanged
const HOLD_MS = 149000;        // hold mode: ~149s, just under the free-plan 150s cap
const FLUSH_MS = 5000;         // hold mode: upsert changed rows to Supabase this often
const GUARD_STALE_MS = 15000;  // hold mode: if the status row advanced within this,
                               // another holder/relay is live -> stand down (no WIGE connect)

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
// P1-4: lap time-of-day is TOD on the message ROOT, not a per-car field (verified
// by the stint9 owner). We still probe per-car keys first in case a future feed
// exposes a real crossing time, else fall back to root TOD (snapshot time), and
// only to receipt time if TOD is absent. Kept in sync with ../vds-relay.mjs.
const TOD_KEYS = ['TAGESZEIT', 'TIMEOFDAY', 'LASTLAPTIMEOFDAY', 'LASTPASSING', 'CROSSINGTIME'];
// deno-lint-ignore no-explicit-any
function lapEndTod(c: any, rootTod: number | null): number | null {
  for (const k of TOD_KEYS) if (c[k] != null && c[k] !== '') return todSeconds(c[k]);
  return rootTod;
}

// P1-2: only latch/accept an event whose TRACKNAME matches NLS/Nordschleife when
// scanning a range (WIGE serves several series at once). WIGE_TRACK_MATCH overrides.
const TRACK_RE = new RegExp(Deno.env.get('WIGE_TRACK_MATCH') || 'n[uü]rburgring|nordschleife', 'i');
// deno-lint-ignore no-explicit-any
function acceptEvent(m: any): boolean { return TRACK_RE.test(String(m.TRACKNAME || '')); }

type TimingRow = {
  event_date: string; car: string; lap: number; klass: string | null;
  s1: number | null; s2: number | null; s3: number | null; s4: number | null; s5: number | null;
  s1_kmh: number | null; s2_kmh: number | null; s3_kmh: number | null; s4_kmh: number | null; s5_kmh: number | null;
  lap_end_tod: number | null; lap_time: number | null;
  inpit: boolean; fastest: boolean; driver: string | null; vehicle: string | null;
};
type Meta = { event_id: string; session: string | null; heat: string | null; track: string | null };

// deno-lint-ignore no-explicit-any
function mapCar(c: any, ed: string, rootTod: number | null, nSectors: number): TimingRow | null {
  const car = String(c.STNR ?? '').trim();
  const lap = Number(c.LAPS ?? c.LAP);
  if (!car || !Number.isFinite(lap)) return null;
  // P2: sector count from the feed. Table has s1..s5, so cap at 5.
  const s = (k: number) => (k <= nSectors ? secOrNull(c[`S${k}TIME`]) : null);
  // S{k}SPEED — WIGE's per-sector-boundary speed reading, feeds the dashboard's
  // Code 60 detector (index.html's code60Sectors()). Kept in sync with ../vds-relay.mjs.
  const spd = (k: number) => (k <= nSectors ? secOrNull(c[`S${k}SPEED`]) : null);
  return {
    event_date: ed, car, lap,
    klass: c.CLASSNAME ?? null,
    s1: s(1), s2: s(2), s3: s(3), s4: s(4), s5: s(5),
    s1_kmh: spd(1), s2_kmh: spd(2), s3_kmh: spd(3), s4_kmh: spd(4), s5_kmh: spd(5),
    lap_end_tod: lapEndTod(c, rootTod),
    lap_time: secOrNull(c.LASTLAPTIME),
    inpit: false, fastest: false,
    driver: c.NAME ?? null, vehicle: c.CAR ?? null,
  };
}

// Race-control messages: WIGE channel [3] pushes frames shaped like
//   { PID:"3", CUP, HEAT, MESSAGES:[{ ID, MESSAGETIME:"HH:MM:SS", MESSAGE, MESSAGEGROUP }] }
// (verified from a live NLS session 2026-08-01). ID is a rolling position index
// (1 = newest), NOT stable, so we dedup on <event_date>|<MESSAGETIME>|<MESSAGE>.
// The feed replaces non-ASCII (ü, en-dash) with '?', so text is stored verbatim.
type MessageRow = { race_class: string | null; car: string | null; message: string; source: string; created_at?: string; ext_key: string };

// MESSAGETIME is Europe/Berlin wall-clock. Convert (date + HH:MM:SS) -> UTC ISO,
// DST-safe via the zone-offset subtraction trick. Returns null if unparseable
// (caller then omits created_at so the column default now() applies).
function berlinToUtcISO(dateStr: string, hms: string): string | null {
  if (!/^\d{1,2}:\d{2}:\d{2}$/.test(hms)) return null;
  const guess = new Date(`${dateStr}T${hms.padStart(8, '0')}Z`);
  if (isNaN(guess.getTime())) return null;
  const berlin = new Date(guess.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (berlin.getTime() - utc.getTime())).toISOString();
}

// deno-lint-ignore no-explicit-any
function mapMessages(items: any[], ed: string): MessageRow[] {
  const out: MessageRow[] = [];
  for (const it of items || []) {
    const message = String(it?.MESSAGE ?? '').trim();
    if (!message) continue;
    const mtime = String(it?.MESSAGETIME ?? '').trim();
    const carM = message.match(/#\s*(\d+)/);            // first car number named, if any
    const created = berlinToUtcISO(ed, mtime);
    out.push({
      race_class: null,                                 // MESSAGEGROUP is empty in the feed; msgs apply to all classes
      car: carM ? carM[1] : null,
      message, source: 'wige',
      ...(created ? { created_at: created } : {}),
      ext_key: `${ed}|${mtime}|${message}`,
    });
  }
  return out;
}

type CollectOpts = {
  holdMs: number;
  flushMs?: number;
  // Called every flushMs with the timing rows that CHANGED and any race-control
  // messages NOT yet flushed since the last tick, plus the full current field
  // size — lets HOLD mode stream both to Supabase mid-socket.
  onFlush?: (rows: TimingRow[], meta: Meta | null, total: number, messages: MessageRow[]) => void | Promise<void>;
};

// Open the socket, subscribe to ids, gather snapshots for opts.holdMs. When
// opts.flushMs/onFlush are set, changed rows are pushed out every flushMs while the
// socket stays open (HOLD mode); otherwise it's a single gather-then-return.
// `gated` (range scan) rejects events whose TRACKNAME doesn't match; a single
// explicit eventId is trusted as-is. Returns rejected candidates for the caller.
async function collect(ids: string[], gated: boolean, opts: CollectOpts): Promise<{ meta: Meta | null; rows: TimingRow[]; messages: MessageRow[]; rejected: string[] }> {
  const ed = eventDate();
  const receipt = todSeconds(Date.now());
  const timing = new Map<string, TimingRow>(); // car|lap -> row (later frames win)
  const messages = new Map<string, MessageRow>(); // ext_key -> row (union across frames)
  const rejected = new Set<string>();
  let meta: Meta | null = null;
  const sig = (r: TimingRow) => `${r.s1},${r.s2},${r.s3},${r.s4},${r.s5},${r.lap_time},${r.lap_end_tod}`;
  const lastSig = new Map<string, string>(); // key -> last-flushed signature (HOLD mode)
  const flushedMsg = new Set<string>();       // ext_keys already flushed (HOLD mode)
  await new Promise<void>((resolve) => {
    let ws: WebSocket;
    let flushTimer: number | undefined;
    const done = () => { if (flushTimer !== undefined) clearInterval(flushTimer); try { ws.close(); } catch { /* noop */ } resolve(); };
    const timer = setTimeout(done, opts.holdMs);
    try { ws = new WebSocket(WS_URL); } catch { clearTimeout(timer); return resolve(); }
    // eventPid [0,4] = leaderboard/trackState, 3 = race-control messages.
    ws.onopen = () => { for (const id of ids) ws.send(JSON.stringify({ eventId: id, eventPid: [0, 4, 3], clientLocalTime: Date.now() })); };
    ws.onmessage = (ev) => {
      // deno-lint-ignore no-explicit-any
      let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.PID === 'LTS_TIMESYNC' || m.PID === 'LTS_NOT_FOUND') return;
      // Channel [3]: race-control message frame (no RESULT). Collect & dedup.
      if (Array.isArray(m.MESSAGES)) { for (const r of mapMessages(m.MESSAGES, ed)) messages.set(r.ext_key, r); return; }
      if (!Array.isArray(m.RESULT) || !m.RESULT.length) return;
      // P1-2: skip wrong-series snapshots while range-scanning.
      if (gated && !acceptEvent(m)) { const id = String(m.EXPORTID ?? ''); if (id) rejected.add(id); return; }
      // P1-4: root TOD (snapshot time); P2: sector count both from the message root.
      const rootTod = m.TOD != null && m.TOD !== '' ? todSeconds(m.TOD) : receipt;
      const nSectors = Math.max(1, Number(m.NROFINTERMEDIATETIMES) || 5);
      if (!meta) meta = { event_id: String(m.EXPORTID ?? ''), session: m.SESSION ?? null, heat: (m.HEAT ?? null) + (m.HEATTYPE ? ` [${m.HEATTYPE}]` : ''), track: m.TRACKNAME ?? null };
      for (const c of m.RESULT) { const r = mapCar(c, ed, rootTod, nSectors); if (r) timing.set(`${r.car}|${r.lap}`, r); }
    };
    ws.onerror = () => { clearTimeout(timer); done(); };
    // HOLD mode: stream just-changed rows to Supabase every flushMs. Fire-and-forget
    // (don't await inside the interval) so a slow write can't stack up the ticks; a
    // dropped tail is harmless — snapshots are full state, refetched next tick.
    if (opts.flushMs && opts.onFlush) {
      flushTimer = setInterval(() => {
        const changed: TimingRow[] = [];
        for (const [k, r] of timing) { const s = sig(r); if (lastSig.get(k) !== s) { lastSig.set(k, s); changed.push(r); } }
        const newMsgs: MessageRow[] = [];
        for (const [k, r] of messages) { if (!flushedMsg.has(k)) { flushedMsg.add(k); newMsgs.push(r); } }
        if (changed.length || newMsgs.length) Promise.resolve(opts.onFlush!(changed, meta, timing.size, newMsgs)).catch(() => { /* next tick retries */ });
      }, opts.flushMs);
    }
  });
  return { meta, rows: [...timing.values()], messages: [...messages.values()], rejected: [...rejected] };
}

// resolution: merge-duplicates (default, updates on conflict) or ignore-duplicates
// (skip existing rows — used for messages so a re-scrape never rewrites created_at).
async function upsert(table: string, rows: unknown[], onConflict: string, resolution = 'merge-duplicates') {
  if (!rows.length) return 0;
  const res = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: `resolution=${resolution},return=minimal` },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return rows.length;
}

function statusRow(ed: string, meta: Meta | null, eventId: string, cars: number) {
  return {
    event_date: ed, live: !!meta, event_id: meta?.event_id ?? eventId ?? null,
    session: meta?.session ?? null, heat: meta?.heat ?? null, track: meta?.track ?? null,
    cars, updated_at: new Date().toISOString(),
  };
}

// HOLD mode guard: has the day's status row advanced within staleMs? If so, another
// holder (a still-running ~149s socket) or the vds-relay is already collecting — so
// stand down instead of opening a second WIGE socket. One read, before any WIGE contact.
async function activeHolder(ed: string, staleMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/stint9_live_status?select=updated_at&event_date=eq.${ed}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!res.ok) return false;
    const a = await res.json();
    const u = a?.[0]?.updated_at;
    return !!u && (Date.now() - new Date(u).getTime()) < staleMs;
  } catch { return false; }
}

function idRange(spec: string | null): string[] {
  const m = spec?.match(/^(\d+)-(\d+)$/);
  if (m) { const out: string[] = []; for (let n = +m[1]; n <= +m[2] && out.length < 200; n++) out.push(String(n)); return out; }
  return Array.from({ length: 80 }, (_, i) => String(i + 1));
}

// P5 (2026-07-31 raceday fix): the WIGE socket only honours ONE event
// subscription per connection — blasting a whole range of eventIds on a single
// socket makes the server answer LTS_NOT_FOUND to ALL of them (verified live:
// event 20 was broadcasting 53 cars, yet a 1..80 mass-subscribe saw nothing and
// even rejected:[] was empty). That silently broke the default range-scan for
// its entire life, which is why stint9_live_status was never once `live`.
//
// So don't brute-force the socket at all: WIGE's own vln.html embeds the current
// NLS/VLN event id in its results iframe (…/events/<ID>/results). Read that with
// one HTTP GET and subscribe to just that id (the reliable single-subscribe
// path). It also tracks the id automatically if WIGE renumbers it per session.
const DISCOVER_URL = Deno.env.get('WIGE_DISCOVER_URL') || 'https://livetiming.wige.de/vln.html';
async function discoverEventId(): Promise<string | null> {
  try {
    const res = await fetch(DISCOVER_URL, { headers: { 'user-agent': 'stint9-dash' } });
    if (!res.ok) return null;
    const m = (await res.text()).match(/events\/(\d+)\/results/);
    return m ? m[1] : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const ed = eventDate();
  try {
    const url = new URL(req.url);
    let eventId = url.searchParams.get('eventId') ?? '';
    let range = url.searchParams.get('range');
    const hp = url.searchParams.get('hold');
    let hold = hp != null && hp !== '0' && hp !== 'false';
    if (req.method === 'POST') { try { const b = await req.json(); eventId = b.eventId ?? eventId; range = b.range ?? range; if (b.hold != null) hold = !!b.hold; } catch { /* no body */ } }

    // ---- HOLD mode (pg_cron): one long-held socket, flush every ~5s ----------
    if (hold) {
      // Another ~149s holder — or the vds-relay — is already streaming: stand down.
      if (await activeHolder(ed, GUARD_STALE_MS))
        return Response.json({ ok: true, held: false, reason: 'collector-active', event_date: ed }, { headers: CORS });
      if (!eventId) eventId = (await discoverEventId()) ?? '';
      // No live event id: don't hold a doomed socket for 149s — bail fast so the
      // next cron tick can try again cheaply.
      if (!eventId)
        return Response.json({ ok: true, held: false, reason: 'no-live-event', event_date: ed }, { headers: CORS });

      let flushed = 0, msgFlushed = 0;
      const onFlush = (rows: TimingRow[], meta: Meta | null, total: number, msgs: MessageRow[]) => (async () => {
        flushed += await upsert('stint9_live_timing', rows, 'event_date,car,lap');
        // Race-control messages -> stint9_messages, deduped on ext_key (ignore-duplicates).
        msgFlushed += await upsert('stint9_messages', msgs, 'ext_key', 'ignore-duplicates');
        await upsert('stint9_live_status', [statusRow(ed, meta, eventId, total)], 'event_date');
      })();
      const { meta, rows, messages } = await collect([eventId], /* gated */ false, { holdMs: HOLD_MS, flushMs: FLUSH_MS, onFlush });
      // Final status write with the true field size (last flush carried a batch count).
      await upsert('stint9_live_status', [statusRow(ed, meta, eventId, rows.length)], 'event_date');
      return Response.json({ ok: true, held: true, live: !!meta, event_date: ed, event: meta?.event_id ?? eventId, cars: rows.length, timing: flushed, messages: msgFlushed, messagesSeen: messages.length }, { headers: CORS });
    }

    // ---- ONE-SHOT mode (⟳ button / default): unchanged 7s snapshot -----------
    // Default path: discover the live id from vln.html and subscribe to just it.
    // Only fall back to the (mass-subscribe) range scan if a range was explicitly
    // asked for — a bare range scan is known-broken, see above.
    if (!eventId && !range) eventId = (await discoverEventId()) ?? '';
    const ids = eventId ? [eventId] : idRange(range);
    const { meta, rows, messages, rejected } = await collect(ids, /* gated */ !eventId, { holdMs: COLLECT_MS });

    const nT = await upsert('stint9_live_timing', rows, 'event_date,car,lap');
    // Race-control messages (channel [3]) -> stint9_messages, deduped on ext_key.
    const nM = await upsert('stint9_messages', messages, 'ext_key', 'ignore-duplicates');
    await upsert('stint9_live_status', [statusRow(ed, meta, eventId, rows.length)], 'event_date');

    return Response.json(
      { ok: true, live: !!meta, event_date: ed, event: meta?.event_id ?? null, track: meta?.track ?? null, heat: meta?.heat ?? null, cars: rows.length, timing: nT, messages: nM, rejected },
      { headers: CORS },
    );
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
});
