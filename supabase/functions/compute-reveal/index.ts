// Beneath the Mask — compute-reveal (host or round controller): score the
// round, persist the reveal, apply points via the apply_round_scores RPC.
// Idempotent. The computation itself lives in _shared/reveal.ts and is ALSO
// invoked server-side by advance-question at the moment the round flips to
// 'reveal' — this endpoint is the idempotent fallback / manual force path.

import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import {
  currentRound,
  loadRoom,
  requirePlayer,
  resolveController,
  serviceClient,
} from '../_shared/client.ts';
import { computeAndStoreReveal } from '../_shared/reveal.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requirePost(req);
    const body = await readBody(req);
    const roomId = requireString(body, 'room_id');
    const playerId = requireString(body, 'player_id');

    const sb = serviceClient();
    // Tally authorization: the round controller OR the room host. The host
    // must be able to tally even when they are the subject (UVTAC9 deadlock:
    // host==subject -> controller-only guard 403'd the only client that ever
    // auto-triggers the tally, and the controller's client never called it).
    const room = await loadRoom(sb, roomId);
    const player = await requirePlayer(sb, roomId, playerId);
    const round = await currentRound(sb, room);
    if (!round) throw new HttpError(400, 'no active round');
    const controller = await resolveController(sb, room, round.subject_player_id);
    if (player.id !== room.host_player_id && (!controller || player.id !== controller.id)) {
      throw new HttpError(403, 'host or round controller only');
    }
    if (round.status !== 'reveal') throw new HttpError(400, 'round is not in reveal');

    const result = await computeAndStoreReveal(sb, room, round);
    return json({ result });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
