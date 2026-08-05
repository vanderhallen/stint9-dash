# STINT9 dash — project docs

> **Single source of truth.** All the project's Markdown notes were merged into
> this one file (2026-08-01). Old separate docs — `stint9-dashboard-summary.md`,
> `data-source.md`, `nls-sector-layout.md`, `tools/README.md`,
> `FUTURE-multi-team.md`, `PROTECTION-PLAN.md`, `RACEDAY.md`,
> `RACECONTROL-MESSAGES.md`, `STINT9-INFO-REQUEST.md`, and everything under
> `live/*.md` — were deleted. **Keep only this file going forward**; add new
> sections here rather than creating new `.md` files.

## Contents

1. [Project summary & handoff](#1-project-summary--handoff)
2. [Data source](#2-data-source)
3. [NLS Nordschleife 5-sector layout](#3-nls-nordschleife-5-sector-layout)
4. [Tools](#4-tools)
5. [Multi-team sharing — current state & planned work](#5-multi-team-sharing--current-state--planned-work)
6. [Source protection & monetization plan](#6-source-protection--monetization-plan)
7. [LIVE feed — race-day runbook](#7-live-feed--race-day-runbook)
8. [LIVE feed — data flow](#8-live-feed--data-flow)
9. [LIVE feed — troubleshooting & hard-won learnings](#9-live-feed--troubleshooting--hard-won-learnings)
10. [Live-timing learnings — 2026-08-01 (NLS 6h race)](#10-live-timing-learnings--2026-08-01-nls-6h-race)
11. [Race-control messages + LIVE message board](#11-race-control-messages--live-message-board)
12. [LIVE feed — info to request before race day](#12-live-feed--info-to-request-before-race-day)
13. [stint9 live-timing API — recovered contract](#13-stint9-live-timing-api--recovered-contract)
14. [Message to send the stint9 owner](#14-message-to-send-the-stint9-owner)
15. [SIM vs LIVE parity audit — 2026-08-02](#15-sim-vs-live-parity-audit--2026-08-02)
16. [SIM race picker — choose an archived event from a popup](#16-sim-race-picker--choose-an-archived-event-from-a-popup-2026-08-02)
17. [PWA — installable app, offline shell, wake lock](#17-pwa--installable-app-offline-shell-wake-lock-2026-08-04)
18. [Race notes — S1 overtakes, pit laps, archive parity](#18-race-notes--s1-overtakes-pit-laps-archive-parity-2026-08-04)
19. [SIM autoplay + ALL CLASSES](#19-sim-autoplay--all-classes-2026-08-04)
20. [Scrubbing back in SIM — panels that ignored the clock](#20-scrubbing-back-in-sim--panels-that-ignored-the-clock-2026-08-04)

---

# 1. Project summary & handoff

> **NOW ALL CLASSES:** the dashboard was extended from CUP5-only to all 27 NLS classes (152 cars). The Race-class dropdown rebuilds the whole UI per class via `buildClass(cls)`; DB has `classes`, `classMaxN`, `classAvg` lookups + per-car data. Selected class/car/settings persist in localStorage.

Context doc so a new chat can continue without re-deriving everything. Last updated 2026-07-02.

## What it is
Single self-contained page **`stint9_dashboard.html`** — a race-intelligence "add-on" that animates NLS (Nürburgring Langstrecken-Serie) sector-timing data for the **CUP5 — BMW M235i Racing Cup** class (16 cars).

- Repo: **vanderhallen/stint9-dash** (moved from vanderhallen/stint9 due to a stuck Pages deploy queue), deployed via **GitHub Pages** → https://vanderhallen.github.io/stint9-dash/ (served as index.html)
- Linked from **vanderhallen/System** `index.html` (bottom button list).
- Standing workflow: **auto commit + push after every change** (no build step; plain HTML/JS/SVG, no framework).
- Backups: `backup/` (2026-07-01) and `backup-2026-07-02/` snapshots.

## Data
- Source: **`nls sector.CSV`** — encoding **cp1252**, delimiter **`;`**. Key cols: `STNR`, `RUNDE_NR`, `TAGESZEIT`, `RUNDENZEIT`, `SEKTOR1..5_ZEIT`, `KLASSE`, `INPIT`, `PITIN_TIME`, `PITSTOPDURATION`, driver name cols, `DIESCHNELLSTE`.
- Data embedded in the HTML as `const DB = {...}` (poly, cars, name, carcol, legs, chart[fx,pos,t], sectimes[car][lap]=[s1..s5], lappos, avgseg, cx/cy, gps, maxN, pits, drvtable).
- **Only CUP5 is in the sector CSV.** The M240i class / #665 exist only in the quali PDF (no sector times) — deferred.
- 5 NLS sectors defined in [§3 NLS Nordschleife 5-sector layout](#3-nls-nordschleife-5-sector-layout).

### Data choices / caveats
- **Per-lap driver is NOT in the data** → stints assumed sequential, split at pit stops (`INPIT='J'`). (The driver-stints table was later **removed** from the UI.)
- **Pit stops**: count is exact = laps where `INPIT='J'` (e.g. #666 = 3, laps 8/16/21) → embedded as `DB.pits`.
  - **Wall-clock in/out IS in the file** → embedded as `DB.pitinfo[car][in-lap] = [pit_in_tod, duration_s, pit_out_tod]`.
    `PITIN_TIME` is a real crossing time at the pit-entry loop and `PITSTOPDURATION` a real
    stopped time; pit-out = in + duration, and it lands inside the out-lap's S1 — which is
    what inflates that sector. 265 of 285 in-laps in the 2026-06-20 file carry both; the
    other 20 read `00.000` (retired in the box, or the stop ran past the end of the session).
  - ⚠️ **This section used to claim `PITSTOPDURATION` is empty in the file and that pit
    duration is "NOT derivable". That was wrong** — and because `tools/gen_db.py` was written
    to that claim, both columns were parsed past and dropped for the whole life of the
    pipeline. Counted directly: the old `nls sector.CSV` carries a real duration on 360 of
    its 382 in-laps too, so the claim was never true of any file in `source/`. Fixed 2026-08-04.
  - Pit *time loss* (as opposed to stopped time) is still the inflated out-lap S1 — not yet in the UI.
- Live position = `progress = lap*5 + (seg-1) + frac`, sorted per frame (`livePos`).
- Gaps between two cars = `commonGap` via their last common sector-boundary crossing times.
- "Last lap"/"Fastest" per car = last completed lap / min over completed laps (leader and selected car may be on different laps).
- **Car colours remapped** to a 16-colour palette that excludes yellow/gold, grey/silver, brown/bronze so non-podium dots never look like medals (`DB.carcol` overridden at load; keeps dot↔lap-line colour identity).

## Layout (top → bottom), fit to one screen
Fixed **1280px design width** (never reflows), scaled by JS (`fitPage`) to fit **both** window width & height, centred horizontally+vertically, **no scrolling** (`__fit` = scale; map/weather height syncs divide by `__fit` to avoid feedback).

1. **Header row (single line):** title `stint9 dash` · Race class (CUP5 only) · Select car · Delay % · playback controls (far right).
2. **Lap chart (~62%) + Weather radar (~38%)** side by side.
3. **Main track map + Zoom view** side by side (maps rendered at 80%; zoom height-synced to main).
4. **Comparison table** (leader vs selected car).

## Features

**Playback controls** — time-of-day clock, Play/Pause, scrubber, speed **1× / 10× / 30× / 60× (default 10×)**, **loops** at end, auto-plays first car on load. Labels toggle removed (labels always on). Flat horizontal, compact.

**Lap chart** — position-over-time, built per sector as time advances (only completed sections drawn). Thin lines (1.15, selected 1.6). Left P1..P16 axis. Right labels: `#car driver ▲/▼<posΔ> PIT <n>` (PIT hidden if 0). `rowH=30`, enlarged fonts.

**Weather radar** — Leaflet + Carto light tiles + **RainViewer** radar (`maxNativeZoom:7` so tiles resolve at the 10 km view), 10 km circle around GPS 50.359/6.960, `fitBounds` framing, **◎ center** reset button. Height synced to the lap chart. Only shows precip when there is rain in the Eifel.

**Main track map** — smoothed 5-sector polyline (Chaikin + moving-average denoise on S1/S2/S3/S5; S4 lighter; all sector boundaries snapped to shared midpoints so segments connect). Animated dots placed on real sector-boundary timestamps, gliding between. Dot radius scales by position (`0.95^(pos-1)`); **#label fixed size 30**; anti-overlap declutter. **DELAY** label (48px) when a section is >threshold% over its average (Delay % input, default 50). Selected car = red outline + 50% translucent + raised on top. **Centre badge**: `#xxx Px Lx` (black) + `−ahead/+behind` gap seconds + driver name; position nudged over the track.

**Zoom view** (circular minimap) — clipped 20%-ish circle centred on the selected car; track slides underneath. Dots sized by position; **#labels (fs 6.2)** placed on the **infield side** of the track, guaranteed clear of all dots (8-direction × 4-distance least-overlap search). **P1/P2/P3 shown inside the top-3 dots**. **Podium dot colours: P1 RAL 1033 `#F9A800`, P2 silver `#C0C0C0`, P3 RAL 8003 `#7E4B26`** (white+halo position text). Dots **z-layered by position** (P1 on top, worse sent to back). **Ahead (▲ top) / Behind (▼ bottom)** neighbour labels (1.5× size) showing last-common-sector **Δ** only (green = selected car faster, red = slower; drops lap/time-vs-time/outside). **GAIN/LOST overtake pills** (green/red) persist 2 sectors.

**Comparison table** — Row 1 = **P1 (leader)**, Row 2 = **selected car** (or **P2** if the selected car is P1). Columns: Pos · Driver · Gap (to selected) · Fastest · Last lap · S1..S5. Row 2 shows **red/green delta triangles** vs P1 on the time columns.

## Theme
Light background, navy ink `#16202b`, red accent `#e0301e`, fonts **Space Grotesk** + **IBM Plex Mono**, white cards. Removed over time: metabar/eyebrow/subline, all section headings, footer, nav links, driver-stints table.

## Layout goal: no empty top/bottom margin (2026-07-04)
`fitPage()` used to scale the whole `.wrap` to fit *both* window width and
height, then centre it — on any viewport whose aspect ratio didn't match the
design's, that left dead blank strips above and below (or left/right) the
content. Changed to: scale by **width only**, anchor top-left (`x:0,y:0`), and
let the page scroll vertically if content is taller than the window. This
guarantees the full page width is always used and content starts flush at the
top; a right/bottom margin can still show when the natural (unscaled) design
is smaller than the window, since we don't upscale past 100% (would blur).

## Big fields (ALL CLASSES) must never drive the page scale (2026-08-05)
Two things made a 130-car selection shrink the whole dashboard to ~26%:

1. **A `let` in the temporal dead zone killed the boot script.** `render()` runs
   near the top of the main `<script>` and calls `pushPit()`, which reads
   `wxReelIdx` — declared with `let` ~1200 lines further down. The read threw
   `ReferenceError: Cannot access 'wxReelIdx' before initialization`, aborting
   the *entire rest of that block*: no `fitPage()` (page never scaled or fitted),
   no message board, no SIM event picker. Now `var`, so it hoists as `undefined`.
   Same trap as `NLS_CHAMP` (`renderChampionship` catches it) — anything render()
   touches must be declared above render() or hoisted.
2. **The reel viewport is aspect-locked to the car count.** Reel panels are sized
   `width × CH/1000`, and `CH` is 44px per car, so ALL CLASSES asked for a
   ~3500px panel; `fitPage` had no choice but to scale the page down to fit it.
   `reelFitHeight()` now caps the un-zoomed panel at 45% of the window height,
   and `syncReelPanels()` gives any chart taller than its panel its natural
   height inside a scrolling `.reelpanel.tall` — rows stay readable, the rest of
   the field is a scroll away, and the page scale is unaffected.

Related: `#gridsvg` is `flex:0 0 auto` so the starting-grid cascade (~8700px for
131 cars) scrolls inside `#gridwrap` instead of being flex-shrunk to a smear, the
grid now fills for the ALL CLASSES selection (class position = field position),
and `syncSideHeights()` measures `.maincol`'s *content* (top → agent-bar bottom)
rather than its stretched box, which used to feed a tall sidebar back into itself.

## Message board (added 2026-07-04)
Right column, bottom ~50% (under Feedback), table `public.stint9_messages`
(same Supabase project as feedback: `esvvzgxqnfszhttdkuzc`). Filtered by
selected race class (null class = shown for all classes). The board is
read-only — the per-row dismiss (×) was removed 2026-08-05, race control's
messages can no longer be hidden from the pit wall. If a message names the currently
selected car, that car gets a pulsing orange ring on the main track map
(`#msgHighlightRing`, driven by `window.msgHighlightActive` inside `render()`).

**Live-timing source:** https://livetiming.wige.de/vln.html → iframe
`https://livetiming.azurewebsites.net/events/{eventId}/results`. That page is
a JS SPA (`leaderboard.*.bundle.js`) that pulls data over a **WebSocket**, not
a plain scrapable HTTP endpoint — found channel numbers in the bundle
(`messages`=`[3]`, `trackState`/`results`=`[0,4]`, `statistics`=`[9002]`) but
couldn't find the actual socket URL/protocol in static analysis, and there
was no live event running to inspect the real traffic against. This note
predates the WIGE pivot; the scraper is now built — see
[§7 race-day runbook](#7-live-feed--race-day-runbook) and
[§11 race-control messages](#11-race-control-messages--live-message-board).

## Open / possible next steps
- Add per-car **pit-loss estimate** (out-lap minus green-lap baseline).
- Optional **PIT ×N** indicator for selected car on the maps.
- Multi-class support if sector data for another class (e.g. M240i) is provided → wire Race-class dropdown to filter.
- S4/S5 (Döttinger Höhe) labelling correction on the static `NLS 5 sectors.png` (deferred).

---

# 2. Data source

## Live / official source: teilnehmer.vln.de

The official VLN/NLS timekeeping publishes per-event **sector-times CSV** files at:

```
https://teilnehmer.vln.de/download.php?file=onb/<YYYY-MM-DD>/NÜRBURGRING_LANGSTRECKEN-SERIE$RENNEN$RENNEN_SEKTORZEITEN.CSV
```

- The `<YYYY-MM-DD>` path segment is the **event date**.
- The `Ü` and the `$` characters must be URL-encoded when fetching non-interactively
  (`%C3%9C` for Ü in a UTF-8 URL; `\$` / `%24` for the `$`).
- Landing page (to find the newest event / browse files): <https://teilnehmer.vln.de>

### Most recent file used (as of 2026-07-04)

- **Event:** 2026-06-20 · 1. ADAC Eifel-Trophy (same event as the quali PDF that
  drives the starting grid → race + grid are now from one consistent dataset).
- **URL:** `https://teilnehmer.vln.de/download.php?file=onb/2026-06-20/NÜRBURGRING_LANGSTRECKEN-SERIE$RENNEN$RENNEN_SEKTORZEITEN.CSV`
- **Saved locally:** `source/vln-2026-06-20-sektorzeiten.CSV` (source/ is gitignored).
- 2222 data rows · **109 cars** · **19 classes**.

### File format

- **Delimiter:** `;`
- **Encoding:** ISO-8859-1 / cp1252 (despite the HTTP `charset=UTF-8` header — German
  umlauts like `Türkei` come through as latin1, so parse as **cp1252**).
- **9-sector schema** (`SEKTOR1..9_ZEIT`) but only **sectors 1–5 are populated**
  for NLS — matches the existing 5-sector layout in [§3](#3-nls-nordschleife-5-sector-layout).
- Much richer than the old `source/nls sector.CSV` (which was CUP5-only). Key columns:
  - `STNR` (car #), `KLASSEKURZ` / `KLASSE` / `UNTERKLASSE` (class), `FAHRZEUG` (car model),
    `KUERZEL` (team short), `BEWERBER` / `TEAM`.
  - `RUNDE_NR` (lap), `TAGESZEIT` (time of day), `RUNDENZEIT` + `RUNDENZEIT_IN_SEKUNDEN`,
    `DIESCHNELLSTE` (J = fastest lap flag), `RANG` (live rank).
  - `SEKTOR1..5_ZEIT`, `SEKTOR1..5_BESTE_ZEIT`, `SEKTOR1..5_KMH`, `TOPSPEED_KMH`.
  - `INPIT`, `CANCELLED`, `PITSTOPDURATION`, `PITIN_TIME`.
  - `WET`, `PRO`/`PROAM`/`AM`/`AMG`, `STINT`, `LAPINSTINT`, `THEORETISCHE_BESTZEIT`.
  - Up to **8 drivers** per car: `FAHRER1..8_NAME` / `_VORNAME` / `_NATION` / etc.

### Classes present (KLASSEKURZ)

SP9 PRO, SP9 PRO-, SP9 AM, SP7, SP4, SP3T, SP10, AT 1, VT2-RWD, VT2-F+4W,
V6, V5, V3, TCR, CUP2, CUP3, BMW M2, BMW M240, BMW 325i.

> Note: these are the **real** class short-names for this event and differ from the
> older synthetic 27-class set. The Race-class dropdown + starting-grid class-name
> matching key off these.

## Regenerating the DB from a CSV (`tools/gen_db.py`)

The dashboard's `const DB = {…}` (embedded in `index.html` line ~289 **and** mirrored
in `data.js`) is generated from the CSV by `tools/gen_db.py`:

1. Download the newest event CSV to `source/` (see URL scheme above).
2. Point `CSV = …` at it in `tools/gen_db.py`.
3. `python3 tools/gen_db.py` → writes `tools/newDB.json` and prints a per-class report.
4. Inject that JSON as `const DB = <json>;` into `index.html` line 289 and overwrite
   `data.js` with the same line.

What the generator does:
- **Reuses the Nordschleife track geometry** (`poly/cx/cy/gps/W/H`) from `tools/geom.json`
  (extracted once from the original `data.js`) — the circuit shape is race-independent.
- Rebuilds everything else from the CSV: `legs` (per-lap 5-sector segments with absolute
  second-of-day boundaries; `TAGESZEIT` = lap-END time, so lap L spans
  `[TAGESZEIT(L-1), TAGESZEIT(L)]`), `sectimes`, `pits` (laps where `INPIT='J'`),
  `pitinfo` (per in-lap `[pit_in_tod, duration_s, pit_out_tod]` from `PITIN_TIME` +
  `PITSTOPDURATION`; either half may be `null` on the `00.000` sentinel),
  within-class track `positions`/`chart`/`lappos` (ranked per sector boundary),
  `classes`/`classMaxN` (max laps)/`classAvg` (mean green-lap sector times),
  `name` (FAHRER1 surname), `carcol` (16-colour palette cycled within each class).
- **Encoding is cp1252** and **only sectors 1–5** of the 9-sector schema are populated.

Current DB = **2026-06-20 event · 106 cars · 19 classes · ~4h21m**.

---

# 3. NLS Nordschleife 5-sector layout

The full NLS configuration (Nürburgring **24h-layout**: Nordschleife + part of the GP circuit / Sprintstrecke) is officially **24.358 km** long — Nordschleife ≈ 20.832 km + the GP section ≈ 3.5 km.

The timing splits each lap into **5 sectors**. The lengths below are **estimated** from the fastest lap-time breakdown (car #28, sum of best sectors = 7:58.675) scaled to 24.358 km.

> **Note:** This is a time-based approximation. Because the average speed differs per sector (slow GP corners vs. the very fast Döttinger Höhe), the real distances can differ by a few hundred metres.

## Sector table

| Sector | Best time (ref.) | Share | Estimated length | Notes |
|--------|------------------|-------|------------------|-------|
| S1 | ~1:05.8 | 13.7 % | ≈ 3.3 km | GP section + start of Nordschleife (incl. pit exit) |
| S2 | ~1:04.0 | 13.4 % | ≈ 3.3 km | |
| S3 | ~1:57.2 | 24.5 % | ≈ 6.0 km | |
| S4 | ~3:03.9 | 38.4 % | ≈ 9.4 km | Longest Nordschleife block (incl. Döttinger Höhe) |
| S5 | ~0:48.2 | 10.1 % | ≈ 2.4 km | Short final sector on the GP circuit to start/finish |
| **Total** | **7:58.7** | **100 %** | **24.358 km** | |

## Sector boundaries (derived from the timing data)

- **Start/finish + pit lane are on the GP circuit, around the S5 → S1 boundary.**
  - **The pit entry sits at the END of S5**, just before the start/finish line — *not* at
    the S4/S5 boundary. A car peeling into the lane drives the whole of S5 but never
    crosses the S5 beacon on the line, so no S5 split is published for it.
  - On *in-laps* (`INPIT = J`), **S5 is empty** and a `PITIN_TIME` is present. This means
    the split is *missing*, **not** that the sector was skipped — the measured hole
    between S4 and the out-lap's S1 has a median of **65.5s** against a **54.5s** median
    green S5, i.e. one S5 of driving plus ~11s of pit-entry decel. Were the entry at the
    S4/S5 boundary the hole would have to swallow the whole stop and run to minutes.
  - On *out-laps* (`INPIT = A`), **S1 is huge** — median **234.8s** vs a normal **74.6s**.
    The pit box, the exit and the Code-60 / out zone are all inside S1, so **the stop
    time lives in S1**, not in the hole.
- S4 is by far the longest sector in time (the long, fast Nordschleife stretch).

> Measured over the 273 stops in the 2026-06-20 DB (all 285 pit in-laps lack an S5).
> `index.html` reconstructs the missing in-lap S5 (`withPitS5`) for map positioning
> only; gap/boundary maths still runs off the real splits in `DB.legs`.

---

# 4. Tools

Helper scripts that support the static dashboard (they are **not** shipped to the
page — run them locally).

## `gen_db.py`
Regenerates the embedded `const DB = {…}` (in `index.html` and `data.js`) from an
official VLN/NLS sector-times CSV. See [§2 Data source](#2-data-source).

## Overtake clips — primary flow is in-browser

Clips of the **selected car**'s on-track overtakes are now cut **in the browser**
from a locally-selected video, in the dashboard's **VIDEO** reel (4th panel of the
right-side weather/agenda reel in `index.html`):

1. Let the race play so overtake notes accumulate for the selected car (LIVE saves
   them to Supabase `public.stint9_racenotes`; SIM keeps them in memory).
2. Open the **VIDEO** reel (▲▼ next to the timetable) and choose the **race video
   file** from this computer. The **race clock** is read automatically from the
   video's burned-in top-left timestamp (OCR); the video is a continuous real-time
   recording, so that anchors video t=0 to race time-of-day. Set **± sec**
   (default 20).
3. Click **ANALYSE & CLIP**. ffmpeg.wasm cuts each overtake ±N s and names it
   `YYYYMMDD_car_Llap_Ssector_Px_Py.mp4` (e.g. `20260620_665_L2_S3_P4_P3.mp4`).
   Each clip appears as a **download link in the reel — click to save it locally**,
   then commit the files into `clips/` yourself (e.g. via VS Code). **Sector 1 is
   excluded** (pit/out zone).

## `make_clips.py` — offline / batch fallback

Still available for cutting from a full local video without the browser (e.g. a
huge recording, or no token). It reads specs straight from Supabase (or a
`jobs.json`) and cuts with local `ffmpeg`:

   ```bash
   python3 tools/make_clips.py --event 2026-06-20 --video full_race.mp4 \
           --video-start 12:05:00 --pad 20
   ```

Requires `ffmpeg` on PATH. Output goes to `./clips/`, named
`YYYYMMDD_car_Llap_Ssector_Px_Py.mp4` (e.g. `20260620_665_L2_S3_P4_P3.mp4`).

Notes:
- **Sector 1 is excluded** — it holds the pit lane / out-zone, so passes there are
  usually a consequence of pit stops, not on-track overtakes.
- Where in the sector the pass happened is estimated from the gap at the sector
  entry vs. exit (`f = |g0| / (|g0| + |g1|)`), then ±pad seconds around that point
  gives the clip window. Sector lengths are the time-based estimates in
  [§3 NLS Nordschleife 5-sector layout](#3-nls-nordschleife-5-sector-layout).
- Default is stream-copy (`-c copy`, instant but cuts on keyframes); pass
  `--reencode` for frame-accurate clips.

---

# 5. Multi-team sharing — current state & planned work

Scenario: two (or more) teams open the shared dashboard, each **select a
different car**, and fill in fuel / notes / tyres. This tracks what's isolated
per-car today and what still needs doing before a large-scale rollout.

## ✅ Done — per-car in the database (no localStorage)
As of 2026-07-13, these are keyed by car and stored in Supabase (single source
of truth, so a teammate on another device sees the same data):

- **Fuel entries** — `stint9_fuel_state (event_date, car)`.
- **Fuel calculator settings** (tank capacity, consumption, start, formation) —
  stored per-car under `state.set` in the same row, applied when a car is
  selected. Two teams with different tank sizes no longer clash.
- **Per-lap notes** — `stint9_fuel_notes (event_date, car, lap)`.
- **Tyre board** (TYRE reel, `tyre.html`) — the WHOLE board as one JSON blob per
  car in `stint9_tyre_state (car)`: stock inventory (serials/km/cycles), stock &
  stint moves, empty bands, and board-band highlights. The dashboard sends the
  selected car to the iframe (`postMessage 'tyreCar'`); on car change the board
  saves the outgoing car, then loads + re-renders the incoming car's blob (or a
  fresh default board if that car has none). Replaces all the old localStorage
  stores (`stint9_stock_state`, `_stock_removed/_adds/_new`, `_stint_xfers/
  _removed`, `_empty_bands`, `stint9_band_state`).

localStorage is no longer used for any of the above. (Fuel/notes persist only in
**LIVE**; SIM stays in-memory. The tyre board persists per-car whenever a car is
selected.)

✅ **Rehearsed in-browser (2026-07-13)** — select car A, edit stock/stint/bands,
switch to car B (fresh board), switch back to A (edits persisted), and a second
device on car A sees the same data. All confirmed working.

## Kept global on purpose
- `stint9_max_km` (max km per band — a tyre spec, same across cars) stays in
  localStorage as global config.
- Board layout + sub-reel index (`test2_*`) stay local (per-device UI).

Config that is genuinely global stays global: `stint9_max_km` (max km per band),
board layout, and sub-reel index.

## ⏳ Planned — team isolation / access control (before large-scale rollout)
**Right now there is NO separation between teams** — anyone with the link can see
*and edit* any car's fuel/notes (and, once migrated, tyres). That's fine for a
couple of trusted teams sharing intentionally, but not for a wider rollout.

Future feature: a lightweight "team" concept so each team only sees/edits its own
car(s) — e.g. a team key in the URL or a simple picker, plus row scoping by team.
Until then, treat the shared link as fully open and trusted.

## localStorage intentionally kept (per-browser UI, not shared data)
UI preferences remain local by design (they're per-device, not race data):
selected class/car, delay/pace thresholds, playback speed, active reel
(`stint9_prefs`), the team sign-in (`stint9_auth`), and the tyre board's layout.

---

# 6. Source protection & monetization plan

_Last updated: 2026-07-03_

## Goal

Protect stint9-dash from being copied, and set it up so access can be sold —
users keep using the service instead of cloning or bypassing it.

## The one hard truth

Anything the browser runs (HTML/CSS/JS), the user can read. There is no way to
fully "shield" a client-side site. The real levers are:

1. Make copying not worth it (deterrence).
2. Make the valuable part impossible to steal (move it off the client).

## What stint9-dash is today (assessment)

- Single self-contained `index.html` (~900 KB), also duplicated as
  `stint9_dashboard.html`. Static site, **no backend**.
- The entire payload is one line: `const DB = {...}` — an ~828 KB JS object
  holding the digitized Nürburgring track (`poly` polygon = thousands of
  coordinate points, sector layout, `W/H` dimensions). **This is the crown
  jewel and it sits in plain text in the browser** — copyable in seconds.
- External calls: Leaflet, Google Fonts, `api.rainviewer.com` (public weather,
  no key). All harmless.
- ✅ No API keys / tokens / passwords / base64 secrets baked in.
- ✅ `source/` (raw CSV, PDF, backups) is gitignored — not in the repo.

### Two assets, two realities

| Asset | Where it lives | Hideable client-side? |
|---|---|---|
| Visuals/animation (SVG render, gauges, flow) | JS in browser | Partly — obfuscation deters casual cloning |
| Data/logic (`const DB` track model) | JS object in browser | **No** — fully exposed, needs a backend |

## Done — Phase 1 (lock it down now)

- [x] **Repo set to PRIVATE** (2026-07-03) — source, history, comments no longer
      publicly readable. _(Does nothing for the deployed site's shipped code.)_

### Optional Phase 1 extras (deterrence only — not yet done)

- Obfuscate/minify the deployed HTML — deters copy-paste of the renderer.
  Downside: complicates editing the 900 KB file. Only buys deterrence.
- Encode the `const DB` blob — speed bump only; a determined person still dumps
  it from DevTools memory. Not worth the hassle yet.

> Honest note: none of these hide the data or logic from someone who opens
> DevTools. Only Phase 2 does that.

## Phase 2 — the real fix (when ready to sell)

Move `const DB` off the client. Browser gets the **renderer**; the **track data**
comes from a server that only answers paying, logged-in users.

```
Visitor ──▶ Cloudflare Pages (HTML/JS shell, NO DB)
              │  fetch('/api/track', with login cookie)
              ▼
          Cloudflare Worker ──▶ valid paying user?
              │ yes                 │ no → 401, empty page
              ▼
          KV / R2  (const DB lives here, never shipped to non-users)
```

### Steps & effort

| Step | Effort | Notes |
|---|---|---|
| Split `DB` out of HTML into KV/R2 | ~½ day | Mechanical, low risk |
| Gatekeeper Worker at `/api/track` | ~½ day | ~50 lines |
| Login + payments — **buy** (Clerk/Auth0 + Stripe/Lemon Squeezy) | 1–2 days | Fastest, small monthly cost |
| Login + payments — **build** (Cloudflare Access / Worker + KV sessions) | 3–5 days | Cheaper, more edge cases |
| Slice-only DB delivery (optional) | +1 day | Skip until piracy actually happens |

**Realistic total: ~2–3 days** using off-the-shelf auth+billing; more if self-built.

### What Phase 2 achieves

- ✅ `const DB` becomes genuinely protected — a copycat must rebuild the whole
  dataset from scratch.
- ✅ Access can be sold; non-payers get an empty shell.
- ⚠️ Renderer JS still copyable — but worthless without the data. Don't
  over-invest in hiding it.
- ⚠️ A paying user can still dump the DB from their own browser once. No system
  stops a legitimate logged-in user. If that ever matters: per-user
  watermarking / tracking as a deterrent.

### The decision that drives everything

**Buy vs. build** auth + payments — difference between ~2 and ~5 days, and it
sets the monthly cost structure. Pin this down first when starting Phase 2.

---

# 7. LIVE feed — race-day runbook

Turning on the LIVE feed.

> **When something goes wrong, read [§9 troubleshooting](#9-live-feed--troubleshooting--hard-won-learnings) first.**
> Hard-won learnings from the 2026‑07‑31 test day: WIGE **rate-limits over-polling**
> (don't run extra pollers or spam ⟳ — it serves a frozen snapshot / blocks headless
> clients while a real browser still works; recover by *stopping*, or use
> `live/browser-collector.js`); corrupt **garage/pit sector/lap times** can inflate
> the timeline into the future and freeze the dashboard while the feed is fine (the
> **admin.html → LIVE data stream** panel tells STREAMING vs STALE vs SILENT apart);
> and the **event id changes per session** (quali vs race) — discovery adapts, but
> watch for sessions merging in `stint9_live_timing`.

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

### The 24h Qualifiers (NLS4/NLS5) — a different source, a different limitation

The 24h Nürburgring weekend's own Zeitplan (multiple qualifying sessions +
the 24h race itself, spanning 4 calendar days) is only published as a **PDF**
on `24h-rennen.de`, not on the NLS calendar site. A third cron job,
`stint9_24h_pdf_autoscan` (daily, 06:15 UTC), calls the `nls-24h-pdf-scrape`
Edge Function (`live/nls-24h-pdf-scrape/index.ts`), which downloads that PDF
(text extraction via `unpdf`), keeps only the "ADAC RAVENOL 24h Nürburgring"
branded sessions (the PDF also lists DHLM/Tourenwagen-Legenden/RCN sessions on
the same shared weekend — not ours), and upserts them the same way.

**Important difference from the NLS scraper: this one cannot auto-discover a
new PDF URL.** `24h-rennen.de` sits behind Cloudflare bot-protection that
blocks everything except a known direct file path — the homepage,
`robots.txt`, `wp-sitemap.xml`, and a directory listing all 403/429; only the
exact PDF URL itself 200s. So the URL lives as **data**, in
`public.stint9_schedule_sources` (`key='24h_zeitplan'`), not in code. The
scraper re-fetches that known URL daily, so an in-place revision to the SAME
file (a new "Version" published at an unchanged URL) is picked up
automatically. A **new URL** — next year's PDF, or a re-versioned filename —
needs a one-line update:

```sql
update public.stint9_schedule_sources set url='<new pdf url>' where key='24h_zeitplan';
```

Session names in the PDF get mapped to: `quali1/2/3`, `topquali1/2/3`,
`warmup`, `startaufstellung`, `opengrid`, `formation`, and `race` (the PDF's
separate "Start Rennen" Saturday marker and "Zieleinlauf" Sunday marker are
combined into one `race` window spanning the full 24 hours). An unrecognized
session name is skipped, not guessed — check `stint9_schedule_scrape_log` if a
session seems to be missing after a Zeitplan revision.

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

---

# 8. LIVE feed — data flow

**Purpose:** a plain-language walkthrough of exactly where our LIVE dashboard
pulls per-lap sector times from on race day, so you can sanity-check that it will
work during the real session. **We do not touch your writes or scrape your API —
we read the same public WIGE timing socket the timing screens already use.**
(Originally written for the stint9 owner / their AI.)

## The chain in one line

```
WIGE live-timing WebSocket  →  our relay (Node)  →  Supabase table  →  dashboard LIVE view
```

Nothing runs inside stint9. Our relay is a standalone process on our laptop; the
dashboard is a static page that polls our own Supabase.

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

## 3. Store — Supabase table `public.stint9_live_timing`

One row per (car, lap): `event_date, car, lap, klass, s1..s5, lap_end_tod,
lap_time, inpit, fastest, driver, vehicle, updated_at`. A companion table
`stint9_live_status` holds one row/day for the header badge (event id / track /
heat / car count / clock).

### `public.stint9_live_frames` — the raw payloads (2026-08-04)

The table above keeps the ~18 fields the dashboard maps; **everything else WIGE
sends is now kept too**, whole and verbatim, one row per sampled WebSocket frame:
`event_date, received_at, pid, event_id, session, heat, track, root_tod, cars,
body_hash, frame (jsonb)`. Nothing reads it at runtime — it is a write-once
evidence log so a question about an unmapped field can be answered by querying
instead of by re-instrumenting and waiting for the next race. See
`live-frames-supabase.sql`; §9's open questions are the worked example.

- Sampling: one frame per channel per `WIGE_FRAME_MIN_MS` (default **15 s**);
  `0` keeps every frame, `WIGE_FRAME_ARCHIVE=off` stops collecting. Byte-identical
  re-sends collapse on the `body_hash` unique index and cost nothing.
- Size: ~130 cars ≈ 70 KB/frame raw, jsonb-compressed to ~15–25 KB → **~25–35 MB per
  6h raceday**. `stint9_prune_live_frames(keep_days)` (cron `stint9_live_frames_prune`,
  daily 05:20, keeps 21 days) is the pressure valve; it refuses to drop frames for a
  date that has no `stint9_events` row, so a failed archive never loses the session.
- Writes come from `wige-scrape` with the service role. RLS grants anon **select only**
  — no anon insert/update/delete policy exists.

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

---

# 9. LIVE feed — troubleshooting & hard-won learnings

Everything we learned wiring the WIGE live feed to the dashboard on 2026‑07‑31
(NLS7 test day). Read this first when LIVE misbehaves. Companion to
[§7 race-day runbook](#7-live-feed--race-day-runbook) (the run procedure) and
[§8 data flow](#8-live-feed--data-flow) (the data chain).

## ⚠️ OPEN — answer from `stint9_live_frames` after the next NLS session (11 Sep 2026)

**These questions are answerable from stored data now.** They were armed 2026-08-01
against a `WIGE_RAWFRAME` temp `console.log`, and stayed open through two race
weekends for one reason: edge-function logs are kept **24 hours**, so the evidence
expired before anyone read it. Since 2026-08-04 `wige-scrape` (v11) also writes every
sampled payload verbatim to **`public.stint9_live_frames`** (see
`live-frames-supabase.sql`), which keeps 21 days. The `console.log` survives as a
same-day fallback; prefer the table.

```sql
-- what does a car object actually contain?
select distinct k from stint9_live_frames, lateral jsonb_object_keys(frame->'RESULT'->0) k
where event_date = 'YYYY-MM-DD' order by 1;
```

1. **`inpit` lap-attribution.** v9+ derives `inpit` by diffing the per-car
   **`PITSTOPCOUNT`** across frames and flagging the lap where it ticks up. It produced
   **zero** pit laps over the 2026-08-01 race (4251 rows, 136 cars, hold mode on), so
   the first thing to check is whether `PITSTOPCOUNT` exists on the socket at all
   (`select ... where k ilike '%pit%'` on the query above). If it does, confirm the tick
   lands on the **in-lap** — what `DB.pits` / `withPitS5` / the racenote PIT-IN note
   expect — and adjust to `lap-1` if it is off by one.
2. **Lap-count inflation.** The stored `lap` (`c.LAPS`) ran **~40 % higher** than
   WIGE's on-screen session-lap count during the 2026-08-01 6h race (e.g. #650 at
   DB L33 @15:52 while WIGE showed ~L23). Confirm what `c.LAPS` actually counts.
3. **Sector count.** Confirm `NROFINTERMEDIATETIMES` = 4 for the Nordschleife
   (why `s5` is always null — the dashboard's 5-sector model vs WIGE's 4 intermediates).
4. **Pit in/out.** Does the socket carry anything like the VLN CSV's `PITIN_TIME` /
   `PITSTOPDURATION`? If it does, map it — LIVE currently has no pit times at all and
   falls back to the out-lap-S1 heuristic in `pitLapsOf()` (index.html), which recovers
   265 of 285 real stops with 18 false positives. The CSV path now carries the real
   thing as `DB.pitinfo`.

Everything else in the 2026-08-01 batch is shipped: STINT label gutter, Find-car in
the Message board (+ Enter searches/highlights it), `inpit` via `PITSTOPCOUNT`
(no-op if the field is absent, so no regression), and racenote LIVE=SIM parity
(regenerate fresh + dup-safe upsert + `pit` kind allowed).

## First move: open admin.html → "LIVE data stream"
It reads what the scraper is actually writing and shows a state pill that tells
the failure modes apart at a glance:

| Pill | Meaning | Where the problem is |
|---|---|---|
| **STREAMING** | writes fresh **and** data-time near wall clock | healthy |
| **SOURCE STALE** | writes fresh, but data-time frozen | WIGE paused (yellow / session end) **or** our capture IP is rate-limited (see below) |
| **SCRAPER SILENT** | nothing written for >2.5min | no capture running (cron not firing / relay down / collector stopped) |
| **OFFLINE (no event)** | scraper ran, found no live event | between sessions, or wrong/ended event id |

The admin panel reads **raw rows** (not the derived timeline), so if admin says
STREAMING but the **dashboard** is broken, the bug is in the dashboard's timeline
derivation — see "corrupt data" below.

## We do NOT depend on stint9.com
The live pipeline reads WIGE's public socket (`wss://livetiming.azurewebsites.net/`,
channels `[0,4]`) directly and writes our own Supabase. `stint9.com`'s Clerk-gated
`/api/worker/*` API is documented in [§13](#13-stint9-live-timing-api--recovered-contract)
only as recovered *learnings* / a possible fallback — nothing at runtime calls it.
Keep it that way.

## Lesson 1 — DON'T over-poll WIGE (rate-limit / bot protection)
**This bit us hard.** A background poller hit event 20 every 60s for an hour plus
dozens of manual probes. WIGE then started **serving a frozen cached snapshot** to
the offending IPs and eventually **blocked headless clients entirely** (a fresh
`ws` connect returned **0 frames**), while a **real browser kept working**.

Symptoms of being rate-limited (vs the session genuinely ending):
- A fresh headless connect (Node/Deno) returns a **stale, unchanging** snapshot,
  or **0 frames**, while `livetiming.wige.de` / the leaderboard page still updates
  live in a normal browser.
- It recovers on its own after you **stop hammering** (minutes–hours).

Rules:
- The WIGE‑intended pattern is **one persistent subscription for the session**,
  not many fresh connects. The relay (`vds-relay.mjs --watch`) holds one socket;
  prefer it over frequent one-shot pokes.
- The pg_cron autoscan pokes once/min *inside session windows only* — acceptable.
  Do **not** run extra pollers alongside it, and don't spam the ⟳ Update button.
- The dashboard's own 5s polling and the admin panel read **Supabase**, not WIGE —
  they can't cause a WIGE block. Only the scraper/relay/collector/⟳/cron touch WIGE.

### Fallback when headless is blocked: the browser collector
`live/browser-collector.js` runs the capture **inside a real browser tab** (which
WIGE still serves) and upserts to Supabase with the publishable key. Paste it into
the console of `https://livetiming.azurewebsites.net/events/<id>/results`. See the
file header for steps. This is the reliable path if the cron/relay get blocked.

## Lesson 2 — corrupt garage/pit times inflate the whole timeline
WIGE emits **multi-minute-to-hour "sector" and lap times** for cars sitting in the
box (seen live: `s1=16727s` ≈ 4.6h, `lap=20490s` ≈ 5.7h). Left untreated these:
- pushed the derived clock **into the future** (badge read `17:54` while the real
  data-time was `13:16`),
- **froze the staleness check** — the dashboard showed `STALE · no update 27m`
  while the feed was streaming perfectly (admin = STREAMING),
- blew up the **cumulative-gap chart** (`+20490s`).

Fixes now in `index.html` (LIVE path only; SIM is fed clean CSV data):
- **Cap/null implausible values before `buildLiveDB`**: sector > 15min → null,
  lap > 1h → null (a real Nordschleife sector < ~15min even wet; lap < ~1h).
- **Derive the LIVE clock from the newest *actual* `lap_end_tod`** (max over raw
  rows), not the derived `DB.tmax`, so a single bad leg can't send it to the future.

If gaps/positions ever look wildly wrong again, suspect a new corrupt-value shape
and check the raw rows in the admin panel (look for absurd s1..s5 / laptime).

## Lesson 3 — the STALE badge measures *time since data advanced*
The dashboard badge "STALE · no update Xm" = wall-clock since the feed's data-time
last **changed** (timezone-agnostic — no UTC/CEST compare). Green running advances
it every few seconds; a real freeze (full-course yellow, session end) makes it
climb. The admin panel's "Xs behind wall clock" is the *absolute* source lag (it
assumes the feed's TOD is UTC — true so far).

## Lesson 4 — event id changes per session; don't let sessions merge
The live **event id is not stable**:
- It differs day-to-day, and **may change between sessions on the same day**
  (e.g. quali on one id, race on another).
- **Discovery already adapts**: `wige-scrape` reads the current id from
  `livetiming.wige.de/vln.html` on every call; the browser collector reads it from
  the leaderboard URL. So the cloud path latches whatever id is live. Good.

**The risk:** `stint9_live_timing` is keyed `(event_date, car, lap)` with no session
id. If quali and race run the same day, race rows **overwrite/merge** quali rows
for the same `(car, lap)` — a corrupt mix. Two ways to handle it:
- **Split per session (preferred).** Treat each event id as a separate dataset —
  e.g. add an `event_id` column to `stint9_live_timing` and filter the LIVE view by
  the current `stint9_live_status.event_id`; then quali and race are distinct and
  can be archived/loaded separately (like the `?event=<slug>` SIM loader). Needs a
  one-column migration + scraper/collector/dashboard tweak.
- **Clear on session change (quick).** When the discovered event id differs from
  the last one written, delete the day's `stint9_live_timing` rows before writing
  the new session, so only the current session is live. Loses in-place history, but
  the hourly archiver still snapshots each session for later.

Until one of those lands, **manually clear between sessions** if quali data lingers
into the race: `delete from stint9_live_timing where event_date = current_date;`
(then let the current session refill it).

## Lesson 5 — LIVE motion is SIM's logic; the frontier estimator was REMOVED
LIVE renders through SIM's exact loop (`activeLeg`+`ptAlong` interpolation). SIM
knows each sector's end time; at the live frontier the *current* sector isn't
finished, so `activeLeg` finds no leg for it.

**We used to extrapolate the car forward** across that unfinished sector at the
class-average pace (`DB.avgseg`), capped at `LIVE_EST_CAP_S` (280s). That gave
smooth motion but **ghost-drove retired cars around the map after the race**: the
extrapolation is driven by the global display clock `T` (newest `lap_end_tod`
across *all* cars), so as long as any car — cool-down laps, in-laps, or WIGE's
junk garage frames — kept `T` advancing, a car that had stopped sending timing
(e.g. #665) was still slid forward from its last real beacon. Seen live 2026-08-01:
"EVENT OVER" yet #665 kept lapping in the track view.

**Removed 2026-08-01** (`index.html`, the `else if(dataMode==='LIVE')` block in
`render()`). Now a car whose in-progress sector isn't in the feed is **frozen at
its last real beacon crossing** (`ptAlong(li[1],1)`), and one gone quiet for a
full `LIVE_RUNNING_WINDOW_S` (360s) parks at the pit line. **Cost:** live motion
is stepwise — a dot jumps forward only when a real crossing lands (every ~1–4 min
on the Nordschleife) instead of gliding. That's the accepted trade for never
inventing a position. `LIVE_EST_CAP_S` and the `DB.avgseg` extrapolation are gone.

The display clock still trails the newest data by `LIVE_BUFFER_S`. **Corrected
twice on 2026-08-02** (see [§15.4a](#154a-sector-bounded-position-prediction-revised-design-2026-08-02)
for the full history — this note went 10s → 120s → superseded): the value was
120s for a while (so a completed sector leg reliably covered the render time
T), then explicit feedback changed the direction entirely — minimal delay is
the priority, and rather than just shrinking the buffer and accepting jumpier
stepwise motion, `render()`'s LIVE branch now **predicts** the still-open
sector from this car's own historical pace (bounded, real data always wins —
§15.4a), which gets both minimal lag AND smooth motion. **Shipped value:
`LIVE_BUFFER_S=8, LIVE_MAXLAG_S=30`** (`index.html`, near `LIVE_POLL_MS`) —
just above the ~5s poll/flush floor, for jitter margin only. Whatever these
constants currently are in `index.html` is the source of truth — keep this
note and §15.4a in sync with it, that mismatch is exactly what caused this
correction to be needed in the first place.

## Quick checklist when "LIVE looks wrong"
1. Admin panel pill? STREAMING vs STALE/SILENT/OFFLINE narrows it instantly.
2. Admin STREAMING but dashboard frozen/weird → timeline corruption (Lesson 2) or
   you're on a stale browser tab (hard-refresh).
3. Headless capture dead but browser live → WIGE rate-limit (Lesson 1) → stop
   pokers, wait, or run the browser collector.
4. Numbers from a *different* session bleeding in → session-id merge (Lesson 4).
5. Never add extra WIGE pollers to "fix" it — that's what causes the block.

---

# 10. Live-timing learnings — 2026-08-01 (NLS 6h race)

WIGE event 20. First full race run of the LIVE pipeline under load. What broke,
what we learned, and where each fix lives. Companion to
[§7 race-day runbook](#7-live-feed--race-day-runbook) and
[§9 troubleshooting](#9-live-feed--troubleshooting--hard-won-learnings).

## 1. HOLD mode — one long-held socket instead of once-a-minute pokes
The cloud path used to `wige-scrape` once per cron minute, so the LIVE ticker
jumped ~once a minute. Fixed by an opt-in **`?hold=1`** mode: hold ONE WIGE socket
for ~149s (just under the free-plan 150s Edge cap) and flush changed rows every
~5s, with a `stint9_live_status.updated_at` freshness guard so overlapping cron
fires — or a running `vds-relay` — stand down (exactly one collector). The cron
POSTs `?hold=1` with `timeout_milliseconds:=155000` (must exceed the hold).
Density from holding the socket longer, NOT connecting more often — WIGE
rate-limits fresh connects, not held sockets. See the `wige-scrape/index.ts` header.

## 2. WIGE never sends sector S5 — reconstruct it
The Nordschleife feed reports **4 intermediate splits (S1..S4)**; there is no
discrete S5 field. Worse: a row's `LASTLAPTIME` is the **previous** lap's time
(reported while on the current lap), so `lap_time − sum(sectors)` on the SAME row
mixes two laps (gives negative / 167s garbage). Correct reconstruction:

> **S5(lap N) = lap_time(lap N+1) − (S1+S2+S3+S4 of lap N)**

because lap N's real total is reported as lap N+1's `LASTLAPTIME`. Done in
`index.html`'s LIVE raw preprocessing (`liveTick`). The newest lap's S5 fills in
one lap later. SIM is unaffected (CSV has real S5).

## 3. PostgREST `db-max-rows = 1000` silently truncated the LIVE fetch
The dashboard's LIVE poll fetches all of today's `stint9_live_timing`
(`order=car,lap`, **no `&limit`**). Once the day passed ~1000 rows, PostgREST's
hard 1000-row cap truncated it (verified: `&limit=5000` still returned 1000), and
the high-numbered cars (BMW M240i #650+, BMW M2 #870+, CUP2/CUP3 #9xx) fell past
row 1000 → **whole classes vanished from the Race-class dropdown mid-race**.
Fixed by raising the cap (persists in the role):
```sql
alter role authenticator set pgrst.db_max_rows = '200000';
notify pgrst, 'reload config';
```
Any "missing cars/classes / truncated data" symptom → re-check this first.

## 4. LIVE class names ≠ offline/championship names
WIGE labels some classes differently from the offline CSV the static datasets
were built from: **`BMW M240i`**/`BMW M240`, **`VT2-F+4WD`**/`VT2-F+4W`,
**`SP9 PRO-AM`**/`SP9 PRO-`. The CHAMPIONSHIP reel (static `NLS_CHAMP`, keyed by
class) missed on the mismatch → "No championship data". Fixed with an alias map in
`renderChampionship`. Any other class-keyed lookup against offline data needs the
same aliasing.

## 5. Admin "SOURCE STALE 961m behind" was a false alarm
`admin.html`'s LIVE data-stream read had **no `event_date` filter** and ranked by
`lap_end_tod` (seconds-of-day), so "newest data-time" became the highest
time-of-day row across ALL days — a prior session's afternoon crossing outranked
today's live rows — and the lag calc `(nowUtcSec − maxTod + 86400) % 86400`
wrapped past midnight into a bogus "961m behind" while the feed streamed fine.
Fixed by filtering the query to today's UTC `event_date`. Old rows also cleaned:
`delete from stint9_live_timing where event_date < current_date` (archiver has
snapshotted past sessions to `stint9_events`).

## 6. Finished-race rendering is a frozen final frame, not a bug
When the feed stops, the display clock holds at the last data-time. The renderer
parks non-circulating cars (`LIVE_RUNNING_WINDOW_S = 360` → pit line); cars
"stuck in S4" were genuinely there when timing froze; POS "angle lines" are lines
collapsing to the frozen frontier.

> **Update (2026-08-01):** the frontier estimator that used to keep a car gliding
> across its unfinished sector (`LIVE_EST_CAP_S = 280`) has since been **removed** —
> it ghost-drove retired cars around the map after the race (e.g. #665 still lapping
> under "EVENT OVER"). Cars now freeze at their last real beacon. See
> [§9 Lesson 5](#9-live-feed--troubleshooting--hard-won-learnings).

**Built:** a **feed-stopped overlay** — when the LIVE data-time hasn't advanced for
>180s (session end / red flag / feed cut), the map shows a grey `FEED STOPPED ·
frozen frame · Xm old` banner (top-right) and dims the car layer (`#dots.stale`),
so the frozen final frame isn't mistaken for live motion. Purely additive: driven
by the existing `_staleS` signal, it toggles an overlay + opacity and **does not
touch car placement** (that's why it was safe to ship without browser verification;
placement/label changes still need a live or `mock-replay` feed). Cleared on
leaving LIVE (`stopLive`). Still open (needs visual verification on a real feed):
correcting a *parked* car's lap label to its own last lap (not the frontier lap),
and an explicit final-classification view.

## 7. Smaller wins
- **TIMES reel**: lap columns reversed — newest/last lap leftmost, lap 1 rightmost.
- **Car search**: header "Find car #" input jumps to any car number across classes.
- **Race-control messages** (WIGE channel [3] → `stint9_messages`, deduped on
  `ext_key`) captured in both `wige-scrape` and `vds-relay`.

---

# 11. Race-control messages + LIVE message board

_2026-08-01._ How the dashboard's **MESSAGE BOARD** gets real race-control messages
(penalties, incidents, flags), and the fixes made on 2026-08-01. Companion to
[§8 data flow](#8-live-feed--data-flow) (which covers timing) and the schema in
`racecontrol-messages-supabase.sql`.

## The problem

The board read `public.stint9_messages`, but **nothing ever wrote to it** — the
scrapers only subscribed to WIGE `eventPid:[0,4]` (leaderboard) and wrote timing.
So the table was always empty and the board fell back to hardcoded `TEST_MESSAGES`,
which surfaced fake "Yellow flag / #666 under investigation" placeholders **during a
real live session** — misleading, since they look like genuine race control.

## The chain now

```
WIGE WebSocket channel [3]  →  wige-scrape edge fn / vds-relay  →  stint9_messages  →  board
```

Both write paths cover messages; a status-row freshness guard keeps only one
collector connected at a time:

| Path | File | Runs |
|---|---|---|
| Edge function (serverless) | `live/wige-scrape/index.ts` | per-minute `stint9_wige_autoscan` pg_cron during session windows |
| Laptop relay (continuous) | `live/vds-relay.mjs` | `node live/vds-relay.mjs --watch` / `raceday.sh` |

### Payload (verified live, event 20, NLS Zeittraining)

Channel `[3]` pushes `PID:"3"` frames:

```json
{ "PID":"3", "CUP":"...", "HEAT":"Zeittraining",
  "MESSAGES":[ { "ID":"1", "MESSAGETIME":"09:05:25",
                 "MESSAGE":"# 718 – overspeeding pitlane under investigation",
                 "MESSAGEGROUP":"" }, ... ] }
```

### Mapping rules

- **car** — first `#<number>` in the text (`null` for general messages).
- **created_at** — `MESSAGETIME` is Europe/Berlin wall-clock → converted to a UTC
  instant (DST-safe).
- **message** — stored **verbatim**. The feed replaces non-ASCII (ü, en-dash) with
  `?`; that is a source limitation we can't recover. Messages are often bilingual
  DE/EN duplicates — both kept.
- **race_class** — `null` (feed's `MESSAGEGROUP` is empty → applies to all classes).
- **ext_key** — `<event_date>|<MESSAGETIME>|<MESSAGE>`, the dedup key. `ID` is a
  rolling position index (1 = newest), **not stable**, so it can't be used.

### Dedup

`stint9_messages` has a `UNIQUE(ext_key)` index; NULLs are distinct, so manual
inserts (ext_key NULL) are unaffected. Upserts use `resolution=ignore-duplicates`
so re-scraping the rolling list never rewrites a row. Idempotent — verified 15 live
messages, zero duplicates on repeated runs.

### `event_date` — added 2026-08-02, scopes messages to one event

`stint9_messages` didn't originally carry `event_date` at all (a global,
point-in-time table) — the day was only recoverable by parsing `ext_key`'s
`<event_date>|…` prefix, and both the LIVE view and the event archiver had to
fall back to a best-effort `created_at`-window heuristic. A real `event_date
date` column was added (schema in `racecontrol-messages-supabase.sql`;
existing rows backfilled once from their `ext_key` prefix), and both write
paths (`live/wige-scrape/index.ts`, `live/vds-relay.mjs`) now stamp it on
every message the same way they already stamp it on `stint9_live_timing`
rows. `stint9_archive_event()` (the automatic hourly SQL archiver) and
`tools/archive_event.mjs` (the manual CLI) both now filter messages by exact
`event_date = <that event's date>` — falling back to the old window heuristic
only for legacy/manual rows that predate the column (`event_date is null`).

## Front-end (index.html message board)

- Real rows are shown in **both SIM and LIVE**; `TEST_MESSAGES` are a SIM/demo
  affordance only and **never** appear in LIVE (empty LIVE shows "No race-control
  messages.").
- **LIVE is scoped to today's `event_date` only** (added 2026-08-02,
  `loadMessages()` in `index.html`) — a past event's messages must never
  linger on the board once that event is over, the same "show nothing until
  real data" principle §15 established for the map/DB, extended here to the
  message board. SIM stays unfiltered (all events, all dates), matching the
  existing "real rows shown in both modes" design. `startLive()`/leaving LIVE
  now also force an immediate re-fetch (`window.reloadMessagesNow`) instead of
  waiting up to 5 minutes for the next scheduled poll, so the correctly-scoped
  list appears the instant you switch modes. Verified against a real live
  session (2026-08-02, event 20): LIVE showed exactly that day's 181
  messages, zero from the prior day's 119; SIM showed all 300 (fetch cap),
  unfiltered.
- **Newest on top**, older drop down, all reachable by scrolling (`.msglist` is
  `overflow-y:auto`); sorted by `created_at` desc in code so order never depends on
  fetch order. Fetch cap raised 50 → 300.

## Also fixed this session — reference-lap table in LIVE

The car's reference-lap table (class / car / prev-lap / ETA best) was data-driven
and only drew when a completed flying lap existed, so it never appeared during a
LIVE warm-up (0 completed laps). It now **always renders the frame** in both modes,
showing `—` until data lands. `ETA S/F` stays `—` in LIVE (its future S/F crossing
can't exist live).

## Commits (2026-08-01, on `main`)

- Message board: never show TEST placeholders in LIVE mode
- Reference-lap table: always render frame in SIM and LIVE
- wige-scrape: scrape WIGE race-control messages (channel [3])
- Message board: newest on top, scroll for the rest, keep more
- vds-relay: scrape race-control messages too (channel [3] parity)

---

# 12. LIVE feed — info to request before race day

The stint9-dash LIVE pipeline is **built and tested end-to-end** except for one
thing: the actual live-timing data source. This note lists exactly what we need
so LIVE lights up on race day with (almost) no coding.

> **Historical note:** this section (and §13/§14) predate the WIGE pivot, when we
> were still deciding between reverse-engineering WIGE and asking the stint9
> owner. The WIGE path is now built and proven (see §7–§11). Kept for context.

## What's already done (no input needed)
- `public.stint9_live_timing` table (raw per-lap rows) — created.
- `live/build-db.js` — rebuilds the dashboard DB from raw rows; **verified** to
  reproduce the offline generator exactly (109 cars, all positions match).
- Dashboard LIVE loop wired: polls the table every 5 s, rebuilds, renders.
  Falls back to "waiting for timing data…" until rows exist. SIM is untouched.
- `live/wige-scrape/` — Supabase Edge Function scaffold (mock mode works today).
- `live/mock-replay.mjs` — replays the 2026-06-20 CSV into the table for a full
  dress rehearsal without a live event.

## The only gap: where the live data comes from
We need **one** of these two sources wired into the scraper.

### Option A — WIGE public feed (preferred; no login)
`livetiming.wige.de` is public. Its leaderboard is a JS app that pulls data over
a **WebSocket**. We already recovered the channel numbers from its bundle
(`messages=[3]`, `results/trackState=[0,4]`, `statistics=[9002]`) but not the
socket URL or payload shape — those can only be seen against a **live event**.

**What to capture (during a running NLS session):** open `livetiming.wige.de`,
DevTools → Network → **WS** → click the connection, then save:
1. the `wss://…` **Request URL** + request headers (esp. `Origin`, any tokens);
2. **Messages** tab → right-click → **Save all as HAR** (30 s is plenty).

### Option B — ask the stint9 site owner
The stint9 app (the authenticated part at **stint9.com/app**, a Next.js + Clerk
site) already shows live timing, so it already consumes a feed. If the owner is
willing to share, ask them:

> **Questions for the stint9 owner:**
> 1. Where does the `/app` live-timing page get its data — the **WIGE
>    WebSocket** directly, or your **own API / backend** in front of it?
> 2. If it's your own API: is there a **URL + auth** (API key / token) we could
>    use read-only for one car number or class during the event?
> 3. If it proxies WIGE: can you share the **socket URL and the subscribe
>    message format** you send, plus one **sample payload** of the results and
>    messages channels?
> 4. Is there any **rate limit / Origin restriction** we should respect?
> 5. Is a per-event **event id** required to subscribe, and where do we read it?

Either option gives us the same three values to fill into
`live/wige-scrape/config.ts` (`SOCKET_URL`, `SUBSCRIBE`, and the field mapping).

## What we learned inspecting the saved page (2026-07-13)
The saved "Live Timing · Stint9" file was the **public marketing homepage**
(`stint9.com`), not the live app — it only contains Clerk auth + landing-page
chunks, no data endpoint. Useful finding: stint9's static JS **is publicly
fetchable**, so if the owner can't help, a "Save Page As → **Webpage, Complete**"
of **stint9.com/app** *while logged in* would pull the real data chunk locally
and we could extract the endpoint statically — but the cleanest path remains the
**HAR capture** in Option A during a live session.

## Bottom line for race day
Once we have the HAR (or the owner's answers): paste 3 values into
`config.ts`, deploy the Edge Function, and LIVE works. See
[§7 race-day runbook](#7-live-feed--race-day-runbook).

---

# 13. stint9 live-timing API — recovered contract

_2026-07-13._

> **SUPERSEDED (2026-07-13) → use `live/vds-relay.mjs`.** livetiming.vdsmotorsport.com
> exposes a **public, auth-free** WebSocket (`wss://livetiming.azurewebsites.net/`,
> subscribe `{eventId,eventPid:[0,4],clientLocalTime}`) carrying the same leaderboard
> data with **S1..S9** sectors. That removes the Clerk-cookie blocker below: a plain
> Node process (`node live/vds-relay.mjs <eventId>`) can consume it and upsert to
> `stint9_live_timing` directly — no logged-in browser tab, no owner permission. The
> Clerk/`/api/worker` contract below is kept only as a fallback.

Extracted statically from a **logged-in Web Archive** of `stint9.com/app` (its
Next.js chunks). This replaced the WIGE-WebSocket plan at the time: stint9 already
ingests the feed and exposes it as **clean same-origin JSON**, which is far easier
to consume than reverse-engineering WIGE.

## Endpoints (same-origin, behind Clerk auth)
| Method | Path | Returns |
|---|---|---|
| GET | `/api/worker/events/{eventId}/laps` | `{ laps: [ lapObj, … ] }` — full snapshot |
| GET | `/api/worker/events/{eventId}/pits`  | pit data |
| GET (SSE) | `/api/worker/stream?eventId={eventId}` | `EventSource` live deltas; `message` = `{type:"event", kind:"lap", …lapObj}` |

Client flow: fetch `/laps` + `/pits` once, then open the SSE `stream` for
incremental frames (tracks `lastFrameAt`). Snapshot and stream carry the **same
lap-object shape**.

## Lap object → our `stint9_live_timing` row
| stint9 field | our column | note |
|---|---|---|
| `stnr` | `car` | start number |
| `className` | `klass` | |
| `driverName` | `driver` | |
| `car` | `vehicle` | vehicle model |
| `lap` | `lap` | |
| `lapTime` | `lap_time` | |
| `s1Time`..`s5Time` | `s1`..`s5` | sector times |
| `todTs` | `lap_end_tod` | timestamp; `new Date(todTs)` → seconds-of-day = h*3600+m*60+s. Fallback `createdAt`. |
| `pitStopCount` | (→ `inpit` via delta) | also `/pits` endpoint |
| `position` / `classRank` | (optional) | stint9's own ranking; we recompute in build-db |
| `team` | — | not needed |

Our `buildLiveDB` recomputes positions itself, so `stnr + lap + s1..s5 + todTs +
className + driverName` are the only fields strictly required.

## Auth — the one thing still to solve
These are same-origin calls that ride the **Clerk session cookie** (`__session`)
in the logged-in browser. A standalone server scraper can't hold that session
cleanly (Clerk JWTs are short-lived). Recommended approach:

**Browser-side collector → ingest function.** A small script pasted into the
logged-in stint9 tab on race day polls `/api/worker/events/{eventId}/laps`
(rides the cookie automatically) and POSTs the JSON to a Supabase Edge Function
(`ingest`) guarded by a shared secret, which upserts with the service-role key.
No Clerk tokens leave the browser, no WIGE work. See `live/wige-scrape/` (to be
renamed `ingest`) — the upsert half already exists.

Alternatives: ask the owner for a read-only token, or for the raw WIGE socket.

## Still unknown (only matters on race day)
- The **`eventId`** value — only exists when an event is live (today the page
  showed "Waiting for feed", no id embedded). Read it from the `/app` URL or a
  `/api/worker/events` list on the day.
- Exact `todTs` type (epoch-ms vs ISO) — trivially handled by `new Date()`.

---

# 14. Message to send the stint9 owner

_Historical — from before the WIGE pivot, when we still needed the owner's help._

We built a race-engineering overlay for our team on top of stint9's live timing
(maps, position chart, sector deltas). It reads stint9's own JSON feed from a
logged-in browser tab. To finish wiring it we need to confirm a few details of
the `/api/worker/...` endpoints. You can either **run a tiny read-only probe**
(Option A) or **just answer the 5 questions** (Option B) — whichever is easier.

## Option A — run the probe (30 seconds, read-only, writes nothing)
During a **live session** (practice/quali/race), while logged in on the live
timing page:
1. Open DevTools → **Console** (⌥⌘I on Mac, F12 on Windows).
2. Paste the contents of **`probe.js`** (attached) and press Enter.
3. Copy the whole console output back to us.

It just does the same `GET /api/worker/events/{eventId}/laps` the page already
does, and prints: the detected `eventId`, one sample lap object, and how `todTs`
parses. **It sends nothing anywhere and changes nothing** — it's your session,
your data, read-only.

## Option B — just answer these 5 (you know them by heart)
1. **eventId** — what's its format, and where does the app get it (route param?
   an events-list endpoint like `/api/worker/events`)? If handy, the id of a
   recent or upcoming event so we can test.
2. **Sample lap** — one raw object from `/api/worker/events/{eventId}/laps`. We
   think the fields are: `stnr, className, driverName, car, lap, lapTime,
   s1Time…s5Time, todTs, pitStopCount, position, classRank` — is that right?
3. **`todTs`** — what is it exactly? epoch-milliseconds, an ISO string, or
   seconds-of-day? (We convert it to time-of-day to place cars on track.)
4. **Auth / sessions** — is the feed the same during quali and race, and do the
   `/api/worker/...` calls need anything beyond the normal Clerk session cookie?
5. **Etiquette** — any objection to us polling
   `/api/worker/events/{id}/laps` from a logged-in tab about **every 5 s**
   during the event (read-only)? Or would you rather give us a read-only token
   or a lighter endpoint? We don't want to hammer your backend.

Thanks! Read-only either way — we're not scraping WIGE or touching your writes,
just mirroring the data you already serve us into our own view.

---

# 15. SIM vs LIVE parity audit — 2026-08-02

Full-page investigation of `index.html`, triggered by a real symptom: **opening
LIVE when no race is actually running still shows cars moving on the track
map.** Backup taken first: `backup-2026-08-02/` (index.html + live/ + admin.html
+ this README, sha256-verified against the working copy at the time of backup).
Scope: `index.html` only (4265 lines; the ~630 KB `const DB` blob on line 646 is
excluded from the analysis — it's static track/CSV data, not logic).

> **SHIPPED 2026-08-02.** Plan step A (isolation fix) and step B, tiers 1/3/4
> (sector-bounded prediction) are implemented in `index.html` and
> browser-verified — see §15.7 for exactly what shipped, what changed from the
> plan during real verification (two real gaps this audit's own first draft
> missed), and what's still open (tier 2, item 9, the wider constants
> refactor).

## 15.1 Root cause — the "ghost SIM cars in LIVE" bug (CRITICAL)

**This is the bug behind the reported symptom**, and it is not an edge case —
it reproduces on most page loads because the mode toggle remembers LIVE across
refresh (`localStorage['stint9_datamode']`, restored at `index.html:3174-3177`),
and most viewers leave the tab on LIVE.

**Mechanism.** LIVE renders through SIM's exact renderer — this is correct and
intentional (see §9 Lesson 5). What's missing is a guard for **"LIVE mode is on,
but we have never yet received a real live frontier this session."** Three
pieces combine to break that guard:

1. `liveTick()` (`index.html:3032`) fetches `stint9_live_timing` for today. If
   the response has **zero rows** — no event today, before the race starts,
   hours after it ends once the day rolls over, or any fetch error — it
   `return`s immediately at line 3038 (or the `.catch` at 3113). **Nothing gets
   cleared.** `DB.cars`, `LEG`, `BX`, the per-car SVG elements (`EL`), and
   `DB.tmax` all keep whatever they held **before** LIVE was entered — which,
   on first entry, is the baked SIM dataset (the 2026-06-20 CUP5/full-grid
   race), and on re-entry, whatever the previous LIVE session last painted.
2. `liveLoop()` (`index.html:3119`) runs on `requestAnimationFrame` starting the
   instant `startLive()` is called (`index.html:3134`) — **before** the first
   fetch has had a chance to resolve. Its frontier line:
   ```js
   const frontier=(liveFrontier!=null)?liveFrontier:DB.tmax;   // index.html:3122
   ```
   `liveFrontier` is only ever set inside the *successful-with-rows* branch of
   `liveTick()` (line 3082), so on a fresh LIVE entry it's still `null` —
   which falls through to `DB.tmax`, the **leftover SIM (or stale prior-LIVE)
   value**, not `null`. The `if(frontier==null||!isFinite(frontier))` bail-out
   right after it therefore never fires, because `DB.tmax` is always a real,
   finite number.
3. With a real-looking `frontier`, the loop does exactly what it's designed to
   do: `liveDispT` starts 120s (`LIVE_BUFFER_S`) behind it and glides forward
   at 1× real time, calling `render()` every frame with `dataMode==='LIVE'` —
   which walks the **stale** `DB.cars`/`LEG` through `activeLeg`/`ptAlong`
   (`index.html:1975-1992`), i.e. it **replays the tail of the 2026-06-20 SIM
   race** (or a stale prior LIVE frame) under the LIVE label, for up to two
   minutes before holding at that frozen leftover frame — indefinitely, if no
   real event ever answers.

This is exactly the reported case: the header badge (`refreshStatus()`,
`index.html:2976`) is fully decoupled from this — it reads
`stint9_live_status` directly and can correctly say `offline`/`event —` **at
the same time** the track map is animating leftover data, because nothing
connects the two. Every panel that reads `DB.*` (map, lap chart, comparison
table, TIMES/POS/SECT reels…) is affected the same way, not just the dots —
the whole page is showing a phantom replay, not just one widget.

**Confirms `render()`'s LIVE branch itself is fine** (`index.html:1978-1993`,
the frontier-freeze-then-park logic added in commit `c966ada` is correct and
should not be touched) — the defect is entirely upstream, in what feeds it a
`T`/`DB` state that was never validated as "real, current, live."

## 15.2 Same root cause, second symptom — staleness detection goes silent (HIGH)

The `_staleS`/`STALE` badge/`FEED STOPPED` banner bookkeeping
(`index.html:3090-3108`) lives **inside the same successful-with-rows branch**
as §15.1. The moment `stint9_live_timing` returns zero rows for the day, this
logic simply stops running — `window.__liveAdvMs` freezes at whatever it last
was, so the one indicator meant to say "this isn't live anymore" doesn't fire
in precisely the scenario (no rows) where the ghost-car bug also needs it most.
Same fix location, same commit.

## 15.3 Proposed fix (scoped, does not touch the LIVE data pipeline)

> **Revised 2026-08-02** after feedback: the first draft only hid the `#dots`
> map layer, which stopped the ghost cars but left `DB.cars`/`DB.legs`/etc.
> holding stale SIM (or prior-LIVE) data underneath — every other panel
> (lap chart, comparison table, TIMES/POS/SECT reels…) could still read it.
> **Explicit requirement going forward: SIM data must never be carried into
> LIVE, in any panel, at all — LIVE shows literally nothing until real data
> has landed.** The fix below now clears `DB` itself, not just one rendering
> layer, so there's structurally nothing left to leak anywhere on the page.

Touches `startLive()` (new `clearLiveDB()` call), the two early-exit paths of
`liveTick()`, and the top of `liveLoop()`. Does **not** change `buildLiveDB`,
the fetch/poll mechanics, `render()`'s car-positioning math, the tween, or the
parking/pit-line logic — a session with real live data streaming in behaves
byte-for-byte as it does today; only the "no real data yet" states change.

```js
// module scope, next to liveFrontier's declaration
let liveHasData=false;     // true only after a real buildLiveDB() has landed this LIVE entry

// Wipes DB (and the derived LEG/BX/EL/SVG car layer/class dropdown) to a
// genuinely empty shape — not "hidden", actually absent. SIM's own copy is
// untouched (already saved aside by snapSim()), so nothing here is
// destructive; restoreSim() on switching back to SIM is unaffected.
function clearLiveDB(){
  DB.classes={};DB.classMaxN={};DB.classAvg={};DB.legs={};DB.chart={};DB.sectimes={};
  DB.lappos={};DB.pits={};DB.name={};DB.drvlap={};DB.carcol={};DB.veh={};
  DB.event={name:'',date:liveEventDate()};
  DB.cars=[];DB.maxN=1;DB.avgseg=[0,0,0,0,0,0];DB.tmin=0;DB.tmax=0;
  for(const k in LEG)delete LEG[k];for(const k in BX)delete BX[k];
  for(const k in BKEYS)delete BKEYS[k];for(const k in POS)delete POS[k];for(const k in BT)delete BT[k];
  gd.innerHTML='';for(const k in EL)delete EL[k];   // remove the car <g> elements entirely — nothing to hide, nothing exists
  fillClassDropdown();                               // renders as empty, harmless
}

function startLive(){
  snapSim();
  clearLiveDB();                                              // NEW: LIVE starts from a genuinely empty DB, every time
  liveSeen=false; liveHasData=false; liveFrontier=null;        // NEW: also reset frontier
  window.__liveAdvMs=Date.now(); window.__liveLastT=undefined; // NEW: don't inherit stale staleness state
  liveDispT=null; liveDispLast=0; liveLastDrawn=null;
  liveMsg.textContent='LIVE · connecting…';
  liveTick();
  if(!liveRAF) liveRAF=requestAnimationFrame(liveLoop);
  liveTimer=setInterval(liveTick, LIVE_POLL_MS);
}

function markStale(){    // NEW: staleness/banner bookkeeping, factored out so every
                          // path (rows, empty rows, fetch error) can call it
  const _staleS=window.__liveAdvMs?Math.round((Date.now()-window.__liveAdvMs)/1000):0;
  // ...exact body currently inlined at index.html:3094-3108, unchanged...
}

function liveTick(){
  refreshStatus();
  fetch(...).then(r=>r.ok?r.json():[]).then(rows=>{
    if(window.dataMode!=='LIVE')return;
    if(!rows||!rows.length){
      liveMsg.textContent='LIVE · waiting for timing data…';  // DB is already empty — nothing to clear further
      markStale();                                    // NEW: keep the banner honest even with 0 rows
      return;
    }
    ...
    liveHasData=true;                                  // NEW: only after buildLiveDB + buildClass ran for real
    markStale();                                        // (replaces the inline block)
    ...
  }).catch(()=>{
    if(window.dataMode==='LIVE'){
      if(!liveSeen) liveMsg.textContent='LIVE · feed unreachable, retrying…';
      markStale();                                      // NEW: network errors count as "not advancing" too
    }
  });
}

function liveLoop(ts){
  if(window.dataMode!=='LIVE'){liveRAF=0;return;}
  liveRAF=requestAnimationFrame(liveLoop);
  if(!liveHasData||liveFrontier==null){liveDispLast=ts;return;}  // nothing built yet — DB is empty, don't even run render()
  const frontier=liveFrontier;                                    // was: liveFrontier ?? DB.tmax — fallback removed entirely
  ...                                                              // rest unchanged
}
```

`clearLiveDB()` running unconditionally at the top of **every** `startLive()`
call (not just the first) also closes the SIM→LIVE→SIM→LIVE round-trip case:
`restoreSim()` (called on switching back to SIM, `index.html:3156`) puts SIM's
data back into `DB` for SIM to use — correctly — but that means `DB` holds SIM
data again right before the *next* `startLive()`; clearing on every entry
guarantees that copy is wiped before LIVE ever gets a chance to read it, no
matter how many times you toggle modes in one page session.

Once `liveHasData` flips true, `DB` and `EL` hold **only** what
`buildLiveDB()`+`buildClass()` just built from real rows — there is no path
left by which SIM data (or a previous LIVE session's leftover data) can be
read by any panel. The existing frozen-frame behaviour for a **real**
mid-session stall (§10.6 — dim + `FEED STOPPED` banner, cars stay visible) is
untouched; that path already has `liveHasData=true` and a valid `liveFrontier`
by the time it can trigger, and none of this clears real, already-received
LIVE data out from under an active session — only the pre-first-data and
mode-entry states are affected.

## 15.4 Secondary findings

- **Docs vs. code drift (low, but misleading).** §9 Lesson 5 says
  `LIVE_BUFFER_S (10s — must stay > the 5s poll)`. The shipped value
  (`index.html:3022`) is **`LIVE_BUFFER_S=120, LIVE_MAXLAG_S=300`**, with a
  much longer comment explaining why 120s was chosen (a completed leg has to
  exist for the frontier time). The 10s note is stale from before that change
  landed — worth fixing so a future debugging session doesn't chase the wrong
  number. *(Corrected in this same edit — see the value now cited above.)*
- **~2 minute replay lag — direction changed 2026-08-02: reduce it, don't just
  disclose it (medium/high — likely part of "timing mismatch").**
  `LIVE_BUFFER_S=120` + up to `LIVE_POLL_MS=5000` fetch cadence + WIGE/relay
  latency means what's labelled "LIVE" is, by design, roughly two minutes
  behind the real track. First draft of this audit proposed just labelling
  that lag in the UI; explicit feedback was **no — minimize the lag itself**,
  SIM-smoothness is not the priority, timeliness is. §15.4a's bounded
  sector-prediction design (second revision) gets both: minimal lag *and*
  smooth motion, by predicting the in-progress sector from this car's own
  history instead of just waiting for it to finish.
- **Stale bookkeeping can carry across a LIVE→SIM→LIVE round-trip (low).**
  `stopLive()` (`index.html:3135`) clears the banner/opacity but not
  `liveFrontier`/`window.__liveAdvMs`/`window.__liveLastT`; `startLive()`
  (`index.html:3134`) resets `liveSeen`/`liveDispT`/`liveDispLast`/
  `liveLastDrawn` but not those three. Folded into the §15.3 patch (reset all
  three in `startLive()`) so re-entering LIVE never flashes a leftover
  STALE/FEED-STOPPED state from a previous entry before the first fresh fetch
  lands.
- **`LIVE_MAXLAG_S` re-anchor snaps instead of easing (cosmetic).** If the
  display clock falls behind the frontier by more than `LIVE_MAXLAG_S` (e.g. a
  backgrounded/throttled tab refocused later), `liveDispT` jumps straight to
  `frontier-LIVE_BUFFER_S` in one frame (`index.html:3128`) rather than easing
  like the small-move tween at lines 1998-2001. Not urgent; noted as an
  optional follow-up, not part of the critical fix. Both constants are being
  retuned anyway per §15.4a.
- **Frozen-frame-while-parked is correct, not a bug.** Re-verified §10.6's
  behaviour: a car quiet for `LIVE_RUNNING_WINDOW_S` (360s) parks at the pit
  line and stays *visible* (dimmed via `#dots.stale`) with the `FEED STOPPED`
  banner up — this is the intentional "frozen final frame" design for a **real
  mid-session stall with real prior data**, and is unrelated to (and should
  stay unrelated to) the §15.1 fix, which only concerns "never had real data
  this LIVE entry" / "zero rows returned."

## 15.4a Sector-bounded position prediction (revised design, 2026-08-02)

**Superseded the "just shrink `LIVE_BUFFER_S`, accept stepwise motion" idea
above** after further direction. The requirement, restated precisely:

1. **Ingestion stays exactly as-is** — one held WIGE socket (§10.1 HOLD mode),
   raw values land in `stint9_live_timing` unmassaged (`admin.html`'s data
   stream reads them raw, on purpose — see §9), the dashboard alone derives
   positions from that Supabase data. *(Confirmed: already true today. No
   change needed here — this whole section is 100% client-side render logic
   in `index.html`, nothing upstream.)*
2. **A real sector-crossing time is the one holy reference.** The instant one
   is known, it pins the car exactly there — no interpretation, no smoothing
   of *where* it happened. *(Also already true — `activeLeg`/`ptAlong` on a
   completed leg, checked first in `render()`, `index.html:1976`.)*
3. **Between two real crossings, PREDICT the in-progress sector** using this
   car's own history (preferred) instead of freezing — but the prediction
   must always defer instantly to the next real crossing the moment it lands.
4. **Show an anomaly signal** (reuse the existing `DELAY` badge,
   `index.html:2008-2012`) when the real crossing is taking noticeably longer
   than predicted — that gap *is* the Code 60 / yellow-flag / mechanical-issue
   signal, not something to hide by extrapolating through it.

This is **not** the removed frontier estimator (commit `c966ada`) coming back
— that one failed because it was (a) driven by the *global* clock advancing
regardless of whether *this specific car* was still transmitting, and (b)
capped by one flat constant (`LIVE_EST_CAP_S=280`) far longer than most
sectors actually take, so a silent car kept sliding for a long time before
anything caught it. The design below fixes both: the estimate is (a) always
relative to *this car's own* last real crossing, and (b) capped at *this
car's own sector's* predicted length, not a flat global number — so a car
that's actually stopped simply reads as "at the sector exit, flagged
DELAY" almost immediately, instead of continuing to move.

### Reference-duration lookup (cascading, cheapest first)

For car `c` about to run sector `k` (i.e. no completed leg for it yet):

1. **This car, this session, most recent *non-pit* completed lap's sector
   `k`.** Already sitting in `DB.sectimes[c]` — every `buildLiveDB()` poll
   rebuilds it, so this needs **no extra fetch**, just a backward scan over
   laps already in memory (mirroring how `classAvg` in `live/build-db.js:124`
   already skips pit laps for the same reason: an in/out-lap's sector time
   isn't representative of normal pace).
2. **This car, most recent earlier session with data** — same-day earlier
   session (quali before the race starts) or, on the 24h weekend, the
   previous calendar day — queried from `stint9_live_timing`/the not-yet-
   archived earlier `event_date`, or from `stint9_events` if it's already
   been archived (§"stint9 event archive" — `bundle.timing[]` or
   `bundle.db.sectimes`). Mainly matters for multi-day events; for a normal
   single-day NLS round this tier is usually empty and falls through to 3.
3. **This car, most recent archived previous race** — one query to
   `public.stint9_events` (`order by event_date desc`), first bundle that
   contains this car number, same non-pit-lap sector average. Fetched **once
   per LIVE session** (on first need per car) and cached in memory —
   `stint9_events` already exists and is already read this way by
   `admin.html` (`loadEventDetail`, `admin.html:312`), so no new table or
   write path, just a new read from `index.html`.
4. **Live class average, this session** — already computed continuously by
   every `buildLiveDB()` poll (`DB.classAvg`/`DB.avgseg`), from real cars in
   the *current* race. Cheapest and always-fresh; used only when tiers 1–3
   have nothing yet (e.g. a car on its very first lap of the whole weekend).
5. **Nothing available at all** (session's very first crossings, before
   *anyone* has completed sector `k`) — no prediction is possible; falls back
   to exactly today's safe behaviour (freeze at last known point / park at
   the pit line). Not a new failure mode — this is the existing 2026-08-01
   fallback, unchanged.

### The bounded interpolation itself

```js
// li = the car's last known completed leg [lap, sector, tStart, tEnd, spd]
// k  = the next sector (li[1]+1, wrapping to lap+1,sector 1 after S5)
const entryT   = li[3];                       // real crossing time — the anchor
const elapsed  = T - entryT;
const predDur  = refDuration(car, k);          // cascading lookup above; may be null (tier 5)
if (predDur) {
  const progress = Math.max(0, Math.min(1, elapsed / predDur));  // capped at the sector EXIT — never overshoots into unknown track
  [x, y] = ptAlong(k, progress);
  // Anomaly signal: reuse the existing DELAY badge/threshold (`thr`, the
  // Delay % control), now applied to an IN-PROGRESS sector too, not just
  // completed ones — index.html:2008-2012's condition extends to this branch.
  showDelayBadge(elapsed > predDur * (1 + thr));
} else {
  // no reference at all yet — unchanged existing fallback (freeze / park)
}
if (elapsed > LIVE_RUNNING_WINDOW_S) { parked = true; [x, y] = ptAlong(1, 0); } // unchanged absolute ceiling
```

Because `progress` is clamped to `[0,1]` **against this car's own predicted
sector duration**, a car that's genuinely stopped (crash, mechanical, retired)
reads as "parked right at the sector exit it never reached, DELAY badge lit"
within roughly one predicted-sector-length of going quiet — not slid forward
indefinitely by other cars' progress. And the moment a real crossing for
sector `k` lands, `activeLeg` finds it on the very next `render()` call
(checked *before* this branch, `index.html:1976`) and the prediction is
simply never consulted again for that leg — real data always wins, with no
explicit "override" logic needed, just the existing check ordering.

### Effect on `LIVE_BUFFER_S`

This **supersedes** the earlier "shrink the buffer, accept mostly-frozen
stepwise motion" trade-off — with a bounded prediction covering the gap
instead of nothing, `T` no longer needs to lag behind the newest data by a
whole sector's length to look smooth. `LIVE_BUFFER_S` can drop close to the
real floor (the ~5s poll/flush cadence, §10.1) — a few seconds of margin for
jitter, not 120s and not the ~12s previously proposed — while motion stays
continuously smooth *and* self-correcting, rather than trading smoothness
away for freshness. Exact value to be confirmed by eye via
`live/mock-replay.mjs --speed 1` once the prediction path is in place.

### Scope / risk

Bigger than a constants tweak — it's new logic (tiers 1 + 4 are simple reads
of data already in memory; tier 3 adds one cached Supabase read per car per
LIVE session; tier 2 is the least essential, mainly for the 24h weekend).
Recommend shipping in slices (§15.7) rather than all at once: tier-1-only
prediction first (zero new fetches, already covers "this car has done at
least one lap"), verified not to ghost, before adding the archive-lookup
tiers as a refinement.

## 15.5 Feature-parity audit — SIM vs LIVE

Traced every `window.dataMode` branch point in `index.html` (24 occurrences).
Every LIVE-only or SIM-only behavioural difference found is legitimately
**input-driven**, not a missing feature:

| Difference | Where | Why it's correct to differ |
|---|---|---|
| Code 60 detection | `index.html:835` | needs live sector *speed* readings; the baked SIM CSV has none |
| Clock timezone shift | `index.html:960-970` (`clockOffsetS`) | WIGE reports UTC; SIM's CSV `TAGESZEIT` is already track-local |
| Gap sanity clamp | `index.html:925` | practice-session LIVE gaps can be hours apart (meaningless as a race gap); SIM gaps are always real |
| Fuel-note / weather / lap-time sync to Supabase | `index.html:712, 2560, 2623` | only the real race is worth persisting; SIM is an ephemeral replay by design (§5) |
| Signal counter / event badge | `index.html:988-1001` | SIM has no feed to count |
| Racenote persistence | `rnLive()`, `index.html:3214` | SIM notes are ephemeral in-memory (§9/§11); LIVE persists — documented, already fixed for parity (commit `d0ef2e0`) |
| Message board fallback | `index.html:3891` | `TEST_MESSAGES` are a SIM-only demo affordance; LIVE never shows fake race-control text (already fixed) |

**No other hidden LIVE feature gaps found.** The "SIM looks better than LIVE"
perception reported is very likely almost entirely explained by §15.1/§15.2 —
once LIVE only ever paints when it has a real, current frontier, the two modes
should read as visually equivalent (same renderer, same interpolation, same
declutter/label logic) whenever there's actually a race to show.

## 15.6 On simplification

Deliberately **not** recommending an architecture change. The single
`window.dataMode` flag + shared `render()` design is sound: LIVE and SIM
provably run through identical positioning/interpolation code today (that's
*why* the bug looked like a "SIM is better" problem rather than two diverging
renderers) — a bigger rewrite would risk exactly the regression this audit was
asked to avoid. Two small, zero-risk cleanups that fall out of the §15.3 patch
anyway:

1. **Centralize the timing thresholds.** `120` (STALE badge), `180` (FEED
   STOPPED), `300` (`LIVE_MAXLAG_S`), `360` (`LIVE_RUNNING_WINDOW_S`), plus the
   garbage-value caps in `liveTick` (`900`/`1200`/`3600`s) are separate magic
   numbers with prose comments scattered across ~200 lines. A single named
   block near `LIVE_POLL_MS` would make future tuning safer without changing
   any behaviour.
2. **`markStale()` extraction** (needed for §15.3 anyway) removes the one
   piece of duplicated inline staleness logic.

No other simplification is recommended at this time — the rest of the file's
complexity (declutter algorithms, tween, pit/park logic, the reel dispatch
table) is load-bearing and specific to real bugs already fixed by prior
commits; collapsing any of it risks reintroducing them.

## 15.7 Step-by-step plan — SHIPPED 2026-08-02 (A + B tiers 1/3/4)

Two independent fixes, both client-side only in `index.html`. Steps 1–6 and 8
are implemented and browser-verified (Playwright against a local static
server, hitting the real public `stint9_live_timing`/`stint9_events` REST
endpoints read-only — no test data written anywhere). Steps 7 and 9–10 are
explicitly deferred, as planned.

**A — Isolation fix (§15.3). Shipped.**

1. ✅ **`clearLiveDB()` on every `startLive()`** + `liveHasData` guard +
   `markStale()` extraction, frontier fallback to `DB.tmax` removed entirely.
   **Revised during implementation:** the first cut of `clearLiveDB()`
   hand-cleared `DB`/`LEG`/`BX`/`EL`/`gd` directly — it worked for the main
   track map, but **missed the "Zoom view" minimap** (`MEL`/`miniG`, a
   parallel per-car SVG map `renderMini()` owns, entirely separate from the
   main map's `EL`/`gd`) and the lap chart (`CLINE`/`CTIP`/`CRT`/`CSEC`/`CPIT`).
   Browser verification caught it directly — the zoom view kept showing
   leftover SIM car dots even after the main map correctly went to zero.
   **Fixed** by having `clearLiveDB()` call `buildClass(undefined)` instead of
   hand-rolling the clear: `buildClass()` is the same routine an ordinary
   class switch already uses to rebuild *every* per-car structure, so reusing
   it guarantees nothing is missed — now or if another per-car structure gets
   added later — instead of a second hand-written clear that can silently
   drift out of sync with what `buildClass()` actually owns. (`DB.tmin`/
   `DB.tmax` get reset to `0` right after, since `buildClass()` derives them
   via `Math.min/max.apply(null,[])` on an empty car list, i.e.
   `Infinity`/`-Infinity`.)
   **Second gap found the same way:** `render()` itself only ever runs from
   `liveTick`'s success path or `liveLoop` once `liveHasData` — neither has
   fired yet on a fresh `startLive()` — so without an explicit call, every
   *other* panel (standings table, reference-lap card, starting grid, message
   board's car-name label) kept showing whatever SIM last painted, frozen,
   even though the map/zoom/chart were correctly empty. Fixed by calling
   `render()` (and `buildStartGrid()`) once, directly in `startLive()`, right
   after `clearLiveDB()`. **Third, smaller gap:** this made `restoreSim()`
   asymmetric — the starting grid blanked on LIVE entry but never came back on
   switching to SIM. Fixed by calling `buildStartGrid()` in `restoreSim()`
   too. All three were only found by actually driving the page in a browser,
   not by static reading — see the verification note below.
2. ✅ **Regression-tested the exact reported case**: zero rows in
   `stint9_live_timing` for today (genuinely true at verification time — no
   live NLS session running). Confirmed **every** panel — main map, zoom-view
   minimap, lap chart, standings table, starting grid, reference-lap card —
   shows a clean empty state ("LIVE · waiting for timing data…", "no
   qualifying data for class —", empty dropdown), not leftover SIM content.
   Confirmed the SIM→LIVE→SIM round-trip restores every panel exactly
   (including the starting-grid fix above). **Zero console errors** across the
   whole sequence, including a direct `render()` call against the cleared DB.
   `mock-replay.mjs` itself was **not** run — it requires the Supabase
   service-role key and writes real rows into the shared `stint9_live_timing`
   table, which this session doesn't have and shouldn't invoke unprompted
   against shared infrastructure; the read-only verification above (real
   endpoint, genuinely empty right now) covers the same "zero rows" case
   without that risk. Recommend a `mock-replay.mjs` pass before the next live
   event, to see steps 3–6 render against real-shaped moving data.

**B — Sector-bounded prediction (§15.4a). Tiers 1, 3, 4 shipped; tier 2
deferred, as planned.**

3. ✅ **Tier-1 prediction** (this car, this session, last non-pit lap's same
   sector — no new fetches, data already in `DB.sectimes`). Bounded-
   interpolation branch added to `render()`'s LIVE path, capped at
   `progress∈[0,1]`, falling through when no tier-1 value exists yet (lap 1,
   or all prior laps were pit laps).
4. ✅ **`DELAY` badge extended** to the in-progress-sector case — same `thr`
   threshold, applied to `elapsed` vs. the predicted duration.
5. ✅ **Tier-4 (live class average)** wired as the fallback when tiers 1/3 are
   unavailable — `DB.avgseg`, already computed every poll.
6. ✅ **Tier-3 (most recent archived previous race)** — one cached
   `stint9_events` read (`limit=3`, not 5 as first drafted, to bound payload
   size) shared across all cars for the whole LIVE session, not per car.
7. ⏸ **Deferred, as planned**: tier-2 (previous day / earlier session, same
   event weekend) — mainly matters for the 24h qualifiers; not implemented,
   revisit if that becomes an active near-term event.
8. ✅ **Buffer retuned**: `LIVE_BUFFER_S=8, LIVE_MAXLAG_S=30` (was 120/300).
   Not yet verified against real moving data (needs an actual live session or
   `mock-replay.mjs`) — the zero-rows path doesn't exercise the prediction
   branch at all, only the isolation fix. §9's note updated to match.

**C — Lower-priority follow-ups. Deferred, as planned; neither blocks A or B.**

9. ⏸ Not implemented: `liveLoop`/`liveTick` consulting `stint9_live_status.live`
   as a second signal alongside row counts.
10. **Partially done**: `markStale()` extraction (step 1) and
    `LIVE_STALE_S=120`/`LIVE_STOPPED_S=180` are now named constants next to
    `LIVE_BUFFER_S`/`LIVE_MAXLAG_S`/`LIVE_POLL_MS`. The wider sweep (the
    `liveTick` garbage-value caps, `LIVE_RUNNING_WINDOW_S`'s separate
    location) was **not** done — left as-is to keep this change's blast
    radius bounded to what's actually load-bearing for the fix.

**Update — `mock-replay.mjs` run, 2026-08-02.** The "open before next live
session" item above is now done: ran `live/mock-replay.mjs` twice (a real
past CSV replayed into `stint9_live_timing` at speed — the script uses the
same public publishable key already embedded client-side, `anon` already has
full insert/update/delete on that table, no service-role secret actually
needed despite §7's dry-run note assuming one). Confirmed tiers 1/3/4's
predicted motion for real: cars glide smoothly between real crossings,
`DELAY` correctly lit for a car mid-pit-stop, standings/lap chart/racenotes
all populated live, zero console errors.

**Found one more real gap this way** — the kind that only shows up with
actual moving data, not the zero-rows case: `carXY(st,T)`, a **second,
separate** position lookup used only by `renderMini()` (the "Zoom view"
circular minimap), still only knew the old activeLeg/pit cases — never the
new sector prediction. The moment the selected car entered its first
predicted sector, `carXY` returned `null`, and `renderMini()` reads "can't
place the selected car" as "hide the whole minimap" — so the zoom view sat
blank the entire time real cars were correctly moving on the main map right
next to it. Root cause was having the prediction logic in two places at all;
fixed by extracting it into one `liveCarXY(st,T)` (defined next to
`liveRefDuration`, above `render()`) that both `render()`'s main loop and
`carXY()` now call — a second hand-written copy can't drift out of sync
again because there's only one copy. Re-verified after the fix: zoom view
mirrors the main map through a full replayed race (P1–P3 labels, gap deltas,
all 6 cars placed), and the zero-rows isolation regression test still passes
unaffected. One unrelated `409` console error was observed once during the
2nd (60×) replay, from the existing racenote-upsert POST
(`index.html:3438`, pre-existing code, not touched by this work) — plausible
under the artificially rapid concurrent note-posting a 60× replay produces,
not reproduced on the 1st (120×) run; noted here rather than chased further,
since it's outside this audit's scope. Test rows written during both runs
(`stint9_live_timing`, `stint9_racenotes`, `stint9_laptimes`,
`stint9_weather`, all `event_date=2026-08-02`) were deleted afterward.

No changes made anywhere in §15 touch `live/vds-relay.mjs`, `live/wige-scrape/`,
or `live/build-db.js` — the single-socket HOLD-mode ingestion and raw Supabase
storage are untouched; everything here is client-side render logic in
`index.html` reading from Supabase, per the architecture confirmed correct in
§15.4a point 1.

---

# 16. SIM race picker — choose an archived event from a popup (2026-08-02)

Previously the only way to replay a specific archived event (`public.stint9_events`
— see §"event archive" references throughout, and `admin.html`'s "Race events
archive" card) in SIM was the baked-in dataset by default, or hand-editing
`?event=<slug>` into the URL. Added a small popup (`#simEventModal`,
`initSimEventPicker()` in `index.html`) reachable via a **Select race** button
inside `#simControls` — visible only in SIM (that div is hidden while LIVE is
active), and **button-triggered only, never auto-opens** (the page already
auto-shows the login/demo modal on load; a second auto-popup would stack on
top of it).

- Two dropdowns, **Year** then **Race**, populated from one
  `stint9_events?select=slug,event_date,label,name` fetch (same fields
  `admin.html` already reads) — today that's 2026 → NLS6 / NLS7, more as
  events get archived. An empty-state message covers the case of no archived
  events yet.
- **SIMULATE** just navigates to `index.html?event=<slug>` — the exact same
  URL `admin.html`'s own "open in SIM" links already use, reusing
  `initArchiveEvent()` (the existing, already-tested archive loader)
  unchanged. No second rendering path was added; the popup is purely a UI
  layer in front of a mechanism that already worked.
- Verified in-browser: button opens the modal, Year shows `["2026"]`, Race
  shows both `NLS7 — 6h ADAC Ruhr-Pokal-Rennen` and
  `NLS6 — 1. ADAC Eifel-Trophy`; picking NLS6 and clicking SIMULATE navigates
  to `?event=NLS6` and loads it correctly (`#evdate` = "2026-06-20 · 1. ADAC
  Eifel-Trophy", 6 cars rendered); NLS7 verified separately (`#evdate` =
  "2026-08-01 · 6h ADAC Ruhr-Pokal-Rennen", 7 cars). Zero console errors in
  both cases.

---

# 17. PWA — installable app, offline shell, wake lock (2026-08-04)

The dashboard stays a plain static site on Cloudflare Pages. Three additions
make it behave like an installed app on a phone or tablet at the pit wall,
with **no build step, no framework and no change to how it is deployed** —
`git push` to `main` still ships it.

Backup taken before this work: `backup-2026-08-04/` (8 pages, verified
byte-identical before committing).

## 17.1 What was added

| File | Purpose |
|---|---|
| `manifest.json` | Makes the site installable. `display: standalone`, `scope: /`, `start_url: /`. |
| `icons/` | `icon-192.png`, `icon-512.png` (both `any maskable`), `apple-touch-icon.png` (180), `favicon-32.png`. Red "S9" on `#16202b`. |
| `sw.js` | Service worker: offline shell, network-first. |
| `index.html` (head) | `<link rel=manifest>`, `theme-color`, apple-touch-icon, `apple-mobile-web-app-*` meta. |
| `index.html` (foot) | Two small IIFEs: the wake lock, and the service-worker registration + `?nosw=1` escape hatch. |
| `tools/sw-selftest.mjs` | Re-runnable end-to-end test of everything below. |

Only `index.html` carries the tags. Because `scope` is `/`, navigating from
the installed app to `service.html`, `tyre.html`, `driver.html` etc. stays
inside the app window.

## 17.2 Screen wake lock

`navigator.wakeLock.request('screen')` — the tablet stops dimming and sleeping
while the dashboard is open. Three details that are easy to get wrong:

- The browser **always** releases the lock when the tab is hidden. Without a
  `visibilitychange` re-acquire it works once and then silently stops for the
  rest of the session. That re-acquire is the whole trick.
- Some browsers only grant it after a user gesture, so a `click` listener
  re-tries as well.
- It is feature-detected and fully `.catch()`ed. Battery saver refusing the
  lock is a normal outcome, not an error worth surfacing.

It only holds while the tab is visible and in the foreground — it cannot drain
the battery in someone's pocket.

## 17.3 The service worker contract — why this is safe on race day

The one real danger of a service worker on a live dashboard is serving a stale
copy of something. **Two rules in `sw.js` make that unreachable:**

1. **Cross-origin requests are never intercepted.** The `fetch` handler
   returns early unless `url.origin === self.location.origin`. Supabase,
   Leaflet and the Google fonts never touch the worker, so live timing data
   can *never* come out of a cache. This is the load-bearing line — if
   anything in `sw.js` is ever edited, this is the property to re-verify.
2. **Same-origin requests are network-first.** While there is a network, the
   response is always the freshly deployed file. The cache is only ever a
   fallback for when the network fails or hangs. A stale `index.html` on the
   pit wall is therefore not a state the worker can produce.

3. **Images are left to the browser too** — added 2026-08-04 to fix a real
   regression, not as an optimisation. `renderGauge()` rebuilds its SVG (which
   contains `<image href="topview.png">`) on a `requestAnimationFrame` loop, so
   the image element is destroyed and recreated *every frame*. The browser
   normally repaints those repeats straight from its in-memory cache; routing
   them through a worker made every frame an async round trip and the car
   visibly blinked. **Any** interception causes this — cache-first would have
   too. So the fetch handler returns early for `req.destination === 'image'`
   and for image file extensions. The cost is that images are not available
   offline; the shell still is.

On top of that:

- **Navigation timeout, 4s** (`NAV_TIMEOUT`). A connection that hangs rather
  than fails — the normal Eifel failure mode — would otherwise leave a blank
  screen for 30s. Instead the cached shell is shown, and it then fetches its
  own live data as usual.
- **`admin.html` is never cached** (`NEVER` list): team-gated, and not
  something to leave on a shared tablet.
- **Only complete same-origin 200s are stored** (`res.status === 200 &&
  res.type === 'basic'`) — no redirects, no partials, no opaque responses.
- **Install cannot get stuck.** Precaching uses `Promise.allSettled`, not
  `cache.addAll`; one missing file would otherwise fail the whole install and
  leave the worker permanently "installing".

## 17.4 Deploying a change

Nothing special: `git push` to `main`, Pages rebuilds. Because of rule 2 the
next load online already gets the new file — **you do not need to bump
anything for normal deploys.**

Bump `VERSION` in `sw.js` (`'v1'` → `'v2'`) only when you want to *drop every
cached copy*, e.g. after changing what gets precached, or if you ever suspect
the cache. On activation the worker deletes every `stint9-*` cache that is not
the current one.

The worker itself updates on its own: browsers re-check `sw.js` on navigation,
and `skipWaiting()` + `clients.claim()` mean a new one takes over promptly
instead of waiting for every tab to close.

## 17.5 The escape hatch — `?nosw=1`

Open **any** page with `?nosw=1` (e.g. `https://…/index.html?nosw=1`) and the
page unregisters every service worker and deletes every cache, then behaves as
a plain website again. Use it first if anything looks wrong at the track;
diagnose afterwards.

**It reloads the page once, on purpose.** A worker that still controls the
page can re-create a cache *while* the page is deleting it — this was a real
bug caught by the self-test, not a theoretical one. After `unregister()` the
worker stops controlling on the next navigation, so the reload lands with
`navigator.serviceWorker.controller === null`, where the wipe sticks. A
`sessionStorage` flag (`nosw-retry`) guarantees it reloads at most once.

## 17.6 Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "I don't get an Add to Home Screen option" | iOS only offers it from **Safari** (not Chrome), via Share → Add to Home Screen. Android needs the manifest to load over HTTPS. | Check `/manifest.json` returns 200 `application/json` and `/icons/icon-192.png` returns 200. |
| Site shows an old version after a deploy | Almost certainly **not** the worker — it is network-first. Suspect the Cloudflare edge cache or the browser HTTP cache first. | Hard-reload. If it persists, confirm with `?nosw=1`: if the old version *still* shows, the worker was never the cause. |
| Screen still dims | Battery saver / low-power mode refuses wake locks, or the browser has no `wakeLock` support. | Nothing to fix in code; disable low-power mode. |
| Timing data looks frozen or stale | The worker cannot cause this — it never touches Supabase (rule 1). | Go to §9 (LIVE troubleshooting) and `admin.html` → "LIVE data stream". |
| Page loads but is oddly slow to appear offline | Working as designed: it waits up to 4s for the network before falling back. | Lower `NAV_TIMEOUT` in `sw.js` if that feels long. |
| Car image blinks / flickers every frame | A service worker intercepting images — see rule 3. Should not recur; `tools/sw-selftest.mjs` guards it. | Confirm with `?nosw=1`: if the blink stops, an image is being intercepted again. |
| Something is wrong and there is no time | — | `?nosw=1`. |
| Worker seems stuck on an old version | Rare; `skipWaiting()` normally prevents it. | Bump `VERSION`, redeploy, then `?nosw=1` once. |

Browser support: iOS 16.4+ for both wake lock and installed-PWA behaviour;
Chrome/Edge/Android throughout. Anything older silently gets today's plain
website — every feature is behind a capability check.

## 17.7 Re-running the self-test

`tools/sw-selftest.mjs` drives real headless Chrome over the DevTools Protocol
and asserts all ten guarantees above. No npm dependencies (node ≥ 22 has a
global `WebSocket`). **Run it after any edit to `sw.js`.** From the repo root:

```sh
python3 -m http.server 8791 --bind 127.0.0.1 &                       # the site
mkdir -p /tmp/sw-other && echo '{"ok":1}' > /tmp/sw-other/ping.json
python3 -m http.server 8792 --bind 127.0.0.1 --directory /tmp/sw-other &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/sw-chrome --no-first-run about:blank &
node tools/sw-selftest.mjs
```

Port **8792 is a second origin standing in for Supabase** — that is how the
"cross-origin is never intercepted" rule is proven without needing the real
backend or an internet connection. The test also rewrites a probe file on disk
mid-run to prove a redeploy beats the cache while online, and uses CDP network
emulation to prove the shell still renders offline.

Result on the shipping commit: **10/10 passed.**

## 17.8 Deliberately not done yet

- **Web Push for race-control messages.** The obvious next step — the
  messages are already in Supabase on a cron (§11). Worth noting that on iOS,
  Web Push *only* works for a site installed to the home screen, which is the
  strongest reason the manifest above exists.
- **Caching the CDN assets** (Leaflet, Google Fonts). Cross-origin, so
  currently untouched by rule 1; offline they fall back to system fonts and
  the map tiles are absent. Cacheable later, but only by deliberately relaxing
  rule 1 for two known hosts — do it carefully or not at all.
- **Manifest tags on the sub-pages.** Not needed while `scope: /` keeps them
  inside the app window; only matters if a sub-page should be separately
  installable.

---

# 18. Race notes — S1 overtakes, pit laps, archive parity (2026-08-04)

**Symptom.** Replaying **NLS7** (2026-08-01, the 6h) in SIM, the RACE NOTES panel
filled with overtakes that never happened, nearly all of them in **S1**, and the
**PIT IN / PIT OUT black bars were missing**. Replaying **NLS6** (2026-06-20) the
same panel is clean. Same code, same panel, opposite behaviour.

## 18.1 What was actually wrong

**There was never an S1 exclusion in the code.** `rnDetect`'s overtake loop had no
S1 guard; the only S1 filter in `index.html` was `rnClipNotes()`, and that guards
the **VIDEO reel** only. NLS6 looked clean by accident:

| | NLS6 | NLS7 |
|---|---|---|
| bundle | pre-built `db` (from `data.js` / VLN CSV) | raw `stint9_live_timing` rows → `buildLiveDB` |
| `inpit` on the rows | flag present → 285 stops in `DB.pits` | **false on all 4251 rows** → `DB.pits` empty |
| in-lap S5 split | **absent on 285 of 285 stops** | **present on 515 of 518 stops** |
| S1 overtake notes, #950/#665 | 1 of 8 | **145 of 180** |

The pit box and the pit exit both sit **inside S1** (§3, and commit `f433ed4`), so
an out-lap S1 runs ~200s against a ~76s green one. In NLS6 the in-lap carries no S5
split, so boundary `L*5` is missing and the out-lap S1 pair
(`bx[idx-1]`/`bx[idx]`) hits the existing `a==null||b==null` guard — the crossing is
skipped **by accident**. The WIGE-derived rows do carry an in-lap S5, so nothing
skipped it there, and a 200s stop flips the gap sign against every car in the class
at once. That is the whole "false overtakes" effect: 573 of the 758 racenotes
persisted for 2026-08-01 are S1 overtakes (hence `NLS7_notes.json` at 156K against
NLS6's 4K).

With `DB.pits` empty there was also no PIT note to replace them, and `withPitS5` /
`secRef` / `pitInfo` / the Code-60 pit skip all silently switched off.

> ⚠️ This contradicts §9's open item 3 and §10.2's "WIGE never sends S5": the
> archived 2026-08-01 rows have a non-null `s5` on **3962 of 4251** rows. Whether
> that is `S5TIME` arriving after all, or `vds-relay` vs `wige-scrape` writing
> different shapes, is still unconfirmed — but the dashboard must not assume the
> in-lap S5 is missing.

## 18.2 The fix (all in `index.html`, source-independent)

1. **`pitLapsOf(st)`** — one pit-lap source of truth: the union of `DB.pits[st]`
   *and* laps derived from the out-lap's own S1 (any S1 leg longer than **1.5× and
   +40s over** that car's median S1 marks the previous lap as the in-lap). Checked
   against the NLS6 CSV flag as ground truth: **265 of 285** real stops recovered,
   18 false positives. `pitInfo`, `secRef`, `withPitS5`, the Code-60 pit skip and
   the racenote PIT IN/OUT notes all read it. Cached per DB build (cleared at the
   top of `buildClass`) because `pitInfo` runs per car per frame.
2. **`rnDetect` never reports an S1 overtake** (`if(k===1)continue;`). Deliberate
   and unconditional, so SIM and LIVE agree whatever the feed publishes; the stop
   is reported by the PIT bars instead. Genuine S1 passes are given up knowingly —
   on NLS6 that costs exactly one note across #665 and #650, and it was a false one.
3. **`window.prepLiveRaw(rows)`** — the LIVE raw clean-up (garage nulling, 900s/3600s
   caps, S5 backfill) lifted out of `liveTick` and now **also run by the archived-event
   loader**. It used to hand `bundle.timing` to `buildLiveDB` untouched, so replaying a
   live-derived event in SIM skipped clean-up LIVE had applied — a 2026-08-01 replay
   showed a **20442s "sector"** on #665. Same rows in, same numbers out, both modes.

## 18.3 Verified

Offline replay of the committed bundles through the patched functions lifted
straight out of `index.html`, plus a real headless-Chrome replay of
`index.html?event=…&overlay=1` driven to `DB.tmax`:

| | before | after |
|---|---|---|
| NLS7 #950 notes | 180 (145 in S1) | **52, zero in S1**, 8 PIT bars (`+161.7s`, `+182.3s`, `+164.8s`, `+107.6s`) |
| NLS7 #953 | 106 (82 in S1) | 24, zero in S1 |
| NLS6 #665 | 8 (1 in S1) | 7, zero in S1, 8 PIT bars — unchanged otherwise |
| NLS7 pit laps found | 0 | 585 (`#950` → laps 6, 15, 23, 31) |

## 18.4 Still open

- ~~**`stint9_racenotes` for 2026-08-01 still holds the 573 stale S1 rows.**~~
  **DONE 2026-08-04.** Deleted (`kind='overtake' and sector=1`): 573 rows, 758 →
  185. The 6 `fastest` S1 rows are legitimate and were kept, and this event had
  no `manual` rows.

  The stale notes were baked into the archived bundle too, so they were stripped
  from `stint9_events.bundle->'overlay'->'racenotes'` with a targeted `jsonb_agg`
  filter **instead of** re-running `tools/archive_event.mjs --date=2026-08-01`.
  A full re-archive of an old event is *not* safe here: `stint9_tyre_state` and
  `stint9_band_state` carry no `event_date` (see the header of
  `archive_event.mjs`), so re-archiving would have stamped **today's** global
  tyre/band state into the NLS7 bundle. Only `--sync-files` was run afterwards,
  to rewrite `events/*.json` from the table. Bundle and table now agree at 185
  notes / 0 S1 overtakes, and `NLS7_notes.json` is down from 156K to 76K.
- **NLS7's archived timing spans 9.8h of time-of-day** (23887 → 59297) — qualifying
  and race merged into one `event_date`. See §9 lesson 4; the `event_id` split
  landed after that archive was taken. Gaps in that replay are affected regardless
  of this fix.
- **The crew-facing pit counts still read `DB.pits` directly** (fuel reel stint
  maths, `PIT n` labels on the chart, the agent's stop answers). They stay on the
  feed flag on purpose — a heuristic with ~6% false positives must not move fuel
  numbers. They therefore still show zero stops on a live-derived event until
  `inpit` works at the source (§9 open item 1).

---

# 19. SIM autoplay + ALL CLASSES (2026-08-04)

Two small SIM/UI changes.

## 19.1 SIM opens on the latest race day and plays at 10×

SIM has **no start button on mobile**, and doesn't need one — playback already
auto-starts on `load` (§the deferred `go()` after `T=DB.tmin`). Two gaps around
that:

- **It always replayed the baked-in dataset.** `initArchiveEvent()` returned
  early with no `?event=`. It now treats "no slug" as *auto*: one
  `stint9_events?select=slug&order=event_date.desc&limit=1` lookup, then the
  normal loader. A failed lookup (offline, empty table) simply leaves the baked
  dataset showing — i.e. exactly the old behaviour, so this cannot leave a blank
  dashboard.
- **A bundle arriving after the boot autoplay could land frozen at L0.** The
  archived-event loader now restarts the RAF loop if `playing` went false while
  the bundle was in flight.

Default speed is now **10×** (was 30×). A saved `stint9_prefs.speed` still wins —
an explicit user choice should not be overridden — so a browser that has already
picked 30× keeps it until changed once.

## 19.2 ALL CLASSES

The class dropdown gets an **`ALL CLASSES (n)`** entry, first in the list, on
every platform (the mobile picker mirrors `#classsel`'s markup, so it inherits it
for free).

**It is deliberately NOT written into `DB.classes`.** That object is walked
elsewhere to answer "which class is car X in?" (`classOf`, the agent's car
lookup) and to build a car→class map in `buildStartGrid` — a synthetic entry
holding every car would have made `carClass` label *every* car "ALL CLASSES".
Instead it exists only as a value `buildClass()` understands:

| | ALL CLASSES |
|---|---|
| `DB.cars` | union of every class, de-duplicated (`allClassCars`) |
| `DB.maxN` | max of the per-class `classMaxN` |
| `DB.avgseg` | mean of the per-class `classAvg` (sector reference for the field) |

`ALL_CLS` is declared with `var`, not `const`, because `buildClass()` is defined
above it and a `const` would sit in the temporal dead zone — which `typeof` does
**not** shield against — if anything ever called `buildClass` before that line.

Verified in headless Chrome with localStorage cleared: `ALL CLASSES (132)` first
of 26 options; selecting it gives `cars=132, maxN=41, avgseg=[0,83,77,142,237,0]`
with zero console errors; the `carClass` map stays clean (**0 of 132** polluted);
speed `10`; `playing=true` from `tmin`; `window.archiveSlug` resolved to
`EVT-2026-08-02`, the newest archived event.

---

# 20. Scrubbing back in SIM — panels that ignored the clock (2026-08-04)

Almost everything on the dashboard re-derives itself from `T` every render, so
dragging the scrubber back just works. Two panels didn't: both kept a **forward-only
accumulator** that nothing rewound, so they went on showing a part of the race that,
at the displayed clock, hadn't happened yet — and a third, the VIDEO reel's count, fell
out of the sweep that went looking for more of them (§20.4).

## 20.1 Race notes

**Symptom.** In SIM, drag the scrubber back and press play: the RACE NOTES feed
still shows every note from *later* in the race — passes, pit stops and fastest
laps that, at the displayed clock, have not happened yet. Everything else on the
dashboard (standings, map, summary line) had already re-derived itself from `T`.

**Cause.** `rnNotes` was an append-only log of everything the detector had ever
emitted, and `rnRenderFeed()` painted all of it. `rnDetect(T)` only ever *adds*
notes at or before `T`, so playing forward looked right — but nothing removed a
note when the clock moved back behind it. The single reset (`T <= DB.tmin+0.5`,
"replay is back at the start") only covered scrubbing all the way home.

**The fix** (`index.html`, racenote section):

- `rnT` holds the clock the feed is painted against; `updateRacenote(T)` sets it
  every frame.
- `rnVisible(n)` = `n.tod == null || n.tod <= rnT`. `rnRenderFeed()` filters
  through it, so the feed is a **view of `rnNotes` at `T`**, not a transcript.
- Detected notes are *hidden*, never dropped. `rnSeen` therefore stays intact, so
  scrubbing back and playing forward re-reveals the identical notes instead of
  re-running detection (and, in LIVE, re-POSTing them).
- `rnFeedN` records how many were visible at the last paint. `updateRacenote`
  repaints when the detector is dirty **or** that count changed — which is what
  makes a note appear at the moment the clock crosses it and disappear when it
  scrubs back past it. Notes carry no tod-less rows today; the `tod == null`
  branch just means a note that cannot be placed on the clock is always shown.

LIVE is unaffected in practice: `T` is the live clock, so every stored note is
already behind it.

**Verified** in headless Chrome against the archived **NLS7** bundle
(`?event=NLS7`, car #5, playback paused, scrubber driven directly):

| | notes shown | notes dated after the clock |
|---|---|---|
| scrub to 14:12:21 | 27 | 0 |
| scrub back to 11:38:27 (**before**) | 27 | **12** |
| scrub back to 11:38:27 (**after**) | 15 | 0 |
| scrub forward to 14:12:21 again | 27 | 0 |

## 20.2 The SNAP reel

**Symptom.** Same drag, same shape of bug: the SNAP table kept every lap column it
had ever drawn — 23 lap columns at a clock where the field was on lap 6.

**Cause.** SNAP is the *frozen* twin of GRID (§ the reel is deliberately not
recomputed: a cell keeps the colour it had the moment that sector was set). That
freeze lives in `gridFreeze.done[car][lap]`, which by design is only ever written
forward — and `lapsSoFar` is derived from it, not from `T`. Nothing dropped a cell
when the clock moved back behind it. GRID isn't affected: it recomputes from `T`
every render by construction.

**The fix.** `gridFreeze` now carries the clock `T` it was built up to.
`renderSectGridFrozen(T)` calls `resetGridFreeze()` when `T` moves backwards and
re-freezes from the start. That is safe because freezing is deterministic — the
events are replayed in boundary order through the running bests — so a rebuilt state
is identical to the incremental one. Forward play is untouched and stays incremental
(only the sectors that crossed since the last call are processed); the rebuild costs
one extra pass over cars × laps, and only on a backward scrub.

**Verified** the same way (`?event=NLS7`, SNAP reel, paused, scrubber driven):

| | lap columns | selected car's filled cells |
|---|---|---|
| scrub to 13:33:52 | 23 | 23 |
| scrub back to 10:59:59 (**before**) | **23** | **23** |
| scrub back to 10:59:59 (**after**) | 6 | 6 |
| scrub forward to 13:33:52 again | 23 | 23, **cell-for-cell identical colours** |

## 20.3 The VIDEO reel count (and what ANALYSE would cut)

Found by the sweep below, not by eye: the reel header read **"12 overtakes ready"** at
a clock where only 7 had happened. `rnClipNotes()` — the single definition of "an
on-track overtake the reel can clip", and deliberately the same list ANALYSE cuts from
— filtered `rnNotes` by kind and sector but not by the clock, so it counted (and would
have cut video for) passes still in the future. It now also filters on `rnVisible`, so
the header, the feed and ANALYSE all agree at any scrubber position.

## 20.4 How the rest was checked — `tools/rewind-audit.mjs`

Rather than reason panel-by-panel about which renderer keeps state, the audit is
mechanical and rerunnable: render **one clock two ways** — straight to `T`, versus out
to a late clock and back — and diff the DOM of every panel. Anything that differs is
carrying state a rewind doesn't undo. A second pass flags panels that render
*identically at an early and a late clock*, which catches the opposite flavour ("shows
the whole race regardless of `T`"). Run it exactly like the PWA self-test (§17.7),
CDP-driven headless Chrome, no npm deps:

```
python3 -m http.server 8791 --bind 127.0.0.1 &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
   --headless=new --remote-debugging-port=9222 \
   --user-data-dir=/tmp/rw-chrome --no-first-run about:blank &
node tools/rewind-audit.mjs
```

With the three fixes reverted it fails on exactly `rn-feed`, `snaptablewrap` and
`vr-count`; with them in place **all 35 panels match**. What it cleared:

- **GRID, DRV, TIMES, POS, FLOW, SECT, PACE, STINT, COMP, DIFF, BARS**, the map, the
  standings, the gap chart, the mini-map and the whole mobile view — all rebuild from
  `T` every render.
- **The FUEL log** already *removes* a lap's row when its condition stops holding at
  `T` (`fuelS5Set` / `fuelPitSet` map lap → row for exactly that reason).
- **The race-control board** gates on `msgTod(created_at) <= T` in SIM, so messages
  hide again on a rewind.
- **The TYRE and SERVICE iframes** only accumulate km when `LIVE_MODE` — the SIM guard
  that stopped scrub-back from re-seeding wear.
- **`_loggedLaps`** (lap-time logging) is LIVE-only, and LIVE never rewinds.

Two known non-findings, both deliberate:

- **STINT driver colours.** `stintDrvColor` hands out a palette colour the first time a
  driver is drawn, so *which* colour a driver gets depends on how far the replay has
  run. A colour is never reassigned, so nothing changes on screen mid-session — the
  audit normalizes STINT's fills and still compares its geometry and labels.
- **`#gridclock`** counts down to the next race weekend off the wall clock, so it is
  meant to differ between two runs; the audit ignores it.

## 20.5 Two errors the same run surfaced

Console/network errors found while auditing, both silent to the user and both fixed:

- **`<path> attribute d: Expected moveto path command`** (twice, on any clock with one
  lap of data). `smoothPath()` returned `''` for a single point, and two callers close
  the curve into an area fill by appending `" L…,base L…,base Z"` — so the path began
  with an `L`, the browser rejected it and dropped the element. `smoothPath` now emits a
  bare `M x,y` for one point; the fill degenerates to a zero-width (invisible) sliver,
  which is what the area under a one-lap trace should be. Empty input still gives `''`.
- **HTTP 409 on every `stint9_reel_usage` flush after the first.** The table's PK is
  `(id)` but its unique index is `(session_id, reel, event_date)`, and the POST asked
  for `resolution=merge-duplicates` without naming a conflict target — so PostgREST
  resolved against the PK and the unique constraint rejected the row. The `.catch()`
  swallowed it, so a session's `seconds` silently froze at its first 15s tick. The URL
  now carries `?on_conflict=session_id,reel,event_date` (the same shape the racenote
  upsert already used). Verified against the real table: one headless session merged
  15 → 30 → 45 s on a single row, no 409s.

The remaining `ERR_ABORTED` lines in a headless run — Carto basemap tiles and the
`keepalive` analytics beacons — are teardown artifacts of closing the browser
mid-flight, not defects.

---

# 21. PIT — stopped time against the regulation minimum

`pit.html`, the 4th panel of the right reel (`wxReelIdx===3`, between TIMETABLE and
CHAMPIONSHIP). Same iframe idiom as `service.html`: a fixed logical **1340×700**
scaled with `transform` by `initPitFrame()`, four horizontal pages driven by
Left/Right, with Up/Down forwarded back to the parent as `{type:'reelV'}`.

| page | answers |
|---|---|
| **STOPS** | what each stop cost against its minimum, and what that cost in position |
| **TARGET** | how much longer may this car stand here — live countdown + release time |
| **LAST HOUR** | the last-stop minimum, keyed on race time remaining |
| **MARGINS** | every car ranked by margin; tightest execution and furthest under |

## 21.1 The regulation tables

Minimum standing time, hardcoded in `index.html` as `PIT_A` / `PIT_B` / `PIT_C`:

- **A** — first stop, by laps completed in the stint: `64 82 101 119 138 156 175 193 212 230`
- **B** — from the second stop on: `A − 8` throughout
- **C** — the last stop, by whole minutes of race time remaining **rounded up** at pit
  entry, 1 min → 28 s up to 59 min → 158 s

Which table applies is decided by *time remaining*, not by "is this the last stop":
`remaining ≤ 59 min → C`, else first stop → A, else B. That is the only formulation
that works mid-race, where you cannot know a stop is the last one. Stints over 10 laps
clamp to the 10-lap value.

**There is deliberately no configurable target.** The benchmark is the sum of the
per-stop minimums, which already scales with laps driven and time remaining, so it is
the true floor for the race being run rather than a round number someone maintains.

Worked reference — NLS 6, car 665, and the regression test for any change here:

| # | in-lap | laps | stopped | minimum | margin |
|---|---|---|---|---|---|
| 1 | 5 | 5 | 2:24.173 | 138 (A₅) | +6.173 |
| 2 | 8 | 3 | 2:19.564 | 93 (B₃) | +46.564 |
| 3 | 15 | 7 | 3:05.636 | 167 (B₇) | +18.636 |
| 4 | 21 | 6 | 1:00.020 | 50 (C₁₁) | +10.020 |

8:49.393 against a 7:28.000 floor → **+81.393 s given away**, which cost 2 places:
class P3 where P1 was available, overall P48 against P43.

## 21.2 Where the stop clock can start

The timing never publishes pit entry, and the obvious anchors are both wrong:

- **The S5 beacon is never crossed on an in-lap.** Pit entry sits at the end of S5, so
  a car peeling in drives S5 but never trips it — 0 of 273 stops carry that split.
- **The out-lap S1 beacon fires far too late.** The box *and* the pit exit are both
  inside S1 (out-lap S1 median 234.8 s against 74.6 s normal), so by then the car has
  already gone.

The usable anchor is the **start/finish crossing that closes the in-lap** —
`legs[lap+1][s1][2]`. Measured over 262 stops carrying a real `PITIN_TIME`, the pit
entry line sits a median **8.42 s before** it (p25 −8.93, p75 −8.11), which is
`PIT_LANE_IN`. The clock therefore back-dates by that constant and shows the correct
remaining time from its first tick.

A by-product worth knowing: **"the in-lap published no S5 split" is a perfect pit
detector** — 273 true positives, 0 false positives, 0 false negatives over 2113 laps,
against `pitLapsOf()`'s out-lap-S1 heuristic at 265/285 with 18 false positives. It
also fires at S/F rather than after pit exit.

## 21.3 Error budget when there is no real pit-in time

| | median | p90 | p95 | max |
|---|---|---|---|---|
| anchor, raw | 0.36 s | 1.23 s | 1.72 s | **73.7 s** |
| anchor, after the guard | 0.34 s | — | 1.22 s | **1.92 s** |

The bad cases are cars crawling or queuing in the lane, and they self-identify: a stop
whose `S/F − S4end` hole runs more than `PIT_HOLE_GUARD` (12 s) over the car's own
green S5 catches **8 of 8** with >5 s error, over-flagging 45 of 259 — the safe
direction. Anchoring late only costs time; anchoring early is a penalty, and the worst
early-release case on the clean set is 1.92 s, hence `PIT_SAFETY = 2`.

**Stopped durations are a different story.** Estimated from the S5 hole plus out-lap S1
excess they run median 1.8 s but **p95 15.4 s** — enough to move the headline by
10-20 s across four stops. So in LIVE the durations are marked estimated and the
position what-if is suppressed rather than shown on sand.

## 21.4 Race end, and why not `DB.tmax`

`DB.tmax` runs ~22 minutes past the flag because cars keep circulating (NLS 6: tmax
16:21:59 against a 16:00 finish). Using it puts the last stop at 32.7 min remaining →
C₃₃ = 99 s instead of C₁₁ = 50 s, destroying the reference figure. `raceEndTod()`
resolves in order:

1. `window.PIT_RACE_END_OVERRIDE` (manual escape hatch)
2. `window.RACEWIN` — the loaded event's own race row, fetched by `loadRaceWindow()`
3. `SCHEDULE`'s `race` row, **only when `SCHEDULE.eventDate` matches `DB.event.date`**
4. derived — `floor(DB.tmin/900)*900 + 4h` (57600 for NLS 6, exactly right)

`loadSchedule()` only ever fetches `event_date >= today`, because the timetable and
grid countdown want the *next* round — so a SIM replay of a past event finds nothing
there. Widening that query is not the fix: its clustering anchors on `rows[0]` and
would latch onto the old round. `loadRaceWindow(date)` fetches that one event's race
row separately instead, and step 3's date guard stops the upcoming round's finish time
being applied to a replay of a different race.

## 21.5 FIELD, and why it only compares within a class

Two things the field data forced:

- **Minimum standing times are class-specific.** Median per-stop margin in this event
  runs from about **−2 s in CUP3 to +64 s in BMW 325i**, and **17 cars** come out below
  the minimum, which the rules do not allow. That is our table not applying to them,
  not a grid full of penalties. So the callouts are computed inside the selected car's
  own class and every other class is listed but muted.
- **A car behind the wall is not making a pit stop.** `#112` showed 143 minutes
  "stopped" and a +8499 s margin. Durations separate cleanly (p95 344 s, then
  545 → 735 → 941 → 8581), so `PIT_REPAIR_S = 600` splits repairs out of the margin and
  surfaces them as a `+N rep` badge. Top margin falls to +635 s.

Cars whose stops are estimated rather than measured are excluded from the callouts too
and marked in the list. The field table is built only while PIT is the visible panel
and at most once a second, and is dropped in `buildClass` alongside `_pitLapCache`.

## 21.6 `DB.pitinfo` mode isolation

`DB.pitinfo` was missing from `RAW_FIELDS`, from `clearLiveDB()` and from the archive
apply list, and `live/build-db.js` never emitted it. Harmless while nothing read it —
but the moment PIT did, switching to LIVE or replaying NLS 7 would have shown NLS 6's
stops against whatever car was selected. All four are fixed; `build-db.js` emits an
empty `pitinfo` because the WIGE socket carries no pit times at all (§9 open question).

## 21.7 Still open

- LIVE has no pit times, so STOPS degrades to marked estimates and the countdown to
  `~est`. The `stint9_live_frames` query settles whether WIGE carries them.
- The `ceil` on remaining minutes and the 8.42 s `PIT_LANE_IN` are reverse-engineered
  from data, not read from a rulebook. Both are single named constants.
- The A/B/C tables are one class's. A per-class table would make FIELD a real
  comparison instead of a same-class one.

---

# 22. CHAMPIONSHIP from the result PDFs, not by hand (2026-08-05)

**Why it was stale.** The standings lived in `NLS_CHAMP` in `index.html` — a
hand-entered object keyed by class and round index. NLS7 ran on 1 Aug and the
table still showed it as an upcoming round three days later, because nothing but
a manual edit ever changed it. Two things were actually broken:

1. **The scraper never ingested NLS7.** `nls-driver-scrape`'s race pass re-parsed
   *every* past round on *every* run (r.pdf + rl.pdf, ~1 MB each). With four
   rounds raced that exceeded the edge worker's CPU budget: the run wrote NLS2,
   NLS3, NLS6 and died before the newest round — the only one anyone was waiting
   for. It is now **incremental** (skips a round that already has
   `has_results` + `driver_rows > 0`, `?force=1` to re-parse) and walks
   **newest-first**, so a budget cut-off costs the oldest round instead. A full
   season now checks in a couple of seconds. The autoscan moved weekly → daily
   (`0 4 * * *`), so a Saturday race is in the standings Sunday morning.
2. **Nothing connected the scrape to the reel.** `stint9_nls_results` (per
   driver) already held finishing position, class and status. The new view
   `public.stint9_champ_rounds` collapses it to one row per (race, class) with
   the class's field in finishing order — see `nls-drivers-supabase.sql`.
   `renderChampionship()` fetches it once and uses it wherever it has a round,
   falling back to `NLS_CHAMP` otherwise.

**Why the class comes from `class_full`, truncated.** The PDF's `class` column
merges the SP9 ratings into one "SP9"; `class_full` ("SP9 PRO-AM") is the real
championship class. `left(class_full,8)` reproduces exactly what the timing CSV's
`KLASSEKURZ` does, which is where the dashboard's own keys come from — so
`SP9 PRO-AM → SP9 PRO-`, `BMW M240i → BMW M240`, `VT2-F+4WD → VT2-F+4W` join up
with no per-class mapping table.

**Position in class = index in the array**, not the PDF's `pos_class`: a round the
parser reads as one merged class would rank `pos_class` wrong, while ordering by
overall finishing position cannot.

**Verified against the hand table.** For BMW M240 the scraped order reproduces
the hand-entered order for NLS2, NLS3 and NLS6 exactly, DNFs included — and adds
retirements NLS2 never had (the "no retirement data for NLS2" caveat is gone).
One known difference: #44 at NLS3 is `dnf` in the scrape and `DSQ` by hand — the
PDF's `*DSQ` marker didn't fall inside that car's block. Points are 0 either way;
only the label differs.

**What is still hand-entered.** The 24h-Qualifier round (24hQ2): its PDF uses the
24h template, which `parseResults`' sanity gate deliberately rejects rather than
mis-parse. `NLS_CHAMP.res` stays the source for that round, and the season
skeleton (round labels/dates/cancellations) is still the static `rounds` array —
a round flips from "upcoming" to raced automatically once results exist for it.
