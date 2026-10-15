// Beneath the Mask — compute-reveal (round controller only): score the round,
// persist the reveal, apply points via the apply_round_scores RPC. Idempotent.

import { analyzeMisread, alternatesFromAxisSums, rankTypesV2, scoreRound, ShuffledDelivery } from '../_shared/engine.ts';
import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import {
  BANK_BY_ID,
  bank,
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
    const { round } = await requireController(sb, roomId, playerId);
    if (round.status !== 'reveal') throw new HttpError(400, 'round is not in reveal');

    // Idempotency: first reveal wins; later calls return the stored row as-is.
    const { data: existing } = await sb
      .from('round_results')
      .select('*')
      .eq('round_id', round.id)
      .not('revealed_at', 'is', null)
      .maybeSingle();
    if (existing) return json({ result: existing });

    const [{ data: deliveries, error: dErr }, { data: sRows }, { data: pRows }] = await Promise.all([
      sb.from('question_deliveries').select('*').eq('round_id', round.id).order('question_idx', { ascending: true }),
      sb.from('subject_answers').select('*').eq('round_id', round.id),
      sb.from('predictions').select('*').eq('round_id', round.id),
    ]);
    if (dErr) throw new HttpError(500, dErr.message);

    const deliveriesTyped = (deliveries ?? []) as Delivery[];
    const engineDeliveries: ShuffledDelivery[] = deliveriesTyped.map((d) => ({ options: d.shuffled_options }));
    const questions = ((round.question_ids ?? []) as number[]).map((id) => {
      const q = BANK_BY_ID.get(id);
      if (!q) throw new HttpError(500, `bank question ${id} not found`);
      return q;
    });

    const subjectAnswers: Array<number | null> = Array(12).fill(null);
    for (const r of (sRows ?? []) as Array<{ question_idx: number; chosen_index: number }>) {
      if (r.question_idx >= 0 && r.question_idx < 12) subjectAnswers[r.question_idx] = r.chosen_index;
    }
    const predictions = new Map<string, Array<number | null>>();
    for (const r of (pRows ?? []) as Array<{ player_id: string; question_idx: number; chosen_index: number }>) {
      let arr = predictions.get(r.player_id);
      if (!arr) {
        arr = Array(12).fill(null);
        predictions.set(r.player_id, arr);
      }
      if (r.question_idx >= 0 && r.question_idx < 12) arr[r.question_idx] = r.chosen_index;
    }

    const score = scoreRound({ questions, deliveries: engineDeliveries, subjectAnswers, predictions });
    const stacks = ((bank.meta.functions as { stacks?: Record<string, string[]> } | undefined)?.stacks ?? {});
    const subjectRanking = rankTypesV2(questions, engineDeliveries, subjectAnswers, stacks);
    const groupAnswers = score.majorityOrig.map((original, i) =>
      original === null ? null : engineDeliveries[i].options.findIndex((option) => option.i === original),
    );
    const groupRanking = rankTypesV2(questions, engineDeliveries, groupAnswers, stacks);
    const subjectType = subjectRanking.top2[0]?.type ?? score.subjectType;
    const groupType = score.groupType === null ? null : (groupRanking.top2[0]?.type ?? score.groupType);
    // Scoring, per the house rules:
    //  - each guesser scores their exact-answer predictions (per_player_correct);
    //  - the SUBJECT earns +1 when the room's inferred type differs from theirs;
    //  - the GROUP (every guesser) earns +1 when its inferred type matches.
    const subjectBonus = groupType !== null && subjectType !== groupType ? 1 : 0;
    const groupBonus = groupType !== null && groupType === subjectType ? 1 : 0;
    const awardedScores: Record<string, number> = { ...score.perPlayerCorrect };
    for (const pid of Object.keys(awardedScores)) awardedScores[pid] += groupBonus;
    if (subjectBonus) awardedScores[round.subject_player_id] = (awardedScores[round.subject_player_id] ?? 0) + subjectBonus;
    const analyzer = analyzeMisread(
      questions,
      engineDeliveries,
      subjectAnswers,
      score.majorityOrig,
      subjectType,
      groupType,
    );
    const { alternates, confidence } = alternatesFromAxisSums(score.subjectAxisSums);

    // Head-to-head deltas among the players tied at the max correct count:
    // each pairing awards +1 to the side that won more of the 12 head-to-heads.
    const origOf = (i: number, chosen: number | null | undefined): number | null => {
      if (typeof chosen !== 'number') return null;
      return engineDeliveries[i]?.options[chosen]?.i ?? null;
    };
    const subjectOrig = engineDeliveries.map((_, i) => origOf(i, subjectAnswers[i]));
    const counts = Object.values(score.perPlayerCorrect);
    const maxCorrect = Math.max(0, ...counts);
    const tied = Object.entries(score.perPlayerCorrect)
      .filter(([, c]) => c === maxCorrect)
      .map(([pid]) => pid);

    const headToHead: Record<string, Record<string, number>> = {};
    for (let a = 0; a < tied.length; a++) {
      for (let b = a + 1; b < tied.length; b++) {
        const pa = predictions.get(tied[a]);
        const pb = predictions.get(tied[b]);
        if (!pa || !pb) continue;
        let wa = 0;
        let wb = 0;
        for (let i = 0; i < engineDeliveries.length; i++) {
          const oa = origOf(i, pa[i]);
          const ob = origOf(i, pb[i]);
          const ca = oa !== null && oa === subjectOrig[i];
          const cb = ob !== null && ob === subjectOrig[i];
          if (ca && !cb) wa++;
          else if (cb && !ca) wb++;
        }
        if (wa > wb) {
          (headToHead[tied[a]] ??= {})[tied[b]] = ((headToHead[tied[a]] ?? {})[tied[b]] ?? 0) + 1;
        } else if (wb > wa) {
          (headToHead[tied[b]] ??= {})[tied[a]] = ((headToHead[tied[b]] ?? {})[tied[a]] ?? 0) + 1;
        }
      }
    }

    const { error: rpcErr } = await sb.rpc('apply_round_scores', {
      p_round_id: round.id,
      p_per_player_correct: awardedScores,
      p_best_predictor: score.bestPredictor,
      p_head_to_head: headToHead,
    });
    if (rpcErr) throw new HttpError(500, rpcErr.message);

    const { error: uErr } = await sb
      .from('round_results')
      .update({
        group_type: groupType,
        subject_type: subjectType,
        per_axis: { subject: score.subjectAxisSums, group: score.groupAxisSums },
        analyzer,
        group_accuracy: score.groupAccuracy,
        alternates,
        confidence,
        subject_bonus: subjectBonus,
        group_bonus: groupBonus,
        top2: subjectRanking.top2,
        type_confidence: subjectRanking.confidence,
        group_top2: groupRanking.top2,
        group_type_confidence: groupRanking.confidence,
      })
      .eq('round_id', round.id);
    if (uErr) throw new HttpError(500, uErr.message);

    const { data: result, error: sErr } = await sb
      .from('round_results')
      .select('*')
      .eq('round_id', round.id)
      .single();
    if (sErr) throw new HttpError(500, sErr.message);

    return json({ result });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
