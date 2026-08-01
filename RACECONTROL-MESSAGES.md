# Race-control messages + LIVE message board — 2026-08-01

How the dashboard's **MESSAGE BOARD** gets real race-control messages (penalties,
incidents, flags), and the fixes made on 2026-08-01. Companion to
[LIVE-DATA-FLOW.md](live/LIVE-DATA-FLOW.md) (which covers timing) and the schema in
[racecontrol-messages-supabase.sql](racecontrol-messages-supabase.sql).

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
| Edge function (serverless) | [live/wige-scrape/index.ts](live/wige-scrape/index.ts) | per-minute `stint9_wige_autoscan` pg_cron during session windows |
| Laptop relay (continuous) | [live/vds-relay.mjs](live/vds-relay.mjs) | `node live/vds-relay.mjs --watch` / `raceday.sh` |

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

## Front-end (index.html message board)

- Real rows are shown in **both SIM and LIVE**; `TEST_MESSAGES` are a SIM/demo
  affordance only and **never** appear in LIVE (empty LIVE shows "No race-control
  messages.").
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
