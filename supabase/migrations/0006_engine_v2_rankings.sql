-- Engine v2: preserve the 16-type ranking and confidence for both readings.
alter table public.round_results add column if not exists top2 jsonb;
alter table public.round_results add column if not exists type_confidence numeric;
alter table public.round_results add column if not exists group_top2 jsonb;
alter table public.round_results add column if not exists group_type_confidence numeric;
