# BENEATH THE MASK — ENGINE V2 SPEC (v2.4.7 APPROVED FOR CODING — 16 review rounds integrated, bank v9.9.2)

Incorporates review rounds 12-15 (15 = final approval with two conditions, both integrated). Zero architecture changes since v2.4; successive
rounds added only implementation precision. FROZEN for coding.

## 0. Priorities
1. Recognizable behavior  2. Defensible interpretation  3. Axis scoring (last).
Single answer = hypothesis, never proof.

## 1. Accumulators
EFFECTIVE WEIGHT: min(raw, 1) unless status == "validated_for_game_use".
- axisSums (effective weights)
- dirSums_general: DERIVED fn x context sensitivity (0.5 high / 0.75 moderate)
- dirSums_duel: EXPLICIT fn on duel strongs ONLY (separate accumulator)
- constructLog, duelLog
ROUTE METADATA (review 14 — declared BEFORE questions, never post-hoc):
    route_targets = the 4 signal constructs this round intends to test
    (stored when the round is built; confidence and coverage use THESE, never a
    denominator chosen after seeing results)

## 2. Candidate distribution + AXIS GUARD (temporary, recoverable masking)
    axis_skeleton: per axis, higher pole and margin = |diff| / sum; DECIDED if margin > 0.20
    candidate_set = 16 types minus types contradicting ANY currently-decided letter
    (review 14: masking is TEMPORARY — if later evidence drops an axis below the
    threshold, its masked types return. No irreversible elimination.)
    axis_fit(T), per axis (review 12.1):
        if margin <= 0.20: contribution = 0.5                    (neutral)
        elif T's letter == higher_pole: contribution = 0.5 + 0.5 * margin
        else: contribution = 0.5 - 0.5 * margin
        axis_fit(T) = mean of the four contributions  -> [0,1]
    function_fit(T) (review 12.2 + 15.1 — PER CANDIDATE normalization):
        raw(T) = 2*dirSums_general[dom(T)] + dirSums_general[aux(T)]
        max_possible(T) = the best-possible evidence THESE questions could have
        produced FOR T's specific stack (different stacks have different possible
        support — never one universal denominator)
        function_fit(T) = raw(T) / max_possible(T)
        ZERO GUARD (review 16): if max_possible(T) == 0 -> function_fit(T) = 0
        (candidate whose stack has no matching evidence in this route)
    duel_fit(T) (review 12.3):
        raw(T) = duel accumulator support for T
        max_possible(T) = sum over ASKED duels of their max support FOR T (per candidate)
        duel_fit(T) = raw / max_possible(T)
        ZERO GUARD: if max_possible(T) == 0 -> duel_fit(T) = 0
    candidate(T) = 0.65*axis_fit + 0.25*function_fit + 0.10*duel_fit   (all in [0,1])
    score(T) = softmax(candidate / tau) over the CURRENT candidate_set (review 16);
    masked types are stored separately as 'temporarily masked, recoverable' —
    softmax over compatible candidates only, never zero-probability deletion.
    tau = 0.1-0.2 at pilot
Undecided axis tipped by process evidence -> reveal labels it ("axis evidence was close
on S/N; process leaned N, so N was selected"). Candidates < 0.05 probability listed
as "unlikely" (recoverable).

## 3. P(option | type) — AXIS COMPATIBILITY ONLY
    compatibility = sum over option.w poles p: +w[p] if type's letter matches p
    raw = softmax(compatibility / 0.5)
    P_i = (raw_i + 0.05) / 1.20        (renormalized Laplace; assert sum == 1)
EIG(Q) = H(current) - expected H after Q under these posteriors.
COVERAGE PRIORITY: 1) <=14  2) >=2 independent opportunities/axis where possible
3) no duplicate primary construct (0.5 discount)  4) max EIG  5) weakest axes first.

## 4. Predictor scoring (the game)
1 point per exact match. NO CLUE = abstention: 0 points, no group evidence, excluded
from denominators, counted. Missing = 0. Tie -> head-to-head.

## 5. Two profiles
SELF: subject answers -> engine. GROUP per question: weighted vote mixture;
all-abstain -> uniform prior + consensus 0; consensus = 1 - H/log2(K).

## 6. Reveal
Beat 1: leader + avatar + playful archetype + tagline + "Also suspected". LOW CONFIDENCE:
function pattern first, archetype second. Axis vs process letters labeled.
Beat 2: group leader + consensus label + per-axis comparison + accuracy + best predictor
+ PREDICTION GAPS (divergence proves nothing about who was right).
Beat 3: celebrities (community attribution) + share card. Disclaimer everywhere.

## 7. CONFIDENCE
    score_margin = P(leader) - P(runner-up) [0-1]
    coverage = min(observed independent constructs supporting leader / len(route_targets), 1)
               (review 14: route_targets pre-declared; unscored constructs never count)
    item_reliability = evidence-weighted mean of item reliabilities supporting leader
    repeated_signal_penalty = 0.05 per leader construct hit by >1 same-family question, max 0.15
    confidence = clamp(0.65*margin + 0.20*coverage + 0.15*item_reliability - penalty, 0, 1)
    BANDS: Low < 0.40 | Moderate 0.40-0.69 | High >= 0.70
    ALL-UNDECIDED CAP (review 15.2): if all four axis margins are undecided, the
    engine relies on function+duel evidence AND confidence cannot exceed Moderate —
    a process-based result never looks more certain than the axis evidence supports.

## 8. Calibration
status: uncalibrated -> pilot_tested -> validated_for_game_use. Pilot protocol in bank meta.

## 9. Implementation (2 PRs) + TESTING ROUTE ONLY
"3 probes + 4 duels + 5 everyday" = validation/testing route only, never hard-coded.
vitest fixtures: candidate masking respects decided letters and RECOVERS when an axis
undecides; sum(P(option|type)) == 1; P uses axes only; all three fits in [0,1] with
zero guards; route_targets locked before answers (attempting to change them mid-round
fails); weight 2 impossible uncalibrated; 4/7-3/7 -> mixed group profile; all-abstain ->
uniform + consensus 0; exhausted duel bank -> entropy fallback; low confidence ->
function pattern, not acronym; duel fn never double-counts.

## 10. Non-goals (review 12.4: terminology corrected)
No irreversible elimination (decided-axis masking is temporary and recoverable).
No per-option authored 16-vectors. No schema change. No new edge functions.
