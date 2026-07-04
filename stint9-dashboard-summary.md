# STINT9 dash — project summary & handoff

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
- 5 NLS sectors defined in `nls-sector-layout.md`.

### Data choices / caveats
- **Per-lap driver is NOT in the data** → stints assumed sequential, split at pit stops (`INPIT='J'`). (The driver-stints table was later **removed** from the UI.)
- **Pit stops**: count is exact = laps where `INPIT='J'` (e.g. #666 = 3, laps 8/16/21) → embedded as `DB.pits`. **Pit-stop duration is NOT derivable** (`PITSTOPDURATION` is empty in the file; no pit-exit timestamp). Pit *time loss* is derivable as an inflated out-lap (`INPIT='A'` = out-lap) — not yet added to UI.
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

## Open / possible next steps
- Add per-car **pit-loss estimate** (out-lap minus green-lap baseline).
- Optional **PIT ×N** indicator for selected car on the maps.
- Multi-class support if sector data for another class (e.g. M240i) is provided → wire Race-class dropdown to filter.
- S4/S5 (Döttinger Höhe) labelling correction on the static `NLS 5 sectors.png` (deferred).
