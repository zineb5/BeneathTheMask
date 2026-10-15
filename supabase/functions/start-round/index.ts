// Beneath the Mask — start-round (round controller only): begin the question
// loop for the room's current round (must be status 'intro'). The controller
// is resolved dynamically: the host while eligible (connected, non-subject,
// fresh heartbeat), else the first connected non-subject by join time.

import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import { QUESTION_WINDOW_MS, requireController, serviceClient } from '../_shared/client.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requirePost(req);
    const body = await readBody(req);
    const roomId = requireString(body, 'room_id');
    const playerId = requireString(body, 'player_id');

    const sb = serviceClient();
    const { room, round } = await requireController(sb, roomId, playerId);
    if (round.status !== 'intro') throw new HttpError(400, 'round is not in intro');

    // Far-future window: the loop advances on all-voted/force, never on the clock.
    const endsAt = new Date(Date.now() + QUESTION_WINDOW_MS).toISOString();

    const { error: dErr } = await sb
      .from('question_deliveries')
      .update({ ends_at: endsAt })
      .eq('round_id', round.id)
      .eq('question_idx', 0);
    if (dErr) throw new HttpError(500, dErr.message);

    const { error: rErr } = await sb
      .from('rounds')
      .update({ status: 'question_loop', current_question_idx: 0 })
      .eq('id', round.id);
    if (rErr) throw new HttpError(500, rErr.message);

    const { error: rmErr } = await sb.from('rooms').update({ status: 'QUESTION_LOOP' }).eq('id', room.id);
    if (rmErr) throw new HttpError(500, rmErr.message);

    return json({ round_id: round.id, idx: 0, ends_at: endsAt });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
