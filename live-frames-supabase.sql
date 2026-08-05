-- ============================================================
--  STINT9 live frame archive — every WIGE payload, verbatim
--  Project: esvvzgxqnfszhttdkuzc
--
--  WHY THIS EXISTS
--  stint9_live_timing stores the ~18 fields wige-scrape maps. Everything
--  else WIGE sends is parsed and thrown away, so any question about a field
--  we don't map ("does the feed carry pit in/out times?", "what does LAPS
--  actually count?") can only be answered by catching a live session with a
--  temp console.log — and edge-function logs are kept 24h, so the evidence
--  expires before anyone reads it. That is how README §9's three open
--  questions survived two race weekends unanswered.
--
--  So: keep the whole frame. One row per archived WebSocket message, stored
--  exactly as it arrived. Nothing in the dashboard reads this table — it is
--  a write-once evidence log, queried by hand between events.
--
--    -- what fields does a car object actually have?
--    select jsonb_object_keys(frame->'RESULT'->0) from stint9_live_frames
--    where pid <> '3' order by 1;
--
--    -- does the feed carry pit data at all?
--    select distinct k from stint9_live_frames,
--      lateral jsonb_object_keys(frame->'RESULT'->0) k where k ilike '%pit%';
--
--  SIZE. A full NLS field is ~130 cars ≈ 70 KB of JSON per frame; jsonb
--  compresses that to roughly 15-25 KB. wige-scrape samples one frame per
--  channel per WIGE_FRAME_MIN_MS (default 15000), so a 6h raceday lands
--  ~1.4k frames ≈ 25-35 MB. Identical payloads collapse on the body_hash
--  unique index and cost nothing. Set WIGE_FRAME_MIN_MS=0 to keep literally
--  every frame (~10x that), or WIGE_FRAME_ARCHIVE=off to stop collecting.
--  stint9_prune_live_frames() below is the pressure valve.
-- ============================================================

create table if not exists public.stint9_live_frames (
  id          bigint generated always as identity primary key,
  event_date  date        not null,
  received_at timestamptz not null default now(),
  pid         text,                        -- WIGE channel: '0'/'4' leaderboard, '3' race control
  event_id    text,                        -- EXPORTID (the WIGE event this frame belongs to)
  session     text,
  heat        text,
  track       text,
  root_tod    double precision,            -- frame-root TOD in seconds-of-day, if present
  cars        integer,                     -- RESULT[] length (null for non-leaderboard frames)
  body_hash   text        not null,        -- FNV-1a of the serialised frame; collapses re-sends
  frame       jsonb       not null         -- THE WHOLE MESSAGE, verbatim
);

comment on table public.stint9_live_frames is
  'Verbatim archive of WIGE live-timing WebSocket frames, written by wige-scrape. One row per sampled message, whole payload in frame (jsonb). Nothing reads this at runtime — it exists so questions about fields we do NOT map (pit in/out times, LAPS semantics, sector count) can be answered from stored data instead of a 24h-retention edge log. Sampled at one frame per channel per WIGE_FRAME_MIN_MS (default 15s); identical payloads collapse on body_hash. Prune with stint9_prune_live_frames().';

-- Exact re-sends are free: same payload on the same day/channel stores once.
create unique index if not exists stint9_live_frames_dedup_idx
  on public.stint9_live_frames (event_date, pid, body_hash);
create index if not exists stint9_live_frames_when_idx
  on public.stint9_live_frames (event_date, received_at);

-- RLS: read-only to the browser key. Writes come from wige-scrape with the
-- service role, which bypasses RLS — so no anon insert/update/delete policy
-- exists at all. Matches the closed-anon-write posture on the archive tables.
alter table public.stint9_live_frames enable row level security;

drop policy if exists "live frames anon read" on public.stint9_live_frames;
create policy "live frames anon read" on public.stint9_live_frames for select using (true);

-- ============================================================
--  RETENTION
--  Frames are raw evidence, not a product. Once an event is safely in
--  stint9_events there is no reason to keep its frames indefinitely — but
--  never drop frames for a day that was never archived, or a failed archive
--  run would silently destroy the only copy of the session.
-- ============================================================

create or replace function public.stint9_prune_live_frames(keep_days integer default 21)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  with gone as (
    delete from public.stint9_live_frames f
     where f.received_at < now() - (keep_days || ' days')::interval
       and exists (select 1 from public.stint9_events e where e.event_date = f.event_date)
    returning 1
  )
  select count(*) into n from gone;
  return n;
end $$;

comment on function public.stint9_prune_live_frames(integer) is
  'Delete archived-event frames older than keep_days (default 21). Skips any event_date with no row in stint9_events, so a failed archive never loses the raw frames. Returns rows deleted.';

-- Daily at 05:20, after the 06:00/06:15 scrape jobs but well clear of raceday.
select cron.schedule('stint9_live_frames_prune', '20 5 * * *',
                     $$select public.stint9_prune_live_frames(21);$$)
where not exists (select 1 from cron.job where jobname = 'stint9_live_frames_prune');
