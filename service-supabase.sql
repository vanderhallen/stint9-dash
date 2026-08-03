-- ============================================================================
--  SERVICE reel — per-car component km tracking (service.html)
-- ----------------------------------------------------------------------------
--  Mirrors the TYRE board's model: the whole component set for a car (per-part
--  service interval, accumulated ACTUAL km, and install date) is stored as ONE
--  JSON blob per car in stint9_service_state. ACTUAL km ticks up from the live
--  timing (same prog->km mapping as the tyre board), LIVE mode only.
--
--  Pressing SWAP on a component closes out its life to stint9_service_log
--  (start_date -> end_date, with the km it did) and resets ACTUAL to 0.
--
--  RLS matches stint9_tyre_state: anon+authenticated may read / insert / update.
--  No DELETE policy (rows are never removed by the client).
--  Already applied to project esvvzgxqnfszhttdkuzc (migration: stint9_service_tracking).
-- ============================================================================

-- one JSON blob per car:  state = { comp: { engine:{interval,actual,start}, ... } }
create table if not exists public.stint9_service_state (
  car        text primary key,
  state      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.stint9_service_state enable row level security;
drop policy if exists stint9_service_state_read   on public.stint9_service_state;
drop policy if exists stint9_service_state_insert on public.stint9_service_state;
drop policy if exists stint9_service_state_update on public.stint9_service_state;
create policy stint9_service_state_read   on public.stint9_service_state for select using (true);
create policy stint9_service_state_insert on public.stint9_service_state for insert with check (true);
create policy stint9_service_state_update on public.stint9_service_state for update using (true) with check (true);

-- swap log: one row each time a component is swapped out (its life closed).
-- On SWAP the crew enters the car's current ODOMETER reading; odo_in is the
-- reading when the part was fitted (= previous part's odo_out), odo_out the
-- reading when removed, and km = odo_out - odo_in (the odometer difference).
create table if not exists public.stint9_service_log (
  id          bigint generated always as identity primary key,
  car         text        not null,
  component   text        not null,        -- engine | oil | disc | pad | shaft | bearing | turbo | diff
  start_date  timestamptz,                 -- when the swapped-out part was installed (null if unknown)
  end_date    timestamptz not null default now(),
  odo_in      numeric,                     -- car odometer at install (ODO 1)
  odo_out     numeric,                     -- car odometer at removal (ODO 2)
  km          numeric     not null default 0,   -- km the part did = odo_out - odo_in
  interval_km numeric,                      -- the service interval it was tracked against
  created_at  timestamptz not null default now()
);
alter table public.stint9_service_log enable row level security;
drop policy if exists stint9_service_log_read   on public.stint9_service_log;
drop policy if exists stint9_service_log_insert on public.stint9_service_log;
create policy stint9_service_log_read   on public.stint9_service_log for select using (true);
create policy stint9_service_log_insert on public.stint9_service_log for insert with check (true);
create index if not exists stint9_service_log_car_idx on public.stint9_service_log (car, component, end_date desc);
