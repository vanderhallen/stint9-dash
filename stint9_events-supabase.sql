-- ============================================================
--  STINT9 event archive — public.stint9_events + automatic archiver
--  Project: esvvzgxqnfszhttdkuzc
--
--  One row per archived NLS race event (slug NLS6, NLS7 …). Each row is a
--  point-in-time SNAPSHOT bundle of everything the dashboard needs to replay
--  the event later:
--    • the SIM timing DB (WIGE-derived) — stored as a pre-built `db` for the
--      baked backfill event, or as raw `timing[]` rows (future live events)
--      that index.html re-derives with window.buildLiveDB (same path as LIVE);
--    • the crew "overlay" layer — fuel, tyres, per-lap notes, racenotes,
--      messages, weather, laptimes.
--
--  WHY a snapshot and not live joins: stint9_tyre_state / stint9_band_state /
--  stint9_messages carry NO event_date (they are global / point-in-time), so
--  the only faithful archive is a bundle captured when the event ends.
--
--  Consumers:  index.html  ?event=<slug>[&overlay=1]   (SIM replay, optional crew overlay)
--              admin.html  "Race events archive" card   (list + open + visualise fuel/tyre/notes)
--  Backup:     events/<slug>.json + events/<slug>_notes.json + events/index.json,
--              written by `node tools/archive_event.mjs --sync-files` and committed to git.
-- ============================================================

create table if not exists public.stint9_events (
  slug        text primary key,            -- 'NLS6','NLS7' — stable id, editable
  event_date  date        not null,        -- first day of the event
  event_end   date,                        -- last day (multi-day 24h weekend), null if single-day
  label       text,                        -- round label from stint9_schedule_windows
  name        text,                        -- DB.event.name (e.g. '1. ADAC Eifel-Trophy')
  car_count   integer,
  bundle      jsonb       not null default '{}'::jsonb,  -- { meta, db?, timing?, overlay{…}, weather, laptimes, live_status }
  archived_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists stint9_events_date_idx on public.stint9_events (event_date desc);

-- Row-level security: same in-browser publishable-key soft-gate as the rest of stint9_*.
alter table public.stint9_events enable row level security;
drop policy if exists "events anon read"   on public.stint9_events;
drop policy if exists "events anon insert" on public.stint9_events;
drop policy if exists "events anon update" on public.stint9_events;
drop policy if exists "events anon delete" on public.stint9_events;
create policy "events anon read"   on public.stint9_events for select using (true);
create policy "events anon insert" on public.stint9_events for insert with check (true);
create policy "events anon update" on public.stint9_events for update using (true) with check (true);
create policy "events anon delete" on public.stint9_events for delete using (true);

-- ============================================================
--  Automatic archiver (pure SQL + pg_cron) — "automatic by date".
--  See the functions + cron job in the applied migrations: stint9_event_slug(),
--  stint9_archive_event(), stint9_maybe_archive_events(). Cron
--  `stint9_event_archive` runs hourly and snapshots any finished (last schedule
--  window ended >2h ago), timing-bearing, not-yet-archived event.
--
--  SLUG/NAME resolution (the NLS round number, e.g. NLS6, is NOT in any timing
--  or schedule field — stint9_schedule_windows only holds session labels):
--    1. public.stint9_event_rounds (date -> slug/name lookup, seeded from the
--       NLS calendar: 2026-04-18/19 = NLS4/NLS5, 2026-06-20 = NLS6,
--       2026-08-01 = NLS7). Add a row when a new round's date is known.
--    2. else an explicit "NLS n" in the schedule label/name.
--    3. else EVT-<date> (editable placeholder).
--  NOTE: the event NAME's own leading number is deliberately NOT used —
--  "1. ADAC Eifel-Trophy" is NLS6, not NLS1.
--
--  Manual one-off (also refreshes the committed events/ backup files):
--    node tools/archive_event.mjs --date=2026-08-01            (from live_timing)
--    node tools/archive_event.mjs --date=2026-06-20 --from-datajs  (baked SIM event)
--    node tools/archive_event.mjs --sync-files                 (rewrite events/*.json)
-- ============================================================
