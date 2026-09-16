-- ============================================================================
-- NLS car-number database — schema mirror (applied to Supabase project
-- esvvzgxqnfszhttdkuzc via MCP migrations car_database_tables +
-- car_database_entries_cron). Kept in-repo for reference/reproducibility.
--
-- stint9_nls_entries is written by the `nls-entrylist-scrape` edge function
-- (live/nls-entrylist-scrape/), which parses the official "Vorläufige
-- Teilnehmerliste" PDF into one row per (event, car): class, team, car
-- brand/model, and the full driver roster (jsonb). See that function's header
-- for the parser design.
--
-- stint9_teams and stint9_driver_links are NOT scraped from anywhere — no
-- official NLS source carries team websites or driver social links at all.
-- They are a hand-maintained overlay, keyed to join onto the scraped data
-- (team_key onto stint9_nls_entries.team / stint9_nls_results.team via a
-- normalized slug; driver_key onto the same driver_key already produced by
-- nls-driver-scrape's foldKey()). Rows are added/updated by asking Claude to
-- write them via the Supabase MCP as links are found — same posture as
-- stint9_event_rounds, which is also hand-seeded rather than scraped.
--
-- Read by driver.html's "Cars" tab.
-- ============================================================================

-- one row per (event, car) from the entry-list PDF — includes future rounds
create table if not exists public.stint9_nls_entries (
  event_date  date    not null,
  car_no      integer not null,
  class       text,               -- base class code as printed on the entry list (e.g. 'SP9')
  team        text,               -- same raw-string convention as stint9_nls_results.team
  car_model   text,               -- same raw-string convention as stint9_nls_results.car_model
  drivers     jsonb   not null default '[]', -- [{"driver_key":"...","driver_name":"..."}]
  scraped_at  timestamptz not null default now(),
  primary key (event_date, car_no)
);
create index if not exists stint9_nls_entries_event_idx on public.stint9_nls_entries (event_date);

-- team_key normalization: lowercase, diacritics-folded, punctuation stripped,
-- whitespace collapsed — apply this consistently anywhere a team string is
-- turned into a key (client-side join in driver.html mirrors this exactly).
-- e.g. team_key('Team Joos Sportwagentechnik') = 'team joos sportwagentechnik'

-- hand-maintained overlay: team website, keyed by the normalized team name
create table if not exists public.stint9_teams (
  team_key   text primary key,
  team_name  text not null,      -- display name, as last seen on a scrape
  website    text,
  updated_at timestamptz not null default now()
);

-- hand-maintained overlay: driver socials, keyed by the existing driver_key
-- (same foldKey() normalization nls-driver-scrape already uses)
create table if not exists public.stint9_driver_links (
  driver_key text primary key,
  website    text,
  instagram  text,
  updated_at timestamptz not null default now()
);

-- RLS: public read-only; writes only via service role (edge function) or the
-- Supabase MCP (also service role), both of which bypass RLS — same posture
-- as every other stint9_* table.
alter table public.stint9_nls_entries  enable row level security;
alter table public.stint9_teams        enable row level security;
alter table public.stint9_driver_links enable row level security;

drop policy if exists nls_entries_read   on public.stint9_nls_entries;
drop policy if exists teams_read         on public.stint9_teams;
drop policy if exists driver_links_read  on public.stint9_driver_links;

create policy nls_entries_read  on public.stint9_nls_entries  for select to anon, authenticated using (true);
create policy teams_read        on public.stint9_teams        for select to anon, authenticated using (true);
create policy driver_links_read on public.stint9_driver_links for select to anon, authenticated using (true);

-- daily auto-refresh (pg_cron + pg_net) — entry lists get published/updated in
-- the days before each round, so (unlike results) a race-proximity gate would
-- miss corrections; a cheap daily re-scan of every round (past + future) in
-- the season picks those up, same cadence as nls-schedule-scrape.
create or replace function public.stint9_run_nls_entrylist_scrape()
  returns void language plpgsql set search_path to 'public', 'pg_temp'
as $$
begin
  perform net.http_post(
    url := 'https://esvvzgxqnfszhttdkuzc.supabase.co/functions/v1/nls-entrylist-scrape',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
end;
$$;

select cron.schedule('stint9_nls_entries_autoscan', '0 5 * * *',
  'select public.stint9_run_nls_entrylist_scrape();');

-- Manual re-trigger for a single event (e.g. entry list just published/
-- corrected): POST /functions/v1/nls-entrylist-scrape {"date":"YYYY-MM-DD"}
-- (skips the calendar scan; fetches only that event's s.pdf).
