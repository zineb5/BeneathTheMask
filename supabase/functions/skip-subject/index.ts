// Beneath the Mask — skip-subject (round controller only): end the current
// round WITHOUT a reveal (subject AFK / not workable). Predictions already
// made still score, partial over the questions already asked; the subject is
// never re-quoted. Then the room moves to the next subject or the final
// leaderboard (shared tail with next-round).

import { scoreRound, ShuffledDelivery } from '../_shared/engine.ts';
import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import {
  advanceAfterRound,
  BANK_BY_ID,
  Delivery,
  requireController,
  serviceClient,
} from '../_shared/client.ts';

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
    if (round.status !== 'intro' && round.status !== 'question_loop') {
      throw new HttpError(400, 'round cannot be skipped now');
    }

    // Partial scoring over the questions already asked (0..current idx).
    const askedIdx = round.current_question_idx ?? 0;
    const [{ data: deliveries }, { data: sRows }, { data: pRows }] = await Promise.all([
      sb.from('question_deliveries').select('*').eq('round_id', round.id).lte('question_idx', askedIdx).order('question_idx', { ascending: true }),
      sb.from('subject_answers').select('*').eq('round_id', round.id),
      sb.from('predictions').select('*').eq('round_id', round.id).lte('question_idx', askedIdx),
    ]);

    const deliveriesTyped = (deliveries ?? []) as Delivery[];
    const engineDeliveries: ShuffledDelivery[] = deliveriesTyped.map((d) => ({ options: d.shuffled_options }));
    const askedIds = deliveriesTyped.map((d) => d.question_id);
    const questions = askedIds.map((id) => {
      const q = BANK_BY_ID.get(id);
      if (!q) throw new HttpError(500, `bank question ${id} not found`);
      return q;
    });

    const subjectAnswers: Array<number | null> = Array(deliveriesTyped.length).fill(null);
    for (const r of (sRows ?? []) as Array<{ question_idx: number; chosen_index: number }>) {
      if (r.question_idx >= 0 && r.question_idx < deliveriesTyped.length) subjectAnswers[r.question_idx] = r.chosen_index;
    }
    const predictions = new Map<string, Array<number | null>>();
    for (const r of (pRows ?? []) as Array<{ player_id: string; question_idx: number; chosen_index: number }>) {
      let arr = predictions.get(r.player_id);
      if (!arr) {
        arr = Array(deliveriesTyped.length).fill(null);
        predictions.set(r.player_id, arr);
      }
      if (r.question_idx >= 0 && r.question_idx < deliveriesTyped.length) arr[r.question_idx] = r.chosen_index;
    }

    const score = scoreRound({ questions, deliveries: engineDeliveries, subjectAnswers, predictions });
    const { error: rpcErr } = await sb.rpc('apply_round_scores', {
      p_round_id: round.id,
      p_per_player_correct: score.perPlayerCorrect,
      p_best_predictor: score.bestPredictor,
      p_head_to_head: {},
    });
    if (rpcErr) throw new HttpError(500, rpcErr.message);

    const { error: sErr } = await sb.from('rounds').update({ status: 'SKIPPED' }).eq('id', round.id);
    if (sErr) throw new HttpError(500, sErr.message);

    return json(await advanceAfterRound(sb, room, round));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
