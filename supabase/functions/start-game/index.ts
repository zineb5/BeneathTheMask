// Beneath the Mask — start-game (host only): shuffle the subject order, build round 1.

import { mulberry32 } from '../_shared/engine.ts';
import { handleOptions, HttpError, json, readBody, requirePost, requireString, hashSeed } from '../_shared/http.ts';
import { createRoundWithDeliveries, Player, requireHost, serviceClient } from '../_shared/client.ts';

function seededShuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requirePost(req);
    const body = await readBody(req);
    const roomId = requireString(body, 'room_id');
    const playerId = requireString(body, 'player_id');

    const sb = serviceClient();
    const { room } = await requireHost(sb, roomId, playerId);
    if (room.status !== 'LOBBY') throw new HttpError(400, 'game already started');

    const { data: rosterRows, error } = await sb
      .from('players')
      .select('*')
      .eq('room_id', room.id)
      .order('id'); // deterministic pre-shuffle order
    if (error) throw new HttpError(500, error.message);
    const roster = (rosterRows ?? []) as Player[];
    if (roster.length < 2) throw new HttpError(400, 'need at least 4 players to start');

    const order = seededShuffle(
      roster.map((p) => p.id),
      mulberry32(hashSeed(room.id + room.created_at)),
    );
    const subjects = room.subjects_limit != null ? order.slice(0, room.subjects_limit) : order;
    if (subjects.length === 0) throw new HttpError(400, 'no subjects available');

    for (let i = 0; i < subjects.length; i++) {
      const { error: uErr } = await sb
        .from('players')
        .update({ subject_order_idx: i })
        .eq('id', subjects[i]);
      if (uErr) throw new HttpError(500, uErr.message);
    }

    const round = await createRoundWithDeliveries(sb, room, subjects[0], room.current_round_seq + 1);
    return json({ round });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
