# stint9 live-timing API — recovered contract (2026-07-13)

Extracted statically from a **logged-in Web Archive** of `stint9.com/app` (its
Next.js chunks). This replaces the WIGE-WebSocket plan: stint9 already ingests
the feed and exposes it as **clean same-origin JSON**, which is far easier for us
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
