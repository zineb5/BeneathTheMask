-- Beneath the Mask — 0009_dynamic_controller
-- The round controller is resolved on the fly (requireController in
-- _shared/client.ts), never stored: host if eligible (connected, non-subject,
-- fresh heartbeat), else first connected non-subject by join time.

-- Join-time ordering for the controller rule.
alter table public.players add column if not exists created_at timestamptz not null default now();

-- 0008 stored the controller per round — that approach is replaced by the
-- dynamic resolver. Drop the column.
alter table public.rounds drop column if exists controller_player_id;
