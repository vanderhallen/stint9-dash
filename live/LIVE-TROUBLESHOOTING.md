# LIVE feed — troubleshooting & hard-won learnings

Everything we learned wiring the WIGE live feed to the dashboard on 2026‑07‑31
(NLS7 test day). Read this first when LIVE misbehaves. Companion to `RACEDAY.md`
(the run procedure) and `LIVE-DATA-FLOW.md` (the data chain).

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
`/api/worker/*` API is documented in `stint9-api.md` only as recovered *learnings*
/ a possible fallback — nothing at runtime calls it. Keep it that way.

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

## Lesson 5 — smooth motion is SIM's logic + an estimated live sector
LIVE renders through SIM's exact loop (`activeLeg`+`ptAlong` interpolation). The
only extra piece: SIM knows each sector's end time; at the live frontier the
*current* sector isn't finished, so we estimate its length from the class average
(`DB.avgseg`) and interpolate the same way, snapping to the real position when the
crossing lands. The display clock trails the newest data by `LIVE_BUFFER_S` (10s —
must stay **> the 5s poll** or motion stutters). Bump it for smoother/laggier,
lower it for fresher/choppier.

## Quick checklist when "LIVE looks wrong"
1. Admin panel pill? STREAMING vs STALE/SILENT/OFFLINE narrows it instantly.
2. Admin STREAMING but dashboard frozen/weird → timeline corruption (Lesson 2) or
   you're on a stale browser tab (hard-refresh).
3. Headless capture dead but browser live → WIGE rate-limit (Lesson 1) → stop
   pokers, wait, or run the browser collector.
4. Numbers from a *different* session bleeding in → session-id merge (Lesson 4).
5. Never add extra WIGE pollers to "fix" it — that's what causes the block.
