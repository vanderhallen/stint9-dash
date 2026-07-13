/* stint9 probe — READ-ONLY dry-run capture (writes nothing).
 * ---------------------------------------------------------------------------
 * Paste into the DevTools Console of a LOGGED-IN stint9.com/app tab during any
 * live session (practice / qualifying / race). It detects the eventId, fetches
 * one snapshot, and prints what I need to lock down the collector:
 *   - the eventId it detected (and whether auto-detect worked)
 *   - lap count returned
 *   - ONE full raw lap object
 *   - the todTs value + how it parses to seconds-of-day
 *
 * Copy the whole console output back to me. Nothing is sent anywhere.
 */
(async function () {
  const ORIGIN = location.origin;
  function detectEventId() {
    const m = location.href.match(/events?\/([a-z0-9_-]{4,})/i) || location.search.match(/eventId=([^&]+)/i);
    if (m) return { id: decodeURIComponent(m[1]), how: 'url' };
    if (window.__EVENT_ID__ || window.eventId) return { id: window.__EVENT_ID__ || window.eventId, how: 'global' };
    return { id: window.prompt('probe: enter eventId (from the /app URL or Network tab)') || '', how: 'prompt' };
  }
  const { id, how } = detectEventId();
  console.log('%c[probe] eventId =', 'font-weight:bold', id, '(via ' + how + ')  location=' + location.href);
  if (!id) { console.error('[probe] no eventId — copy the /app URL to me and stop here.'); return; }

  try {
    const url = `${ORIGIN}/api/worker/events/${encodeURIComponent(id)}/laps`;
    const r = await fetch(url, { cache: 'no-store', credentials: 'include' });
    console.log('[probe] GET', url, '->', r.status, r.statusText);
    if (!r.ok) { console.error('[probe] fetch failed (auth/CORS/eventId?). Copy this line to me.'); return; }
    const body = await r.json();
    const laps = body.laps || [];
    console.log('[probe] laps returned:', laps.length, ' top-level keys:', Object.keys(body));
    if (!laps.length) { console.warn('[probe] 0 laps — no cars out yet? try again once cars are running.'); return; }
    const s = laps[0];
    console.log('[probe] ONE raw lap object:\n' + JSON.stringify(s, null, 2));
    const parsed = new Date(s.todTs);
    console.log('[probe] todTs =', s.todTs, ' typeof=', typeof s.todTs,
      ' -> Date =', isNaN(parsed) ? 'UNPARSEABLE' : parsed.toString(),
      isNaN(parsed) ? '' : ' -> secs-of-day = ' + (parsed.getHours() * 3600 + parsed.getMinutes() * 60 + parsed.getSeconds()));
    console.log('[probe] field presence:', ['stnr','lap','className','driverName','car','lapTime','s1Time','s2Time','s3Time','s4Time','s5Time','todTs','createdAt','pitStopCount','position','classRank'].filter(k => k in s).join(', '));
    console.log('%c[probe] done — copy everything above back to me.', 'font-weight:bold;color:green');
  } catch (e) {
    console.error('[probe] error (copy to me):', e);
  }
})();
