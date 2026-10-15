// One-off inspection of room UVTAC9 via the anon key (rooms/players/rounds are anon-readable).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(
  readFileSync(path.join(root, 'app', '.env'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);

const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const { data: room } = await sb.from('rooms').select('*').eq('code', 'UVTAC9').maybeSingle();
if (!room) { console.log('room UVTAC9 not found'); process.exit(0); }
console.log('ROOM', JSON.stringify(room, null, 1));

const { data: players } = await sb.from('players').select('*').eq('room_id', room.id).order('created_at');
console.log('PLAYERS');
for (const p of players ?? []) {
  console.log(` ${p.display_name} host=${p.is_host} connected=${p.connected} subject_order=${p.subject_order_idx} last_seen=${p.last_seen_at}`);
}

const { data: rounds } = await sb.from('rounds').select('*').eq('room_id', room.id).order('seq');
console.log('ROUNDS');
for (const r of rounds ?? []) {
  console.log(` seq=${r.seq} status=${r.status} subject=${r.subject_player_id} idx=${r.current_question_idx} q_ids=${(r.question_ids ?? []).length}`);
}

const { data: results } = await sb.from('round_results').select('round_id, revealed_at, subject_type, group_type').eq('round_id', rounds?.at(-1)?.id ?? '').maybeSingle();
console.log('LAST ROUND RESULT', JSON.stringify(results));
