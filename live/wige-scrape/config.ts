/* config.ts — the ONLY file that changes on race day.
 *
 * Everything else in the LIVE pipeline (table, build-db.js, dashboard loop) is
 * built and tested. The three things below cannot be known until we capture a
 * live WIGE session (see ../../STINT9-INFO-REQUEST.md and ../../RACEDAY.md):
 *
 *   1. SOCKET_URL   — the wss:// endpoint the leaderboard SPA connects to
 *   2. SUBSCRIBE    — the frame(s) sent right after connect to join channels
 *   3. mapResults / mapMessages — how a channel payload maps to our DB rows
 *
 * Channel numbers were already recovered from leaderboard.*.bundle.js by static
 * analysis (stint9-dashboard-summary.md):
 *      messages = [3]        trackState/results = [0, 4]      statistics = [9002]
 */

export const CFG = {
  // 1) WebSocket endpoint — from DevTools > Network > WS > Request URL.  TODO(raceday)
  SOCKET_URL: '',                    // e.g. 'wss://livetiming.azurewebsites.net/...'
  ORIGIN: 'https://livetiming.wige.de',   // some servers reject foreign Origins; spoof server-side
  EVENT_ID: '',                      // WIGE event id (in the iframe results URL), if the socket needs it

  // 2) Frame(s) to send after the socket opens, to subscribe to the channels we
  //    want. Exact shape is unknown until capture; {EVENT_ID} is substituted.  TODO(raceday)
  SUBSCRIBE: [
    // e.g. { type: 'subscribe', channels: [0, 4, 3], event: '{EVENT_ID}' }
  ] as unknown[],

  // Channels recovered from the JS bundle.
  CH: { results: [0, 4], messages: [3], statistics: [9002] },

  // How long to keep the socket open per invocation to gather a full snapshot (ms).
  COLLECT_MS: 8000,

  // MOCK_MODE: when true (or SOCKET_URL empty), skip the socket and upsert an
  // embedded sample so the whole pipeline is deployable/testable before raceday.
  MOCK_MODE: true,
};

/* ---- payload -> DB-row adapters (the real-risk piece) ------------------------
 * These convert one decoded WIGE channel message into rows for our tables.
 * Field names below are PLACEHOLDERS — replace them with the real keys from the
 * captured payload (the HAR). Return [] to ignore a message.
 */

export type TimingRow = {
  event_date: string; car: string; lap: number; klass: string | null;
  s1: number | null; s2: number | null; s3: number | null; s4: number | null; s5: number | null;
  lap_end_tod: number | null; lap_time: number | null;
  inpit: boolean; fastest: boolean; driver: string | null; vehicle: string | null;
};

export type MessageRow = {
  race_class: string | null; car: string | null; message: string; source: string;
};

// '12:08:32.610' -> seconds of day; accepts number pass-through.  Adjust to real format.
export function todSeconds(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const m = String(v).trim().match(/^(\d+):(\d+):([\d.]+)$/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null;
}
export function secOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let val = 0; for (const p of String(v).split(':')) val = val * 60 + parseFloat(p);
  return Number.isFinite(val) ? val : null;
}

export function mapResults(msg: any, eventDate: string): TimingRow[] {
  // TODO(raceday): replace r.* with the real per-car fields from the results payload.
  const cars = msg?.entries ?? msg?.results ?? msg?.data ?? [];
  const out: TimingRow[] = [];
  for (const r of cars) {
    const car = String(r?.number ?? r?.startNumber ?? r?.no ?? '').trim();
    const lap = Number(r?.lap ?? r?.laps ?? r?.lapNumber);
    if (!car || !Number.isFinite(lap)) continue;
    const s = (r?.sectors ?? r?.sectorTimes ?? []) as unknown[];
    out.push({
      event_date: eventDate, car, lap,
      klass: r?.class ?? r?.className ?? null,
      s1: secOrNull(s[0]), s2: secOrNull(s[1]), s3: secOrNull(s[2]), s4: secOrNull(s[3]), s5: secOrNull(s[4]),
      lap_end_tod: todSeconds(r?.timeOfDay ?? r?.lastCrossing),
      lap_time: secOrNull(r?.lapTime ?? r?.lastLap),
      inpit: !!(r?.inPit ?? r?.pit),
      fastest: !!(r?.fastest ?? r?.isFastest),
      driver: r?.driver ?? r?.driverName ?? null,
      vehicle: r?.vehicle ?? r?.car ?? null,
    });
  }
  return out;
}

export function mapMessages(msg: any): MessageRow[] {
  // TODO(raceday): replace with the real race-control message payload shape.
  const items = msg?.messages ?? msg?.items ?? (Array.isArray(msg) ? msg : []);
  return items.map((m: any) => ({
    race_class: m?.class ?? null,
    car: m?.car != null ? String(m.car) : null,
    message: String(m?.text ?? m?.message ?? ''),
    source: 'wige',
  })).filter((m: MessageRow) => m.message);
}
