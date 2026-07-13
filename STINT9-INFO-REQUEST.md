# LIVE feed — info to request before race day

The stint9-dash LIVE pipeline is **built and tested end-to-end** except for one
thing: the actual live-timing data source. This note lists exactly what we need
so LIVE lights up on race day with (almost) no coding.

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
`config.ts`, deploy the Edge Function, and LIVE works. See `RACEDAY.md`.
