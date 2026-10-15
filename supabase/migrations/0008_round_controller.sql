-- Beneath the Mask — 0008_round_controller
-- Per-round flow controller. When the room host IS the round's subject they
-- cannot manage the group flow (private questionnaire only), so control moves
-- to the first connected non-subject player for that round. Recalculated every
-- round. NULL on legacy rows = fall back to rooms.host_player_id.

alter table public.rounds add column if not exists controller_player_id uuid;
