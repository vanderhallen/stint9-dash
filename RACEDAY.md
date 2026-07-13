# Race-day runbook — turning on the LIVE feed

## ⭐ Primary path (2026-07-13) — one command, no browser, no auth
```
node live/vds-relay.mjs --watch
```
Leave it running from before the session. It scans the WIGE timing backend
(`wss://livetiming.azurewebsites.net/` — the same socket vdsmotorsport.com and
wige.de use, channels [0,4]) across eventIds 1..80 every 30 s, and the moment an
event goes live it auto-detects the `eventId` and starts upserting laps into
`stint9_live_timing`. Then open the dashboard → **LIVE**. Stop with Ctrl-C.

- Narrow/uncertain id range: `--watch --range 1-120`.
- Known id (skip the scan): `node live/vds-relay.mjs <eventId>`.
- Dry test (map + log, no writes): add `--dry`. Raw snapshots are always logged
  to `live/logs/` so the first live event verifies the field shapes.
- This reads WIGE **directly** — VDS is not in the data path. If a distinct
  wige.de socket ever appears, `WIGE_WS_URL=wss://… node live/vds-relay.mjs --watch`
  tries it first.

The two older paths below (browser collector on stint9's Clerk-gated API, and the
Deno WIGE-scrape Edge Function) are kept only as fallbacks.

---

Goal: minimal coding on the day. Everything is built and tested. The data source
is stint9's own JSON API (see `live/stint9-api.md`), read by the browser
collector — the WIGE-socket path below is only a fallback.

## 🔬 Dry-run (do this BEFORE the real race — any live NLS session works)
A 5-minute test during practice/quali proves the four things not yet verified:
eventId detection, the Clerk cookie, the `todTs` format, and end-to-end render.
It moves race-day confidence from ~65% to ~90%.

1. **Probe (read-only, writes nothing).** Log in to **stint9.com/app**, open the
   live-timing view while cars are running, DevTools → Console → paste
   **`live/probe.js`**. Copy the whole console output back to me — it captures
   the `eventId` and one real lap object so I can lock down `todTs`/fields with
   no guessing. *(Skip straight to step 2 if you'd rather just try it.)*
2. **Collector.** Paste **`live/collector.js`**, let it run ~2 min. Check
   `stint9collector.status()` shows `polls` climbing and `lastErr: null`.
3. **Render.** Open the dashboard → **LIVE**. Confirm cars appear on the map and
   positions look sane. Note anything off.
4. **Clean up the test data:**
   `delete from stint9_live_timing where event_date = current_date;`
   and `stint9collector.stop()`.

If steps 1–3 work, race day is ~95%. If anything errors, send me the console
line — every likely failure is a small patch (eventId regex, todTs conversion,
a field name).

## ✅ Primary path — browser collector (recommended, ~30 seconds)
1. Open **stint9.com/app**, log in, go to the **live timing** view.
2. Open DevTools → **Console**, paste the entire contents of **`live/collector.js`**.
   It auto-detects the `eventId` (asks if it can't) and starts pushing laps to
   Supabase every 5 s. Leave the tab open.
   - stop with `stint9collector.stop()`, check with `stint9collector.status()`.
3. Open the dashboard, click **LIVE**. Done — positions/maps fill in live.

That's it. No deploy, no secret: the collector rides your Clerk cookie to read
stint9's feed and writes with the public publishable key (same as the dashboard's
other Supabase writes). The rest of this file is the WIGE fallback only.

---
## Fallback path — WIGE WebSocket scraper

## 0. Rehearse anytime (no live event)
Prove the whole chain with the 2026-06-20 CSV:
```
SUPABASE_SERVICE_KEY=<service-role key> node live/mock-replay.mjs --speed 120
```
Open the dashboard → flip **LIVE** → the maps/positions fill in and track "now".
Stop with Ctrl-C. Clean up after: `delete from stint9_live_timing where event_date = <that day>;`

## 1. Capture the WIGE socket (during a live session)
DevTools → Network → **WS** on `livetiming.wige.de`:
- copy the `wss://…` **Request URL** and request headers (Origin, any token);
- **Messages** tab → right-click → **Save all as HAR**.

## 2. Fill in the one config file — `live/wige-scrape/config.ts`
```ts
SOCKET_URL: 'wss://…',              // from the Request URL
EVENT_ID:   '…',                    // if the subscribe needs it
SUBSCRIBE:  [ /* the frame(s) sent right after connect */ ],
MOCK_MODE:  false,                  // flip off mock
```
Then adjust `mapResults` / `mapMessages` field names to match the real payload
(the HAR shows the exact keys). This is the only logic that can't be pre-written.

## 3. Deploy the Edge Function
Via the Supabase MCP (`deploy_edge_function`, project `esvvzgxqnfszhttdkuzc`,
name `wige-scrape`, files = `index.ts` + `config.ts`), or:
```
supabase functions deploy wige-scrape --project-ref esvvzgxqnfszhttdkuzc
```
Smoke-test: invoke it once and confirm it returns `{ ok:true, mode:'live', timing:N }`
and that rows land in `stint9_live_timing` for today.

## 4. Schedule it while the event runs
`pg_cron` (or an external cron) to call the function every 30–60 s during the
race window. Gate on the event actually being live to avoid idle churn.

## 5. Go LIVE
Open the dashboard, click **LIVE**. The header switches to today's date and the
status shows `LIVE · N cars · <clock>`. The message board (`stint9_messages`)
also fills from the same scraper. Done.

## Known risks (all detectable from the HAR)
- **Origin check:** WIGE may reject sockets whose `Origin` isn't its own page.
  Deno's `WebSocket` can't set `Origin`; if so, switch the connect to a raw
  `fetch` Upgrade with headers (marked TODO in `index.ts`), or use Option B.
- **Auth token:** if using stint9's own API instead, tokens from Clerk are
  short-lived — confirm refresh strategy with the owner.
- **Channel routing:** `index.ts` routes by a guessed `channel` field; correct
  it to the real field once the HAR shows it.
