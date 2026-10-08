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
check('round has 12 question ids', Array.isArray(round1.question_ids) && round1.question_ids.length === 12);
check('subject is one of the players', players.some((p) => p.id === round1.subject_player_id));

const sr = await call('start-round', { room_id: room.id, player_id: pid(host) });
check('start-round 200 idx 0', sr.status === 200 && sr.data.idx === 0);

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
  }
}

console.log('— reveal gating —');
const rtClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
const early = await rtClient.from('round_results').select('*').eq('round_id', round1.id);
check('round_results hidden from anon before reveal', early.status === 200 && (early.data ?? []).length === 0, early.error?.message);

const cr = await call('compute-reveal', { room_id: room.id, player_id: pid(host) });
check('compute-reveal 200', cr.status === 200, JSON.stringify(cr.data));
const result = cr.data.result;
check('subject_type is a 4-letter type', /^[EI][SN][TF][JP]$/.test(result.subject_type), result.subject_type);
check('group_type present', /^[EI][SN][TF][JP]$/.test(result.group_type));
check('per_player_correct covers 4 predictors', Object.keys(result.per_player_correct).length === players.length - 1);
check('group_accuracy total is 12', result.group_accuracy?.total === 12);
check('analyzer is an array', Array.isArray(result.analyzer));
const again = await call('compute-reveal', { room_id: room.id, player_id: pid(host) });
check('idempotent re-call', again.status === 200 && again.data.result.round_id === result.round_id);

const late = await rtClient.from('round_results').select('*').eq('round_id', round1.id);
check('round_results visible after reveal', late.status === 200 && (late.data ?? []).length === 1);

const scores = await rtClient.from('players').select('id, total_score, best_predictor_badges').eq('room_id', room.id);
const scoreSum = (scores.data ?? []).reduce((a, p) => a + p.total_score, 0);
const expectedSum = Object.values(result.per_player_correct).reduce((a, b) => a + b, 0);
check('scores applied to players', scoreSum === expectedSum, `${scoreSum} != ${expectedSum}`);

console.log('— round 2 (subjects_limit=2) then leaderboard —');
const nr = await call('next-round', { room_id: room.id, player_id: pid(host) });
check('next-round starts round 2', nr.status === 200 && nr.data.round?.seq === 2);
const round2 = nr.data.round;

await call('start-round', { room_id: room.id, player_id: pid(host) });
for (let q = 0; q < 12; q++) {
  await call('submit-answer', { room_id: room.id, player_id: round2.subject_player_id, question_idx: q, chosen_index: q % 4 });
  for (const p of players) {
    if (p.id === round2.subject_player_id || p.id === joined[3].id) continue; // joined[3] stays silent -> partial scoring
    await call('submit-answer', { room_id: room.id, player_id: pid(p), question_idx: q, chosen_index: (q + 1) % 4 });
  }
  // joined[3] stays silent the whole round: without force, the loop would wait
  // on them forever — the host's force-advance (anti-AFK filet) carries it.
  const adv = await call('advance-question', { room_id: room.id, player_id: pid(host), force: true });
  if (adv.data.status === 'reveal') break;
}
await call('compute-reveal', { room_id: room.id, player_id: pid(host) });

const fin = await call('next-round', { room_id: room.id, player_id: pid(host) });
check('after last subject -> FINAL_LEADERBOARD', fin.data.room_status === 'FINAL_LEADERBOARD', JSON.stringify(fin.data));
check('leaderboard has 5 entries', (fin.data.leaderboard ?? []).length === 5);
const lb = fin.data.leaderboard ?? [];
const sorted = [...lb].sort((a, b) => b.total_score - a.total_score || b.best_predictor_badges - a.best_predictor_badges);
check('leaderboard ordered by score then badges', JSON.stringify(lb) === JSON.stringify(sorted));

console.log('— realtime —');
await new Promise((r) => setTimeout(r, 3000));
check('postgres_changes delivered (Realtime enabled)', realtimeEvents.length > 0, 'no rooms events — is Realtime enabled on this project?');

await rt.removeChannel(channel);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
