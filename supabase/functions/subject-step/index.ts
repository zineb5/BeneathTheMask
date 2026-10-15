// Beneath the Mask — subject-step: the subject's PRIVATE navigation through
// their own questionnaire. Selecting an answer never moves them (they may
// change their mind); they step forward/back with this function, independent
// of the room's current_question_idx. Subject only.

import { handleOptions, HttpError, json, readBody, requirePost } from '../_shared/http.ts';
import {
  API_VERSION,
  currentRound,
  ensureDelivery,
  loadRoom,
  questionPayload,
  requirePlayer,
  serviceClient,
  voteCounts,
} from '../_shared/client.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requirePost(req);
    const body = await readBody(req);
    const roomId = body.room_id;
    const playerId = body.player_id;
    const rawDelta = typeof body.delta === 'number' && Number.isFinite(body.delta) ? Math.trunc(body.delta) : 1;
    const delta = rawDelta < 0 ? -1 : 1; // only prev/next, one step at a time

    const sb = serviceClient();
    const room = await loadRoom(sb, roomId);
    const player = await requirePlayer(sb, roomId, playerId);
    const round = await currentRound(sb, room);
    if (!round) throw new HttpError(404, 'no active round');
    if (round.status !== 'question_loop') return json({ status: round.status, version: API_VERSION });
    if (player.id !== round.subject_player_id) throw new HttpError(403, 'subject only');

    const nextIdx = Math.min(11, Math.max(0, (round.subject_idx ?? 0) + delta));
    await sb.from('rounds').update({ subject_idx: nextIdx }).eq('id', round.id);

    // Engine v2 PR2: the subject may browse ahead of the room — create the
    // delivery on demand (adaptively selected from their answers so far).
    const delivery = await ensureDelivery(sb, roomId, round, nextIdx);
    const counts = await voteCounts(sb, room, round, round.current_question_idx ?? 0);
    return json({
      ...questionPayload(delivery),
      ...counts,
      room_idx: round.current_question_idx ?? 0,
      version: API_VERSION,
    });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
