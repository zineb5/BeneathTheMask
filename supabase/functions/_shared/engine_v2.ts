// Beneath the Mask — ENGINE V2 (spec v2.4.7 FROZEN, bank v9.9.2).
//
// PR1 = scoring (spec §1, §2, §5, §7). PR2 = adaptive selection (spec §3).
// Pure TypeScript: no Deno/node APIs. Consumed by edge functions (Deno) and vitest (node).
//
// DEVIATION RULE (owner doctrine): any behavior here that contradicts
// engine_v2_spec.md is a bug in THIS file. The spec is never "fixed" by
// improvising. Where the spec leaves a derivation undefined, the concrete rule
// is written out in a comment block marked DECISION and reported to the owner.
//
// DECISION LOG (derivations the spec does not spell out, chosen + documented):
//  D1. duel question = question carrying a `duel` field (family probes and
//      pair duels). Duel options accrue their EXPLICIT fn tags to dirSums_duel
//      ONLY (spec §1 "duel strongs ONLY"; §9 "duel fn never double-counts").
//  D2. non-duel options ignore their bank-level fn tags for scoring; their fn
//      evidence is DERIVED from b constructs via meta.functions.behavior_to_function
//      (bank meta anti_circularity: evidence is never assigned directly to an
//      option). The bank fn tags stay lineage documentation.
//  D3. context sensitivity: behavior_to_function entries marked
//      context_sensitivity:"high" multiply by 0.5, "moderate" by 0.75
//      (spec §1); unmarked constructs multiply by 1. The bank currently marks
//      5 high-sensitivity constructs; inventing marks would violate doctrine.
//  D4. function_fit max_possible(T) = sum over asked (non-duel, scored)
//      questions of the best single option's stack support 2*dom+aux for T.
//      duel_fit max_possible(T) = sum over asked duel questions of the best
//      single option's stack support for T (any stack fn, FN_WEIGHT-graded).
//  D5. route_targets = the bank's 4 axis signal constructs (one per axis,
//      derived from the signal taxonomy). Locked at round build: the derivation
//      takes the round's selected question ids, never answers, so no mid-round
//      answer can change it (spec §1 review 14 + §9 fixture).
//  D6. item_reliability: the bank has no reliability data (all uncalibrated),
//      so every item contributes the neutral prior 0.5 until pilot data fills
//      ctx.reliability. A neutral prior adds no fake certainty.
//  D7. tau = 0.15 (spec band 0.1-0.2 at pilot; midpoint, frozen constant).
//  D8. Adaptive selection is live and sequential: delivery k+1 is chosen from
//      the SUBJECT's answers to 0..k (the evidence the engine exists to read).
//      When the subject has not answered yet, the posterior is uniform. The
//      selection is a pure function of (bank, usedIds, chosenSoFar, answersSoFar,
//      rng) so concurrent creators converge on identical deliveries.
//      OBSERVED LEAK (reported, not fixed): guessers can see the question
//      sequence, which weakly reflects the subject's earlier axis evidence.
//      EIG favors separating questions on UNCERTAIN axes, which limits the
//      leak; pilot protocol should watch group-accuracy inflation.

import {
  AXES,
  type Axis,
  type Bank,
  type BankQuestion,
  type Direction,
  type FnConfidence,
  type Letter,
  type ShuffledDelivery,
} from './engine.ts';

export const FN_WEIGHT: Record<FnConfidence, number> = { high: 2, moderate: 1, low: 0.5 };
const DIRECTIONS: Direction[] = ['Ni', 'Ne', 'Si', 'Se', 'Ti', 'Te', 'Fi', 'Fe'];
export const AXIS_INDEX: Record<Axis, number> = { EI: 0, SN: 1, TF: 2, JP: 3 };
const POLES: Record<Axis, [Letter, Letter]> = { EI: ['E', 'I'], SN: ['S', 'N'], TF: ['T', 'F'], JP: ['J', 'P'] };
const AXIS_OF_LETTER: Record<Letter, Axis> = {
  E: 'EI', I: 'EI', S: 'SN', N: 'SN', T: 'TF', F: 'TF', J: 'JP', P: 'JP',
};

/** Decided-axis threshold (spec §2): margin > 0.20 decides an axis. */
export const DECIDED_MARGIN = 0.20;
/** P(option|type) softmax temperature (spec §3). */
export const OPTION_TAU = 0.5;
/** Candidate softmax temperature at pilot (spec §2: 0.1-0.2). */
export const TAU = 0.15;
/** Route length + hard cap (spec §3 priority 1; bank meta fixes 12/round). */
export const ROUTE_LENGTH = 12;
export const ROUTE_HARD_CAP = 14;
/** Coverage floor per axis per route (bank meta.selection.min_total_weight_per_axis). */
export const MIN_AXIS_TOTAL = 3;
/** Coverage priority 2: independent opportunities per axis (spec §3). */
export const MIN_OPPORTUNITIES_PER_AXIS = 2;
/** Candidates below this probability are listed as "unlikely" (spec §2). */
export const UNLIKELY_THRESHOLD = 0.05;

// ---------------------------------------------------------------------------
// Context (bank-derived, built once per bank)
// ---------------------------------------------------------------------------

export interface BehaviorFnEntry {
  [fn: string]: FnConfidence | string | number | undefined;
  note?: string;
  context_sensitivity?: string;
  function_multiplier?: number;
}

export interface EngineV2Context {
  bank: Bank;
  stacks: Record<string, Direction[]>;
  behaviorToFn: Record<string, BehaviorFnEntry>;
  /** item reliability overrides (questionId -> [0,1]); absent ids use 0.5 (D6). */
  reliability: Record<number, number>;
  tau: number;
}

export function contextFromBank(bank: Bank, overrides?: { reliability?: Record<number, number>; tau?: number }): EngineV2Context {
  const fns = bank.meta.functions as
    | { stacks?: Record<string, string[]>; behavior_to_function?: Record<string, BehaviorFnEntry> }
    | undefined;
  const stacks: Record<string, Direction[]> = {};
  for (const [type, stack] of Object.entries(fns?.stacks ?? {})) {
    stacks[type] = stack as Direction[];
  }
  if (Object.keys(stacks).length !== 16) {
    throw new Error(`bank meta.functions.stacks must define 16 types (got ${Object.keys(stacks).length})`);
  }
  return {
    bank,
    stacks,
    behaviorToFn: fns?.behavior_to_function ?? {},
    reliability: overrides?.reliability ?? {},
    tau: overrides?.tau ?? TAU,
  };
}

export const ALL_TYPES = (ctx: EngineV2Context): string[] => Object.keys(ctx.stacks).sort();

// ---------------------------------------------------------------------------
// Spec §1 — effective weights + accumulators
// ---------------------------------------------------------------------------

/** EFFECTIVE WEIGHT: min(raw, 1) unless status == validated_for_game_use (spec §1). */
export function effectiveWeight(raw: number, status?: string): number {
  return status === 'validated_for_game_use' ? raw : Math.min(raw, 1);
}

function effectiveAxisWeights(q: BankQuestion, o: { w?: Record<string, number> }): Partial<Record<Letter, number>> {
  const out: Partial<Record<Letter, number>> = {};
  for (const [letter, raw] of Object.entries(o.w ?? {})) {
    out[letter as Letter] = effectiveWeight(raw ?? 0, q.status);
  }
  return out;
}

/** Context-sensitivity multiplier for a behavior_to_function entry (D3). */
export function sensitivityMultiplier(entry: BehaviorFnEntry | undefined): number {
  if (!entry) return 1;
  if (entry.context_sensitivity === 'high') return 0.5;
  if (entry.context_sensitivity === 'moderate') return 0.75;
  return 1;
}

/** General (derived) fn evidence of one option: b constructs -> fn weights (D2, D3). */
export function derivedFnEvidence(o: { b?: string[] }, ctx: EngineV2Context): Record<Direction, number> {
  const out = Object.fromEntries(DIRECTIONS.map((d) => [d, 0])) as Record<Direction, number>;
  for (const construct of o.b ?? []) {
    const entry = ctx.behaviorToFn[construct];
    if (!entry) continue;
    const mult = sensitivityMultiplier(entry);
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'note' || key === 'context_sensitivity' || key === 'function_multiplier') continue;
      if (!DIRECTIONS.includes(key as Direction)) continue;
      out[key as Direction] += (FN_WEIGHT[value as FnConfidence] ?? 0) * mult;
    }
  }
  return out;
}

/** Explicit fn evidence of one duel option (D1). */
export function explicitFnEvidence(o: { fn?: Record<string, FnConfidence> }): Record<Direction, number> {
  const out = Object.fromEntries(DIRECTIONS.map((d) => [d, 0])) as Record<Direction, number>;
  for (const [fn, conf] of Object.entries(o.fn ?? {})) {
    if (DIRECTIONS.includes(fn as Direction)) out[fn as Direction] += FN_WEIGHT[conf] ?? 0;
  }
  return out;
}

export interface ConstructLogEntry {
  questionId: number;
  family: string;
  constructs: string[];
  /** poles this option scores toward (w > 0). */
  supports: Letter[];
}

export interface DuelLogEntry {
  questionId: number;
  duel: string[];
  fns: Array<{ fn: Direction; weight: number }>;
}

export interface V2Accumulators {
  axisSums: Record<Letter, number>;
  dirSumsGeneral: Record<Direction, number>;
  dirSumsDuel: Record<Direction, number>;
  constructLog: ConstructLogEntry[];
  duelLog: DuelLogEntry[];
  /** answered questions counted toward typing (prediction_only excluded). */
  scoredAnswers: number;
}

const emptyAccumulators = (): V2Accumulators => ({
  axisSums: { E: 0, I: 0, S: 0, N: 0, T: 0, F: 0, J: 0, P: 0 },
  dirSumsGeneral: Object.fromEntries(DIRECTIONS.map((d) => [d, 0])) as Record<Direction, number>,
  dirSumsDuel: Object.fromEntries(DIRECTIONS.map((d) => [d, 0])) as Record<Direction, number>,
  constructLog: [],
  duelLog: [],
  scoredAnswers: 0,
});

function isDuel(q: BankQuestion): boolean {
  return Array.isArray(q.duel);
}

function accumulateOption(acc: V2Accumulators, q: BankQuestion, o: BankQuestion['opts'][number], ctx: EngineV2Context, weight = 1): void {
  const w = effectiveAxisWeights(q, o);
  for (const [letter, value] of Object.entries(w)) {
    if ((value ?? 0) > 0) acc.axisSums[letter as Letter] += value! * weight;
  }
  if (isDuel(q)) {
    const ev = explicitFnEvidence(o);
    for (const fn of DIRECTIONS) acc.dirSumsDuel[fn] += ev[fn] * weight;
    acc.duelLog.push({
      questionId: q.id,
      duel: q.duel ?? [],
      fns: DIRECTIONS.filter((fn) => ev[fn] > 0).map((fn) => ({ fn, weight: ev[fn] })),
    });
  } else {
    const ev = derivedFnEvidence(o, ctx);
    for (const fn of DIRECTIONS) acc.dirSumsGeneral[fn] += ev[fn] * weight;
  }
  acc.constructLog.push({
    questionId: q.id,
    family: q.family ?? q.lin?.facet ?? q.cat,
    constructs: o.b ?? [],
    supports: (Object.entries(w) as Array<[Letter, number]>).filter(([, v]) => v > 0).map(([l]) => l),
  });
}

/**
 * Accumulate one answer set (subject picks, or one predictor's picks).
 * prediction_only questions contribute NO typing evidence (doctrine + Q27 design).
 * `weight` scales the contribution (group mixture averages use 1/K).
 */
export function accumulate(
  questions: BankQuestion[],
  deliveries: ShuffledDelivery[],
  answers: Array<number | null | undefined>,
  ctx: EngineV2Context,
  weight = 1,
  into?: V2Accumulators,
): V2Accumulators {
  const acc = into ?? emptyAccumulators();
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (q.prediction_only) continue;
    const chosen = answers[i];
    const original = typeof chosen === 'number' ? deliveries[i]?.options[chosen]?.i : undefined;
    if (original === undefined) continue;
    const o = q.opts[original];
    if (!o) continue;
    accumulateOption(acc, q, o, ctx, weight);
    acc.scoredAnswers += weight;
  }
  return acc;
}

/** Mean-of-mixture accumulators over many answer sets (spec §5 group profile). */
export function accumulateMixture(
  questions: BankQuestion[],
  deliveries: ShuffledDelivery[],
  answersList: Array<Array<number | null | undefined>>,
  ctx: EngineV2Context,
): V2Accumulators {
  const total = emptyAccumulators();
  const k = answersList.length;
  if (k === 0) return total;
  for (const answers of answersList) accumulate(questions, deliveries, answers, ctx, 1 / k, total);
  return total;
}

// ---------------------------------------------------------------------------
// Spec §2 — axis skeleton, candidate set, fits, distribution
// ---------------------------------------------------------------------------

export interface AxisState {
  axis: Axis;
  sums: [number, number];
  higherPole: Letter;
  /** |diff| / sum; 0 when the axis has no evidence. */
  margin: number;
  decided: boolean;
}

export function axisSkeleton(axisSums: Record<Letter, number>): Record<Axis, AxisState> {
  const out = {} as Record<Axis, AxisState>;
  for (const axis of AXES) {
    const [p1, p2] = POLES[axis];
    const a = axisSums[p1] ?? 0;
    const b = axisSums[p2] ?? 0;
    const sum = a + b;
    const higherPole: Letter = a >= b ? p1 : p2;
    const margin = sum > 0 ? Math.abs(a - b) / sum : 0;
    out[axis] = { axis, sums: [a, b], higherPole, margin, decided: margin > DECIDED_MARGIN };
  }
  return out;
}

export interface CandidateSet {
  candidates: string[];
  /** contradict a currently-decided letter; TEMPORARY + recoverable (spec §2). */
  masked: Array<{ type: string; contradictions: Axis[] }>;
}

export function candidateSet(skeleton: Record<Axis, AxisState>, ctx: EngineV2Context): CandidateSet {
  const sk = skeleton;
  const candidates: string[] = [];
  const masked: CandidateSet['masked'] = [];
  for (const type of ALL_TYPES(ctx)) {
    const contradictions = AXES.filter((axis) => sk[axis].decided && type[AXIS_INDEX[axis]] !== sk[axis].higherPole);
    if (contradictions.length === 0) candidates.push(type);
    else masked.push({ type, contradictions });
  }
  return { candidates, masked };
}

/** spec §2 axis_fit verbatim. */
export function axisFit(type: string, skeleton: Record<Axis, AxisState>): number {
  let total = 0;
  for (const axis of AXES) {
    const { margin, decided, higherPole } = skeleton[axis];
    let contribution: number;
    if (!decided || margin <= DECIDED_MARGIN) contribution = 0.5;
    else if (type[AXIS_INDEX[axis]] === higherPole) contribution = 0.5 + 0.5 * margin;
    else contribution = 0.5 - 0.5 * margin;
    total += contribution;
  }
  return total / 4;
}

function stackSupportGeneral(o: BankQuestion['opts'][number], stack: Direction[], ctx: EngineV2Context): number {
  const ev = derivedFnEvidence(o, ctx);
  return 2 * (ev[stack[0]] ?? 0) + (ev[stack[1]] ?? 0);
}

function stackSupportDuel(o: BankQuestion['opts'][number], stack: Direction[]): number {
  const ev = explicitFnEvidence(o);
  return stack.reduce((sum, fn) => sum + (ev[fn] ?? 0), 0);
}

function askedQuestions(questions: BankQuestion[]): { general: BankQuestion[]; duels: BankQuestion[] } {
  const general: BankQuestion[] = [];
  const duels: BankQuestion[] = [];
  for (const q of questions) {
    if (q.prediction_only) continue;
    (isDuel(q) ? duels : general).push(q);
  }
  return { general, duels };
}

/** spec §2 function_fit with per-candidate max_possible + ZERO GUARD (review 16). */
export function functionFit(type: string, acc: V2Accumulators, asked: BankQuestion[], ctx: EngineV2Context): number {
  const stack = ctx.stacks[type];
  const raw = 2 * acc.dirSumsGeneral[stack[0]] + acc.dirSumsGeneral[stack[1]];
  let maxPossible = 0;
  for (const q of asked) {
    let best = 0;
    for (const o of q.opts) best = Math.max(best, stackSupportGeneral(o, stack, ctx));
    maxPossible += best;
  }
  if (maxPossible === 0) return 0; // ZERO GUARD
  return Math.min(1, Math.max(0, raw / maxPossible));
}

/** spec §2 duel_fit with per-candidate max_possible + ZERO GUARD (review 16). */
export function duelFit(type: string, acc: V2Accumulators, askedDuels: BankQuestion[], ctx: EngineV2Context): number {
  const stack = ctx.stacks[type];
  let raw = 0;
  for (const entry of acc.duelLog) raw += entry.fns.filter((f) => stack.includes(f.fn)).reduce((s, f) => s + f.weight, 0);
  let maxPossible = 0;
  for (const q of askedDuels) {
    let best = 0;
    for (const o of q.opts) best = Math.max(best, stackSupportDuel(o, stack));
    maxPossible += best;
  }
  if (maxPossible === 0) return 0; // ZERO GUARD
  return Math.min(1, Math.max(0, raw / maxPossible));
}

/** spec §2 candidate combination. */
export function candidateScore(type: string, skeleton: Record<Axis, AxisState>, acc: V2Accumulators, asked: BankQuestion[], askedDuels: BankQuestion[], ctx: EngineV2Context): number {
  return (
    0.65 * axisFit(type, skeleton) +
    0.25 * functionFit(type, acc, asked, ctx) +
    0.1 * duelFit(type, acc, askedDuels, ctx)
  );
}

export function stableSoftmax(logits: number[], tau: number): number[] {
  const scaled = logits.map((l) => l / tau);
  const m = Math.max(...scaled);
  const exps = scaled.map((l) => Math.exp(l - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export interface TypeProbability {
  type: string;
  probability: number;
}

export interface CandidateDistribution {
  /** softmax over the CURRENT candidate set only (spec §2 review 16). */
  probabilities: TypeProbability[];
  masked: CandidateSet['masked'];
  /** candidates under UNLIKELY_THRESHOLD — recoverable, listed honestly. */
  unlikely: string[];
  leader: string | null;
  runnerUp: string | null;
  scoreMargin: number;
}

export function candidateDistribution(
  acc: V2Accumulators,
  asked: BankQuestion[],
  askedDuels: BankQuestion[],
  ctx: EngineV2Context,
): CandidateDistribution {
  const skeleton = axisSkeleton(acc.axisSums);
  const { candidates, masked } = candidateSet(skeleton, ctx);
  const logits = candidates.map((t) => candidateScore(t, skeleton, acc, asked, askedDuels, ctx));
  const probs = stableSoftmax(logits, ctx.tau);
  const probabilities = candidates
    .map((type, i) => ({ type, probability: probs[i] }))
    .sort((a, b) => b.probability - a.probability || a.type.localeCompare(b.type));
  const unlikely = probabilities.filter((p) => p.probability < UNLIKELY_THRESHOLD).map((p) => p.type);
  const leader = probabilities[0]?.type ?? null;
  const runnerUp = probabilities[1]?.type ?? null;
  const scoreMargin = leader && runnerUp ? probabilities[0].probability - probabilities[1].probability : leader ? 1 : 0;
  return { probabilities, masked, unlikely, leader, runnerUp, scoreMargin };
}

// ---------------------------------------------------------------------------
// Spec §1/§7 — route targets (D5) + confidence
// ---------------------------------------------------------------------------

/**
 * The 4 axis signal constructs this game's routes intend to test (D5).
 * Derived from the bank: per axis, the signal tag most common among questions
 * whose options score that axis. Locked at round build — never answer-dependent.
 */
export function routeTargets(ctx: EngineV2Context): Record<Axis, string> {
  const counts: Record<Axis, Map<string, number>> = {
    EI: new Map(), SN: new Map(), TF: new Map(), JP: new Map(),
  };
  for (const q of ctx.bank.bank) {
    const axes = new Set<Axis>();
    for (const o of q.opts) {
      for (const letter of Object.keys(o.w ?? {})) {
        if (letter in AXIS_OF_LETTER) axes.add(AXIS_OF_LETTER[letter as Letter]);
      }
    }
    for (const tag of q.signal ?? []) {
      for (const axis of axes) {
        counts[axis].set(tag, (counts[axis].get(tag) ?? 0) + 1);
      }
    }
  }
  const out = {} as Record<Axis, string>;
  for (const axis of AXES) {
    const best = [...counts[axis].entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (!best) throw new Error(`bank has no signal-tagged question for axis ${axis}`);
    out[axis] = best[0];
  }
  return out;
}

/**
 * Route declaration stored at round build (spec §1 review 14). Pure function of
 * the selected question ids — attempting to recompute with different answers is
 * meaningless because answers are not an input. The targets are the round's
 * declared INTENT; how many of them the answers actually realized is the
 * coverage term of confidenceV2, never a build-time error.
 */
export function buildRouteDeclaration(ctx: EngineV2Context, questionIds: number[]): { targets: Record<Axis, string>; targetList: string[] } {
  const targets = routeTargets(ctx);
  void questionIds; // ids are the declaration handle; answers cannot change it.
  return { targets, targetList: AXES.map((a) => targets[a]) };
}

export type ConfidenceBand = 'Low' | 'Moderate' | 'High';

export function confidenceBand(value: number): ConfidenceBand {
  return value < 0.4 ? 'Low' : value < 0.7 ? 'Moderate' : 'High';
}

export interface TippedAxis {
  axis: Axis;
  /** the letter the process evidence leaned toward (the leader's letter). */
  selected: Letter;
  /** the pole the raw axis sums slightly favored. */
  evidencePole: Letter;
  label: string;
}

export interface ConfidenceResult {
  value: number;
  band: ConfidenceBand;
  /** spec review 15.2: process-based result never looks more certain than the
   *  axis evidence supports — confidence cannot exceed Moderate when all four
   *  axis margins are undecided. */
  allUndecidedCapped: boolean;
  coverage: number;
  itemReliability: number;
  repeatedSignalPenalty: number;
}

export function confidenceV2(
  dist: CandidateDistribution,
  skeleton: Record<Axis, AxisState>,
  acc: V2Accumulators,
  askedLookup: BankQuestion[],
  routeTargetsByAxis: Record<Axis, string>,
  ctx: EngineV2Context,
): ConfidenceResult {
  const leader = dist.leader;
  /** an entry supports the leader when any pole it scores matches the leader's letter on that axis. */
  const supportsLeader = (entry: ConstructLogEntry): boolean =>
    !!leader && entry.supports.some((l) => leader[AXIS_INDEX[AXIS_OF_LETTER[l]]] === l);

  const coverageHits = AXES.filter((axis) => {
    const target = routeTargetsByAxis[axis];
    return acc.constructLog.some((entry) => {
      if (!entry.supports.includes(leader![AXIS_INDEX[axis]] as Letter)) return false;
      const q = askedLookup.find((x) => x.id === entry.questionId);
      return !!q && (q.signal ?? []).includes(target);
    });
  }).length;
  const coverage = Math.min(coverageHits / AXES.length, 1);

  // item_reliability: evidence-weighted mean over items supporting the leader (D6).
  let relWeighted = 0;
  let relTotal = 0;
  for (const entry of acc.constructLog) {
    if (!supportsLeader(entry)) continue;
    const weight = entry.supports.length;
    relWeighted += (ctx.reliability[entry.questionId] ?? 0.5) * weight;
    relTotal += weight;
  }
  const itemReliability = relTotal > 0 ? relWeighted / relTotal : 0.5;

  // repeated_signal_penalty: leader constructs hit by >1 same-family question.
  const seen = new Map<string, Set<string>>();
  for (const entry of acc.constructLog) {
    if (!leader || !supportsLeader(entry)) continue;
    for (const construct of entry.constructs) {
      if (!seen.has(construct)) seen.set(construct, new Set());
      seen.get(construct)!.add(entry.family);
    }
  }
  let repeatedConstructs = 0;
  for (const families of seen.values()) {
    if (families.size > 1) repeatedConstructs++;
  }
  const repeatedSignalPenalty = Math.min(0.05 * repeatedConstructs, 0.15);

  const allUndecided = AXES.every((a) => !skeleton[a].decided);
  let value = 0.65 * dist.scoreMargin + 0.2 * coverage + 0.15 * itemReliability - repeatedSignalPenalty;
  value = Math.min(1, Math.max(0, value));
  let capped = false;
  if (allUndecided && value > 0.69) {
    value = 0.69;
    capped = true;
  }
  return { value, band: confidenceBand(value), allUndecidedCapped: capped, coverage, itemReliability, repeatedSignalPenalty };
}

/** Undecided axes where the leader's letter differs from the raw evidence pole (spec §2). */
export function tippedAxes(dist: CandidateDistribution, skeleton: Record<Axis, AxisState>): TippedAxis[] {
  const leader = dist.leader;
  if (!leader) return [];
  const out: TippedAxis[] = [];
  for (const axis of AXES) {
    const state = skeleton[axis];
    if (state.decided) continue;
    const selected = leader[AXIS_INDEX[axis]] as Letter;
    if (selected === state.higherPole) continue;
    const [p1, p2] = POLES[axis];
    out.push({
      axis,
      selected,
      evidencePole: state.higherPole,
      label: `axis evidence was close on ${p1}/${p2}; process leaned ${selected}, so ${selected} was selected`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spec §5 — group vote mixture + consensus
// ---------------------------------------------------------------------------

export interface GroupMixture {
  accumulators: V2Accumulators;
  /** per-question consensus 1 - H/log2(K); 0 when nobody voted (spec §5). */
  consensus: number[];
  overallConsensus: number;
  /** votes counted per question (abstentions excluded from denominators). */
  votesPerQuestion: number[];
}

export function groupMixture(
  questions: BankQuestion[],
  deliveries: ShuffledDelivery[],
  predictions: Map<string, Array<number | null | undefined>>,
  ctx: EngineV2Context,
): GroupMixture {
  const answersList = [...predictions.values()];
  const accumulators = accumulateMixture(questions, deliveries, answersList, ctx);
  const consensus: number[] = [];
  const votesPerQuestion: number[] = [];
  for (let i = 0; i < questions.length; i++) {
    const counts = [0, 0, 0, 0];
    let total = 0;
    for (const ans of predictions.values()) {
      const chosen = ans[i];
      if (typeof chosen === 'number' && deliveries[i]?.options[chosen]) {
        counts[chosen]++;
        total++;
      }
    }
    votesPerQuestion.push(total);
    if (total === 0) {
      consensus.push(0); // all-abstain: uniform prior + consensus 0 (spec §5)
      continue;
    }
    const p = counts.map((c) => c / total);
    const h = -p.reduce((sum, pi) => (pi > 0 ? sum + pi * Math.log2(pi) : sum), 0);
    consensus.push(1 - h / Math.log2(counts.length));
  }
  const overallConsensus = consensus.length > 0 ? consensus.reduce((a, b) => a + b, 0) / consensus.length : 0;
  return { accumulators, consensus, overallConsensus, votesPerQuestion };
}

// ---------------------------------------------------------------------------
// Spec §3 — P(option|type) + EIG + adaptive selection (PR2)
// ---------------------------------------------------------------------------

/** AXIS COMPATIBILITY ONLY (spec §3). Asserts the distribution sums to 1. */
export function optionProbabilities(question: BankQuestion, type: string, ctx: EngineV2Context): number[] {
  const compat = question.opts.map((o) => {
    const w = effectiveAxisWeights(question, o);
    let sum = 0;
    for (const axis of AXES) {
      const letter = type[AXIS_INDEX[axis]] as Letter;
      sum += w[letter] ?? 0;
    }
    return sum;
  });
  const raw = stableSoftmax(compat, OPTION_TAU);
  const p = raw.map((r) => (r + 0.05) / 1.2);
  const total = p.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error(`P(option|${type}) for Q${question.id} sums to ${total}`);
  return p;
}

export function entropyBits(p: number[]): number {
  return -p.reduce((sum, pi) => (pi > 0 ? sum + pi * Math.log2(pi) : sum), 0);
}

/** EIG(Q) = H(current) - expected H after Q under these posteriors (spec §3). */
export function expectedInformationGain(
  question: BankQuestion,
  current: TypeProbability[],
  ctx: EngineV2Context,
): number {
  if (current.length === 0) return 0;
  const hCurrent = entropyBits(current.map((c) => c.probability));
  const perType = current.map((c) => ({ type: c.type, p: c.probability, optionP: optionProbabilities(question, c.type, ctx) }));
  let expected = 0;
  for (let i = 0; i < question.opts.length; i++) {
    const pickProb = perType.reduce((sum, t) => sum + t.p * t.optionP[i], 0);
    if (pickProb <= 0) continue;
    const post = perType.map((t) => ({ ...t, post: t.p * t.optionP[i] }));
    const postSum = post.reduce((sum, t) => sum + t.post, 0);
    const hPost = entropyBits(post.map((t) => t.post / postSum));
    expected += pickProb * hPost;
  }
  return hCurrent - expected;
}

/** Effective per-axis weight a question can contribute (coverage bookkeeping). */
export function axisOpportunity(q: BankQuestion, axis: Axis): number {
  const [p1, p2] = POLES[axis];
  return Math.max(...q.opts.map((o) => {
    const w = effectiveAxisWeights(q, o);
    return (w[p1] ?? 0) + (w[p2] ?? 0);
  }));
}

function primaryConstruct(q: BankQuestion): string {
  if (q.lin?.facet) return q.lin.facet;
  if (q.family) return q.family;
  const counts = new Map<string, number>();
  for (const o of q.opts) for (const c of o.b ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? `q${q.id}`;
}

export interface AdaptivePickResult {
  question: BankQuestion;
  /** true when the session used-set was reset (bank could not fill the route otherwise). */
  resetUsed: boolean;
  /** coverage priority applied at this step, for logs/tests. */
  via: 'needed_axis' | 'max_eig' | 'entropy_fallback';
}

/**
 * Pick the NEXT route question (PR2, spec §3 coverage priority verbatim):
 *   1) <= ROUTE_HARD_CAP questions (route length 12 comes from the caller);
 *   2) >= MIN_OPPORTUNITIES_PER_AXIS independent opportunities per axis where possible;
 *   3) no duplicate primary construct (0.5 EIG discount);
 *   4) max EIG;
 *   5) weakest axes first.
 * D8: `answers` are the subject's answers to `chosenSoFar` (aligned by index).
 */
export function selectNextAdaptive(
  ctx: EngineV2Context,
  usedIds: ReadonlySet<number>,
  chosenSoFar: BankQuestion[],
  answersSoFar: Array<number | null | undefined>,
  rng: () => number,
): AdaptivePickResult | null {
  if (chosenSoFar.length >= ROUTE_HARD_CAP) return null;
  const deliveriesSoFar: ShuffledDelivery[] = chosenSoFar.map((q) => ({
    options: q.opts.map((_, i) => ({ i, t: q.opts[i].t })),
  }));
  const acc = accumulate(chosenSoFar, deliveriesSoFar, answersSoFar, ctx);
  const skeleton = axisSkeleton(acc.axisSums);
  const { candidates } = candidateSet(skeleton, ctx);
  const asked = askedQuestions(chosenSoFar);
  const dist0 = candidateDistribution(acc, asked.general, asked.duels, ctx);
  const current: TypeProbability[] = dist0.probabilities.length > 0 ? dist0.probabilities : ALL_TYPES(ctx).map((type) => ({ type, probability: 1 / 16 }));

  let pool = ctx.bank.bank.filter((q) => !chosenSoFar.some((c) => c.id === q.id) && !usedIds.has(q.id));
  let resetUsed = false;
  if (pool.length === 0) {
    pool = ctx.bank.bank.filter((q) => !chosenSoFar.some((c) => c.id === q.id));
    resetUsed = true;
  }
  if (pool.length === 0) return null;

  const opportunities: Record<Axis, number> = { EI: 0, SN: 0, TF: 0, JP: 0 };
  const axisLoad: Record<Axis, number> = { EI: 0, SN: 0, TF: 0, JP: 0 };
  for (const q of chosenSoFar) {
    for (const axis of AXES) {
      const opp = axisOpportunity(q, axis);
      if (opp > 0) opportunities[axis] += 1;
      axisLoad[axis] += opp;
    }
  }
  const chosenConstructs = new Set(chosenSoFar.map(primaryConstruct));

  const scored = (q: BankQuestion): number => {
    let eig = expectedInformationGain(q, current, ctx);
    if (chosenConstructs.has(primaryConstruct(q))) eig *= 0.5; // priority 3
    return eig;
  };

  const weakestFirst = (axes: Axis[]): Axis =>
    [...axes].sort((a, b) => axisLoad[a] - axisLoad[b] || AXES.indexOf(a) - AXES.indexOf(b))[0];

  const neededAxes = AXES.filter((axis) => opportunities[axis] < MIN_OPPORTUNITIES_PER_AXIS);
  const pickFrom = (candidates: BankQuestion[]): BankQuestion | null => {
    if (candidates.length === 0) return null;
    const order = candidates.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order.sort((a, b) => scored(b) - scored(a) || 0)[0];
  };

  // Priority 2 (where possible): serve the weakest under-covered axis first.
  for (const axis of neededAxes) {
    const covering = pool.filter((q) => axisOpportunity(q, axis) > 0);
    const pick = pickFrom(covering);
    if (pick) return { question: pick, resetUsed, via: 'needed_axis' };
  }

  // Priority 4: max EIG over the whole pool.
  const best = pickFrom(pool);
  if (best) return { question: best, resetUsed, via: 'max_eig' };

  // Entropy fallback: bank exhausted for rules 2-4 — take the most uncertain
  // remaining question (its own option-entropy), ignoring coverage needs.
  const fallback = pool
    .map((q) => {
      const meanCompat = q.opts.map((_, i) => {
        const p = current.reduce((sum, c) => sum + c.probability * optionProbabilities(q, c.type, ctx)[i], 0);
        return p;
      });
      return { q, h: entropyBits(meanCompat) };
    })
    .sort((a, b) => b.h - a.h || a.q.id - b.q.id);
  return { question: fallback[0].q, resetUsed, via: 'entropy_fallback' };
}

/**
 * Full adaptive route (PR2) — convenience for tests and non-lazy consumers.
 * Guarantees the §3 floor: every axis carries >= MIN_AXIS_TOTAL effective weight.
 */
export function selectAdaptiveRoute(
  ctx: EngineV2Context,
  usedIds: ReadonlySet<number>,
  rng: () => number,
  count = ROUTE_LENGTH,
): { questions: BankQuestion[]; resetUsed: boolean } {
  const chosen: BankQuestion[] = [];
  const answers: Array<number | null> = [];
  let resetUsed = false;
  for (let i = 0; i < count; i++) {
    const pick = selectNextAdaptive(ctx, usedIds, chosen, answers, rng);
    if (!pick) break;
    resetUsed = resetUsed || pick.resetUsed;
    chosen.push(pick.question);
    answers.push(null); // route composition is answer-agnostic here (live answers drive the real flow)
  }
  const totals: Record<Axis, number> = { EI: 0, SN: 0, TF: 0, JP: 0 };
  for (const q of chosen) for (const axis of AXES) totals[axis] += axisOpportunity(q, axis);
  for (const axis of AXES) {
    if (totals[axis] < MIN_AXIS_TOTAL) {
      throw new Error(`adaptive route failed the coverage floor: axis ${axis} total ${totals[axis]} < ${MIN_AXIS_TOTAL}`);
    }
  }
  return { questions: chosen, resetUsed };
}

// ---------------------------------------------------------------------------
// Spec §6 — reveal payload assembly
// ---------------------------------------------------------------------------

export interface EngineV2Reveal {
  subject: {
    type: string;
    probabilities: TypeProbability[];
    masked: CandidateDistribution['masked'];
    unlikely: string[];
    tipped: TippedAxis[];
    confidence: ConfidenceResult;
    /** Beat 1 low-confidence presentation: function pattern FIRST (spec §6). */
    presentation: 'function_first' | 'archetype_first';
    topFunctions: Array<{ fn: Direction; weight: number }>;
  };
  group: {
    type: string | null;
    probabilities: TypeProbability[];
    confidence: ConfidenceResult;
    consensus: number[];
    overallConsensus: number;
  } | null;
}

function topFunctions(acc: V2Accumulators): Array<{ fn: Direction; weight: number }> {
  const combined = DIRECTIONS.map((fn) => ({ fn, weight: acc.dirSumsGeneral[fn] + acc.dirSumsDuel[fn] }));
  return combined.sort((a, b) => b.weight - a.weight || a.fn.localeCompare(b.fn)).slice(0, 2).filter((f) => f.weight > 0);
}

/** Full PR1 pipeline over one answer set (subject or a predictor-shaped reader). */
export function revealFor(
  questions: BankQuestion[],
  deliveries: ShuffledDelivery[],
  answers: Array<number | null | undefined>,
  routeTargetsByAxis: Record<Axis, string>,
  ctx: EngineV2Context,
): EngineV2Reveal['subject'] {
  const acc = accumulate(questions, deliveries, answers, ctx);
  const asked = askedQuestions(questions);
  const skeleton = axisSkeleton(acc.axisSums);
  const dist = candidateDistribution(acc, asked.general, asked.duels, ctx);
  const confidence = confidenceV2(dist, skeleton, acc, questions, routeTargetsByAxis, ctx);
  const fns = topFunctions(acc);
  return {
    type: dist.leader ?? 'ESTJ',
    probabilities: dist.probabilities,
    masked: dist.masked,
    unlikely: dist.unlikely,
    tipped: tippedAxes(dist, skeleton),
    confidence,
    presentation: confidence.band === 'Low' && fns.length > 0 ? 'function_first' : 'archetype_first',
    topFunctions: fns,
  };
}
