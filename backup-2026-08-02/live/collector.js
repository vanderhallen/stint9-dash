/* stint9 LIVE collector — race-day bridge.
 * ---------------------------------------------------------------------------
 * Paste this whole file into the DevTools Console of a tab that is LOGGED IN to
 * stint9.com/app and showing the live timing. It reads stint9's own JSON feed
 * (riding your Clerk session cookie automatically) and upserts each lap into our
 * Supabase table `stint9_live_timing`, which the stint9-dash LIVE view renders.
 *
 * No secret / server needed: it writes with the public publishable key, exactly
 * like the dashboard's fuel/message sync already does.
 *
 *   START:  just paste — it auto-detects the eventId and starts polling.
 *   STOP:   stint9collector.stop()
 *   STATUS: stint9collector.status()
 *
 * See live/stint9-api.md for the recovered API contract.
 */
(function () {
  const SB_URL = 'https://esvvzgxqnfszhttdkuzc.supabase.co';
  const SB_KEY = 'sb_publishable_svmP7ATfuf9eK-jJGXjlYQ_qC8nONLU';
  const POLL_MS = 5000;              // how often to pull the snapshot
  const ORIGIN = location.origin;    // same-origin -> Clerk cookie is sent

  // event_date the dashboard reads in LIVE = today's local date.
  const p = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  // todTs (epoch-ms or ISO) -> seconds-of-day, matching live/build-db.js.
  function todSeconds(v) {
    if (v == null) return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
  }
  const secOrNull = v => (v == null || v === '' ? null : (Number.isFinite(+v) ? +v : (() => { let x = 0; for (const q of String(v).split(':')) x = x * 60 + parseFloat(q); return Number.isFinite(x) ? x : null; })()));

  // Find the eventId: URL path/query, a global, or ask.
  function detectEventId() {
    const m = location.href.match(/events?\/([a-z0-9_-]{4,})/i) || location.search.match(/eventId=([^&]+)/i);
    if (m) return decodeURIComponent(m[1]);
    const g = window.__EVENT_ID__ || window.eventId;
    if (g) return g;
    return window.prompt('stint9 collector: enter the eventId (see the /app URL or Network tab)') || '';
  }

  function mapLaps(laps, ed) {
    const out = [];
    for (const s of laps || []) {
      const car = String(s.stnr ?? '').trim();
      const lap = Number(s.lap);
      if (!car || !Number.isFinite(lap)) continue;
      out.push({
        event_date: ed, car, lap,
        klass: s.className ?? null,
        s1: secOrNull(s.s1Time), s2: secOrNull(s.s2Time), s3: secOrNull(s.s3Time),
        s4: secOrNull(s.s4Time), s5: secOrNull(s.s5Time),
        lap_end_tod: todSeconds(s.todTs ?? s.createdAt),
        lap_time: secOrNull(s.lapTime),
        inpit: false,
        fastest: false,
        driver: s.driverName ?? null,
        vehicle: s.car ?? null,
        updated_at: new Date().toISOString(),
      });
    }
    return out;
  }

  async function upsert(rows) {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const res = await fetch(SB_URL + '/rest/v1/stint9_live_timing?on_conflict=event_date,car,lap', {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json',
                   Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error('supabase ' + res.status + ': ' + (await res.text()).slice(0, 200));
    }
  }

  const state = { eventId: '', ed: today(), timer: null, polls: 0, lastRows: 0, lastErr: null, running: false };

  async function tick() {
    try {
      const r = await fetch(`${ORIGIN}/api/worker/events/${encodeURIComponent(state.eventId)}/laps`, { cache: 'no-store', credentials: 'include' });
      if (!r.ok) throw new Error('laps ' + r.status);
      const laps = (await r.json()).laps || [];
      const rows = mapLaps(laps, state.ed);
      await upsert(rows);
      state.polls++; state.lastRows = rows.length; state.lastErr = null;
      console.log(`[stint9collector] poll ${state.polls}: ${rows.length} laps -> Supabase (${state.ed})`);
    } catch (e) {
      state.lastErr = String(e);
      console.warn('[stint9collector] error:', e);
    }
  }

  window.stint9collector = {
    start(eventId) {
      state.eventId = eventId || detectEventId();
      if (!state.eventId) { console.error('[stint9collector] no eventId — aborting.'); return; }
      state.ed = today(); state.running = true;
      console.log(`[stint9collector] START event=${state.eventId} date=${state.ed} every ${POLL_MS}ms`);
      tick(); state.timer = setInterval(tick, POLL_MS);
    },
    stop() { if (state.timer) clearInterval(state.timer); state.timer = null; state.running = false; console.log('[stint9collector] stopped.'); },
    status() { console.log('[stint9collector]', JSON.stringify({ ...state, timer: !!state.timer }, null, 2)); return state; },
    setDate(d) { state.ed = d; console.log('[stint9collector] event_date =', d); },
  };

  // auto-start
  window.stint9collector.start();
})();
