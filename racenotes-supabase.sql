-- ============================================================
--  STINT9 racenotes — chronological race report for one car
--  (stint9-dash index.html, left-sidebar racenote panel that
--   replaces the starting grid after formation lap L0).
--  Project: esvvzgxqnfszhttdkuzc
--
--  One row per note. kind = overtake / fastest / gap are
--  auto-detected from the timing DB as the race evolves;
--  kind = manual is crew-typed. Same in-browser publishable-key
--  soft-gate model as the rest of the stint9_* tables.
--
--  tod  = time-of-day (seconds) of the noted moment — used to
--         locate the highlight on the race video.
--  meta = passed car, px/py within-class positions, gap_start/
--         gap_end and sector-boundary TODs, so the video
--         "analyse" step needs no recomputation.
--  nkey = natural dedupe key for auto notes (null for manual).
-- ============================================================

create table if not exists public.stint9_racenotes (
  id          bigint generated always as identity primary key,
  event_date  date        not null,
  car         text        not null,
  lap         integer,
  sector      integer,
  kind        text        not null
                check (kind in ('overtake','fastest','gap','manual')),
  body        text        not null
                check (char_length(body) between 1 and 2000),
  tod         double precision,           -- time-of-day (seconds) of the moment noted
  nkey        text,                        -- natural key for auto-dedupe (null for manual)
  meta        jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

comment on table public.stint9_racenotes is
  'Chronological race notes for one car, shown in the stint9-dash left-sidebar racenote panel (index.html, replaces the starting grid after formation lap L0). kind=overtake/fastest/gap are auto-detected from the timing DB as the race evolves; kind=manual is crew-typed. tod = time-of-day seconds of the noted moment (used to locate the highlight on the race video). meta (jsonb) carries passed car, px/py within-class positions, gap_start/gap_end and sector boundary TODs so the video "analyse" step needs no recomputation. nkey = natural dedupe key for auto notes.';

-- one auto note per (event,car,natural-key); manual notes (nkey null) never collide
create unique index if not exists stint9_racenotes_nkey_idx
  on public.stint9_racenotes (event_date, car, nkey) where nkey is not null;
create index if not exists stint9_racenotes_feed_idx
  on public.stint9_racenotes (event_date, car, tod);

-- Row-level security: same in-browser publishable-key model as the
-- rest of the project (soft gate; key is public).
alter table public.stint9_racenotes enable row level security;

drop policy if exists "racenotes anon read"   on public.stint9_racenotes;
drop policy if exists "racenotes anon insert" on public.stint9_racenotes;
drop policy if exists "racenotes anon update" on public.stint9_racenotes;
drop policy if exists "racenotes anon delete" on public.stint9_racenotes;

create policy "racenotes anon read"   on public.stint9_racenotes for select using (true);
create policy "racenotes anon insert" on public.stint9_racenotes for insert with check (true);
create policy "racenotes anon update" on public.stint9_racenotes for update using (true) with check (true);
create policy "racenotes anon delete" on public.stint9_racenotes for delete using (true);
