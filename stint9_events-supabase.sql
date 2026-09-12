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
--  Automatic archiver (pure SQL + pg_cron) — "automatic per session".
--  Function bodies below are the live source of truth (kept in sync with
--  the applied migrations — CREATE OR REPLACE so this file is safe to re-run).
--  Cron `stint9_event_archive` runs hourly and calls stint9_maybe_archive_events(),
--  which snapshots any finished (last schedule window in the surrounding
--  +-3 days ended >30min ago) session that doesn't already have a
--  stint9_events row for its (event_date, label) — e.g. quali being archived
--  early/manually no longer blocks the race from auto-archiving later the
--  same day. Before 2026-09-12 the dedup was by event_date alone, and the
--  gate was 2h; both were tightened after NLS8's race sat un-archived for
--  over an hour despite a manual NLS8-quali row already existing for the date.
--
--  SLUG/NAME resolution (the NLS round number, e.g. NLS6, is NOT in any timing
--  or schedule field — stint9_schedule_windows only holds session labels):
--    1. public.stint9_event_rounds (date -> slug/name lookup, seeded from the
--       NLS calendar: 2026-04-18/19 = NLS4/NLS5, 2026-06-20 = NLS6,
--       2026-08-01 = NLS7, 2026-09-12 = NLS8). Add a row when a new round's
--       date is known.
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

create or replace function public.stint9_event_slug(p_label text, p_name text, p_date date)
 returns text
 language plpgsql
 immutable
 set search_path to 'public', 'pg_temp'
as $function$
declare s text; m text[];
begin
  foreach s in array array[coalesce(p_label,''), coalesce(p_name,'')] loop
    m := regexp_match(s, 'NLS\s*0*(\d{1,2})', 'i');       -- explicit "NLS n"
    if m is not null then return 'NLS' || m[1]; end if;
  end loop;
  return 'EVT-' || to_char(p_date, 'YYYY-MM-DD');
end $function$;

create or replace function public.stint9_archive_event(p_date date, p_slug text default null::text, p_label text default null::text, p_name text default null::text, p_end date default null::date)
 returns text
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_slug text; v_name text := p_name; v_label text := p_label; v_end date := p_end;
  v_round_slug text; v_round_name text;
  v_win_lo timestamptz; v_win_hi timestamptz;
  v_cars int; v_timing jsonb; v_overlay jsonb; v_bundle jsonb;
begin
  select min(start_ts), max(end_ts),
         coalesce(v_label, (array_agg(label order by end_ts desc nulls last))[1]),
         nullif(max(event_date), p_date)
    into v_win_lo, v_win_hi, v_label, v_end
    from public.stint9_schedule_windows
   where event_date between p_date - 3 and p_date + 3;
  if v_end is not null and v_end <= p_date then v_end := coalesce(p_end, null); end if;

  select slug, name into v_round_slug, v_round_name
    from public.stint9_event_rounds where event_date = p_date;

  v_name := coalesce(v_name, v_round_name, v_label);
  v_slug := coalesce(p_slug, v_round_slug, public.stint9_event_slug(v_label, v_name, p_date));

  -- Timing: WIGE never sends S5 for the Nordschleife (s5 is always null on the
  -- raw row) -- index.html's LIVE-mode liveTick() reconstructs it client-side
  -- as S5(lap N) = lap_time(lap N+1) - (S1+S2+S3+S4 of lap N), but that fix
  -- was never applied here, so every archived event's stored bundle had a
  -- permanently-missing S5/lap-total (confirmed 2026-08-02 on NLS7 car #665:
  -- s5=null on all 7 rows despite valid lap_time on 6 of them). Same formula,
  -- same safety bounds (5s < d5 < 900s), via lead() over each car's own laps.
  with base as (
    select car, lap, klass, s1, s2, s3, s4, s5, s1_kmh, s2_kmh, s3_kmh, s4_kmh, s5_kmh,
           lap_end_tod, lap_time, inpit, fastest, driver, vehicle,
           lead(lap) over (partition by car order by lap) as next_lap,
           lead(lap_time) over (partition by car order by lap) as next_lap_time
    from public.stint9_live_timing where event_date = p_date
  )
  select count(distinct car),
         coalesce(jsonb_agg(jsonb_build_object(
           'car', car::text, 'lap', lap, 'klass', klass,
           's', jsonb_build_array(s1, s2, s3, s4,
                  case
                    when s5 is not null then s5
                    when s1 is not null and s2 is not null and s3 is not null and s4 is not null
                         and next_lap = lap + 1 and next_lap_time is not null
                         and (next_lap_time - (s1+s2+s3+s4)) > 5 and (next_lap_time - (s1+s2+s3+s4)) < 900
                    then round((next_lap_time - (s1+s2+s3+s4))::numeric, 3)
                    else null
                  end),
           'spd', jsonb_build_array(s1_kmh,s2_kmh,s3_kmh,s4_kmh,s5_kmh),
           'tend', lap_end_tod, 'rt', lap_time, 'inpit', coalesce(inpit,false),
           'fast', coalesce(fastest,false), 'drv', driver, 'veh', vehicle)
           order by char_length(car::text), car::text, lap), '[]'::jsonb)
    into v_cars, v_timing
    from base;

  v_overlay := jsonb_build_object(
    'fuel_state', (select coalesce(jsonb_agg(jsonb_build_object('car',car,'state',state) order by car),'[]'::jsonb)
                     from public.stint9_fuel_state where event_date = p_date::text),
    'fuel_notes', (select coalesce(jsonb_agg(jsonb_build_object('car',car,'lap',lap,'note',note) order by car,lap),'[]'::jsonb)
                     from public.stint9_fuel_notes where event_date = p_date::text),
    'racenotes',  (select coalesce(jsonb_agg(jsonb_build_object('car',car,'lap',lap,'sector',sector,'kind',kind,'body',body,'tod',tod,'nkey',nkey,'meta',meta) order by car,tod),'[]'::jsonb)
                     from public.stint9_racenotes where event_date = p_date),
    'tyre_state', (select coalesce(jsonb_agg(jsonb_build_object('car',car,'state',state) order by car),'[]'::jsonb)
                     from public.stint9_tyre_state),
    'band_state', (select coalesce(jsonb_agg(jsonb_build_object('band',band,'active',active,'texts',texts) order by band),'[]'::jsonb)
                     from public.stint9_band_state),
    'messages',   (select coalesce(jsonb_agg(jsonb_build_object('race_class',race_class,'car',car,'message',message,'source',source,'created_at',created_at,'event_date',event_date) order by created_at),'[]'::jsonb)
                     from public.stint9_messages
                    where event_date = p_date
                       or (event_date is null and (v_win_lo is null or created_at between v_win_lo and coalesce(v_win_hi, now()))))
  );

  v_bundle := jsonb_build_object(
    'meta', jsonb_build_object('slug',v_slug,'event_date',to_char(p_date,'YYYY-MM-DD'),
              'event_end', case when v_end is not null then to_char(v_end,'YYYY-MM-DD') end,
              'label',v_label,'name',v_name,'car_count',v_cars,
              'archived_at', to_char(now(),'YYYY-MM-DD"T"HH24:MI:SSOF'),'source','stint9_live_timing'),
    'db', null, 'timing', v_timing, 'overlay', v_overlay,
    'weather', (select coalesce(jsonb_agg(jsonb_build_object('recorded_at',recorded_at,'temp_c',temp_c,'weather_code',weather_code,'precip_prob',precip_prob) order by recorded_at),'[]'::jsonb)
                  from public.stint9_weather where event_date = p_date::text),
    'laptimes', (select coalesce(jsonb_agg(jsonb_build_object('car',car,'driver',driver,'lap',lap,'laptime_s',laptime_s,'temp_c',temp_c,'weather_code',weather_code) order by car,lap),'[]'::jsonb)
                  from public.stint9_laptimes where event_date = p_date::text),
    'live_status', (select to_jsonb(ls) from public.stint9_live_status ls where event_date = p_date));

  insert into public.stint9_events (slug, event_date, event_end, label, name, car_count, bundle, updated_at)
  values (v_slug, p_date, v_end, v_label, v_name, v_cars, v_bundle, now())
  on conflict (slug) do update set
    event_date = excluded.event_date, event_end = excluded.event_end, label = excluded.label,
    name = excluded.name, car_count = excluded.car_count, bundle = excluded.bundle, updated_at = now();

  return v_slug;
end $function$;

create or replace function public.stint9_maybe_archive_events()
 returns void
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare r record;
begin
  for r in
    select lt.event_date,
           (select sw.label from public.stint9_schedule_windows sw
             where sw.event_date between lt.event_date - 3 and lt.event_date + 3
             order by sw.end_ts desc nulls last limit 1) as v_label
      from (select distinct event_date from public.stint9_live_timing) lt
     where exists (select 1 from public.stint9_schedule_windows sw
                    where sw.event_date between lt.event_date - 3 and lt.event_date + 3
                    group by 1=1
                   having max(sw.end_ts) < now() - interval '30 minutes')
  loop
    -- Skip if this specific session (event_date + label) is already archived,
    -- rather than skipping the whole date -- quali/race/practice share event_date
    -- but must each get their own stint9_events row.
    if not exists (
      select 1 from public.stint9_events e
       where (e.event_date = r.event_date
              or (e.event_end is not null and r.event_date between e.event_date and e.event_end))
         and coalesce(e.label, '') = coalesce(r.v_label, '')
    ) then
      perform public.stint9_archive_event(r.event_date);
    end if;
  end loop;
end $function$;
