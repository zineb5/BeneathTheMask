// Beneath the Mask — local full-game simulation (engine v2.7.5, bank v10.2).
// Plays one complete round through the REAL pipeline: 12-question adaptive
// route, subject answers, 4 predictors vote (one mostly abstains), reveal
// payload with 3 beats worth of data: alternates, readings/gaps, agreement,
// consensus. Done-definition gate for the implementation mission.
import { readFileSync } from 'node:fs';
import bankJson from '../supabase/functions/_shared/bank.json' with { type: 'json' };
import { mulberry32, type Bank, type ShuffledDelivery } from '../supabase/functions/_shared/engine.ts';
import {
  accumulate,
  axisSkeleton,
  buildRouteDeclaration,
  candidateDistribution,
  confidenceV2,
  consensusPerQuestion,
  contextFromBank,
  groupAggregate,
  individualReadings,
  routeTargets,
  selectAdaptiveRoute,
} from '../supabase/functions/_shared/engine_v2.ts';

const bank = bankJson as unknown as Bank;
const ctx = contextFromBank(bank);
const rng = mulberry32(20261016);

// 1) Adaptive route (PR2): 12 questions, three channels.
const { questions, floorWarnings } = selectAdaptiveRoute(ctx, new Set(), rng);
if (questions.length !== 12) throw new Error(`route length ${questions.length} != 12`);
const ids = new Set(questions.map((q) => q.id));
if (ids.size !== 12) throw new Error('duplicate questions in route');
const hasFamilyProbe = questions.some((q) => q.layer === 'family_probe');
const hasDuel = questions.some((q) => (q.duel ?? []).every((f) => ['Ni','Ne','Si','Se','Ti','Te','Fi','Fe'].includes(f)));
console.log('route:', questions.map((q) => `Q${q.id}${q.duel ? '(duel)' : ''}`).join(' '));
console.log('family probe in route:', hasFamilyProbe, '| function duel in route:', hasDuel, '| floor warnings:', floorWarnings);

const declarations = buildRouteDeclaration(ctx, questions.map((q) => q.id));
console.log('route_targets (locked at build):', declarations.targetList.join(', '));

// 2) Deliveries + answers (subject reads as an INTP-ish profile).
const deliveries: ShuffledDelivery[] = questions.map((q) => ({
  options: q.opts.map((_, i) => ({ i, t: q.opts[i].t })),
}));
const intpPick = (q: (typeof questions)[number]) => {
  let best = 0; let bestW = -1;
  q.opts.forEach((o, j) => {
    const w = o.w ?? {};
    const score = (w.I ?? 0) * 2 + (w.N ?? 0) * 2 + (w.T ?? 0) + (w.P ?? 0);
    if (score > bestW) { bestW = score; best = j; }
  });
  return best;
};
const subjectAnswers = questions.map(intpPick);

// 3) Predictors (PR1 §5): two aligned readers, one opposed reader, one abstainer.
const alignedPick = questions.map(intpPick);
const opposedPick = questions.map((q) => {
  let best = 0; let bestW = -1;
  q.opts.forEach((o, j) => {
    const w = o.w ?? {};
    const score = (w.E ?? 0) * 2 + (w.S ?? 0) * 2 + (w.F ?? 0) + (w.J ?? 0);
    if (score > bestW) { bestW = score; best = j; }
  });
  return best;
});
const noCluePick = questions.map((q) => q.opts.findIndex((o) => (o.b ?? []).includes('non-diagnostic') && !Object.keys(o.w ?? {}).length && !Object.keys(o.fn ?? {}).length));
const predictions = new Map<string, Array<number | null>>([
  ['reader-aligned-1', alignedPick],
  ['reader-aligned-2', alignedPick.map((v, i) => (i % 3 === 2 ? opposedPick[i] : v))],
  ['reader-opposed', opposedPick],
  ['abstainer', noCluePick],
]);

// 4) Three profiles.
const targets = routeTargets(ctx);
const acc = accumulate(questions, deliveries, subjectAnswers, ctx);
const skeleton = axisSkeleton(acc.axisSums);
const subjectDist = candidateDistribution(acc, questions.filter((q) => !q.duel), questions.filter((q) => !!q.duel), ctx);
const subjectConf = confidenceV2(subjectDist, skeleton, acc, questions, targets, ctx);
const readings = individualReadings(questions, deliveries, predictions, targets, ctx);
const aggregate = groupAggregate(readings, ctx);
const consensus = consensusPerQuestion(questions, deliveries, predictions);

console.log('\nSELF profile:', subjectDist.leader, '| confidence:', subjectConf.band, subjectConf.value.toFixed(3),
  '| all-undecided capped:', subjectConf.allUndecidedCapped);
console.log('also suspected (alternates):', subjectDist.probabilities.filter((p) => p.probability >= 0.05 && p.type !== subjectDist.leader).slice(0, 3).map((p) => `${p.type}(${(p.probability * 100).toFixed(0)}%)`).join(', '));
console.log('\nINDIVIDUAL READINGS (prediction gaps):');
for (const r of readings) {
  console.log(` ${r.playerId}: valid=${r.valid} answered=${r.answeredCount} abstained=${r.abstentionCount}` +
    (r.profile ? ` sees=${r.profile.type}(${(r.profile.probabilities[0].probability * 100).toFixed(0)}%) conf=${r.individualConfidence?.band}` : ''));
}
console.log('\nGROUP AGGREGATE (mean of valid posteriors): agreement =', aggregate.agreement, '| uniform =', aggregate.uniform);
console.log(' top4:', aggregate.probabilities.slice(0, 4).map((p) => `${p.type}(${(p.probability * 100).toFixed(1)}%)`).join('  '));
console.log('consensus: overall', consensus.overallConsensus.toFixed(3), '| votes/q:', consensus.votesPerQuestion.join(','));

// 5) Beat data presence check (done definition).
const problems: string[] = [];
if (!subjectDist.leader || !/^[EI][SN][TF][JP]$/.test(subjectDist.leader)) problems.push('subject type missing');
if (subjectDist.probabilities.filter((p) => p.probability >= 0.05 && p.type !== subjectDist.leader).length === 0) problems.push('no alternates');
if (readings.filter((r) => r.valid).length !== 3) problems.push('expected 3 valid readers');
if (readings.find((r) => r.playerId === 'abstainer')?.valid !== false) problems.push('abstainer should be invalid');
if (aggregate.uniform) problems.push('aggregate should not be uniform');
if (aggregate.agreement !== 'moderate' && aggregate.agreement !== 'divided') problems.push('expected moderate/divided agreement, got ' + aggregate.agreement);
if (consensus.overallConsensus <= 0) problems.push('consensus should be > 0 with real votes');
if (hasFamilyProbe !== true) problems.push('family probe missing');
if (hasDuel !== true) problems.push('function duel missing');
if (floorWarnings.length > 0) console.log('note: floor warnings (softened, allowed):', floorWarnings);

if (problems.length) {
  console.error('\nSIMULATION FAILED:', problems.join('; '));
  process.exit(1);
}
console.log('\nSIMULATION OK — full round: 12 questions, 3 valid readings + 1 abstainer, reveal data for all 3 beats.');
