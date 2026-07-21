# Race-day runbook — turning on the LIVE feed

## The one true primary path (since 2026-07-13): WIGE direct, fully automatic

The dashboard reads WIGE's live-timing WebSocket directly
(`wss://livetiming.azurewebsites.net/` — the same socket vdsmotorsport.com and
wige.de use, channels `[0,4]`). **No login, no eventId lookup, no manual
"set the event" step, for anyone.** Both ways of getting data in auto-discover
the WIGE `eventId` themselves, by scanning eventIds 1..80 and latching onto
whichever one has a `TRACKNAME` matching Nürburgring/Nordschleife:

1. **Cloud, fully automatic (default, as of 2026-07-21)** — a Supabase
   `pg_cron` job (`stint9_wige_autoscan`) runs every minute, 24/7, and calls the
   `wige-scrape` Edge Function *only* while `now()` falls inside a known
   session window (see "Per-round maintenance" below). No laptop, no relay, no
   button-click required. This is why the LIVE view can just start filling in
   near a session's known start time with nobody doing anything.
2. **Laptop relay (optional, for denser data / as a backup)** — leave
   `./live/raceday.sh` running (`= vds-relay.mjs --watch`, auto-restarts if it
   dies) for a full session. Upserts every ~4 s instead of the cloud path's
   on-demand snapshot. Narrow the scan if unsure of the id range:
   `./live/raceday.sh --range 1-120`. Pin a known id (skips the scan):
   `node live/vds-relay.mjs <eventId>`.
3. **Manual poke (fallback)** — click **⟳ Update** in the LIVE header any time;
   it invokes `wige-scrape` for one snapshot regardless of the schedule table.

Both #1/#3 (`wige-scrape`) and #2 (`vds-relay.mjs`) write the same tables —
`stint9_live_timing` (per-lap rows) and `stint9_live_status` (header badge) —
so they're interchangeable and safe to run at the same time.

**⚠️ Everything below this involving `stint9.com/app`, `live/collector.js`, or
`live/probe.js` is OLD and SUPERSEDED.** It was the original data source before
the WIGE pivot and is kept only for historical reference — do not use it as a
"primary"/"recommended" path; despite how earlier revisions of this file
labelled it, it is not maintained and stint9-dash does not need it. If you've
been logging into stint9.com/app to find and set an eventId, that's for
stint9.com's *own* unrelated eventId/API, not this dashboard's WIGE pipeline —
you can stop doing that.

---

## Per-round maintenance: now automatic (2026-07-21)

`public.stint9_schedule_windows` is the single source of truth for both the
`stint9_wige_autoscan` cron gate above AND `index.html`'s race-day
timetable/countdown reel (the client fetches it directly — see
`loadSchedule()`), so the two can no longer drift out of sync with each other.

**Keeping that table populated is itself now automatic.** A second cron job,
`stint9_nls_schedule_autoscan` (daily, 06:00 UTC), calls the
`nls-schedule-scrape` Edge Function (`live/nls-schedule-scrape/index.ts`),
which:
1. fetches the official NLS calendar page and finds every round's own event
   page URL,
2. fetches each upcoming round's page (next ~120 days) and parses its
   published "Zeitplan" table, if one exists yet,
3. upserts the parsed session times into `stint9_schedule_windows`.

**It never deletes anything** — a round with no Zeitplan published yet, an
unparseable page, or a network hiccup just means nothing is written for that
round *this run*; existing rows (including any manual correction) are left
alone. A round is only written if its parse found at least a `race` session,
as a basic sanity check against a garbled parse. Every run logs its outcome to
`stint9_schedule_scrape_log` (`select * from stint9_schedule_scrape_log order
by created_at desc limit 5;`) — check there first if the on-page timetable
ever looks stale.

**This closed a real bug**, not just a hypothetical one: the schedule this
table was originally seeded with (a "4h round template" guess) had NLS7's race
ending at 16:00; the real, since-published Zeitplan runs 12:00–18:00 (it's a 6h
round). The auto-scan would have silently stopped polling 2 hours before the
race actually ended. The scraper caught and corrected this the same day it was
built, and now would catch it on its own going forward.

**If a round's page structure ever changes** and the scraper stops finding a
"Zeitplan" heading/table it recognizes, it just logs `no_zeitplan_yet` (or
`error`) and leaves that round's rows untouched — fall back to the manual
insert this section used to describe:

```sql
insert into public.stint9_schedule_windows (event_date, label, start_ts, end_ts) values
  ('2026-09-12', 'quali', '2026-09-12T08:30:00+02:00', '2026-09-12T10:00:00+02:00'),
  ('2026-09-12', 'race',  '2026-09-12T12:00:00+02:00', '2026-09-12T16:00:00+02:00')
on conflict (event_date, label) do update set start_ts=excluded.start_ts, end_ts=excluded.end_ts;
```
(Times are wall-clock Europe/Berlin — `+02:00` CEST / `+01:00` CET, mind the
late-October DST switch. The cron gate pads 10 min before/15 min after each
window, so a slightly-early pitlane open or a session overrun is still covered.)

Check the WIGE auto-scan itself is running: `select * from
cron.job_run_details where jobid = (select jobid from cron.job where
jobname='stint9_wige_autoscan') order by start_time desc limit 5;`

---

## ✅ Race-day checklist

1. Confirm this round's windows are in `stint9_schedule_windows` (above) — do
   this as soon as the Zeitplan is published, well before race day.
2. Open the dashboard → click **LIVE**. That's it for the cloud path.
3. **Read the header badge:**
   - grey **`offline`** + "waiting for timing data…" → no event live yet (or
     outside the scheduled window, or the scan hasn't found it yet). Cars on
     the map are leftover SIM data — not a bug.
   - green **`event <id> · <track> · H<heat>`** + "LIVE · N cars · <clock>" →
     you're live. Check the event id/track is the right session — WIGE serves
     several concurrent series and the `TRACKNAME` gate usually screens the
     wrong ones out, but if it latched a wrong one, pin the correct id:
     `node live/vds-relay.mjs <correct-id>`.
4. Want denser data for a full session? Also start `./live/raceday.sh` (safe
   to run alongside the cloud path — same tables, both upsert).
5. **First live snapshot = the one verification.** The relay/edge function log
   the raw snapshot; if cars sit slightly "late" on the map, that's
   `lap_end_tod` needing a field-name tweak (see `TOD_KEYS` in
   `live/vds-relay.mjs`) — everything else maps 1:1.
6. **After the session:** nothing to stop — the cron job just goes quiet once
   `now()` leaves the padded window. Optional cleanup of test data:
   `delete from stint9_live_timing where event_date = current_date;`

---

## 🔬 Dry-run (do this once, before trusting it on a real round)

A 5-minute test during any live NLS session (practice/quali) proves the chain
end to end without waiting for race day:

1. Insert a `stint9_schedule_windows` row covering the next few minutes
   (`start_ts = now() - interval '5 min'`, `end_ts = now() + interval '30
   min'`), or just click **⟳ Update** directly — it ignores the schedule.
2. Open the dashboard → **LIVE**. Confirm cars appear on the map and positions
   look sane.
3. Clean up: `delete from stint9_live_timing where event_date = current_date;`
   and delete the test schedule row if you added one.

Rehearsal without any live event at all (replays a real past CSV at speed, so
you can test the whole render pipeline any day):
```
SUPABASE_SERVICE_KEY=<service-role key> node live/mock-replay.mjs --speed 120
```
Open the dashboard → flip **LIVE** → the maps/positions fill in and track "now".
Stop with Ctrl-C. Clean up after: `delete from stint9_live_timing where event_date = <that day>;`

---

## Known risks
- **Origin check:** WIGE could in principle reject sockets whose `Origin`
  isn't its own page. Hasn't been observed as an issue so far (`vds-relay.mjs`
  and `wige-scrape` both connect fine without setting one) — flag it if a
  session ever fails to connect and this hasn't already been ruled out.
- **Concurrent series:** WIGE serves multiple races on the same socket; the
  `TRACKNAME` regex gate (`TRACK_MATCH` env var to override) is what keeps the
  scan from latching a non-NLS event. Rejected candidates are logged.
- **9-sector events (24h):** the table only has `s1..s5`; a warning fires on
  the first snapshot if the feed reports `NROFINTERMEDIATETIMES` > 5 — the
  schema needs widening before then.
