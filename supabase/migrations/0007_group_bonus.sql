-- Beneath the Mask — 0007_group_bonus
-- Symmetric to 0005's subject_bonus: the GROUP earns one point per guesser
-- when its inferred type matches the subject's self-reported type.

alter table public.round_results add column if not exists group_bonus int not null default 0;
