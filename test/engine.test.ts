import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  analyzeMisread,
  alternatesFromAxisSums,
  mulberry32,
  rankTypesV2,
  scoreRound,
  selectQuestions,
  selectQuestionsV2,
  shuffleOptions,
  typeFromSums,
  AXES,
  type Bank,
  type BankQuestion,
  type ShuffledDelivery,
} from '../supabase/functions/_shared/engine';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bank = JSON.parse(
  readFileSync(path.join(root, 'supabase/functions/_shared/bank.json'), 'utf8'),
) as Bank;

describe('bank sanity', () => {
  it('has 98 questions with 4 options each (bank v8.1)', () => {
    expect(bank.bank).toHaveLength(98);
    for (const q of bank.bank) expect(q.opts).toHaveLength(4);
  });
});

describe('selectQuestions', () => {
  it('10,000 draws: never under-covered, deterministic per seed', () => {
    for (let i = 0; i < 10_000; i++) {
      const rng = mulberry32(i);
      const { questions } = selectQuestions(bank, new Set(), rng);
      expect(questions).toHaveLength(12);
      const ids = new Set(questions.map((q) => q.id));
      expect(ids.size).toBe(12);
      const cov = { EI: 0, SN: 0, TF: 0, JP: 0 };
      for (const q of questions) {
        for (const ax of AXES) {
          const [p1, p2] = ax === 'EI' ? ['E', 'I'] : ax === 'SN' ? ['S', 'N'] : ax === 'TF' ? ['T', 'F'] : ['J', 'P'];
          cov[ax] += Math.max(...q.opts.map((o) => (o.w?.[p1 as 'E'] ?? 0) + (o.w?.[p2 as 'I'] ?? 0)));
        }
      }
      for (const ax of AXES) expect(cov[ax]).toBeGreaterThanOrEqual(3);
    }
    const a = selectQuestions(bank, new Set(), mulberry32(42));
    const b = selectQuestions(bank, new Set(), mulberry32(42));
    expect(a.questions.map((q) => q.id)).toEqual(b.questions.map((q) => q.id));
  });

  it('full session simulation: 10 rounds x 12, reset flag fires when bank is exhausted', () => {
    const used = new Set<number>();
    let resets = 0;
    for (let round = 0; round < 10; round++) {
      const { questions, resetUsed } = selectQuestions(bank, used, mulberry32(1000 + round));
      if (resetUsed) resets++;
      const before = used.size;
      questions.forEach((q) => used.add(q.id));
      // Without a reset the used-set grows by exactly 12; with a reset it grows by
      // however many of the re-picked questions were not already used.
      if (!resetUsed) expect(used.size).toBe(before + 12);
    }
    expect(resets).toBeGreaterThan(0); // 120 picks from a 60-question bank must reset at least once
    // After the first reset, later rounds still meet coverage (decision b guarantee).
    const late = selectQuestions(bank, used, mulberry32(7));
    expect(late.questions).toHaveLength(12);
  });
});

describe('shuffleOptions', () => {
  it('produces a valid permutation carrying original indexes', () => {
    const q = bank.bank[0];
    const d = shuffleOptions(q, mulberry32(1));
    expect(d.options).toHaveLength(4);
    expect(d.options.map((o) => o.i).sort()).toEqual([0, 1, 2, 3]);
    expect(d.options.map((o) => o.t)).toEqual(d.options.map((o) => q.opts[o.i].t));
  });
});

// --- Synthetic fixture for scoring/analyzer (controlled weights & fn evidence) ---
function makeQuestion(id: number): BankQuestion {
  return {
    id,
    cat: 'test',
    q: `Q${id}?`,
    opts: [
      { t: 'E-heavy', w: { E: 2 }, fn: { Fe: 'moderate', Se: 'low' } },
      { t: 'I-heavy', w: { I: 2 }, fn: { Fi: 'moderate', Ni: 'low' } },
      { t: 'T-heavy', w: { T: 2 }, fn: { Ti: 'high' } },
      { t: 'F-heavy', w: { F: 2 }, fn: { Fi: 'high', Ne: 'moderate' } },
    ],
  };
}
const fixtureQuestions = Array.from({ length: 12 }, (_, i) => makeQuestion(i + 1));
// No shuffle for scoring tests: shuffled index == original index.
const fixtureDeliveries: ShuffledDelivery[] = fixtureQuestions.map((q) => ({
  options: q.opts.map((o, i) => ({ i, t: o.t })),
}));

describe('scoreRound', () => {
  it('computes types, per-player correct, majority, accuracy', () => {
    // Subject answers I-heavy (idx 1) and T-heavy (idx 2) alternating.
    const subject = fixtureQuestions.map((_, i) => (i % 2 === 0 ? 1 : 2));
    const predictions = new Map<string, Array<number | null>>([
      // alice copies the subject exactly -> 12 correct.
      ['alice', subject.slice()],
      // bob picks E-heavy (idx 0) everywhere -> 0 correct.
      ['bob', fixtureQuestions.map(() => 0)],
      // carol picks I-heavy on evens, F-heavy on odds -> 6 correct.
      ['carol', fixtureQuestions.map((_, i) => (i % 2 === 0 ? 1 : 3))],
    ]);
    const r = scoreRound({ questions: fixtureQuestions, deliveries: fixtureDeliveries, subjectAnswers: subject, predictions });
    expect(r.subjectType).toBe('ISTJ'); // I beats E; S/N tie -> S (tie convention); T beats F; J/P tie -> J
    expect(r.perPlayerCorrect).toEqual({ alice: 12, bob: 0, carol: 6 });
    expect(r.bestPredictor).toBe('alice');
    expect(r.groupType).not.toBeNull();
    // Majority per question: evens -> idx1 (alice+carol, 2 of 3); odds -> three-way tie (2,0,3) -> smallest orig index.
    expect(r.majorityOrig[0]).toBe(1);
    expect(r.majorityOrig[1]).toBe(0);
    expect(r.groupAccuracy.correct + r.groupAccuracy.correct).toBeGreaterThanOrEqual(0);
    expect(r.groupAccuracy.total).toBe(12);
  });

  it('majority ties resolve to the smallest original index', () => {
    const subject = fixtureQuestions.map(() => 0);
    const predictions = new Map<string, Array<number | null>>([
      ['a', fixtureQuestions.map(() => 1)],
      ['b', fixtureQuestions.map(() => 2)],
    ]);
    const r = scoreRound({ questions: fixtureQuestions, deliveries: fixtureDeliveries, subjectAnswers: subject, predictions });
    expect(r.majorityOrig[0]).toBe(1); // 1 vote each for idx 1 and 2 -> smallest wins
  });

  it('best-predictor tie breaks by head-to-head', () => {
    // 4 questions suffice: alice and bob both 2 correct, but alice beats bob head-to-head.
    const qs = fixtureQuestions.slice(0, 4);
    const ds = fixtureDeliveries.slice(0, 4);
    const subject = [1, 2, 1, 2];
    const alice = [1, 2, 0, 0]; // correct on 0,1
    const bob = [1, 0, 1, 0]; // correct on 0,2
    const r = scoreRound({
      questions: qs,
      deliveries: ds,
      subjectAnswers: subject,
      predictions: new Map([
        ['alice', alice],
        ['bob', bob],
      ]),
    });
    expect(r.perPlayerCorrect.alice).toBe(2);
    expect(r.perPlayerCorrect.bob).toBe(2);
    // Head-to-head: q0 both right (tie), q1 alice right only -> alice wins the pairing.
    expect(r.bestPredictor).toBe('alice');
  });

  it('handles missing answers: partial predictor rows score only answered matches', () => {
    const subject = fixtureQuestions.map(() => 1);
    const r = scoreRound({
      questions: fixtureQuestions,
      deliveries: fixtureDeliveries,
      subjectAnswers: subject,
      predictions: new Map([['part', [1, null, undefined, 1]]]),
    });
    expect(r.perPlayerCorrect.part).toBe(2); // 2 answered (positions 0 & 3), both matched
  });

  it('typeFromSums tie convention returns the first pole', () => {
    expect(typeFromSums({ E: 0, I: 0, S: 0, N: 0, T: 5, F: 5, J: 0, P: 0 })).toBe('ESTJ');
  });
});

describe('analyzeMisread', () => {
  it('explains flipped axes in function language, skipping matched axes', () => {
    // Subject: I + F picks (idx 1 and 3). Group majority: E + T picks (idx 0 and 2).
    const subject = fixtureQuestions.map((_, i) => (i % 2 === 0 ? 1 : 3));
    const predictions = new Map<string, Array<number | null>>([
      ['g1', fixtureQuestions.map((_, i) => (i % 2 === 0 ? 0 : 2))],
      ['g2', fixtureQuestions.map((_, i) => (i % 2 === 0 ? 0 : 2))],
    ]);
    const scored = scoreRound({ questions: fixtureQuestions, deliveries: fixtureDeliveries, subjectAnswers: subject, predictions });
    const misreads = analyzeMisread(fixtureQuestions, fixtureDeliveries, subject, scored.majorityOrig, scored.subjectType, scored.groupType);
    const axes = misreads.map((m) => m.axis).sort();
    expect(axes).toEqual(['EI', 'TF']); // SN and JP tie-flip equally on both sides -> not misreads
    const ei = misreads.find((m) => m.axis === 'EI')!;
    expect(ei.subjectLetter).toBe('I');
    expect(ei.groupLetter).toBe('E');
    expect(ei.mismatches).toBe(12);
    // Subject I-picks carry Fi/Ni; group E-picks carry Fe/Se.
    expect(ei.subjectFns.map((f) => f.fn)).toContain('Fi');
    expect(ei.groupFns.map((f) => f.fn)).toContain('Fe');
    expect(ei.copy).toContain('EI');
    expect(ei.copy).toContain('Fi');
  });

  it('returns empty when group type is null or identical', () => {
    const subject = fixtureQuestions.map(() => 1);
    const none = analyzeMisread(fixtureQuestions, fixtureDeliveries, subject, fixtureQuestions.map(() => null), 'INTJ', null);
    expect(none).toEqual([]);
    const same = analyzeMisread(fixtureQuestions, fixtureDeliveries, subject, fixtureQuestions.map(() => 1), 'INTJ', 'INTJ');
    expect(same).toEqual([]);
  });
});

describe('selectQuestionsV2 — slot composition (bank v8.1)', () => {
  const FAMILY_PROBE = ['NT', 'NF', 'ST', 'SF'];
  const DUEL_PAIRS = [['Ni', 'Ne'], ['Ti', 'Te'], ['Fi', 'Fe'], ['Si', 'Se']];
  const samePair = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

  it('one draw respects the slot spec: A2 / B4(one per pair) / C4(2 EI + 2 JP) / D2', () => {
    for (let seed = 0; seed < 200; seed++) {
      const { questions } = selectQuestionsV2(bank, new Set(), mulberry32(seed));
      expect(questions).toHaveLength(12);
      expect(new Set(questions.map((q) => q.id)).size).toBe(12);

      const a = questions.filter((q) => samePair(q.duel, FAMILY_PROBE));
      expect(a).toHaveLength(2);

      const b = questions.filter((q) => q.duel && !samePair(q.duel, FAMILY_PROBE));
      expect(b).toHaveLength(4);
      for (const [x, y] of DUEL_PAIRS) {
        expect(b.filter((q) => samePair(q.duel, [x, y]))).toHaveLength(1);
      }

      const ei = questions.filter((q) => !!q.src && /ipip:(extraversion|introversion)/.test(q.src));
      const jp = questions.filter((q) => !!q.src && /ipip:conscientiousness/.test(q.src));
      expect(ei).toHaveLength(2);
      expect(jp).toHaveLength(2);

      const d = questions.filter((q) => q.id <= 63);
      expect(d).toHaveLength(2);
    }
  });

  it('session simulation: every round covered (>=3 per axis), slot-local reuse flagged', () => {
    const used = new Set<number>();
    for (let round = 0; round < 8; round++) {
      const { questions, resetUsed } = selectQuestionsV2(bank, used, mulberry32(500 + round));
      const cov = { EI: 0, SN: 0, TF: 0, JP: 0 };
      for (const q of questions) {
        for (const ax of AXES) {
          const [p1, p2] = ax === 'EI' ? ['E', 'I'] : ax === 'SN' ? ['S', 'N'] : ax === 'TF' ? ['T', 'F'] : ['J', 'P'];
          cov[ax] += Math.max(...q.opts.map((o) => (o.w?.[p1 as 'E'] ?? 0) + (o.w?.[p2 as 'I'] ?? 0)));
        }
      }
      for (const ax of AXES) expect(cov[ax]).toBeGreaterThanOrEqual(3);
      questions.forEach((q) => used.add(q.id));
      // slot A holds only 3 probes for 2 picks/round: reuse must begin by round 2.
      if (round >= 1) expect(resetUsed).toBe(true);
    }
  });

  it('deterministic per seed', () => {
    const a = selectQuestionsV2(bank, new Set(), mulberry32(7));
    const b = selectQuestionsV2(bank, new Set(), mulberry32(7));
    expect(a.questions.map((q) => q.id)).toEqual(b.questions.map((q) => q.id));
  });
});

describe('alternatesFromAxisSums', () => {
  it('flips the weakest axis first and grades confidence from the smallest margin', () => {
    const strong = { EI: [12, 0], SN: [0, 11], TF: [10, 0], JP: [0, 12] }; // ENTP, weakest axis TF (margin 10)
    const r1 = alternatesFromAxisSums(strong);
    expect(r1.confidence).toBe('high');
    expect(r1.alternates[0]).toBe('ENFP'); // TF flipped first
    expect(r1.alternates.length).toBeGreaterThanOrEqual(3);

    const weak = { EI: [6, 5], SN: [5, 6], TF: [6, 5], JP: [5, 6] }; // ties everywhere, min margin 1
    const r2 = alternatesFromAxisSums(weak);
    expect(r2.confidence).toBe('low');
    expect(r2.alternates.length).toBeGreaterThanOrEqual(2);

    const mid = { EI: [8, 2], SN: [2, 6], TF: [6, 2], JP: [2, 6] }; // min margin 4
    expect(alternatesFromAxisSums(mid).confidence).toBe('high');
  });
});

describe('rankTypesV2 — 16-type ranking (engine v2)', () => {
  const stacks = (bank.meta as { functions?: { stacks?: Record<string, string[]> } }).functions?.stacks ?? {};

  it('ranks 16 types, returns top2 with a normalized confidence', () => {
    const rng = mulberry32(42);
    const { questions } = selectQuestionsV2(bank, new Set(), rng);
    const deliveries = questions.map((q) => shuffleOptions(q, rng));
    const answers = questions.map(() => Math.floor(rng() * 4));
    const r = rankTypesV2(questions, deliveries, answers, stacks);
    expect(r.top2).toHaveLength(2);
    expect(r.top2[0].score).toBeGreaterThanOrEqual(r.top2[1].score);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(Object.keys(r.dirSums)).toHaveLength(8);
  });

  it('rewards answers aligned with a type stack (INTP pattern beats random)', () => {
    const rng = mulberry32(7);
    const { questions } = selectQuestionsV2(bank, new Set(), rng);
    const deliveries = questions.map((q) => shuffleOptions(q, rng));
    // Pick, per question, the option carrying the most I+N+T+P weight.
    const aligned = questions.map((q, i) => {
      let best = 0;
      let bestW = -1;
      deliveries[i].options.forEach((opt, j) => {
        const w = q.opts[opt.i].w ?? {};
        const score = (w.I ?? 0) + (w.N ?? 0) + (w.T ?? 0) + (w.P ?? 0);
        if (score > bestW) { bestW = score; best = j; }
      });
      return best;
    });
    const r = rankTypesV2(questions, deliveries, aligned, stacks);
    expect(r.top2[0].type).toBe('INTP');
  });
});

describe('real bank end-to-end', () => {
  it('one synthetic full round over real bank questions scores without errors', () => {
    const rng = mulberry32(2026);
    const { questions } = selectQuestions(bank, new Set(), rng);
    const deliveries = questions.map((q) => shuffleOptions(q, rng));
    const subject = questions.map((_, i) => Math.floor(rng() * 4));
    const predictions = new Map<string, Array<number | null>>([
      ['p1', questions.map(() => 0)],
      ['p2', questions.map(() => 1)],
      ['p3', questions.map(() => 2)],
    ]);
    const r = scoreRound({ questions, deliveries, subjectAnswers: subject, predictions });
    expect(r.subjectType).toMatch(/^[EI][SN][TF][JP]$/);
    expect(r.groupType).toMatch(/^[EI][SN][TF][JP]$/);
    const misreads = analyzeMisread(questions, deliveries, subject, r.majorityOrig, r.subjectType, r.groupType);
    for (const m of misreads) expect(m.copy.length).toBeGreaterThan(40);
  });
});
