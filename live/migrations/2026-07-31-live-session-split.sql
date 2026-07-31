-- LIVE session split — give stint9_live_timing a per-session event_id so quali and
-- race (different WIGE event ids on the same day) no longer overwrite/merge each
-- other. Run this ONCE in the Supabase SQL editor BEFORE deploying the matching
-- code (wige-scrape, browser-collector, index.html). Safe: existing rows just get
-- event_id = NULL.
begin;

-- 1) the session column (nullable)
alter table public.stint9_live_timing add column if not exists event_id text;

-- 2) drop the old (event_date, car, lap) uniqueness — whatever its name — because
--    it would reject two sessions' rows that share (car, lap). Handles both a named
--    unique CONSTRAINT and a bare unique INDEX.
do $$
declare r record;
begin
  -- unique constraints on exactly {event_date, car, lap}
  for r in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.stint9_live_timing'::regclass and con.contype = 'u'
      and (select array_agg(a.attname order by a.attname)
           from unnest(con.conkey) k join pg_attribute a
             on a.attrelid = con.conrelid and a.attnum = k)
          = array['car','event_date','lap']
  loop
    execute format('alter table public.stint9_live_timing drop constraint %I', r.conname);
  end loop;
  -- unique indexes on exactly {event_date, car, lap} not backing a constraint
  for r in
    select i.relname
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    where x.indrelid = 'public.stint9_live_timing'::regclass and x.indisunique
      and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid)
      and (select array_agg(a.attname order by a.attname)
           from unnest(x.indkey::int[]) k join pg_attribute a
             on a.attrelid = x.indrelid and a.attnum = k)
          = array['car','event_date','lap']
  loop
    execute format('drop index public.%I', r.relname);
  end loop;
end $$;

-- 3) new session-aware uniqueness — the on_conflict target the scraper/collector use.
create unique index if not exists stint9_live_timing_session_key
  on public.stint9_live_timing (event_date, event_id, car, lap);

commit;

-- Verify:
--   \d public.stint9_live_timing      -- event_id present, stint9_live_timing_session_key unique
