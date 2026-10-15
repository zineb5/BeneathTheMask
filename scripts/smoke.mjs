// Beneath the Mask — end-to-end smoke test against a LIVE Supabase project.
// Exercises the full game loop with synthetic clients: create -> join x4 ->
// update-room -> start-game -> 12 questions (subject answers + predictions +
// advance) -> reveal gating -> compute-reveal -> next-round -> leaderboard.
// Also verifies Realtime delivery (postgres_changes) — fails loudly if the
// project's Realtime is off.
//
// Setup: fill app/.env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY), then `npm run smoke`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadEnv() {
  const out = {};
  try {
    const raw = readFileSync(path.join(root, 'app', '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* fall through to process.env */
  }
  return out;
}

const envFile = loadEnv();
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || envFile.VITE_SUPABASE_URL || '';
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || envFile.VITE_SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !ANON_KEY || SUPABASE_URL.includes('YOUR-PROJECT')) {
  console.error('Missing configuration. Fill app/.env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY) first.');
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function call(name, body, attempt = 0) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } catch (err) {
    // Hosted edge gateways occasionally drop a TLS connection under rapid
    // sequential calls — every smoke call is upsert/idempotent, so a retry
    // is safe. Retry network-level failures only, never HTTP error statuses.
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      return call(name, body, attempt + 1);
    }
    throw err;
  }
}

const HUES = ['#6F63B8', '#2E8B6E', '#46586E', '#D98E2B', '#C94F6D'];
const NAMES = ['Ada', 'Bruce', 'Cleo', 'Dmitri', 'Eve'];

// Realtime listener (validates postgres_changes delivery for anon clients).
const rt = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
let realtimeEvents = [];
let roomFilterId = null;
const channel = rt
  .channel('smoke-room')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, (p) => {
    if (roomFilterId && p.new?.id === roomFilterId) realtimeEvents.push(p);
  })
  .subscribe();

console.log('— create/join —');
const created = await call('create-room', {
  display_name: NAMES[0], hue: HUES[0], avatar_variant: 'F', question_timer_s: 30, subjects_limit: null,
});
check('create-room 200', created.status === 200, JSON.stringify(created.data));
const { room, player: host } = created.data;
roomFilterId = room.id;

const joined = [];
for (let i = 1; i < 5; i++) {
  const r = await call('join-room', { code: room.code, display_name: NAMES[i], hue: HUES[i], avatar_variant: i % 2 ? 'M' : 'F' });
  check(`join-room #${i} 200`, r.status === 200);
  joined.push(r.data.player);
}
const players = [host, ...joined];
const pid = (p) => p.id;

const upd = await call('update-room', { room_id: room.id, player_id: pid(host), question_timer_s: 33, subjects_limit: 2 });
check('update-room 200 + timer persisted', upd.status === 200 && upd.data.room.question_timer_s === 33);

const notHost = await call('start-game', { room_id: room.id, player_id: pid(joined[0]) });
check('start-game rejected for non-host', notHost.status === 403);

console.log('— round 1 —');
const sg = await call('start-game', { room_id: room.id, player_id: pid(host) });
check('start-game 200', sg.status === 200, JSON.stringify(sg.data));
const round1 = sg.data.round;
// Engine v2 PR2 (adaptive routes): only delivery 0 exists at round build; the
// remaining 11 deliveries are selected from the subject's answers as the room
// advances. question_ids grows accordingly and is complete (12) by the reveal.
check('round starts with its first question id', Array.isArray(round1.question_ids) && round1.question_ids.length === 1);
check('subject is one of the players', players.some((p) => p.id === round1.subject_player_id));
// Dynamic round controller (no DB column): host unless the host IS the
// subject, else the first connected non-subject by join time. All smoke
// players are fresh (last_seen_at = join), so join order decides.
const controllerOf = (round) => (round.subject_player_id === pid(host) ? pid(joined[0]) : pid(host));
const c1 = controllerOf(round1);
check('round controller resolved and never the subject', c1 !== round1.subject_player_id);

// start-round is controller-only.
const sr = await call('start-round', { room_id: room.id, player_id: c1 });
check('start-round 200 idx 0 (by controller)', sr.status === 200 && sr.data.idx === 0);
const startDenied = await call('start-round', { room_id: room.id, player_id: pid(host) });
check(
  'start-round rejected for non-controller',
  c1 === pid(host) ? startDenied.status === 400 : startDenied.status === 403,
  JSON.stringify(startDenied.data),
);

const stepFwd = await call('subject-step', { room_id: room.id, player_id: round1.subject_player_id, delta: 1 });
check('subject-step moves the subject privately', stepFwd.status === 200 && stepFwd.data.idx === 1);
const stepBack = await call('subject-step', { room_id: room.id, player_id: round1.subject_player_id, delta: -1 });
check('subject-step can go back', stepBack.status === 200 && stepBack.data.idx === 0);
const stepDenied = await call('subject-step', { room_id: room.id, player_id: pid(joined[0]), delta: 1 });
check('subject-step forbidden for guessers', stepDenied.status === 403);

for (let q = 0; q < 12; q++) {
  const pick = (seed) => (seed + q) % 4;
  const sIdx = pick(1);
  const sub = await call('submit-answer', { room_id: room.id, player_id: round1.subject_player_id, question_idx: q, chosen_index: sIdx });
  if (q === 0) check('subject submit ok', sub.status === 200 && sub.data.ok === true);
  for (const p of players) {
    if (p.id === round1.subject_player_id) continue;
    await call('submit-answer', { room_id: room.id, player_id: pid(p), question_idx: q, chosen_index: pick(2) });
  }
  const stale = await call('submit-answer', { room_id: room.id, player_id: pid(joined[0]), question_idx: 99, chosen_index: 0 });
  if (q === 0) check('stale question_idx rejected softly', stale.status === 200 && stale.data.ok === false);

  if (q === 11) {
    // Gating check must run BEFORE the q12 advance: since the server-side
    // tally fix, the very advance call that flips the round to 'reveal' also
    // computes and stores the result — there is no longer any window where
    // the round is in reveal with results still hidden.
    const rtPre = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const early = await rtPre.from('round_results').select('*').eq('round_id', round1.id);
    check('round_results hidden from anon before reveal', early.status === 200 && (early.data ?? []).length === 0, early.error?.message);
  }

  const adv = await call('advance-question', { room_id: room.id, player_id: pid(joined[1]) });
  if (q < 11) {
    if (adv.data.status !== 'question' || adv.data.idx !== q + 1) {
      check(`advance to q${q + 1}`, false, JSON.stringify(adv.data));
      break;
    }
    if (q === 0) {
      check('advance returns question payload', typeof adv.data.q === 'string' && adv.data.options.length === 4);
      check('payload leaks no weights', !JSON.stringify(adv.data).match(/"(w|fn|b|dni)":/));
      check('vote tally reflects the room only', typeof adv.data.answered === 'number' && adv.data.expected === 4);
      check('vote status names the room', Array.isArray(adv.data.voted) && Array.isArray(adv.data.pending));
    }
  } else {
    check('advance after q12 returns reveal', adv.data.status === 'reveal', JSON.stringify(adv.data));
    // Server-side tally: the reveal must already be stored by the same
    // advance call — no client-side trigger needed (UVTAC9 round 2 fix).
    const rtPost = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const stored = await rtPost.from('round_results').select('round_id').eq('round_id', round1.id).not('revealed_at', 'is', null);
    check('server-side tally stored at reveal flip', (stored.data ?? []).length === 1, stored.error?.message);
  }
}

console.log('— reveal gating —');
const rtClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

const cr = await call('compute-reveal', { room_id: room.id, player_id: c1 });
check('compute-reveal 200', cr.status === 200, JSON.stringify(cr.data));
const result = cr.data.result;
check('subject_type is a 4-letter type', /^[EI][SN][TF][JP]$/.test(result.subject_type), result.subject_type);
check('group_type present', /^[EI][SN][TF][JP]$/.test(result.group_type));
// Deliveries are anon-hidden; rounds are anon-readable — question_ids is the
// route declaration handle and must be complete (12 distinct ids) at reveal.
const roundFinal = await rtClient.from('rounds').select('question_ids').eq('room_id', room.id).eq('seq', 1).single();
const routeIds = roundFinal.data?.question_ids ?? [];
check(
  'adaptive route complete: 12 distinct question ids',
  routeIds.length === 12 && new Set(routeIds).size === 12,
  JSON.stringify(routeIds),
);
check('per_player_correct covers the 4 predictors (subject joins when bonused)', Object.keys(result.per_player_correct).length >= players.length - 1);
check('subject bonus rule consistent', (result.subject_type !== result.group_type) === (result.subject_bonus === 1));
check('group bonus rule consistent', (result.subject_type === result.group_type) === (result.group_bonus === 1));
check('group_accuracy total is 12', result.group_accuracy?.total === 12);
check('analyzer is an array', Array.isArray(result.analyzer));
const again = await call('compute-reveal', { room_id: room.id, player_id: c1 });
check('idempotent re-call', again.status === 200 && again.data.result.round_id === result.round_id);

const late = await rtClient.from('round_results').select('*').eq('round_id', round1.id);
check('round_results visible after reveal', late.status === 200 && (late.data ?? []).length === 1);

const scores = await rtClient.from('players').select('id, total_score, best_predictor_badges').eq('room_id', room.id);
const scoreSum = (scores.data ?? []).reduce((a, p) => a + p.total_score, 0);
const expectedSum = Object.values(result.per_player_correct).reduce((a, b) => a + b, 0);
check('scores applied to players', scoreSum === expectedSum, `${scoreSum} != ${expectedSum}`);

console.log('— round 2 (subjects_limit=2) — skip-subject flow —');
const nr = await call('next-round', { room_id: room.id, player_id: c1 });
check('next-round starts round 2', nr.status === 200 && nr.data.round?.seq === 2);
const round2 = nr.data.round;
const c2 = controllerOf(round2);
check('round 2 controller resolved and never its subject', c2 !== round2.subject_player_id);

await call('start-round', { room_id: room.id, player_id: c2 });

// q0: EVERY guesser votes (whoever the shuffled subject is) -> auto-advance.
await call('submit-answer', { room_id: room.id, player_id: round2.subject_player_id, question_idx: 0, chosen_index: 0 });
for (const p of players) {
  if (p.id === round2.subject_player_id) continue;
  await call('submit-answer', { room_id: room.id, player_id: pid(p), question_idx: 0, chosen_index: 1 });
}
const adv0 = await call('advance-question', { room_id: room.id, player_id: c2 });
check('auto-advance once every guesser voted', adv0.status === 200 && adv0.data.idx === 1, JSON.stringify(adv0.data));

// q1: one guesser stays silent — force by a NON-controller must work too
// (advance is open to every participant; the CAS is the real gate).
const straggler = players.find((p) => p.id !== round2.subject_player_id && p.id !== c2);
await call('submit-answer', { room_id: room.id, player_id: round2.subject_player_id, question_idx: 1, chosen_index: 1 });
for (const p of players) {
  if (p.id === round2.subject_player_id || p.id === straggler.id) continue;
  await call('submit-answer', { room_id: room.id, player_id: pid(p), question_idx: 1, chosen_index: 2 });
}
const nonController2 = players.find((p) => p.id !== c2 && p.id !== round2.subject_player_id);
const advForce = await call('advance-question', { room_id: room.id, player_id: nonController2.id, force: true });
check('force advance open to any participant', advForce.status === 200 && advForce.data.idx === 2, JSON.stringify(advForce.data));

// skip-subject: controller only; no reveal for the subject; partial scores kept.
const skipDenied = await call('skip-subject', { room_id: room.id, player_id: nonController2.id });
check('skip-subject rejected for non-controller', skipDenied.status === 403, JSON.stringify(skipDenied.data));
const skipped = await call('skip-subject', { room_id: room.id, player_id: c2 });
check(
  'skip-subject closes the room (last subject)',
  skipped.status === 200 && skipped.data.room_status === 'FINAL_LEADERBOARD',
  JSON.stringify(skipped.data),
);
const rr2 = await rtClient.from('round_results').select('*').eq('round_id', round2.id);
check(
  'skipped round keeps scores but has no reveal types',
  rr2.status === 200 && (rr2.data ?? []).length === 1 && !rr2.data[0].subject_type && !rr2.data[0].group_type,
  JSON.stringify(rr2.data),
);
const lb = skipped.data.leaderboard ?? [];
check('leaderboard has 5 entries after skip', lb.length === 5);
const sorted = [...lb].sort((a, b) => b.total_score - a.total_score || b.best_predictor_badges - a.best_predictor_badges);
check('leaderboard ordered by score then badges', JSON.stringify(lb) === JSON.stringify(sorted));

console.log('— realtime —');
await new Promise((r) => setTimeout(r, 3000));
check('postgres_changes delivered (Realtime enabled)', realtimeEvents.length > 0, 'no rooms events — is Realtime enabled on this project?');

await rt.removeChannel(channel);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
