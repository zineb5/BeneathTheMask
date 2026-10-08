-- The subject earns one point when the group's inferred MBTI differs from
-- their self-reported MBTI. Store it separately from predictor accuracy.

alter table public.round_results add column if not exists subject_bonus int not null default 0;
