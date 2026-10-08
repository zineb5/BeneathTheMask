-- Beneath the Mask — 0004_fix_round_results
-- Reconciles round_results with tables created by the earlier exploratory
-- snippet (same disease as question_deliveries/correct_index): the pre-existing
-- table is missing columns the engine writes (best_predictor_player_id, …).
-- Idempotent: add-if-missing, relax stale NOT NULLs, drop dead computed_at.

alter table public.round_results add column if not exists per_player_correct jsonb not null default '{}'::jsonb;
alter table public.round_results add column if not exists best_predictor_player_id uuid;
alter table public.round_results add column if not exists group_type text;
alter table public.round_results add column if not exists subject_type text;
alter table public.round_results add column if not exists per_axis jsonb;
alter table public.round_results add column if not exists analyzer jsonb;
alter table public.round_results add column if not exists group_accuracy jsonb;
alter table public.round_results add column if not exists revealed_at timestamptz;

-- Reveal "mask was ambiguous" runner-ups (engine v1.5).
alter table public.round_results add column if not exists alternates jsonb;
alter table public.round_results add column if not exists confidence text;

-- Inserts set these on the compute step, so a leftover NOT NULL from the old
-- snippet would break apply_round_scores — relax just in case.
alter table public.round_results alter column group_type drop not null;
alter table public.round_results alter column subject_type drop not null;
alter table public.round_results alter column per_player_correct drop not null;

-- Dead tautology column from the §6 draft schema, if present.
alter table public.round_results drop column if exists computed_at;
