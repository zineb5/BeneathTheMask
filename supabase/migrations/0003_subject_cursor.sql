-- Beneath the Mask — 0003_subject_cursor
-- Personal navigation cursor for the subject's private questionnaire. The
-- subject moves through the 12 questions independently of the room's
-- current_question_idx: selecting an answer never advances them; they step
-- with the subject-step function. NULL means 0 (pre-existing rounds).

alter table public.rounds add column if not exists subject_idx int;
