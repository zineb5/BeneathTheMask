-- Beneath the Mask — 0002_fix_deliveries
-- Reconciles question_deliveries with tables created by an earlier exploratory
-- snippet: that schema carried `correct_index not null` (spec §6 draft), but the
-- engine stores the option->original mapping inside shuffled_options ([{i,t}]),
-- so nothing writes correct_index and the NOT NULL constraint breaks start-game.
-- Drop the dead column; safe no-op if absent.

alter table public.question_deliveries drop column if exists correct_index;
