// Beneath the Mask — scoring engine.
//
// NOTE: the bank's meta.selection.no_repeat_within_session rule is SUPERSEDED by
// decision (b): selectQuestions prefers unused questions but resets the used-set
// once the bank can no longer fill a round — option re-shuffling per delivery
// defeats memorized option→pole mapping.
//
// Pure TypeScript: no Deno/node APIs. Consumed by edge functions (Deno) and vitest (node).

export type Axis = 'EI' | 'SN' | 'TF' | 'JP';
export type Letter = 'E' | 'I' | 'S' | 'N' | 'T' | 'F' | 'J' | 'P';
export type FnConfidence = 'high' | 'moderate' | 'low';

export interface AxisWeights {
  E?: number; I?: number; S?: number; N?: number;
  T?: number; F?: number; J?: number; P?: number;
}

export interface BankOption {
  t: string;
  w?: AxisWeights;
  b?: string[];
  fn?: Record<string, FnConfidence>;
  alt?: string[];
  dni?: string[];
}

export interface BankQuestion {
  id: number;
  cat: string;
  q: string;
  opts: BankOption[];
  /** slot metadata (bank v8.1): family probe ["NT","NF","ST","SF"] or a duel pair ["Ni","Ne"] etc. */
  duel?: string[];
  /** IPIP lineage for temperament slots, e.g. "ipip:extraversion-gregariousness". */
  src?: string;
}

export interface Bank {
  meta: Record<string, unknown>;
  bank: BankQuestion[];
}

export const AXES: Axis[] = ['EI', 'SN', 'TF', 'JP'];
const POLES: Record<Axis, [Letter, Letter]> = {
  EI: ['E', 'I'], SN: ['S', 'N'], TF: ['T', 'F'], JP: ['J', 'P'],
};
// Tie convention: when both poles of an axis carry equal summed weight,
// the first pole wins (documented; bank v6 narrowing makes exact ties rare).
const TIE_DEFAULT: Record<Axis, Letter> = { EI: 'E', SN: 'S', TF: 'T', JP: 'J' };

/** Deterministic seeded PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function axisMaxWeight(q: BankQuestion, axis: Axis): number {
  const [p1, p2] = POLES[axis];
  let m = 0;
  for (const o of q.opts) m = Math.max(m, (o.w?.[p1] ?? 0) + (o.w?.[p2] ?? 0));
  return m;
}

function axisCoverage(questions: BankQuestion[]): Record<Axis, number> {
  const cov: Record<Axis, number> = { EI: 0, SN: 0, TF: 0, JP: 0 };
  for (const q of questions) for (const ax of AXES) cov[ax] += axisMaxWeight(q, ax);
  return cov;
}

export interface Selection {
  questions: BankQuestion[];
  /** true when the used-set was reset because the bank could not fill the round (decision b). */
  resetUsed: boolean;
}

// ---------------------------------------------------------------------------
// Selector v1.5 — slot composition (bank v8.1, 98 questions).
//   SLOT A: 2 family probes   (duel = ["NT","NF","ST","SF"], ids 64-66)
//   SLOT B: 4 duels           (one per pair Ni/Ne, Ti/Te, Fi/Fe, Si/Se, ids 67-74)
//   SLOT C: 4 IPIP temperaments (2 E/I from extraversion/introversion src,
//                               2 J/P from conscientiousness src)
//   SLOT D: 2 validations     (ids 1-63, preferring 17, 36, 54, 61, 62, 63)
// Unused-biased per slot (slot-local reset when exhausted — decision b);
// guaranteed >= minAxisTotal per axis, weakest-pick swap fallback.
// ---------------------------------------------------------------------------

const FAMILY_PROBE = ['NT', 'NF', 'ST', 'SF'];
const DUEL_PAIRS: Array<[string, string]> = [
  ['Ni', 'Ne'], ['Ti', 'Te'], ['Fi', 'Fe'], ['Si', 'Se'],
];
const PREFERRED_VALIDATIONS = [17, 36, 54, 61, 62, 63];

function samePair(a?: string[], b: string[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x === b[i]);
}

function pickUnused(
  pool: BankQuestion[],
  usedIds: ReadonlySet<number>,
  n: number,
  rng: () => number,
): { picks: BankQuestion[]; reused: boolean } {
  let candidates = pool.filter((q) => !usedIds.has(q.id));
  let reused = false;
  if (candidates.length < n) {
    candidates = pool.slice(); // slot-local used-set reset (decision b)
    reused = true;
  }
  const picks = shuffle(candidates, rng).slice(0, n);
  return { picks, reused: reused || picks.some((p) => usedIds.has(p.id)) };
}

export function selectQuestionsV2(
  bank: Bank,
  usedIds: ReadonlySet<number>,
  rng: () => number,
  minAxisTotal = 3,
): Selection {
  const poolA = bank.bank.filter((q) => samePair(q.duel, FAMILY_PROBE));
  const poolsB = DUEL_PAIRS.map(([a, b]) => bank.bank.filter((q) => samePair(q.duel, [a, b])));
  // V2 bank slots are deliberately bounded. Earlier validation questions can
  // carry IPIP source text too, but they must never leak into temperament C.
  const poolEI = bank.bank.filter((q) => q.id >= 75 && q.id <= 80);
  const poolJP = bank.bank.filter((q) => q.id >= 93 && q.id <= 98);
  const poolD = bank.bank.filter((q) => q.id <= 63);
  const preferredD = poolD.filter((q) => PREFERRED_VALIDATIONS.includes(q.id));

  let resetUsed = false;
  const picked: BankQuestion[] = [];
  const take = (res: { picks: BankQuestion[]; reused: boolean }) => {
    resetUsed = resetUsed || res.reused;
    picked.push(...res.picks);
  };

  take(pickUnused(poolA, usedIds, 2, rng));
  for (const pool of poolsB) take(pickUnused(pool, usedIds, 1, rng));
  take(pickUnused(poolEI, usedIds, 2, rng));
  take(pickUnused(poolJP, usedIds, 2, rng));
  take(pickUnused(preferredD.length >= 2 ? preferredD : poolD, usedIds, 2, rng));

  const seen = new Set<number>();
  const selected = picked.filter((q) => (seen.has(q.id) ? false : (seen.add(q.id), true)));
  // Top up in the unlikely event of a dedupe shortfall.
  for (const q of poolD) {
    if (selected.length >= 12) break;
    if (!seen.has(q.id)) {
      seen.add(q.id);
      selected.push(q);
    }
  }

  // Coverage repair: swap the pick contributing least to a deficient axis for
  // the strongest unused candidate on that axis, but never across a slot.
  // Otherwise a repair can silently turn a 2/4/4/2 draw into four validations.
  const slotKey = (q: BankQuestion): string => {
    if (samePair(q.duel, FAMILY_PROBE)) return 'family';
    const duelIndex = DUEL_PAIRS.findIndex(([a, b]) => samePair(q.duel, [a, b]));
    if (duelIndex >= 0) return `duel:${duelIndex}`;
    if (q.src && /ipip:(extraversion|introversion)/.test(q.src)) return 'temperament:EI';
    if (q.src && /ipip:conscientiousness/.test(q.src)) return 'temperament:JP';
    return 'validation';
  };
  for (let iter = 0; iter < 200; iter++) {
    const cov = axisCoverage(selected);
    const deficient = AXES.filter((ax) => cov[ax] < minAxisTotal);
    if (deficient.length === 0) break;
    const ax = deficient[0];
    const swapOrder = selected
      .map((q, i) => ({ i, w: axisMaxWeight(q, ax) }))
      .sort((a, b) => a.w - b.w || a.i - b.i);
    let repaired = false;
    for (const { i } of swapOrder) {
      const candidates = bank.bank
        .filter((q) => !selected.includes(q) && slotKey(q) === slotKey(selected[i]) && axisMaxWeight(q, ax) > 0)
        .sort((a, b) => axisMaxWeight(b, ax) - axisMaxWeight(a, ax) || a.id - b.id);
      if (candidates.length > 0) {
        selected[i] = candidates[0];
        repaired = true;
        break;
      }
    }
    if (!repaired) break;
  }

  const finalCov = axisCoverage(selected);
  for (const ax of AXES) {
    if (finalCov[ax] < minAxisTotal) {
      throw new Error(`slot selection failed: axis ${ax} coverage ${finalCov[ax]} < ${minAxisTotal}`);
    }
  }
  return { questions: selected.slice(0, 12), resetUsed };
}

/**
 * Pick `count` questions guaranteeing >= minAxisTotal per axis.
 * Prefers questions not in usedIds; resets the used-set when the pool is too small.
 */
export function selectQuestions(
  bank: Bank,
  usedIds: ReadonlySet<number>,
  rng: () => number,
  count = 12,
  minAxisTotal = 3,
): Selection {
  let pool = bank.bank.filter((q) => !usedIds.has(q.id));
  let resetUsed = false;
  if (pool.length < count) {
    pool = bank.bank.slice();
    resetUsed = true;
  }

  const pick = (): BankQuestion[] => {
    const idxs = shuffle(pool.map((_, i) => i), rng).slice(0, count);
    return idxs.map((i) => pool[i]);
  };

  let selected = pick();

  // Repair: swap questions contributing nothing to a deficient axis for ones that do.
  for (let iter = 0; iter < 500; iter++) {
    const cov = axisCoverage(selected);
    const deficient = AXES.filter((ax) => cov[ax] < minAxisTotal);
    if (deficient.length === 0) break;
    const ax = deficient[0];
    const swapOutOrder = shuffle(selected.map((_, i) => i), rng)
      .sort((a, b) => axisMaxWeight(selected[a], ax) - axisMaxWeight(selected[b], ax));
    const candidates = pool.filter((q) => !selected.includes(q) && axisMaxWeight(q, ax) > 0);
    if (candidates.length === 0) break; // bank cannot repair this axis (tests assert this never happens)
    const replacement = candidates[Math.floor(rng() * candidates.length)];
    const outIdx = swapOutOrder[0];
    selected = selected.map((q, i) => (i === outIdx ? replacement : q));
  }

  const finalCov = axisCoverage(selected);
  for (const ax of AXES) {
    if (finalCov[ax] < minAxisTotal) {
      throw new Error(`question selection failed: axis ${ax} coverage ${finalCov[ax]} < ${minAxisTotal}`);
    }
  }
  return { questions: selected, resetUsed };
}

export interface ShuffledOption {
  /** original option index in the bank question — the scoring anchor. */
  i: number;
  t: string;
}

export interface ShuffledDelivery {
  options: ShuffledOption[]; // display order for clients; weights/fn never leave the server
}

export function shuffleOptions(question: BankQuestion, rng: () => number): ShuffledDelivery {
  const perm = shuffle(question.opts.map((_, i) => i), rng);
  return { options: perm.map((i) => ({ i, t: question.opts[i].t })) };
}

export function typeFromSums(sums: Record<Letter, number>): string {
  let out = '';
  for (const ax of AXES) {
    const [p1, p2] = POLES[ax];
    out += sums[p1] >= sums[p2] ? p1 : p2; // >= : tie -> first pole (TIE_DEFAULT)
  }
  return out;
}

export type Direction = 'Ni' | 'Ne' | 'Si' | 'Se' | 'Ti' | 'Te' | 'Fi' | 'Fe';
export interface TypeScore { type: string; score: number }
export interface TypeRanking {
  top2: TypeScore[];
  confidence: number;
  dirSums: Record<Direction, number>;
}

const DIRECTIONS: Direction[] = ['Ni', 'Ne', 'Si', 'Se', 'Ti', 'Te', 'Fi', 'Fe'];

/** Accumulate confidence-weighted directional evidence from chosen options. */
export function directionSumsFor(
  questions: BankQuestion[],
  deliveries: ShuffledDelivery[],
  answers: Array<number | null | undefined>,
): Record<Direction, number> {
  const sums = Object.fromEntries(DIRECTIONS.map((fn) => [fn, 0])) as Record<Direction, number>;
  for (let i = 0; i < deliveries.length; i++) {
    const chosen = answers[i];
    const original = typeof chosen === 'number' ? deliveries[i]?.options[chosen]?.i : undefined;
    if (original === undefined) continue;
    for (const [fn, confidence] of Object.entries(questions[i]?.opts[original]?.fn ?? {})) {
      if (DIRECTIONS.includes(fn as Direction)) sums[fn as Direction] += FN_WEIGHT[confidence as FnConfidence] ?? 0;
    }
  }
  return sums;
}

/**
 * Rank all 16 types with the same answer instrument used for the subject and
 * for the group's majority answers. Axis poles provide the base; the dominant
 * and auxiliary functions add directional evidence from the bank's stacks.
 */
export function rankTypesV2(
  questions: BankQuestion[],
  deliveries: ShuffledDelivery[],
  answers: Array<number | null | undefined>,
  stacks: Record<string, string[]>,
): TypeRanking {
  const axisSums = { E: 0, I: 0, S: 0, N: 0, T: 0, F: 0, J: 0, P: 0 } as Record<Letter, number>;
  for (let i = 0; i < deliveries.length; i++) {
    const chosen = answers[i];
    const original = typeof chosen === 'number' ? deliveries[i]?.options[chosen]?.i : undefined;
    if (original === undefined) continue;
    for (const [letter, weight] of Object.entries(questions[i]?.opts[original]?.w ?? {})) {
      axisSums[letter as Letter] += weight ?? 0;
    }
  }
  const dirSums = directionSumsFor(questions, deliveries, answers);
  const top2 = Object.entries(stacks)
    .map(([type, stack]) => {
      const base = [...type].reduce((total, letter) => total + (axisSums[letter as Letter] ?? 0), 0);
      const bonus = 2 * (dirSums[stack[0] as Direction] ?? 0) + (dirSums[stack[1] as Direction] ?? 0);
      return { type, score: base + bonus };
    })
    .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type))
    .slice(0, 2);
  const [first, second] = top2;
  const confidence = first && second && first.score + second.score > 0
    ? (first.score - second.score) / (first.score + second.score)
    : 0;
  return { top2, confidence, dirSums };
}

export interface ScoreInput {
  /** bank questions aligned by question_idx (0..11). */
  questions: BankQuestion[];
  /** shuffled deliveries aligned by question_idx. */
  deliveries: ShuffledDelivery[];
  /** subject's chosen SHUFFLED index per idx, null/undefined = unanswered. */
  subjectAnswers: Array<number | null | undefined>;
  /** predictor id -> chosen SHUFFLED index per idx. */
  predictions: Map<string, Array<number | null | undefined>>;
}

export interface ScoreResult {
  subjectType: string;
  groupType: string | null;
  perPlayerCorrect: Record<string, number>;
  bestPredictor: string | null;
  /** majority original option index per idx (null = no predictions). */
  majorityOrig: Array<number | null>;
  groupAccuracy: { correct: number; total: number };
  /** per-axis pole sums for the subject (reveal display). */
  subjectAxisSums: Record<Axis, [number, number]>;
  groupAxisSums: Record<Axis, [number, number]>;
}

export function scoreRound(input: ScoreInput): ScoreResult {
  const { questions, deliveries, subjectAnswers, predictions } = input;
  const n = deliveries.length;
  const origOf = (d: ShuffledDelivery, chosen: number | null | undefined): number | null =>
    typeof chosen === 'number' && d.options[chosen] ? d.options[chosen].i : null;

  const subjectOrig: Array<number | null> = deliveries.map((d, idx) => origOf(d, subjectAnswers[idx]));

  // Majority vote per question: plurality over predictors; ties -> smallest orig index.
  const majorityOrig: Array<number | null> = deliveries.map((_, idx) => {
    const counts = new Map<number, number>();
    for (const ans of predictions.values()) {
      const o = origOf(deliveries[idx], ans[idx]);
      if (o !== null) counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    let best: number | null = null;
    let bestCount = -1;
    for (const [o, c] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
      if (c > bestCount) { best = o; bestCount = c; }
    }
    return best;
  });

  const sumsFor = (origs: Array<number | null>): Record<Letter, number> => {
    const sums = { E: 0, I: 0, S: 0, N: 0, T: 0, F: 0, J: 0, P: 0 } as Record<Letter, number>;
    for (let idx = 0; idx < n; idx++) {
      const o = origs[idx];
      if (o === null) continue;
      const w = questions[idx].opts[o].w;
      if (!w) continue;
      for (const k of Object.keys(w) as Letter[]) sums[k] += w[k] ?? 0;
    }
    return sums;
  };

  const subjectSums = sumsFor(subjectOrig);
  const groupSums = sumsFor(majorityOrig);

  const axisSums = (s: Record<Letter, number>): Record<Axis, [number, number]> => ({
    EI: [s.E, s.I], SN: [s.S, s.N], TF: [s.T, s.F], JP: [s.J, s.P],
  });

  const perPlayerCorrect: Record<string, number> = {};
  for (const [pid, ans] of predictions) {
    let c = 0;
    for (let idx = 0; idx < n; idx++) {
      if (origOf(deliveries[idx], ans[idx]) !== null && origOf(deliveries[idx], ans[idx]) === subjectOrig[idx]) c++;
    }
    perPlayerCorrect[pid] = c;
  }

  // Best predictor: max correct; ties -> head-to-head wins among the tied; then player id (deterministic).
  const pids = Object.keys(perPlayerCorrect).sort();
  const max = Math.max(0, ...pids.map((p) => perPlayerCorrect[p]));
  let tied = pids.filter((p) => perPlayerCorrect[p] === max);
  if (tied.length > 1) {
    const wins: Record<string, number> = Object.fromEntries(tied.map((p) => [p, 0]));
    for (let a = 0; a < tied.length; a++) {
      for (let b = a + 1; b < tied.length; b++) {
        const [pa, pb] = [tied[a], tied[b]];
        let wa = 0, wb = 0;
        for (let idx = 0; idx < n; idx++) {
          const ra = origOf(deliveries[idx], predictions.get(pa)![idx]) === subjectOrig[idx];
          const rb = origOf(deliveries[idx], predictions.get(pb)![idx]) === subjectOrig[idx];
          if (ra && !rb) wa++;
          if (rb && !ra) wb++;
        }
        if (wa > wb) wins[pa]++; else if (wb > wa) wins[pb]++; // tie round: nobody scores
      }
    }
    const bestWins = Math.max(...tied.map((p) => wins[p]));
    const stillTied = tied.filter((p) => wins[p] === bestWins).sort();
    tied = [stillTied[0]];
  }
  const bestPredictor = tied[0] ?? null;

  let correct = 0;
  for (let idx = 0; idx < n; idx++) if (majorityOrig[idx] !== null && majorityOrig[idx] === subjectOrig[idx]) correct++;

  return {
    subjectType: typeFromSums(subjectSums),
    groupType: pids.length === 0 ? null : typeFromSums(groupSums),
    perPlayerCorrect,
    bestPredictor,
    majorityOrig,
    groupAccuracy: { correct, total: n },
    subjectAxisSums: axisSums(subjectSums),
    groupAxisSums: axisSums(groupSums),
  };
}

const FN_WEIGHT: Record<FnConfidence, number> = { high: 2, moderate: 1, low: 0.5 };

const FN_DESCRIPTORS: Record<string, string> = {
  Ti: 'impersonal logic',
  Te: 'organized execution',
  Fi: 'personal values',
  Fe: 'reading the room',
  Ni: 'convergent foresight',
  Ne: 'possibility-hopping',
  Si: 'what worked before',
  Se: 'acting on the moment',
};

export interface AxisMisread {
  axis: Axis;
  subjectLetter: Letter;
  groupLetter: Letter;
  mismatches: number;
  subjectFns: Array<{ fn: string; score: number }>;
  groupFns: Array<{ fn: string; score: number }>;
  copy: string;
}

function topFns(entries: Array<[string, number]>): Array<{ fn: string; score: number }> {
  return entries
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([fn, score]) => ({ fn, score }));
}

/**
 * For each flipped axis (group letter != subject letter): on questions where the
 * majority picked a different option than the subject, sum confidence-weighted
 * function evidence of the subject's actual picks vs the group's predicted picks.
 */
export function analyzeMisread(
  questions: BankQuestion[],
  deliveries: ShuffledDelivery[],
  subjectAnswers: Array<number | null | undefined>,
  majorityOrig: Array<number | null>,
  subjectType: string,
  groupType: string | null,
): AxisMisread[] {
  if (!groupType) return [];
  const out: AxisMisread[] = [];
  for (let a = 0; a < AXES.length; a++) {
    const ax = AXES[a];
    const sLetter = subjectType[a] as Letter;
    const gLetter = groupType[a] as Letter;
    if (sLetter === gLetter) continue;

    const subj = new Map<string, number>();
    const grp = new Map<string, number>();
    let mismatches = 0;

    for (let idx = 0; idx < deliveries.length; idx++) {
      const sChosen = subjectAnswers[idx];
      const sOrig = typeof sChosen === 'number' ? deliveries[idx].options[sChosen]?.i : null;
      const gOrig = majorityOrig[idx];
      if (sOrig === null || gOrig === null || sOrig === gOrig) continue;
      mismatches++;
      const collect = (orig: number, into: Map<string, number>) => {
        const fn = questions[idx].opts[orig]?.fn;
        if (!fn) return;
        for (const [f, conf] of Object.entries(fn)) {
          into.set(f, (into.get(f) ?? 0) + (FN_WEIGHT[conf as FnConfidence] ?? 0));
        }
      };
      collect(sOrig, subj);
      collect(gOrig, grp);
    }
    if (mismatches === 0) continue;

    const sTop = topFns([...subj.entries()]);
    const gTop = topFns([...grp.entries()]);
    const fmt = (top: Array<{ fn: string }>) => top.map((t) => t.fn).join(' + ');
    const desc = (top: Array<{ fn: string }>) =>
      top.map((t) => FN_DESCRIPTORS[t.fn] ?? t.fn).join(' mixed with ');

    out.push({
      axis: ax,
      subjectLetter: sLetter,
      groupLetter: gLetter,
      mismatches,
      subjectFns: sTop,
      groupFns: gTop,
      copy:
        `On the ${ax} axis, the group read your answers as ${fmt(gTop)} — ${desc(gTop)}. ` +
        `Your actual picks pattern ${fmt(sTop)} — ${desc(sTop)}. That's why they got you wrong.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reveal runner-ups — "Also suspected: {T2}, {T3} — the mask was ambiguous here."
// Alternates flip the weakest axis, then the next weakest. Confidence comes
// from the smallest per-axis margin (in weight points):
//   high (>= 4) -> 1 alternate shown, medium (>= 2) -> 2, low -> 3.
// ---------------------------------------------------------------------------

export type Confidence = 'high' | 'medium' | 'low';

export function alternatesFromAxisSums(
  axisSums: Record<Axis, [number, number]>,
): { alternates: string[]; confidence: Confidence } {
  const sums: Record<Letter, number> = {
    E: axisSums.EI[0], I: axisSums.EI[1],
    S: axisSums.SN[0], N: axisSums.SN[1],
    T: axisSums.TF[0], F: axisSums.TF[1],
    J: axisSums.JP[0], P: axisSums.JP[1],
  };
  const base = typeFromSums(sums);
  const margins = AXES.map((ax) => ({ ax, margin: Math.abs(axisSums[ax][0] - axisSums[ax][1]) }));
  const minMargin = Math.min(...margins.map((m) => m.margin));
  const confidence: Confidence = minMargin >= 4 ? 'high' : minMargin >= 2 ? 'medium' : 'low';
  const weakest = [...margins].sort((a, b) => a.margin - b.margin || AXES.indexOf(a.ax) - AXES.indexOf(b.ax));
  const alternates: string[] = [];
  for (const { ax } of weakest) {
    const [p1, p2] = POLES[ax];
    const flipped = { ...sums, [p1]: sums[p2], [p2]: sums[p1] };
    const t = typeFromSums(flipped);
    if (t !== base && !alternates.includes(t)) alternates.push(t);
    if (alternates.length >= 3) break;
  }
  return { alternates, confidence };
}
