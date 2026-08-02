/* ============================================================================
 * stint9 LIVE — browser-console collector  (fallback for when headless clients
 * are blocked by WIGE's bot/rate protection but a real browser still works)
 * ============================================================================
 *
 * WHY: WIGE serves its live timing socket to real browsers, but blocks/stales
 * headless clients (Node relay, Deno edge function) — especially after heavy
 * polling. This runs the *same* capture INSIDE your browser, where WIGE lets us
 * in, and upserts straight into Supabase with the publishable key. The dashboard
 * (which just polls Supabase) then lights up live. No redeploy, no server.
 *
 * HOW TO USE (during a live session):
 *   1. Open the WIGE leaderboard in its OWN tab and confirm it's moving:
 *        https://livetiming.azurewebsites.net/events/20/results
 *      (event id is in that URL — replace 20 if the live event differs; the
 *       collector auto-reads it from the URL, or set window.__stint9event='NN'
 *       before pasting.)
 *   2. DevTools → Console (⌥⌘I / F12).
 *   3. Paste this whole file, press Enter. You'll see "[stint9] wrote N rows…".
 *   4. Open the stint9 dashboard → LIVE. It fills in within ~5s.
 *   5. Leave the tab open for the session. Stop anytime with:  __stint9stop()
 *
 * It only READS the WIGE socket and WRITES to our own Supabase. Nothing else.
 * ==========================================================================*/
(function () {
  const SB  = 'https://esvvzgxqnfszhttdkuzc.supabase.co';
  const KEY = 'sb_publishable_svmP7ATfuf9eK-jJGXjlYQ_qC8nONLU';
  const H   = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const WS_URL = 'wss://livetiming.azurewebsites.net/';

  if (window.__stint9stop) { console.warn('[stint9] a collector is already running — call __stint9stop() first.'); return; }

  // --- event id: explicit override > this page's URL > embedded iframe > 20 ---
  function discoverId() {
    const src = location.href + ' ' + (document.querySelector('iframe') ? document.querySelector('iframe').src : '');
    const m = src.match(/events\/(\d+)\/results/) || src.match(/events\/(\d+)/);
    return m ? m[1] : '20';
  }
  const EVENT_ID = String(window.__stint9event || discoverId());

  // date matches the dashboard's liveEventDate() (LOCAL date) so rows line up.
  const p2 = n => String(n).padStart(2, '0');
  const eventDate = () => { const d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };

  // --- parsers: kept identical to live/wige-scrape/index.ts ---
  const secOrNull = v => {
    if (v == null || v === '' || v === '-') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (isFinite(+v)) return +v;
    let x = 0; for (const q of String(v).split(':')) x = x * 60 + parseFloat(q);
    return isFinite(x) ? x : null;
  };
  const todSeconds = v => {
    if (v == null || v === '') return null;
    if (typeof v === 'string' && /^\d{1,2}:\d{2}:\d{2}/.test(v)) return secOrNull(v);
    const d = new Date(typeof v === 'string' && !isFinite(+v) ? v : Number(v));
    if (isNaN(d.getTime())) return null;
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
  };
  const TOD_KEYS = ['TAGESZEIT', 'TIMEOFDAY', 'LASTLAPTIMEOFDAY', 'LASTPASSING', 'CROSSINGTIME'];
  const lapEndTod = (c, rootTod) => { for (const k of TOD_KEYS) if (c[k] != null && c[k] !== '') return todSeconds(c[k]); return rootTod; };
  function mapCar(c, ed, rootTod, nSectors) {
    const car = String(c.STNR == null ? '' : c.STNR).trim();
    const lap = Number(c.LAPS != null ? c.LAPS : c.LAP);
    if (!car || !isFinite(lap)) return null;
    const s   = k => (k <= nSectors ? secOrNull(c['S' + k + 'TIME']) : null);
    const spd = k => (k <= nSectors ? secOrNull(c['S' + k + 'SPEED']) : null);
    return {
      event_date: ed, car, lap, klass: c.CLASSNAME != null ? c.CLASSNAME : null,
      s1: s(1), s2: s(2), s3: s(3), s4: s(4), s5: s(5),
      s1_kmh: spd(1), s2_kmh: spd(2), s3_kmh: spd(3), s4_kmh: spd(4), s5_kmh: spd(5),
      lap_end_tod: lapEndTod(c, rootTod), lap_time: secOrNull(c.LASTLAPTIME),
      inpit: false, fastest: false, driver: c.NAME != null ? c.NAME : null, vehicle: c.CAR != null ? c.CAR : null,
    };
  }

  let ws, timer, stopped = false, meta = null, frames = 0, writes = 0;
  const pending = new Map();  // car|lap -> row (latest frame wins, dedup before write)

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { console.log('[stint9] connected — subscribing event ' + EVENT_ID); ws.send(JSON.stringify({ eventId: EVENT_ID, eventPid: [0, 4], clientLocalTime: Date.now() })); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.PID === 'LTS_TIMESYNC' || m.PID === 'LTS_NOT_FOUND') return;
      if (!Array.isArray(m.RESULT) || !m.RESULT.length) return;
      frames++;
      const ed = eventDate();
      const rootTod = (m.TOD != null && m.TOD !== '') ? todSeconds(m.TOD) : todSeconds(Date.now());
      const nSectors = Math.min(5, Math.max(1, Number(m.NROFINTERMEDIATETIMES) || 5));
      meta = { event_id: String(m.EXPORTID != null ? m.EXPORTID : EVENT_ID), session: m.SESSION != null ? m.SESSION : null,
               heat: (m.HEAT != null ? m.HEAT : '') + (m.HEATTYPE ? ' [' + m.HEATTYPE + ']' : ''),
               track: m.TRACKNAME != null ? m.TRACKNAME : null, cars: m.RESULT.length };
      for (const c of m.RESULT) { const r = mapCar(c, ed, rootTod, nSectors); if (r) pending.set(r.car + '|' + r.lap, r); }
    };
    ws.onclose = () => { if (!stopped) { console.log('[stint9] socket closed — reconnecting in 3s'); setTimeout(connect, 3000); } };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  async function post(table, rows, onConflict) {
    const r = await fetch(SB + '/rest/v1/' + table + '?on_conflict=' + onConflict,
      { method: 'POST', headers: Object.assign({}, H, { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows) });
    if (!r.ok) console.warn('[stint9] ' + table + ' ' + r.status + ': ' + (await r.text()).slice(0, 160));
    return r.ok;
  }
  async function flush() {
    if (stopped) return;
    const rows = [...pending.values()]; pending.clear();
    const ed = eventDate();
    try {
      if (rows.length) await post('stint9_live_timing', rows, 'event_date,car,lap');
      await post('stint9_live_status', [{
        event_date: ed, live: !!meta, event_id: meta ? meta.event_id : EVENT_ID,
        session: meta ? meta.session : null, heat: meta ? meta.heat : null, track: meta ? meta.track : null,
        cars: meta ? meta.cars : 0, updated_at: new Date().toISOString(),
      }], 'event_date');
      writes++;
      if (rows.length || writes % 5 === 0)
        console.log('[stint9] wrote ' + rows.length + ' rows · event ' + EVENT_ID + ' · ' + (meta ? meta.cars + ' cars' : 'no data yet') + ' · ' + new Date().toLocaleTimeString());
    } catch (e) { console.warn('[stint9] flush error', e); }
  }

  connect();
  timer = setInterval(flush, 4000);
  window.__stint9stop = () => { stopped = true; clearInterval(timer); try { ws.close(); } catch (e) {} console.log('[stint9] collector stopped.'); };
  console.log('%c[stint9] browser collector started for event ' + EVENT_ID + ' — leave this tab open. Stop with __stint9stop()', 'color:#16a34a;font-weight:bold;font-size:13px');
})();
