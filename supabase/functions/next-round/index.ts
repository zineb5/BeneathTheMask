// Beneath the Mask — next-round (round controller only): either deals the next
// subject a new round, or closes the room with the final leaderboard. Shared
// tail with skip-subject (advanceAfterRound in _shared/client.ts).

import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import { advanceAfterRound, requireController, serviceClient } from '../_shared/client.ts';

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
    if (room.status !== 'ROUND_REVEAL') throw new HttpError(400, 'room is not in ROUND_REVEAL');
    if (round.status !== 'reveal') throw new HttpError(400, 'round is not revealed');

    return json(await advanceAfterRound(sb, room, round));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
