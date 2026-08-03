-- ============================================================================
-- stint9_grid — per-event starting grid from the official NLS qualifying
-- ("Ergebnis Zeittraining") result PDF. Applied to Supabase project
-- esvvzgxqnfszhttdkuzc via MCP migration stint9_grid. Kept in-repo for
-- reference/reproducibility.
--
-- Written by the `nls-driver-scrape` edge function (live/nls-driver-scrape/),
-- which — alongside the race-result <date>r.pdf it already ingests — also
-- fetches the qualifying <date>t.pdf for each round and upserts one row per
-- car here. Read by index.html's buildStartGrid() with the anon key, keyed by
-- the loaded event's date (DB.event.date in SIM, liveEventDate() in LIVE).
--
-- Replaces the old hardcoded REAL_QUALI array (one event only, 2026-06-20).
-- Idempotent — safe to re-run.
-- ============================================================================

-- one row per (event, car): its qualifying classification = its grid slot
create table if not exists public.stint9_grid (
  event_date  date    not null,
  car_no      integer not null,
  class       text,               -- class label as printed on the quali PDF (e.g. 'SP9 PRO-AM')
  pos_overall integer,            -- Pl. — grid position across the whole field (P)
  pos_class   integer,            -- grid position within the base class (Py)
  best_lap_ms integer,            -- Bestzeit (qualifying best lap) in ms
  primary key (event_date, car_no)
);
create index if not exists stint9_grid_event_idx on public.stint9_grid (event_date);

-- RLS: public read-only; writes only via service role (which bypasses RLS),
-- same posture as stint9_nls_results.
alter table public.stint9_grid enable row level security;
drop policy if exists stint9_grid_read on public.stint9_grid;
create policy stint9_grid_read on public.stint9_grid for select to anon, authenticated using (true);

-- Grids are scraped by nls-driver-scrape in "grid mode" (POST {grid:true} — one
-- t.pdf per round). This is a SEPARATE pass from the race-results run: parsing
-- r.pdf+rl.pdf+t.pdf for every round in one invocation trips the edge worker's
-- WORKER_RESOURCE_LIMIT, so grids get their own lightweight cron (t.pdf only).
create or replace function public.stint9_run_nls_grid_scrape()
  returns void language plpgsql set search_path to 'public', 'pg_temp'
as $$
begin
  perform net.http_post(
    url := 'https://esvvzgxqnfszhttdkuzc.supabase.co/functions/v1/nls-driver-scrape',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{"grid":true}'::jsonb
  );
end;
$$;
-- Mondays 04:30 UTC, 30 min after the driver-results scan so they don't overlap.
select cron.schedule('stint9_nls_grid_autoscan', '30 4 * * 1',
  'select public.stint9_run_nls_grid_scrape();');

-- Same-day LIVE grid on a race weekend: invoke the fast path for just that date
--   POST /functions/v1/nls-driver-scrape  {"grid":true,"date":"YYYY-MM-DD"}
-- (skips the calendar scan; fetches only that event's t.pdf).
