# STINT9 dash — how the LIVE view gets sector times (for the stint9 owner / their AI)

**Purpose:** a plain-language walkthrough of exactly where our LIVE dashboard
pulls per-lap sector times from on race day, so you can sanity-check that it will
work during the real session. **We do not touch your writes or scrape your API —
we read the same public WIGE timing socket the timing screens already use.**

---

## The chain in one line

```
WIGE live-timing WebSocket  →  our relay (Node)  →  Supabase table  →  dashboard LIVE view
```

Nothing runs inside stint9. Our relay is a standalone process on our laptop; the
dashboard is a static page that polls our own Supabase.

---

## 1. Source — the WIGE live-timing WebSocket (public, no auth)

- URL: `wss://livetiming.azurewebsites.net/`
  (this is the WIGE timing backend that both `vdsmotorsport.com` and `wige.de`
  front-end onto — channels `[0,4]`).
- On connect we send one subscribe frame:
  ```json
  { "eventId": "<id>", "eventPid": [0, 4], "clientLocalTime": <epoch-ms> }
  ```
- It pushes leaderboard snapshots shaped like:
  ```json
  { "EXPORTID": 24, "SESSION": "...", "HEAT": 1, "TRACKNAME": "...",
    "RESULT": [ { car... }, { car... }, ... ] }
  ```
- Heartbeats (`PID:"LTS_TIMESYNC"`) and "not live yet" (`PID:"LTS_NOT_FOUND"`)
  frames are ignored.

**eventId discovery:** we don't hard-code it. On race day the relay runs in
`--watch` mode and scans eventIds 1..80 every 30 s until one returns a live
`RESULT` array, then latches that id automatically.

### Per-car fields we read from each `RESULT[]` entry

| WIGE field (UPPERCASE) | meaning | our column |
|---|---|---|
| `STNR` | start number | `car` |
| `CLASSNAME` | class | `klass` |
| `NAME` | driver | `driver` |
| `CAR` | vehicle model | `vehicle` |
| `LAPS` (or `LAP`) | lap number | `lap` |
| `LASTLAPTIME` | lap time | `lap_time` |
| **`S1TIME`..`S5TIME`** | **sector times (NLS uses 1–5; S6–S9 exist for 24h/9-sector)** | **`s1`..`s5`** |
| time-of-day of lap end | see note ⚠️ below | `lap_end_tod` |

Sector/lap time parsing accepts `"1:23.456"`, `"83.456"`, a number, or empty/`-`
→ seconds or null (null is normal for S5 on a pit-in lap).

⚠️ **The one field we're not 100% sure of — please confirm:** the *time-of-day of
the lap crossing*. We convert it to seconds-of-day and use it to place each car
on the track map. We look for the first present of these keys on each car object:
`TAGESZEIT, TIMEOFDAY, TOD, LASTLAPTIMEOFDAY, LASTPASSING, CROSSINGTIME`. If none
is present we fall back to our receipt time (cars then sit slightly "late" on the
map but positions/sectors are still correct). **If you know which field carries
the lap's time-of-day (and whether it's ISO / epoch-ms / "hh:mm:ss"), that's the
single most useful thing to tell us.** Every raw snapshot is logged to
`live/logs/` so the first live frame verifies all of this.

---

## 2. Relay — `live/vds-relay.mjs` (plain Node ≥ 22, no npm deps, no browser)

- Consumes the socket above, maps each snapshot's cars to rows (table below), and
  **upserts** into Supabase `public.stint9_live_timing`, throttled to ~one write
  every 4 s.
- Conflict key: `(event_date, car, lap)` with `merge-duplicates`, so a car's row
  for a given lap is updated in place as sectors complete — no duplicates.
- Writes with the **public/publishable Supabase key** only. Read-only against WIGE.
- `pit` state and the "fastest lap" flag are **recomputed by us downstream**, not
  taken from the feed.

Run command on the day: `node live/vds-relay.mjs --watch` (or `./live/raceday.sh`,
which auto-restarts it).

---

## 3. Store — Supabase table `public.stint9_live_timing`

One row per (car, lap): `event_date, car, lap, klass, s1..s5, lap_end_tod,
lap_time, inpit, fastest, driver, vehicle, updated_at`. A companion table
`stint9_live_status` holds one row/day for the header badge (event id / track /
heat / car count / clock).

---

## 4. Dashboard LIVE view — `index.html` + `live/build-db.js`

- When the user flips to **LIVE**, the page polls every **5 s**:
  ```
  GET /rest/v1/stint9_live_timing?select=car,lap,klass,s1,s2,s3,s4,s5,
      lap_end_tod,lap_time,inpit,fastest,driver,vehicle
      &event_date=eq.<today>&order=car,lap
  ```
- It feeds those raw rows into `buildLiveDB()` (shared, pre-tested), which derives
  the **exact same data structure** the offline SIM mode renders — per-lap
  5-sector segments, within-class positions, sector deltas, pit laps, track map
  placement. So LIVE and SIM render through identical code; only the data source
  differs.
- The loop is **read-only** and snapshots/restores SIM data so switching modes is
  non-destructive.

**Backup / no-laptop path:** a `wige-scrape` Supabase Edge Function is the
serverless twin of the relay — the LIVE header's **⟳ Update** button calls it to
pull a single WIGE snapshot into the same table, so the view works even with no
process running locally.

---

## What we'd love you to confirm (race-day readiness)

1. **eventId** — is scanning 1..80 on `wss://livetiming.azurewebsites.net/` the
   right way to find the live NLS event, or is there a cleaner id/endpoint?
2. **Sector fields** — are `S1TIME..S5TIME` (and `STNR/CLASSNAME/NAME/CAR/LAPS/
   LASTLAPTIME`) the correct keys during the race, same as practice/quali?
3. **Lap time-of-day field** ⚠️ — which key carries it, and what format? (see §1)
4. **Session continuity** — does the same socket/eventId serve practice, quali and
   race, or does the id change between sessions?
5. **Etiquette** — any objection to us holding one WebSocket subscription for the
   session (read-only)? We're not scraping your API or writing anything of yours.

Read-only either way — we're just mirroring the timing feed into our own view.
