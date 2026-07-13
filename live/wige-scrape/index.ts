/* wige-scrape — Supabase Edge Function that fills the LIVE feed.
 *
 * Per invocation it (a) opens the WIGE live-timing WebSocket, (b) subscribes to
 * the results + messages channels, (c) collects a snapshot for CFG.COLLECT_MS,
 * then (d) upserts into public.stint9_live_timing and public.stint9_messages.
 * Meant to be called by pg_cron every ~30-60s while an event is live.
 *
 * Until the socket details are captured (CFG.SOCKET_URL empty / CFG.MOCK_MODE),
 * it runs in MOCK mode: it upserts an embedded 2-car sample so the whole chain
 * (this fn -> tables -> dashboard LIVE loop) is deployable and testable today.
 *
 * Deploy:  see ../../RACEDAY.md  (mcp deploy or `supabase functions deploy wige-scrape`)
 * Secrets: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 */
import { CFG, mapResults, mapMessages, type TimingRow, type MessageRow } from './config.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function eventDate(): string {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function upsert(table: string, rows: unknown[], onConflict?: string) {
  if (!rows.length) return 0;
  const qs = onConflict ? `?on_conflict=${onConflict}` : '';
  const res = await fetch(`${SB_URL}/rest/v1/${table}${qs}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} upsert ${res.status}: ${await res.text()}`);
  return rows.length;
}

// ---- MOCK snapshot: a tiny 2-car slice with valid geometry ----
function mockSnapshot(ed: string): { timing: TimingRow[]; messages: MessageRow[] } {
  const row = (car: string, lap: number, base: number, tod: number, pit = false, s5: number | null = 61.9): TimingRow => ({
    event_date: ed, car, lap, klass: 'SP9 PRO',
    s1: base, s2: base + 4, s3: base * 2, s4: base * 3, s5,
    lap_end_tod: tod, lap_time: base + (base + 4) + base * 2 + base * 3 + (s5 ?? 0),
    inpit: pit, fastest: false, driver: car === '941' ? 'Testdriver A' : 'Testdriver B',
    vehicle: car === '941' ? 'Porsche 911 GT3 R' : 'Audi R8 LMS',
  });
  return {
    timing: [
      row('941', 1, 86, 43450), row('941', 2, 85.5, 44120),
      row('666', 1, 87, 43460), row('666', 2, 86.5, 44140, true, null),
    ],
    messages: [{ race_class: null, car: null, message: 'MOCK: pipeline online — awaiting live WIGE feed.', source: 'wige-mock' }],
  };
}

// ---- REAL snapshot: connect, subscribe, collect for COLLECT_MS ----
async function liveSnapshot(ed: string): Promise<{ timing: TimingRow[]; messages: MessageRow[] }> {
  const timing = new Map<string, TimingRow>();   // keyed car|lap so later frames win
  const messages: MessageRow[] = [];
  await new Promise<void>((resolve) => {
    // NOTE: Deno's WebSocket cannot set an Origin header; if WIGE rejects on
    // Origin we switch to a raw fetch Upgrade with headers here (see RACEDAY.md).
    const ws = new WebSocket(CFG.SOCKET_URL);
    const done = () => { try { ws.close(); } catch { /* noop */ } resolve(); };
    const timer = setTimeout(done, CFG.COLLECT_MS);
    ws.onopen = () => {
      for (const frame of CFG.SUBSCRIBE) {
        const s = JSON.stringify(frame).replaceAll('{EVENT_ID}', CFG.EVENT_ID);
        ws.send(s);
      }
    };
    ws.onmessage = (ev) => {
      let msg: any; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      // TODO(raceday): route by the real channel field once known.
      const ch = msg?.channel ?? msg?.ch;
      if (CFG.CH.results.includes(ch) || msg?.results || msg?.entries)
        for (const r of mapResults(msg, ed)) timing.set(`${r.car}|${r.lap}`, r);
      if (CFG.CH.messages.includes(ch) || msg?.messages)
        for (const m of mapMessages(msg)) messages.push(m);
    };
    ws.onerror = () => { clearTimeout(timer); done(); };
  });
  return { timing: [...timing.values()], messages };
}

Deno.serve(async (_req) => {
  const ed = eventDate();
  try {
    const useMock = CFG.MOCK_MODE || !CFG.SOCKET_URL;
    const snap = useMock ? mockSnapshot(ed) : await liveSnapshot(ed);
    const nT = await upsert('stint9_live_timing', snap.timing, 'event_date,car,lap');
    const nM = await upsert('stint9_messages', snap.messages);   // append-only
    return Response.json({ ok: true, mode: useMock ? 'mock' : 'live', event_date: ed, timing: nT, messages: nM });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
