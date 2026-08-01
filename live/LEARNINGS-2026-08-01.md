# Live-timing learnings — 2026-08-01 (NLS 6h race, WIGE event 20)

First full race run of the LIVE pipeline under load. What broke, what we learned,
and where each fix lives. Companion to [`RACEDAY.md`](../RACEDAY.md) and
[`LIVE-TROUBLESHOOTING.md`](LIVE-TROUBLESHOOTING.md).

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
already parks non-circulating cars (`LIVE_RUNNING_WINDOW_S = 360` → pit line) and
caps the frontier estimator (`LIVE_EST_CAP_S = 280`), so retired cars are parked
(near S/F, hence visually near the leaders) rather than ghost-driven forever; cars
"stuck in S4" were genuinely there when timing froze; POS "angle lines" are lines
collapsing to the frozen frontier.

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
