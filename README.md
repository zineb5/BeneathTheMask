# Beneath the Mask

MBTI prediction party game for 2–10 players, online. Each round one player (the
subject) secretly answers 12 behavioral questions about themselves; everyone else
predicts their answers. Scores go to individual predictors; the group majority
feeds the reveal — who you are vs. who your group thinks you are.

One shared screen hosts (TV/laptop), everyone else plays on their phone.

## Stack

- **Frontend**: React + Vite + TypeScript (`app/`) — deployable to Vercel/Netlify as a static SPA.
- **Backend**: Supabase — Postgres for all state, Realtime for live sync, Edge Functions (Deno) for all game logic.
- **Scoring engine**: pure TypeScript (`supabase/functions/_shared/engine.ts`), unit-tested with vitest (`npm test`).

## Setup

```bash
npm install                 # root dev deps (vitest, sharp, supabase-js for smoke)
npm --prefix app install    # frontend deps
cp app/.env app/.env   # then fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
supabase link --project-ref <your-project-ref>
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
supabase db push            # applies migrations/0001 + 0002 (idempotent)
supabase functions deploy create-room --no-verify-jwt
supabase functions deploy join-room --no-verify-jwt
supabase functions deploy update-room --no-verify-jwt
supabase functions deploy start-game --no-verify-jwt
supabase functions deploy start-round --no-verify-jwt
supabase functions deploy advance-question --no-verify-jwt
supabase functions deploy submit-answer --no-verify-jwt
supabase functions deploy compute-reveal --no-verify-jwt
supabase functions deploy next-round --no-verify-jwt
supabase functions deploy sync-state --no-verify-jwt
supabase functions deploy heartbeat --no-verify-jwt
supabase functions deploy sync-state
supabase functions deploy advance-question
supabase functions deploy compute-reveal
supabase functions deploy subject-step
supabase functions deploy submit-answer
```

**One-time dashboard toggle**: enable **Realtime** on the project (Database →
Replication / Realtime configuration). Without it clients never receive
state updates and the game stalls in the lobby. `npm run smoke` fails loudly
on exactly this.

## Verify

```bash
npm test        # engine unit tests: coverage, scoring, tie-breaks, analyzer
npm run build   # frontend typecheck + production build
npm run smoke   # full e2e against the live project (needs app/.env filled)
```

## Security model (read before tweaking)

- **Identity = possession of a UUID.** Edge functions run with
  `--no-verify-jwt`; "who you are" is the `player_id` UUID the client sends,
  checked only for room membership (and `is_host` where required). Players
  store it in `localStorage`. This is acceptable for a no-accounts party game;
  it is **not** protection against a motivated client — do not reuse this
  model for anything where cheating matters.
- **The hidden layer is deny-by-default.** `question_deliveries`,
  `predictions`, `subject_answers` have no anon policies at all; bank weights,
  function tags and option→original mappings never leave the server.
  `round_results` is additionally gated by `revealed_at is not null` — the
  reveal is a server state transition, not a client unhide.
- **Accepted trade-off — enumeration**: the scoped `SELECT` policies on
  `rooms`/`players`/`rounds` (required so `postgres_changes` reaches anon
  clients; Realtime respects RLS) mean any anon key can list rooms and
  players. This data is non-sensitive; noted here as a deliberate choice.
- **Visibility matrix during the question loop**: the subject's answers are
  invisible to everyone (including whether they've voted) until the reveal.
  Whether each guesser has voted is shown by first name to the whole room (a
  party room can nudge its stragglers) — counts and names, never choices.
  Anonymous choice leanings (momentum bars) render for the host **and the
  subject** only: the subject is physically separated, so there is no herding
  risk; guessers never see leanings, which keeps votes independent
  (pillar: individual understanding beats group consensus).

## Game rules implemented

- The question loop is **discussion-driven, not clock-driven**: it advances when
  every connected **guesser** has voted (or the host forces "Next question" —
  the anti-AFK filet). The subject is separated from the room so they can't
  influence it: their answers are private, never gate the room's flow, and are
  never counted in the vote tally. The subject answers their own questionnaire
  in parallel (any question, catch-up allowed) — nobody sees their picks until
  the reveal. This is why a 2-player game works: a room of one guesser still
  moves as soon as that guesser votes. The per-question expiry is a far-future
  safety net, so debate is never cut mid-question.
  `rooms.question_timer_s` is kept for API compatibility but no longer gates
  anything.
- Questions and all four options render with the subject's first name in place
  of the bank's "X" placeholder (possessive `X's` handled; everyone, including
  the subject, reads the third person).

- 12 questions per round, selected server-side (≥3 weight per axis; unused
  preferred, used-set reset when the 60-question bank can't fill a round —
  option re-shuffling per delivery defeats memorized mappings).
- Type = per-axis sum of option weights; letter = higher pole (tie → E/S/T/J,
  documented in `engine.ts`). Group type = same math on majority-voted options.
- 1 point per individually correct prediction; no group-majority bonus.
- Best Predictor badge per round; tie-break = head-to-head, then join order.
- Missing answers never block a reveal — they score 0.

## Content

`app/src/content/types.ts` — 16 nicknames/taglines/celebrity lists (community
folklore attributions, always labeled **unofficial**) + original blurbs.
Avatars are original sliced art in `app/public/avatars/` (`[TYPE]_[MF].png`).
Regenerate with `npm run slice-avatars` from the root contact sheet.

The bank's `meta.selection.no_repeat_within_session` is **superseded** by the
used-set reset described above (decision recorded in `engine.ts` header).
