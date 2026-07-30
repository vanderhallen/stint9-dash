-- ============================================================================
-- 2026 NLS driver database — schema mirror (applied to Supabase project
-- esvvzgxqnfszhttdkuzc via MCP migrations stint9_nls_driver_db +
-- stint9_nls_driver_autoscan_cron). Kept in-repo for reference/reproducibility.
--
-- Written by the `nls-driver-scrape` edge function (live/nls-driver-scrape/),
-- read by driver.html. See that function's header for the data-source details.
-- ============================================================================

-- one row per ingested race
create table if not exists public.stint9_nls_races (
  event_date    date primary key,
  round_no      text,
  title         text,
  series        text not null default 'NLS',        -- 'NLS' | '24h'
  results_url   text,
  entrylist_url text,
  has_results   boolean not null default false,
  driver_rows   integer,
  scraped_at    timestamptz
);

-- fact table: one row per driver per race
create table if not exists public.stint9_nls_results (
  id           bigint generated always as identity primary key,
  event_date   date not null,
  car_no       integer not null,
  class        text,               -- base class, e.g. SP9, CUP2, V6
  rating       text,               -- PRO | AM | PRO-AM (SP9 sub-rating) or null
  class_full   text,               -- raw class label incl. rating
  team         text,
  car_model    text,
  driver_key   text not null,      -- normalized (ascii-folded) "lastname firstname" dedupe key
  driver_name  text not null,
  nationality  text,               -- ISO-2 (from Ort country name / license prefix)
  license_no   text,
  pos_overall  integer,            -- finishing position overall (null = not classified)
  pos_class    integer,            -- finishing position within base class
  laps         integer,
  best_lap_ms  integer,            -- this DRIVER's own fastest lap (ms) from the Lap-by-Lap chart; falls back to the car's fastest if no chart
  set_fastest  boolean,            -- true = this driver set the car's fastest lap that race (from <date>rl.pdf); null = unknown (no lap chart)
  status       text,               -- classified | dnf | dsq
  unique (event_date, car_no, driver_key)
);
create index if not exists stint9_nls_results_driver_idx on public.stint9_nls_results (driver_key);
create index if not exists stint9_nls_results_event_idx  on public.stint9_nls_results (event_date);
create index if not exists stint9_nls_results_class_idx  on public.stint9_nls_results (class);

-- one row per scrape run
create table if not exists public.stint9_nls_scrape_log (
  id            bigint generated always as identity primary key,
  ok            boolean,
  races_checked integer,
  detail        jsonb,
  created_at    timestamptz not null default now()
);

-- convenience aggregate view (driver.html re-aggregates client-side for the
-- class filter; this backs quick checks). security_invoker => underlying RLS applies.
create or replace view public.stint9_nls_driver_stats
with (security_invoker = true) as
select
  driver_key,
  max(driver_name) as driver_name,
  (array_agg(nationality order by event_date desc) filter (where nationality is not null))[1] as nationality,
  count(distinct event_date)                                           as races,
  count(distinct event_date) filter (where pos_overall between 1 and 3) as podiums_overall,
  count(distinct event_date) filter (where pos_class   between 1 and 3) as podiums_class,
  min(pos_overall)                                                     as best_pos_overall,
  min(pos_class)                                                       as best_pos_class,
  min(best_lap_ms)                                                     as best_lap_ms,
  count(distinct car_model)                                            as distinct_cars,
  count(distinct team)                                                 as distinct_teams
from public.stint9_nls_results
group by driver_key;

-- RLS: public read-only; writes only via service role (which bypasses RLS)
alter table public.stint9_nls_races      enable row level security;
alter table public.stint9_nls_results    enable row level security;
alter table public.stint9_nls_scrape_log enable row level security;

drop policy if exists nls_races_read   on public.stint9_nls_races;
drop policy if exists nls_results_read on public.stint9_nls_results;
drop policy if exists nls_log_read     on public.stint9_nls_scrape_log;

create policy nls_races_read   on public.stint9_nls_races      for select to anon, authenticated using (true);
create policy nls_results_read on public.stint9_nls_results    for select to anon, authenticated using (true);
create policy nls_log_read     on public.stint9_nls_scrape_log for select to anon, authenticated using (true);

-- weekly auto-refresh (pg_cron + pg_net). Mondays 04:00 UTC.
create or replace function public.stint9_run_nls_driver_scrape()
  returns void language plpgsql set search_path to 'public', 'pg_temp'
as $$
begin
  perform net.http_post(
    url := 'https://esvvzgxqnfszhttdkuzc.supabase.co/functions/v1/nls-driver-scrape',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
end;
$$;

select cron.schedule('stint9_nls_driver_autoscan', '0 4 * * 1',
  'select public.stint9_run_nls_driver_scrape();');

-- To include the 24h Nürburgring race (best-effort — 24h-rennen.de is bot-protected),
-- insert its result-PDF URL as data; the scraper will then pick it up:
--   insert into public.stint9_nls_races (event_date, series, title, results_url)
--   values ('2026-05-17', '24h', 'ADAC RAVENOL 24h Nürburgring', '<direct-pdf-url>')
--   on conflict (event_date) do update set results_url = excluded.results_url, series = '24h';
