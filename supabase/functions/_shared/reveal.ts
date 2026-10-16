// Beneath the Mask — shared reveal computation (engine v2.4.7, spec §4-§7).
//
// Extracted from compute-reveal so the reveal can be computed SERVER-SIDE at
// the exact moment advance-question flips the round to 'reveal', instead of
// relying on some client's browser to notice and call compute-reveal. The
// client-triggered path stays as an idempotent fallback (and for the manual
// force button), but it is no longer the single point of failure: UVTAC9
// round 2 sat on "Tallying the mask" for minutes with every client connected
// and authorized, because no client ever fired the trigger.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { analyzeMisread, scoreRound, ShuffledDelivery } from './engine.ts';
import {
  accumulate,
  axisSkeleton,
  buildRouteDeclaration,
  candidateDistribution,
  confidenceV2,
  consensusPerQuestion,
  groupAggregate,
  individualReadings,
  routeTargets,
  tippedAxes,
  UNLIKELY_THRESHOLD,
} from './engine_v2.ts';
import { HttpError } from './http.ts';
import { BANK_BY_ID, engineV2, type Room, type Round } from './client.ts';

/**
 * Compute the round reveal, apply scores, persist round_results. Idempotent:
 * if a revealed result already exists, it is returned as-is. Throws HttpError
 * on failure; callers decide how to surface it.
 */
// deno-lint-ignore no-explicit-any
export async function computeAndStoreReveal(sb: SupabaseClient, room: Room, round: Round): Promise<any> {
  // Idempotency: first reveal wins; later calls return the stored row as-is.
  const { data: existing } = await sb
    .from('round_results')
    .select('*')
    .eq('round_id', round.id)
    .not('revealed_at', 'is', null)
    .maybeSingle();
  if (existing) return existing;

  const [{ data: deliveries, error: dErr }, { data: sRows }, { data: pRows }, { count: playerCount }] = await Promise.all([
    sb.from('question_deliveries').select('*').eq('round_id', round.id).order('question_idx', { ascending: true }),
    sb.from('subject_answers').select('*').eq('round_id', round.id),
    sb.from('predictions').select('*').eq('round_id', round.id),
    sb.from('players').select('id', { count: 'exact', head: true }).eq('room_id', room.id),
  ]);
  if (dErr) throw new HttpError(500, dErr.message);

  // Tally audit line: how much evidence existed at reveal time. A guesser who
  // never voted does not block the tally (spec §4: abstention is allowed) —
  // but the shortfall must be VISIBLE in the logs, not silent.
  {
    const perQuestion = new Map<number, number>();
    for (const r of (pRows ?? []) as Array<{ question_idx: number }>) {
      perQuestion.set(r.question_idx, (perQuestion.get(r.question_idx) ?? 0) + 1);
    }
    const guessers = Math.max(0, (playerCount ?? 1) - 1);
    console.log(JSON.stringify({
      event: 'tally',
      trigger: 'server',
      room_id: room.id,
      round_id: round.id,
      subject_answers: (sRows ?? []).length,
      predictions: (pRows ?? []).length,
      expected_predictions: guessers * 12,
      votes_per_question: Object.fromEntries([...perQuestion.entries()].sort((a, b) => a[0] - b[0])),
    }));
  }

  const deliveriesTyped = (deliveries ?? []) as Array<{ shuffled_options: Array<{ i: number }> }>;
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

  // ---- Engine v2.4.7 (PR1): typing -------------------------------------------------
  const targets = routeTargets(engineV2);
  buildRouteDeclaration(engineV2, (round.question_ids ?? []) as number[]); // locked at build; recomputed identically
  const subjectAcc = accumulate(questions, engineDeliveries, subjectAnswers, engineV2);
  const subjectSkeleton = axisSkeleton(subjectAcc.axisSums);
  const askedGeneral = questions.filter((q) => !q.duel && !q.prediction_only);
  const askedDuels = questions.filter((q) => !!q.duel);
  const subjectDist = candidateDistribution(subjectAcc, askedGeneral, askedDuels, engineV2);
  const subjectConfidence = confidenceV2(subjectDist, subjectSkeleton, subjectAcc, questions, targets, engineV2);
  const subjectTipped = tippedAxes(subjectDist, subjectSkeleton);
  const subjectFns = (() => {
    const combined = (Object.keys(subjectAcc.dirSumsGeneral) as Array<keyof typeof subjectAcc.dirSumsGeneral>).map((fn) => ({
      fn,
      weight: subjectAcc.dirSumsGeneral[fn] + subjectAcc.dirSumsDuel[fn],
    }));
    return combined.sort((a, b) => b.weight - a.weight || a.fn.localeCompare(b.fn)).slice(0, 2).filter((f) => f.weight > 0);
  })();
  const subjectType = subjectDist.leader ?? 'ESTJ';

  // Group profile — spec §5 v2.6/review 18: THREE profiles, always computed.
  // INDIVIDUAL READINGS: each predictor through the SAME scoring pipeline as
  // the subject, separate accumulator set (a vote is a full claim, not a
  // probability — pilot-data amendment). GROUP AGGREGATE: unweighted mean of
  // VALID individual posteriors, renormalized — never a vote mixture. With 2
  // predictors reading ENFP and ISTJ the aggregate shows TWO peaks ("divided").
  const readings = individualReadings(questions, engineDeliveries, predictions, targets, engineV2);
  const aggregate = groupAggregate(readings, engineV2);
  const consensusProfile = consensusPerQuestion(questions, engineDeliveries, predictions);
  const groupType = aggregate.uniform ? null : (aggregate.probabilities[0]?.type ?? null);
  /** group confidence displayed from the aggregate leader's own probability;
   *  agreement controls narration, never computation (spec §5). */
  const groupLeaderP = aggregate.probabilities[0]?.probability ?? 0;

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
  // "Also suspected": surviving candidates that were not ruled unlikely,
  // best runner-ups first. "Unlikely": < 0.05, recoverable (spec §2).
  const alsoSuspected = subjectDist.probabilities
    .filter((p) => p.type !== subjectType && p.probability >= UNLIKELY_THRESHOLD)
    .slice(0, 3)
    .map((p) => p.type);
  const confidenceBand = subjectConfidence.band;

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
      per_axis: {
        subject: score.subjectAxisSums,
        group: score.groupAxisSums,
        // Engine v2 additions (additive keys in the existing jsonb column —
        // spec non-goal: no schema change).
        tipped_axes: subjectTipped,
        unlikely: subjectDist.unlikely,
        consensus: {
          value: consensusProfile.overallConsensus,
          per_question: consensusProfile.consensus,
        },
        presentation: subjectConfidence.band === 'Low' && subjectFns.length > 0 ? 'function_first' : 'archetype_first',
        top_functions: subjectFns,
        route_targets: buildRouteDeclaration(engineV2, (round.question_ids ?? []) as number[]).targetList,
        // Spec §5/§6: individual readings (PREDICTION GAPS — divergence proves
        // nothing about who was right) + agreement narration, stored per
        // predictor: answered/abstention counts + individual confidence.
        readings: aggregate.readings.map((r) => ({
          player_id: r.playerId,
          type: r.type,
          top_probability: r.topProbability,
          answered_count: r.answeredCount,
        })),
        abstentions: readings
          .filter((r) => r.abstentionCount > 0)
          .map((r) => ({ player_id: r.playerId, abstention_count: r.abstentionCount })),
        individual_confidence: readings
          .filter((r) => r.valid && r.individualConfidence)
          .map((r) => ({ player_id: r.playerId, band: r.individualConfidence!.band, value: r.individualConfidence!.value })),
        agreement: aggregate.agreement,
      },
      analyzer,
      group_accuracy: score.groupAccuracy,
      alternates: alsoSuspected,
      confidence: confidenceBand,
      subject_bonus: subjectBonus,
      group_bonus: groupBonus,
      top2: subjectDist.probabilities.slice(0, 2).map((p) => ({ type: p.type, score: p.probability })),
      type_confidence: subjectConfidence.value,
      group_top2: aggregate.uniform ? null : aggregate.probabilities.slice(0, 2).map((p) => ({ type: p.type, score: p.probability })),
      group_type_confidence: aggregate.uniform ? null : groupLeaderP,
    })
    .eq('round_id', round.id);
  if (uErr) throw new HttpError(500, uErr.message);

  const { data: result, error: sErr } = await sb
    .from('round_results')
    .select('*')
    .eq('round_id', round.id)
    .single();
  if (sErr) throw new HttpError(500, sErr.message);

  return result;
}
