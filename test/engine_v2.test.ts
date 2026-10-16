// Beneath the Mask — engine v2.7.5 spec §9 testing route (bank v10.2).
// Every fixture below maps to a line of spec §9 (vitest fixtures list).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Bank, BankQuestion, ShuffledDelivery } from '../supabase/functions/_shared/engine';
import { AXES, isAbstainOption, mulberry32 } from '../supabase/functions/_shared/engine';
import {
  accumulate,
  axisFit,
  axisSkeleton,
  buildRouteDeclaration,
  candidateDistribution,
  candidateSet,
  channelEIG,
  confidenceV2,
  consensusPerQuestion,
  contextFromBank,
  derivedFnEvidence,
  duelEIG,
  duelFit,
  duelOptionFunction,
  duelOptionProbs,
  duelPredictive,
  effectiveWeight,
  entropyBits,
  expectedInformationGain,
  functionFit,
  groupAggregate,
  individualReadings,
  optionProbabilities,
  pairPosteriorAfterObserving,
  pairPrior,
  pairScore,
  revealFor,
  routeTargets,
  selectAdaptiveRoute,
  selectNextAdaptive,
  sensitivityMultiplier,
  stackPositionWeight,
  tippedAxes,
  DUEL_TAU,
  type EngineV2Context,
} from '../supabase/functions/_shared/engine_v2';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bank = JSON.parse(
  readFileSync(path.join(root, 'supabase/functions/_shared/bank.json'), 'utf8'),
) as Bank;
const ctx = contextFromBank(bank);
const identityDeliveries = (qs: BankQuestion[]): ShuffledDelivery[] =>
  qs.map((q) => ({ options: q.opts.map((_, i) => ({ i, t: q.opts[i].t })) }));

// --- Synthetic fixtures -----------------------------------------------------

function q(id: number, partial: Partial<BankQuestion> & Pick<BankQuestion, 'opts'>): BankQuestion {
  return { id, cat: 'test', q: `Q${id}?`, status: 'uncalibrated', ...partial };
}

describe('bank v10.2 sanity + §9 "weight 2 impossible uncalibrated"', () => {
  it('has 99 questions, all uncalibrated, zero weights at 2', () => {
    expect(bank.bank).toHaveLength(99);
    for (const item of bank.bank) {
      expect(item.opts).toHaveLength(4);
      expect(item.status).toBe('uncalibrated');
      for (const o of item.opts) {
        for (const w of Object.values(o.w ?? {})) expect(w).toBeLessThanOrEqual(1);
      }
    }
  });

  it('effectiveWeight: min(raw,1) unless validated_for_game_use', () => {
    expect(effectiveWeight(2, 'uncalibrated')).toBe(1);
    expect(effectiveWeight(2, undefined)).toBe(1);
    expect(effectiveWeight(2, 'pilot_tested')).toBe(1);
    expect(effectiveWeight(2, 'validated_for_game_use')).toBe(2);
    expect(effectiveWeight(1, 'uncalibrated')).toBe(1);
  });
});

describe('§2 candidate masking: decided letters mask, undeciding RECOVERS', () => {
  it('masks types contradicting decided letters and recovers them when the axis undecides', () => {
    // Strong E + strong S -> decided EI, SN.
    const sums = { E: 5, I: 1, S: 4, N: 1, T: 2, F: 2, J: 2, P: 2 };
    const skeleton = axisSkeleton(sums);
    expect(skeleton.EI.decided).toBe(true);
    expect(skeleton.SN.decided).toBe(true);
    const { candidates, masked } = candidateSet(skeleton, ctx);
    expect(candidates.every((t) => t[0] === 'E' && t[1] === 'S')).toBe(true);
    expect(candidates).toHaveLength(4);
    expect(masked).toHaveLength(12);
    expect(masked.find((m) => m.type === 'INFP')?.contradictions.sort()).toEqual(['EI', 'SN']);

    // New evidence drops both decided axes below the threshold -> every masked type RETURNS.
    const rebalanced = axisSkeleton({ E: 2, I: 2, S: 2, N: 2, T: 2, F: 2, J: 2, P: 2 });
    expect(rebalanced.EI.decided).toBe(false);
    expect(rebalanced.SN.decided).toBe(false);
    const recovered = candidateSet(rebalanced, ctx);
    expect(recovered.candidates).toHaveLength(16);
    expect(recovered.masked).toHaveLength(0);
  });
});

describe('§3 P(option|type): sums to 1, axes only', () => {
  it('sum(P(option|type)) == 1 for every question and type', () => {
    for (const item of bank.bank) {
      for (const type of Object.keys(ctx.stacks)) {
        const p = optionProbabilities(item, type, ctx);
        expect(p).toHaveLength(item.opts.length);
        expect(Math.abs(p.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-9);
      }
    }
  });

  it('P uses axes only: fn-only differences between options do not change the distribution', () => {
    const fnOnly = q(9000, {
      opts: [0, 1, 2, 3].map((i) => ({
        t: `o${i}`,
        w: {},
        b: ['possibility-exploration'],
        fn: i === 0 ? ({ Ni: 'high' } as const) : i === 1 ? ({ Se: 'high' } as const) : ({} as const),
      })),
    });
    const p0 = optionProbabilities(fnOnly, 'INTJ', ctx);
    const p1 = optionProbabilities(fnOnly, 'ESFP', ctx);
    expect(p0).toEqual(p1); // stacks differ wildly, axes carry nothing -> identical
  });

  it('options scoring the type\'s poles get higher probability', () => {
    const ei = bank.bank.find((b) => b.id === 2)!; // typing_route EI pair
    const pE = optionProbabilities(ei, 'ESTJ', ctx);
    const pI = optionProbabilities(ei, 'ISTJ', ctx);
    const bestForE = Math.max(...pE);
    const bestForI = Math.max(...pI);
    expect(bestForE).toBeGreaterThan(0.25);
    expect(bestForI).toBeGreaterThan(0.25);
  });
});

describe('§2 fits: all in [0,1] with zero guards', () => {
  const askedGeneral = bank.bank.filter((b) => !b.duel && !b.prediction_only).slice(0, 8);
  const askedDuels = bank.bank.filter((b) => !!b.duel).slice(0, 4);
  const askedAll = [...askedGeneral, ...askedDuels];
  const deliveries = identityDeliveries(askedAll);
  const answers = askedAll.map((_, i) => i % 4);

  it('axis_fit / function_fit / duel_fit stay in [0,1] over real answers', () => {
    const acc = accumulate(askedAll, deliveries, answers, ctx);
    const skeleton = axisSkeleton(acc.axisSums);
    for (const type of Object.keys(ctx.stacks)) {
      const af = axisFit(type, skeleton);
      const ff = functionFit(type, acc, askedGeneral, ctx);
      const df = duelFit(type, acc, askedDuels, ctx);
      expect(af).toBeGreaterThanOrEqual(0);
      expect(af).toBeLessThanOrEqual(1);
      expect(ff).toBeGreaterThanOrEqual(0);
      expect(ff).toBeLessThanOrEqual(1);
      expect(df).toBeGreaterThanOrEqual(0);
      expect(df).toBeLessThanOrEqual(1);
    }
  });

  it('ZERO GUARD: a stack with no matching evidence gets function_fit 0, never NaN', () => {
    const noEvidence = q(9100, {
      opts: [0, 1, 2, 3].map((i) => ({
        t: `o${i}`,
        w: i === 0 ? ({ E: 1 } as const) : ({} as const),
        b: ['possibility-exploration'], // Ne/Se only
      })),
    });
    const acc = accumulate([noEvidence], identityDeliveries([noEvidence]), [0], ctx);
    // INTJ stack (Ni,Te) has zero possible support in this route.
    expect(functionFit('INTJ', acc, [noEvidence], ctx)).toBe(0);
    expect(duelFit('INTJ', acc, [], ctx)).toBe(0);
  });
});

describe('§1 accumulator separation: duel fn never double-counts', () => {
  it('explicit duel fn lands in dirSums_duel only; derived evidence stays general-only', () => {
    const duelQ = bank.bank.find((b) => b.id === 67)!; // Ni/Ne duel
    const pick = duelQ.opts.findIndex((o) => Object.keys(o.fn ?? {}).length > 0);
    const acc = accumulate([duelQ], identityDeliveries([duelQ]), [pick], ctx);
    expect(acc.duelLog).toHaveLength(1);
    const duelFns = acc.duelLog[0].fns.map((f) => f.fn);
    for (const fn of duelFns) {
      expect(acc.dirSumsDuel[fn]).toBeGreaterThan(0);
      expect(acc.dirSumsGeneral[fn]).toBe(0); // never double-counted
    }
    // A non-duel question contributes to general only.
    const plain = bank.bank.find((b) => b.id === 1)!;
    const acc2 = accumulate([plain], identityDeliveries([plain]), [0], ctx);
    const genFns = Object.entries(acc2.dirSumsGeneral).filter(([, v]) => v > 0).map(([k]) => k);
    expect(genFns.length).toBeGreaterThan(0);
    expect(Object.values(acc2.dirSumsDuel).every((v) => v === 0)).toBe(true);
  });

  it('context sensitivity: high-sensitivity constructs carry a 0.5 multiplier', () => {
    expect(sensitivityMultiplier({ context_sensitivity: 'high' })).toBe(0.5);
    expect(sensitivityMultiplier({ context_sensitivity: 'moderate' })).toBe(0.75);
    expect(sensitivityMultiplier({})).toBe(1);
    expect(sensitivityMultiplier(undefined)).toBe(1);
    const opt = { t: 'x', b: ['solitude-preference'] }; // marked high in bank meta
    const ev = derivedFnEvidence(opt, ctx);
    expect(ev.Fi).toBe(0.5 * 0.5); // low (0.5) x sensitivity (0.5)
  });
});

describe('§1/§7 route_targets locked before answers', () => {
  it('route targets are the 4 axis signal constructs, fixed for the bank', () => {
    const targets = routeTargets(ctx);
    expect(Object.keys(targets).sort()).toEqual([...AXES].sort());
    expect(new Set(Object.values(targets)).size).toBe(4);
  });

  it('attempting to change them mid-round fails: the declaration ignores answers entirely', () => {
    const rng = mulberry32(11);
    const { questions } = selectAdaptiveRoute(ctx, new Set(), rng);
    const ids = questions.map((x) => x.id);
    const before = buildRouteDeclaration(ctx, ids);
    // Simulate a mid-round mutation attempt: new answers, different tau context.
    const mutatedCtx = contextFromBank(bank, { tau: 0.2 });
    const after = buildRouteDeclaration(mutatedCtx, ids);
    expect(after).toEqual(before);
    expect(before.targetList).toHaveLength(4);
  });
});

describe('§5 three profiles (v2.6/review 18): individual readings + mean aggregate', () => {
  // Fixture: the first THREE questions carry the only axis weight (E/I with
  // different surface constructs); the rest are fn-only filler, so each
  // individual reading is a sharp E-types-vs-I-types posterior.
  const ei = (id: number, bE: string, bI: string): BankQuestion =>
    q(id, {
      opts: [
        { t: 'E', w: { E: 1 }, b: [bE] },
        { t: 'I', w: { I: 1 }, b: [bI] },
        { t: 'x', w: {}, b: ['possibility-exploration'] },
        { t: 'no clue', w: {}, b: ['non-diagnostic'] },
      ],
    });
  const mixed: BankQuestion[] = [
    ei(9600, 'social-initiation', 'solitude-preference'),
    ei(9601, 'stimulation-seeking', 'reflective-processing'),
    ei(9602, 'social-initiation', 'solitude-preference'),
    ...Array.from({ length: 9 }, (_, i) =>
      q(9610 + i, {
        opts: [
          { t: 'o0', w: {}, b: ['possibility-exploration'] },
          { t: 'o1', w: {}, b: ['possibility-exploration'] },
          { t: 'o2', w: {}, b: ['possibility-exploration'] },
          { t: 'no clue', w: {}, b: ['non-diagnostic'] },
        ],
      }),
    ),
  ];
  const deliveries = identityDeliveries(mixed);
  const targets = routeTargets(ctx);

  it('a 4/7-3/7 split keeps BOTH sides in the group profile (mean of posteriors, not majority)', () => {
    const predictions = new Map<string, Array<number | null>>();
    for (let i = 0; i < 7; i++) {
      predictions.set(`p${i}`, mixed.map((_, qi) => (qi < 3 ? (i < 4 ? 0 : 1) : 2)));
    }
    const readings = individualReadings(mixed, deliveries, predictions, targets, ctx);
    expect(readings.filter((r) => r.valid)).toHaveLength(7);
    const aggregate = groupAggregate(readings, ctx);
    // Two distinct individual leaders (E-types vs I-types): the honest mean
    // shows the division instead of inventing a hybrid midpoint.
    const leaderLetters = new Set(aggregate.readings.map((r) => r.type[0]));
    expect(leaderLetters.size).toBeGreaterThanOrEqual(2);
    expect(aggregate.uniform).toBe(false);
    expect(aggregate.probabilities.reduce((s, p) => s + p.probability, 0)).toBeCloseTo(1, 9);
    // Consensus reflects the 4/7-3/7 vote on question 0.
    const consensus = consensusPerQuestion(mixed, deliveries, predictions);
    expect(consensus.consensus[0]).toBeCloseTo(1 - entropyBits([4 / 7, 3 / 7, 0, 0]) / 2, 5);
  });

  it('1 predictor -> the group posterior IS their own', () => {
    const predictions = new Map<string, Array<number | null>>([
      ['solo', mixed.map((_, qi) => (qi < 3 ? 0 : 2))],
    ]);
    const readings = individualReadings(mixed, deliveries, predictions, targets, ctx);
    const aggregate = groupAggregate(readings, ctx);
    const own = readings[0].profile!.probabilities;
    for (const p of aggregate.probabilities) {
      expect(p.probability).toBeCloseTo(own.find((x) => x.type === p.type)?.probability ?? 0, 9);
    }
  });

  it('2 opposed predictors -> two peaks (divided), no invented hybrid', () => {
    const predictions = new Map<string, Array<number | null>>([
      ['proE', mixed.map((_, qi) => (qi < 3 ? 0 : 3))],
      ['proI', mixed.map((_, qi) => (qi < 3 ? 1 : 3))],
    ]);
    const readings = individualReadings(mixed, deliveries, predictions, targets, ctx);
    const aggregate = groupAggregate(readings, ctx);
    expect(aggregate.agreement).toBe('divided');
    const [r1, r2] = aggregate.readings;
    // The leaders genuinely disagree on the E/I pole...
    expect(r1.type[0]).not.toBe(r2.type[0]);
    // ...and the mean posterior splits its mass across the two poles instead
    // of inventing a hybrid midpoint (spec §5: two peaks, "divided").
    const eMass = aggregate.probabilities.filter((p) => p.type[0] === 'E').reduce((s, p) => s + p.probability, 0);
    expect(eMass).toBeGreaterThan(0.35);
    expect(eMass).toBeLessThan(0.65);
    // Both individual leaders hold real mass in the aggregate.
    for (const r of [r1, r2]) {
      const p = aggregate.probabilities.find((x) => x.type === r.type)!.probability;
      expect(p).toBeGreaterThan(1 / 16); // above uniform: the reading survives
    }
    // Sanity: the aggregate is still a normalized distribution.
    expect(aggregate.probabilities.reduce((s, p) => s + p.probability, 0)).toBeCloseTo(1, 9);
  });

  it('all-abstain -> uniform + consensus 0', () => {
    // Every predictor picks the no-clue option on every question: invalid
    // readers, uniform aggregate, consensus 0 (spec §5 + §4 abstention).
    const allNoClue = mixed.map((q) => q.opts.findIndex(isAbstainOption));
    expect(allNoClue.every((i) => i >= 0)).toBe(true);
    const predictions = new Map<string, Array<number | null>>([
      ['a1', allNoClue],
      ['a2', allNoClue],
    ]);
    const readings = individualReadings(mixed, deliveries, predictions, targets, ctx);
    expect(readings.every((r) => !r.valid)).toBe(true);
    expect(readings.reduce((s, r) => s + r.abstentionCount, 0)).toBe(mixed.length * 2);
    const aggregate = groupAggregate(readings, ctx);
    expect(aggregate.uniform).toBe(true);
    expect(aggregate.probabilities).toHaveLength(16);
    for (const p of aggregate.probabilities) expect(p.probability).toBeCloseTo(1 / 16, 9);
    const consensus = consensusPerQuestion(mixed, deliveries, predictions);
    expect(consensus.consensus.every((c) => c === 0)).toBe(true);
    expect(consensus.overallConsensus).toBe(0);
  });

  it('valid predictor = >= 1 real typing answer AND not entirely abstaining', () => {
    // ghost: no-clue everywhere -> invalid, abstentions counted. real: one
    // real E answer + no-clue elsewhere -> valid with answeredCount 1.
    const noClue = mixed.map((q) => q.opts.findIndex(isAbstainOption));
    const predictions = new Map<string, Array<number | null>>([
      ['ghost', noClue],
      ['real', [0, ...noClue.slice(1)]],
    ]);
    const readings = individualReadings(mixed, deliveries, predictions, targets, ctx);
    const byPlayer = new Map(readings.map((r) => [r.playerId, r]));
    expect(byPlayer.get('ghost')!.valid).toBe(false);
    expect(byPlayer.get('ghost')!.abstentionCount).toBe(mixed.length);
    expect(byPlayer.get('real')!.valid).toBe(true);
    expect(byPlayer.get('real')!.answeredCount).toBe(1);
    expect(byPlayer.get('real')!.abstentionCount).toBe(mixed.length - 1);
  });
});

// ---------------------------------------------------------------------------
// Spec §3 channel 2 — duel mathematics (reviews 19-23)
// ---------------------------------------------------------------------------

describe('§3 channel 2 — duel mathematics', () => {
  const DUELS = [67, 69, 71, 73].map((id) => bank.bank.find((b) => b.id === id)!);
  const axisIdx = (a: string) => (a === 'EI' ? 0 : a === 'SN' ? 1 : a === 'TF' ? 2 : 3);
  const empty = (): ReturnType<typeof accumulate> => accumulate([], [], [], ctx);

  it('Q67/Q69/Q71/Q73: axis-EIG ~ 0 AND duel-EIG > 0 when the pair is unsettled', () => {
    const cases: Array<[BankQuestion, string, string]> = [
      [DUELS[0], 'SN', 'N'],
      [DUELS[1], 'TF', 'T'],
      [DUELS[2], 'TF', 'F'],
      [DUELS[3], 'SN', 'S'],
    ];
    for (const [q, axis, letter] of cases) {
      const current = Object.keys(ctx.stacks)
        .filter((t) => t[axisIdx(axis)] === letter)
        .map((type) => ({ type, probability: 1 / 8 }));
      const axisEig = expectedInformationGain(q, current, ctx);
      const duelEig = duelEIG(q, current, empty(), ctx);
      expect(Math.abs(axisEig)).toBeLessThan(1e-9); // axis-free by design (review 17)
      expect(duelEig).toBeGreaterThan(1e-6); // the duel channel sees the value
    }
  });

  it('settled pair -> duel-EIG ~ 0', () => {
    const q67 = DUELS[0];
    const niIdx = q67.opts.findIndex((o) => duelOptionFunction(o, q67.duel ?? []) === 'Ni');
    // Six Ni answers: dirSums_duel[Ni] = 6 — the pair belief is settled, so
    // the current uncertainty is ~0 and another Ni/Ne duel adds nothing.
    const qs = Array.from({ length: 6 }, () => q67);
    const acc = accumulate(qs, identityDeliveries(qs), qs.map(() => niIdx), ctx);
    const current = Object.keys(ctx.stacks).map((type) => ({ type, probability: 1 / 16 }));
    const unsettled = duelEIG(q67, current, empty(), ctx);
    const settled = duelEIG(q67, current, acc, ctx);
    expect(settled).toBeLessThan(unsettled);
    expect(settled).toBeLessThan(0.05);
  });

  it('sum(P_duel) == 1 for the four duels x all 16 types', () => {
    for (const q of DUELS) {
      for (const t of Object.keys(ctx.stacks)) {
        const p = duelOptionProbs(q, t, empty(), ctx);
        expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      }
    }
  });

  it('pair_score = stack_position_weight + beta * dirSums_duel; weights 2/1/0.5/0', () => {
    expect(stackPositionWeight('INTJ', 'Ni', ctx)).toBe(2);
    expect(stackPositionWeight('INTJ', 'Te', ctx)).toBe(1);
    expect(stackPositionWeight('INTJ', 'Fi', ctx)).toBe(0.5);
    expect(stackPositionWeight('INTJ', 'Se', ctx)).toBe(0);
    expect(stackPositionWeight('INTJ', 'Ne', ctx)).toBe(0);
    expect(pairScore('INTJ', 'Ni', empty(), ctx)).toBe(2);
    const withDuel = accumulate([DUELS[0]], identityDeliveries([DUELS[0]]), [0], ctx);
    expect(pairScore('INTJ', 'Ni', withDuel, ctx)).toBeCloseTo(2 + withDuel.dirSumsDuel.Ni, 9);
  });

  it('Bayesian update: pair_posterior(o) ∝ prior x P_duel(o|f), normalized over the pair', () => {
    const q67 = DUELS[0];
    const prior: [number, number] = [0.7, 0.3];
    const post = pairPosteriorAfterObserving(q67, 0, prior, empty(), ctx);
    expect(duelOptionFunction(q67.opts[0], q67.duel ?? [])).toBe('Ni');
    const l1 = Math.exp(2 / DUEL_TAU);
    const l2 = Math.exp(1 / DUEL_TAU);
    expect(post[0]).toBeCloseTo((prior[0] * l1) / (prior[0] * l1 + prior[1] * l2), 9);
    expect(post[0] + post[1]).toBeCloseTo(1, 9);
    expect(post[0]).toBeGreaterThan(prior[0]);
    // A no-clue option is uninformative: posterior == prior.
    const noClue = q67.opts.findIndex(isAbstainOption);
    expect(noClue).toBeGreaterThanOrEqual(0);
    const postNC = pairPosteriorAfterObserving(q67, noClue, prior, empty(), ctx);
    expect(postNC[0]).toBeCloseTo(prior[0], 12);
  });

  it('P_predictive is a candidate mixture and sums to 1', () => {
    const q67 = DUELS[0];
    const current = candidateDistribution(
      accumulate([bank.bank[0]], identityDeliveries([bank.bank[0]]), [0], ctx),
      [bank.bank[0]],
      [],
      ctx,
    ).probabilities;
    const mix = duelPredictive(q67, current, empty(), ctx);
    expect(mix.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('AXIS ISOLATION: function evidence changes P_axis by exactly 0', () => {
    const q67 = DUELS[0];
    const current = Object.keys(ctx.stacks).map((type) => ({ type, probability: 1 / 16 }));
    const before = expectedInformationGain(q67, current, ctx);
    const rich = accumulate([q67, q67], identityDeliveries([q67, q67]), [0, 0], ctx);
    const after = expectedInformationGain(q67, current, ctx);
    expect(after).toBeCloseTo(before, 12);
    // The duel channel reacts to the same evidence — two distributions.
    expect(duelEIG(q67, current, rich, ctx)).not.toBeCloseTo(duelEIG(q67, current, empty(), ctx), 6);
    // And the channel router sends function duels to channel 2:
    expect(channelEIG(q67, current, rich, ctx)).toBeCloseTo(duelEIG(q67, current, rich, ctx), 12);
  });

  it('pair prior is the candidate-mixture stack compatibility (review 22)', () => {
    const q67 = DUELS[0];
    // Candidates where Ni is dominant (INTJ/INFJ) at 50/50: prior favors Ni.
    const current = [
      { type: 'INTJ', probability: 0.5 },
      { type: 'INFJ', probability: 0.5 },
    ];
    const [pNi] = pairPrior(q67, current, ctx);
    expect(pNi).toBeGreaterThan(0.5);
    // Uniform current: Ni sits somewhere in the stacks, prior reflects the
    // bank's stack composition — and always sums to 1.
    const u = pairPrior(q67, Object.keys(ctx.stacks).map((type) => ({ type, probability: 1 / 16 })), ctx);
    expect(u[0] + u[1]).toBeCloseTo(1, 9);
  });
});

describe('§7 confidence: all-undecided cap (Moderate ceiling)', () => {
  it('a process-based result never exceeds Moderate when every axis is undecided', () => {
    // 12 balanced E/I questions: every axis margin stays <= 0.20 (undecided),
    // while duel evidence is strong enough to push candidates apart.
    const balanced: BankQuestion[] = Array.from({ length: 12 }, (_, i) =>
      q(9200 + i, {
        duel: ['Ni', 'Ne'],
        opts: [0, 1, 2, 3].map((k) => ({
          t: `o${k}`,
          w: k < 2 ? ({ E: 1, I: 1 } as const) : ({} as const),
          b: ['possibility-exploration'],
          fn: k === 0 ? ({ Ni: 'high' } as const) : k === 1 ? ({ Ne: 'high' } as const) : ({} as const),
        })),
      }),
    );
    const deliveries = identityDeliveries(balanced);
    const answers = balanced.map(() => 0); // all Ni-side duel picks, perfectly split axes
    const acc = accumulate(balanced, deliveries, answers, ctx);
    const skeleton = axisSkeleton(acc.axisSums);
    for (const axis of AXES) expect(skeleton[axis].decided).toBe(false);
    const dist = candidateDistribution(acc, [], balanced, ctx);
    const targets = routeTargets(ctx);
    const confidence = confidenceV2(dist, skeleton, acc, balanced, targets, ctx);
    expect(confidence.value).toBeLessThanOrEqual(0.69);
    if (confidence.value > 0.4) {
      expect(confidence.band).toBe('Moderate');
    } else {
      expect(confidence.band).toBe('Low');
    }
  });

  it('the cap is the only difference: identical evidence WITH a decided axis can reach High', () => {
    // 12 one-sided questions: E, N, T, P picks (3 per axis) -> all four axes decided.
    const poleOf = (i: number) => (['E', 'N', 'T', 'P'] as const)[Math.floor(i / 3)];
    const oneSided: BankQuestion[] = Array.from({ length: 12 }, (_, i) => {
      const pole = poleOf(i);
      return q(9300 + i, {
        opts: [
          { t: pole, w: { [pole]: 1 }, b: ['social-initiation'] },
          { t: 'other', w: {}, b: ['solitude-preference'] },
          { t: 'x', w: {}, b: ['possibility-exploration'] },
          { t: 'y', w: {}, b: ['mechanism-analysis'] },
        ],
      });
    });
    const deliveries = identityDeliveries(oneSided);
    const answers = oneSided.map(() => 0);
    const acc = accumulate(oneSided, deliveries, answers, ctx);
    const skeleton = axisSkeleton(acc.axisSums);
    expect(AXES.every((a) => skeleton[a].decided)).toBe(true);
    const dist = candidateDistribution(acc, oneSided, [], ctx);
    const confidence = confidenceV2(dist, skeleton, acc, oneSided, routeTargets(ctx), ctx);
    expect(confidence.allUndecidedCapped).toBe(false);
    // Single surviving candidate -> margin 1 -> High band.
    expect(confidence.band).toBe('High');
    expect(confidence.value).toBeGreaterThan(0.69);
  });
});

describe('§3 adaptive selection: coverage floor, no duplicates, entropy fallback', () => {
  it('100 draws: 12 distinct questions, >=3 effective weight per axis, deterministic per seed', () => {
    for (let seed = 0; seed < 100; seed++) {
      const { questions } = selectAdaptiveRoute(ctx, new Set(), mulberry32(seed));
      expect(questions).toHaveLength(12);
      expect(new Set(questions.map((x) => x.id)).size).toBe(12);
      for (const axis of AXES) {
        const total = questions.reduce((sum, x) => {
          const [p1, p2] = axis === 'EI' ? ['E', 'I'] : axis === 'SN' ? ['S', 'N'] : axis === 'TF' ? ['T', 'F'] : ['J', 'P'];
          return sum + Math.max(...x.opts.map((o) => (o.w?.[p1 as 'E'] ?? 0) + (o.w?.[p2 as 'I'] ?? 0)));
        }, 0);
        expect(total).toBeGreaterThanOrEqual(3);
      }
    }
    const a = selectAdaptiveRoute(ctx, new Set(), mulberry32(42));
    const b = selectAdaptiveRoute(ctx, new Set(), mulberry32(42));
    expect(a.questions.map((x) => x.id)).toEqual(b.questions.map((x) => x.id));
  });

  it('serves under-covered axes first (priority 2), then max EIG', () => {
    const rng = mulberry32(5);
    const chosen: BankQuestion[] = [];
    const answers: Array<number | null> = [];
    const vias: string[] = [];
    for (let i = 0; i < 12; i++) {
      const pick = selectNextAdaptive(ctx, new Set(), chosen, answers, rng);
      expect(pick).not.toBeNull();
      vias.push(pick!.via);
      chosen.push(pick!.question);
      answers.push(null);
    }
    // Every coverage serve (family probe or needed axis) happens before any
    // pure-EIG pick; by the time the selector switches to EIG every axis has
    // >=2 opportunities (a single question can cover two axes, so 3 picks may
    // suffice). Channel 3 (family probe, spec §3) is part of the coverage
    // prefix and fires first while family evidence is untouched.
    const firstEig = vias.indexOf('max_eig');
    expect(vias.slice(0, firstEig).every((v) => v === 'needed_axis' || v === 'family_probe')).toBe(true);
    const opportunities: Record<string, number> = { EI: 0, SN: 0, TF: 0, JP: 0 };
    for (const x of chosen.slice(0, firstEig)) {
      for (const axis of AXES) {
        const [p1, p2] = axis === 'EI' ? ['E', 'I'] : axis === 'SN' ? ['S', 'N'] : axis === 'TF' ? ['T', 'F'] : ['J', 'P'];
        if (Math.max(...x.opts.map((o) => (o.w?.[p1 as 'E'] ?? 0) + (o.w?.[p2 as 'I'] ?? 0))) > 0) opportunities[axis] += 1;
      }
    }
    expect(Object.values(opportunities).every((n) => n >= 2)).toBe(true);
  });

  it('exhausted pool -> entropy fallback still returns a question', () => {
    // One-question bank that is already used: the used-set reset kicks in and
    // the pick still lands (max-EIG on the only question with real signal).
    const tiny = contextFromBank({ meta: bank.meta, bank: [bank.bank[0]] });
    const pick = selectNextAdaptive(tiny, new Set([bank.bank[0].id]), [], [], mulberry32(1));
    expect(pick).not.toBeNull();
    expect(pick!.question.id).toBe(bank.bank[0].id);
    expect(pick!.resetUsed).toBe(true);
  });

  it('exhausted DISCRIMINATIVE bank -> via entropy_fallback (spec §9 fixture)', () => {
    // Every remaining question is fully non-diagnostic: zero channel-EIG, so
    // the selector falls back to the question's own option entropy. Four
    // options per question (bank invariant) — the Laplace constant 1.20 in
    // optionProbabilities is spec-literal for 4-option items (§3).
    const flat = contextFromBank({
      meta: bank.meta,
      bank: [
        { id: 9101, cat: 'test', q: 'spent', opts: [{ t: 'a', w: { E: 1 }, b: ['social-initiation'] }, { t: 'b', w: {} }, { t: 'c', w: {} }, { t: 'd', w: {} }] },
        {
          id: 9102,
          cat: 'test',
          q: 'fallback A',
          opts: [
            { t: 'w', w: {}, b: ['non-diagnostic'] },
            { t: 'x', w: {}, b: ['non-diagnostic'] },
            { t: 'y', w: {}, b: ['non-diagnostic'] },
            { t: 'z', w: {}, b: ['non-diagnostic'] },
          ],
        },
        {
          id: 9103,
          cat: 'test',
          q: 'fallback B',
          opts: [
            { t: 'w', w: {}, b: ['non-diagnostic'] },
            { t: 'x', w: {}, b: ['non-diagnostic'] },
            { t: 'y', w: {}, b: ['non-diagnostic'] },
            { t: 'z', w: {}, b: ['non-diagnostic'] },
          ],
        },
      ],
    });
    const chosen = [flat.bank.bank[0]];
    const pick = selectNextAdaptive(flat, new Set(), chosen, [0], mulberry32(7));
    expect(pick).not.toBeNull();
    expect(pick!.via).toBe('entropy_fallback');
  });

  it('EIG is non-negative and zero for a fully unscored (prediction-only-style) question', () => {
    const current = Object.keys(ctx.stacks).map((type) => ({ type, probability: 1 / 16 }));
    const unscored = q(9400, {
      prediction_only: true,
      opts: [0, 1, 2, 3].map((i) => ({ t: `o${i}`, w: {}, b: ['possibility-exploration'] })),
    });
    expect(expectedInformationGain(unscored, current, ctx)).toBe(0);
    const real = bank.bank[3];
    expect(expectedInformationGain(real, current, ctx)).toBeGreaterThan(0);
  });
});

describe('§6 low confidence -> function pattern first, not acronym', () => {
  // 4-axis fixture with BOTH poles scored: E/I, S/N, T/F, J/P (2 questions per
  // axis) — so balanced picks genuinely balance each axis.
  const POLES4: Array<[string, string, string, string]> = [
    ['E', 'I', 'social-initiation', 'solitude-preference'],
    ['N', 'S', 'possibility-exploration', 'routine-anchored'],
    ['T', 'F', 'mechanism-analysis', 'emotional-attunement'],
    ['P', 'J', 'impulse-follow', 'systematic-execution'],
  ];
  const balanced: BankQuestion[] = Array.from({ length: 8 }, (_, i) => {
    const [pole, opposite, bPole, bOpp] = POLES4[Math.floor(i / 2)];
    return q(9500 + i, {
      opts: [
        { t: pole, w: { [pole]: 1 }, b: [bPole] },
        { t: opposite, w: { [opposite]: 1 }, b: [bOpp] },
        { t: 'x', w: {}, b: ['possibility-exploration'] },
        { t: 'y', w: {}, b: ['mechanism-analysis'] },
      ],
    });
  });
  const deliveries = identityDeliveries(balanced);

  it('presentation flips to function_first only when the band is Low', () => {
    // One pole pick + one opposite pick per axis -> every axis margin 0 (undecided).
    const balancedPicks = balanced.map((_, i) => (Math.floor(i / 2) % 2 === 0 ? i % 2 : (i + 1) % 2));
    const reveal = revealFor(balanced, deliveries, balancedPicks, routeTargets(ctx), ctx);
    expect(reveal.confidence.band).not.toBe('High');
    expect(reveal.confidence.value).toBeLessThanOrEqual(0.69); // cap holds whether or not it fired
    if (reveal.confidence.band === 'Low') {
      expect(reveal.presentation).toBe('function_first');
      expect(reveal.topFunctions.length).toBeGreaterThan(0);
    } else {
      expect(reveal.presentation).toBe('archetype_first');
    }
    // One-sided picks on all four axes -> single candidate -> High -> archetype first.
    const oneSided: BankQuestion[] = Array.from({ length: 12 }, (_, i) => {
      const pole = (['E', 'N', 'T', 'P'] as const)[Math.floor(i / 3)];
      return q(9600 + i, {
        opts: [
          { t: pole, w: { [pole]: 1 }, b: ['social-initiation'] },
          { t: 'other', w: {}, b: ['solitude-preference'] },
          { t: 'x', w: {}, b: ['possibility-exploration'] },
          { t: 'y', w: {}, b: ['mechanism-analysis'] },
        ],
      });
    });
    const confident = revealFor(oneSided, identityDeliveries(oneSided), oneSided.map(() => 0), routeTargets(ctx), ctx);
    expect(confident.confidence.band).toBe('High');
    expect(confident.presentation).toBe('archetype_first');
  });
});

describe('§2 reveal assembly end-to-end on the real bank', () => {
  it('aligned INTP-style answers surface INTP among the top candidates', () => {
    const { questions } = selectAdaptiveRoute(ctx, new Set(), mulberry32(2026));
    const deliveries = questions.map((x, i) => ({
      options: x.opts.map((_, j) => ({ i: j, t: x.opts[j].t })),
    }));
    const answers = questions.map((x) => {
      let best = 0;
      let bestW = -1;
      x.opts.forEach((o, j) => {
        const w = o.w ?? {};
        const score = (w.I ?? 0) + (w.N ?? 0) + (w.T ?? 0) + (w.P ?? 0);
        if (score > bestW) {
          bestW = score;
          best = j;
        }
      });
      return best;
    });
    const reveal = revealFor(questions, deliveries, answers, routeTargets(ctx), ctx);
    expect(reveal.type).toMatch(/^[EI][SN][TF][JP]$/);
    expect(reveal.probabilities.length).toBeGreaterThanOrEqual(1);
    expect(reveal.confidence.value).toBeGreaterThanOrEqual(0);
    expect(reveal.confidence.value).toBeLessThanOrEqual(1);
    // Fully aligned picks decide all four axes: INTP is the only surviving candidate.
    if (reveal.probabilities.length === 1) {
      expect(reveal.type).toBe('INTP');
    } else {
      const top = reveal.probabilities.slice(0, 3).map((p) => p.type);
      expect(top).toContain('INTP');
    }
  });

  it('prediction_only questions (Q27) never contribute typing evidence', () => {
    const q27 = bank.bank.find((b) => b.id === 27)!;
    const acc = accumulate([q27], identityDeliveries([q27]), [0], ctx);
    expect(acc.scoredAnswers).toBe(0);
    expect(acc.constructLog).toHaveLength(0);
    expect(Object.values(acc.axisSums).every((v) => v === 0)).toBe(true);
  });

  it('undecided axis tipped by process evidence is LABELED, never silently flipped (§2)', () => {
    // Two opposing E/I answers -> EI margin 0 (undecided). Whichever letter the
    // leader carries, a tip label appears only when the raw pole disagrees;
    // the invariant under test: labels carry both poles and a human sentence.
    const q1 = bank.bank.find((b) => b.id === 1)!;
    const q2 = bank.bank.find(
      (b) => !b.duel && !b.prediction_only && b.id !== 1 &&
        b.opts.some((o) => (o.w?.E ?? 0) > 0) && b.opts.some((o) => (o.w?.I ?? 0) > 0),
    )!;
    const both = [q1, q2];
    const answers = [
      q1.opts.findIndex((o) => (o.w?.I ?? 0) > 0),
      q2.opts.findIndex((o) => (o.w?.E ?? 0) > 0),
    ];
    const acc = accumulate(both, identityDeliveries(both), answers, ctx);
    const dist = candidateDistribution(acc, both, [], ctx);
    const tipped = tippedAxes(dist, axisSkeleton(acc.axisSums));
    expect(dist.probabilities.reduce((s, p) => s + p.probability, 0)).toBeCloseTo(1, 9);
    for (const t of tipped) {
      expect(t.selected).not.toBe(t.evidencePole);
      expect(t.label.length).toBeGreaterThan(10);
    }
  });
});

describe('§4 NO CLUE = abstention (bank v10.2 marker)', () => {
  it('no-clue options are detected and are never typing evidence', () => {
    let count = 0;
    for (const item of bank.bank) {
      for (const o of item.opts) if (isAbstainOption(o)) count++;
    }
    expect(count).toBeGreaterThanOrEqual(39);
    // Q67 carries two no-clue rows; picking one adds nothing but abstentions.
    const q67 = bank.bank.find((b) => b.id === 67)!;
    const noClue = q67.opts.findIndex(isAbstainOption);
    const acc = accumulate([q67], identityDeliveries([q67]), [noClue], ctx);
    expect(acc.abstentions).toBe(1);
    expect(acc.scoredAnswers).toBe(0);
    expect(Object.values(acc.dirSumsDuel).every((v) => v === 0)).toBe(true);
    expect(Object.values(acc.dirSumsGeneral).every((v) => v === 0)).toBe(true);
    expect(acc.axisSums).toEqual({ E: 0, I: 0, S: 0, N: 0, T: 0, F: 0, J: 0, P: 0 });
  });
});
