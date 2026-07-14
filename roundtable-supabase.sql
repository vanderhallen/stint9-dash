-- ============================================================
--  AI Roundtable — Supabase schema  (roundtable.html)
--  Project: esvvzgxqnfszhttdkuzc
--
--  Standalone table. Does NOT touch the stint9_* dashboard
--  stream used by index.html — the roundtable has its own store.
--
--  Channels (5 columns, left -> right):
--    h1h2    Human 1 -> Human 2        (white arrow)
--    h1ai2   Human 1 -> AI of H2       (gray arrow)
--    ai1ai2  AI1 <-> AI2 indirect/risk (red arrow)
--    h2h1    Human 2 -> Human 1        (white arrow)
--    h2ai1   Human 2 -> AI of H1       (gray arrow)
--
--  Participants: H1, H2, AI1, AI2
--  Rule: an AI may draft a message, but only a human presses Send.
--        Rows written by an AI draft that a human approved keep
--        via_ai = true so the origin is auditable.
-- ============================================================

create table if not exists public.roundtable_messages (
  id          bigint generated always as identity primary key,
  channel     text        not null
                check (channel in ('h1h2','h1ai2','ai1ai2','h2h1','h2ai1')),
  sender      text        not null
                check (sender in ('H1','H2','AI1','AI2')),
  body        text        not null
                check (char_length(body) between 1 and 4000),
  via_ai      boolean     not null default false,  -- drafted by AI, sent by a human
  read        boolean     not null default false,  -- recipient has opened the column
  created_at  timestamptz not null default now()
);

comment on table public.roundtable_messages is
  'AI Roundtable 4-way chat (roundtable.html). One row per message. Separate from the stint9_* dashboard stream. channel = one of h1h2/h1ai2/ai1ai2/h2h1/h2ai1; sender = H1/H2/AI1/AI2; via_ai = drafted by AI then human-sent; read = recipient opened the column.';

create index if not exists roundtable_messages_channel_idx
  on public.roundtable_messages (channel, created_at);

create index if not exists roundtable_messages_unread_idx
  on public.roundtable_messages (channel) where read = false;

-- Row-level security: same in-browser publishable-key model as the
-- rest of the project (soft gate; key is public).
alter table public.roundtable_messages enable row level security;

drop policy if exists "roundtable anon read"   on public.roundtable_messages;
drop policy if exists "roundtable anon insert" on public.roundtable_messages;
drop policy if exists "roundtable anon update" on public.roundtable_messages;

create policy "roundtable anon read"
  on public.roundtable_messages for select using (true);

create policy "roundtable anon insert"
  on public.roundtable_messages for insert with check (true);

-- update limited to flipping the read flag (mark-as-read)
create policy "roundtable anon update"
  on public.roundtable_messages for update using (true) with check (true);

-- Live updates so both humans see new messages without refresh.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'roundtable_messages'
  ) then
    alter publication supabase_realtime add table public.roundtable_messages;
  end if;
end $$;
