-- Beneath the Mask — 0001_init
-- Idempotent: safe to run on a database where an earlier exploratory snippet was
-- already applied (anon_all policies / raw tables). Reconciles column-by-column.
--
-- Security model: deny-by-default for anon on the hidden layer
-- (question_deliveries, predictions, subject_answers). Scoped anon SELECT only on
-- rooms/players/rounds (+ round_results once revealed) so postgres_changes can
-- deliver state to anon clients — Realtime respects RLS.

-- ---------------------------------------------------------------------------
-- 0. Reconcile any permissive policies from earlier snippets
-- ---------------------------------------------------------------------------
drop policy if exists anon_all on public.rooms;
drop policy if exists anon_all on public.players;
drop policy if exists anon_all on public.rounds;
drop policy if exists anon_all on public.question_deliveries;
drop policy if exists anon_all on public.predictions;
drop policy if exists anon_all on public.subject_answers;
drop policy if exists anon_all on public.round_results;

-- ---------------------------------------------------------------------------
-- 1. Tables (create-if-missing, then additive columns)
-- ---------------------------------------------------------------------------
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'LOBBY',
  current_round_seq int not null default 0,
  host_player_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  display_name text not null,
  hue text not null,
  avatar_variant text not null default 'F' check (avatar_variant in ('F','M')),
  is_host boolean not null default false,
  total_score int not null default 0,
  best_predictor_badges int not null default 0,
  subject_order_idx int,
  connected boolean not null default true,
  last_seen_at timestamptz not null default now()
);

create table if not exists public.rounds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  seq int not null,
  subject_player_id uuid not null references public.players(id),
  question_ids jsonb not null default '[]'::jsonb,
  status text not null default 'intro', -- intro | question_loop | reveal
  created_at timestamptz not null default now(),
  unique (room_id, seq)
);

create table if not exists public.question_deliveries (
  round_id uuid not null references public.rounds(id) on delete cascade,
  question_idx int not null, -- 0..11
  question_id int not null,  -- bank question id
  shuffled_options jsonb not null, -- [{i: original option index, t: text}] — the scoring anchor
  ends_at timestamptz,
  primary key (round_id, question_idx)
);

create table if not exists public.predictions (
  round_id uuid not null references public.rounds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  question_idx int not null,
  chosen_index int not null, -- shuffled-space index
  primary key (round_id, player_id, question_idx)
);

create table if not exists public.subject_answers (
  round_id uuid not null references public.rounds(id) on delete cascade,
  question_idx int not null,
  chosen_index int not null, -- shuffled-space index
  primary key (round_id, question_idx)
);

-- Reveal gate: revealed_at stays NULL until compute-reveal runs. Deliberately NO
-- default now() here — a default would make the SELECT policy a dead tautology.
create table if not exists public.round_results (
  round_id uuid primary key references public.rounds(id) on delete cascade,
  per_player_correct jsonb not null default '{}'::jsonb, -- {player_id: correct_count}
  best_predictor_player_id uuid,
  group_type text,
  subject_type text,
  per_axis jsonb,     -- {subject: {EI:[a,b],...}, group: {...}}
  analyzer jsonb,     -- AxisMisread[] from the engine
  group_accuracy jsonb, -- {correct, total}
  revealed_at timestamptz
);

-- Additive columns (no-op on a fresh DB, reconcile a half-run snippet):
alter table public.rooms add column if not exists question_timer_s int not null default 40;
alter table public.rooms add column if not exists subjects_limit int; -- NULL = every player is a subject
alter table public.players add column if not exists head_to_head jsonb not null default '{}'::jsonb; -- {winner: {loser: wins}}
alter table public.rounds add column if not exists current_question_idx int;
alter table public.question_deliveries add column if not exists ends_at timestamptz;

create index if not exists players_room_idx on public.players(room_id);
create index if not exists rounds_room_idx on public.rounds(room_id);
create index if not exists predictions_round_idx on public.predictions(round_id);

-- ---------------------------------------------------------------------------
-- 2. RLS — deny by default, scoped SELECT on the publishable state only
-- ---------------------------------------------------------------------------
alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.rounds enable row level security;
alter table public.question_deliveries enable row level security;
alter table public.predictions enable row level security;
alter table public.subject_answers enable row level security;
alter table public.round_results enable row level security;

-- NOTE: the SELECT policies below are global (any anon key can enumerate
-- rooms/players/rounds). Accepted trade-off: this data is non-sensitive.
-- round_results additionally requires the reveal transition.
-- (create policy has no IF NOT EXISTS — drop first to stay re-runnable.)
drop policy if exists anon_select on public.rooms;
drop policy if exists anon_select on public.players;
drop policy if exists anon_select on public.rounds;
drop policy if exists anon_select_results on public.round_results;
create policy anon_select on public.rooms for select to anon using (true);
create policy anon_select on public.players for select to anon using (true);
create policy anon_select on public.rounds for select to anon using (true);
create policy anon_select_results on public.round_results for select to anon using (revealed_at is not null);

-- ---------------------------------------------------------------------------
-- 3. Realtime publication (postgres_changes delivers state to clients)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms') then
    alter publication supabase_realtime add table public.rooms;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'players') then
    alter publication supabase_realtime add table public.players;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rounds') then
    alter publication supabase_realtime add table public.rounds;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'round_results') then
    alter publication supabase_realtime add table public.round_results;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. apply_round_scores — atomic, idempotent scoring application.
--    Called ONLY by compute-reveal (service role). First call wins; later calls
--    are no-ops (the round_results insert conflicts and `if not found` bails).
-- ---------------------------------------------------------------------------
create or replace function public.apply_round_scores(
  p_round_id uuid,
  p_per_player_correct jsonb,
  p_best_predictor uuid,
  p_head_to_head jsonb default '{}'::jsonb -- {winner: {loser: wins_to_add}}
) returns void
language plpgsql
security definer
as $$
declare
  w record;
  l record;
begin
  insert into public.round_results (round_id, per_player_correct, best_predictor_player_id)
  values (p_round_id, coalesce(p_per_player_correct, '{}'::jsonb), p_best_predictor)
  on conflict (round_id) do nothing;
  if not found then
    return; -- already revealed: idempotent no-op
  end if;

  update public.players p
  set total_score = p.total_score + j.value::int
  from jsonb_each_text(p_per_player_correct) as j
  where p.id = j.key::uuid;

  for w in select key as winner, value as losers from jsonb_each(p_head_to_head) loop
    for l in select key as loser, value::text as delta from jsonb_each_text(w.losers) loop
      update public.players p
      set head_to_head = jsonb_set(
            p.head_to_head,
            array[w.winner, l.loser],
            ((coalesce((p.head_to_head #> array[w.winner, l.loser])::text, '0')::int) + l.delta::int)::text::jsonb
          )
      where p.id = w.winner::uuid;
    end loop;
  end loop;

  if p_best_predictor is not null then
    update public.players
    set best_predictor_badges = best_predictor_badges + 1
    where id = p_best_predictor;
  end if;

  update public.round_results
  set revealed_at = now()
  where round_id = p_round_id and revealed_at is null;
end $$;

revoke execute on function public.apply_round_scores(uuid, jsonb, uuid, jsonb) from anon, authenticated;
