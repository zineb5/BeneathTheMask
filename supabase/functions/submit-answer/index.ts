// Beneath the Mask — submit-answer: the subject answers for real, everyone else predicts.

import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import { currentRound, loadRoom, API_VERSION, requirePlayer, serviceClient } from '../_shared/client.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requirePost(req);
    const body = await readBody(req);
    const roomId = requireString(body, 'room_id');
    const playerId = requireString(body, 'player_id');
    const questionIdx = body.question_idx;
    const chosenIndex = body.chosen_index;

    if (!Number.isInteger(chosenIndex) || (chosenIndex as number) < 0 || (chosenIndex as number) > 3) {
      throw new HttpError(400, 'chosen_index must be an integer between 0 and 3');
    }

    const sb = serviceClient();
    const room = await loadRoom(sb, roomId);
    const player = await requirePlayer(sb, roomId, playerId);
    const round = await currentRound(sb, room);
    if (!round) throw new HttpError(400, 'no active round');
    if (round.status !== 'question_loop') return json({ ok: false, reason: 'stale' });

    // The subject sits in a "separate room" answering their own questionnaire
    // at their own pace: any question of the round is acceptable (catch-up
    // allowed). Predictors vote the question currently on the room's screen.
    const isSubject = player.id === round.subject_player_id;
    if (isSubject) {
      if (!Number.isInteger(questionIdx) || (questionIdx as number) < 0 || (questionIdx as number) > 11) {
        return json({ ok: false, reason: 'invalid question_idx' });
      }
    } else if (questionIdx !== (round.current_question_idx ?? 0)) {
      return json({ ok: false, reason: 'stale' });
    }

    if (player.id === round.subject_player_id) {
      const { error } = await sb
        .from('subject_answers')
        .upsert(
          { round_id: round.id, question_idx: questionIdx, chosen_index: chosenIndex },
          { onConflict: 'round_id,question_idx' },
        );
      if (error) throw new HttpError(500, error.message);
    } else {
      const { error } = await sb
        .from('predictions')
        .upsert(
          { round_id: round.id, player_id: player.id, question_idx: questionIdx, chosen_index: chosenIndex },
          { onConflict: 'round_id,player_id,question_idx' },
        );
      if (error) throw new HttpError(500, error.message);
    }

    await sb.from('players').update({ last_seen_at: new Date().toISOString() }).eq('id', player.id);

    return json({ ok: true, version: API_VERSION });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
