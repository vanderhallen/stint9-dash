-- ===========================================================================
-- stint9_presence — live "how many people have the dashboard open" counter
-- ===========================================================================
-- One row per open browser tab, keyed by a random client id the page mints
-- once (sessionStorage-backed, so a reload within the same tab reuses it but
-- every distinct open tab gets its own row). The dashboard calls the
-- stint9_presence_heartbeat() RPC roughly every 20s, which upserts this tab's
-- last_seen and returns the current "active" count in one round trip.
--
-- The client never touches the table directly — no REST/anon policies are
-- granted on public.stint9_presence itself, only EXECUTE on the RPC below,
-- which runs SECURITY DEFINER. This keeps the RLS surface the same as before
-- (see README security posture notes: anon-delete was deliberately closed off
-- elsewhere; this table gets no anon policies at all, not even wider ones).
--
-- Idempotent — safe to re-run.

create table if not exists public.stint9_presence (
  client_id text primary key,
  last_seen timestamptz not null default now()
);

alter table public.stint9_presence enable row level security;
-- No policies: RLS stays on with an empty policy list, so even a future
-- accidental grant of table privileges to anon still serves zero rows.

create or replace function public.stint9_presence_heartbeat(p_client_id text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  active_count int;
begin
  insert into public.stint9_presence (client_id, last_seen)
  values (p_client_id, now())
  on conflict (client_id) do update set last_seen = excluded.last_seen;

  select count(*) into active_count
  from public.stint9_presence
  where last_seen > now() - interval '45 seconds';

  return active_count;
end;
$$;

revoke all on function public.stint9_presence_heartbeat(text) from public;
grant execute on function public.stint9_presence_heartbeat(text) to anon, authenticated;

-- Housekeeping: rows go stale ~45s after their tab stops heartbeating, but the
-- table would otherwise grow by one row per tab ever opened. A cron sweep
-- keeps it tiny — same guarded-schedule pattern as stint9_session_rotate in
-- stint9_events-supabase.sql.
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'stint9_presence_sweep') then
    perform cron.schedule('stint9_presence_sweep', '*/5 * * * *',
      $cron$delete from public.stint9_presence where last_seen < now() - interval '1 hour'$cron$);
  end if;
end $$;
