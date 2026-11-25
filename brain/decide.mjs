// brain/decide.mjs — environment A, decision half: pick a candidate using
// ONLY the pre-computed policy table and simple pure math.
//
// HARD BOUNDARY: this module must NEVER import stream.mjs, slice.mjs, or
// read decisions.jsonl directly — not even transitively. It receives
// candidates and a policy snapshot as plain arguments and returns a choice.
// All history-dependent recomputation belongs to environment B
// (deliberate.mjs); this file only ever does O(candidates) table lookups.

import { ucb } from './formulas.mjs';

/**
 * Look up a candidate's policy entry, preferring the state-bucketed key
 * (`${stateBucket}::${key}`, written by deliberate.mjs's upgrade-3 bucketed
 * stats) and falling back to the global key when the bucket has no samples
 * yet (new bucket, or a policy table from before bucketing existed —
 * entries[key] is always still written alongside the bucketed ones for
 * exactly this fallback).
 *
 * @returns {{entry: object|null, bucketHit: boolean}}
 */
function policyEntryFor(policyTable, key, stateBucket) {
  if (stateBucket) {
    const bucketed = policyTable?.entries?.[`${stateBucket}::${key}`];
    if (bucketed && Number.isFinite(bucketed.proficiency_count) && bucketed.proficiency_count > 0) {
      return { entry: bucketed, bucketHit: true };
    }
  }
  return { entry: policyTable?.entries?.[key] ?? null, bucketHit: false };
}

/**
 * Score one candidate using the low-dimensional four-step lookup chain:
 *   1. weight            — policyTable.entries[key].weight (default 1)
 *   2. prior_confidence   — policyTable.entries[key].prior_confidence (default 0)
 *   3. proficiency_count  — policyTable.entries[key].proficiency_count / n (default 0)
 *   4. has_precedent      — policyTable.entries[key].has_precedent (default false => cold start)
 *
 * Combines a UCB1 base score (using n/sum/t from the table, never from raw
 * history) with the candidate's weight and Wiki-direction bonus/penalty.
 */
// Eligibility trace decay rate (TD-lambda style, stage 4): each
// deliberation round the entry was NOT revisited, its eligibility fades by
// this factor. 0.9 means ~10 rounds untouched roughly halves it
// (0.9^10 ≈ 0.35), so a candidate that was briefly strong long ago cannot
// keep outranking one that is actively succeeding right now purely on
// stale history — without zeroing it out instantly on a single quiet
// round either.
const ELIGIBILITY_DECAY_PER_ROUND = 0.9;

// How much of the (already [0,1]-bounded) decayed eligibility actually
// reaches the final score. Fix for a real magnitude bug: a raw eligibility
// of up to 1.0 added straight into the score could exceed wikiBonus (0.5)
// and directionPenalty (0.4), letting a merely-active-but-irrelevant
// candidate outrank one that actually hits the next Wiki split, or
// out-survive the off-route penalty. At 0.3x, the MAXIMUM possible
// eligibility contribution (1.0 * 0.3 = 0.3) stays strictly below both
// wikiBonus and directionPenalty's default magnitudes, so eligibility can
// only ever act as a tie-break/ranking nudge among otherwise-similar
// candidates, never override the Wiki-direction logic or the UCB1
// exploration term it rides alongside.
const ELIGIBILITY_SCORE_FACTOR = 0.3;

// Suspend/resume (task 2): minimum momentum-style bonus a resumed chain
// candidate (isResumeArc: true) always gets, even when the active persona's
// own momentum_bonus is 0 — small and strictly below wikiBonus (0.5) /
// directionPenalty (0.4) by construction, so it can nudge a resume back
// ahead of an equally-fresh alternative without ever overriding the
// Wiki-direction logic.
const RESUME_ARC_MOMENTUM_FLOOR = 0.15;

/**
 * Lightweight eligibility-trace-decayed score contribution for one policy
 * entry. Pure math, no I/O: `entry.eligibility`/`entry.last_updated_round`
 * are plain fields written by deliberate.mjs (see its doc comment) and read
 * here exactly as given — this file never recomputes them from history.
 * Entries from an older snapshot (or hand-seeded ones) that carry neither
 * field get 0 decay contribution, which is backward-compatible with every
 * existing test/behavior that predates this field.
 *
 * The raw stored `eligibility` is clamped into [0, 1] here (belt-and-
 * suspenders alongside deliberate.mjs's own clamp on write — a
 * hand-edited/corrupt snapshot value outside that range must never blow up
 * the score either way), THEN decayed, so the final contribution added to
 * the score (see ELIGIBILITY_SCORE_FACTOR above) can never exceed
 * `ELIGIBILITY_SCORE_FACTOR` in magnitude.
 *
 * @returns {number} eligibilityNow, already clamped+decayed — 0 when the
 *   entry has no eligibility field at all (nothing to decay).
 */
function decayedEligibility(entry, currentRound) {
  if (!Number.isFinite(entry?.eligibility)) return 0;
  const bounded = Math.min(1, Math.max(0, entry.eligibility));
  if (!Number.isFinite(entry?.last_updated_round) || !Number.isFinite(currentRound)) return bounded;
  const roundsPassed = Math.max(0, currentRound - entry.last_updated_round);
  return bounded * Math.pow(ELIGIBILITY_DECAY_PER_ROUND, roundsPassed);
}

// Action-family prefix used by the momentum bonus (task 2): everything
// before the first ':' in a candidate's key/id (e.g. 'gather:oak_log' ->
// 'gather', 'craft:wooden_pickaxe' -> 'craft', 'move:explore_n' -> 'move').
// A candidate with no ':' at all (e.g. a bare 'flee'/'eat' key) uses its
// whole key as its own family, which still compares correctly against
// itself round to round.
function actionFamilyOf(key) {
  if (typeof key !== 'string' || !key) return null;
  const idx = key.indexOf(':');
  return idx === -1 ? key : key.slice(0, idx);
}

function scoreCandidate(candidate, policyTable, { prior, wikiBonus, directionPenalty, stateBucket, anyHitsNext, recentFailures, persona, lastChosenKey }) {
  const { entry, bucketHit } = policyEntryFor(policyTable, candidate.key, stateBucket);

  // Step 1: weight
  const weight = Number.isFinite(entry?.weight) ? entry.weight : 1;

  // Step 2: prior confidence (used as the UCB "mean" seed via sum/n below)
  const priorConfidence = Number.isFinite(entry?.prior_confidence) ? entry.prior_confidence : 0;

  // Step 3: proficiency count (sample size)
  const n = Number.isFinite(entry?.proficiency_count) ? entry.proficiency_count : 0;

  // Step 4: has_precedent — explicit cold-start flag, independent of n in
  // case the table was hand-seeded with a precedent but no logged rounds.
  const hasPrecedent = Boolean(entry?.has_precedent) || n > 0;

  const sum = Number.isFinite(entry?.sum_reward) ? entry.sum_reward : priorConfidence * n;
  const t = Number.isFinite(policyTable?.total_rounds) && policyTable.total_rounds > 0 ? policyTable.total_rounds + 1 : 1;

  let base = hasPrecedent ? ucb(n, sum, t, prior) : prior;

  // Long-chain commitment multiplier (NOT the quota weight above): a
  // multi-step stitched macro's `macro_commitment` (see candidates.mjs/
  // deliberate.mjs's computeMacroFlowSummary() doc comment) is a SEPARATE
  // [0.2, 1.2] trust multiplier, applied here directly onto the
  // low-dimensional confidence/proficiency term (`base`) — never onto
  // `weight`, which stays a pure resource-allocation/quota knob untouched
  // by whether this particular long chain tends to finish or break
  // halfway. A chain that reliably completes earns an above-neutral
  // multiplier (trust its later steps more); one that keeps dying
  // partway earns a below-neutral one, nudging decide.mjs's own ranking
  // back toward a safer single-step alternative without ever touching
  // the quota/weight the human/persona/anti-domination logic manages
  // separately. Only applied to an ACTUAL multi-step candidate
  // (candidate.steps.length > 1) — a plain single-step candidate (the
  // overwhelming majority) is completely unaffected, and a macro with no
  // macro_commitment field at all (never attempted as a chain yet, or
  // predates this upgrade) defaults to the fully-neutral 1.0 multiplier,
  // same cold-start treatment this file already gives has_precedent.
  const isMultiStepCandidate = Array.isArray(candidate.steps) && candidate.steps.length > 1;
  const macroCommitmentMultiplier = isMultiStepCandidate && Number.isFinite(candidate.macro_commitment) ? candidate.macro_commitment : 1;
  if (isMultiStepCandidate) {
    base *= macroCommitmentMultiplier;
  }

  // Cross-scale fair competition (task 3): a multi-step chain's
  // `completion_rate` (real walk-through rate, [0,1]) and its milestone
  // span (`span_to_idx - span_from_idx`, how many Wiki splits it crosses
  // in ONE shot) are both READ here as their own explicit terms,
  // deliberately kept SEPARATE from the macroCommitmentMultiplier applied
  // to `base` just above — macro_commitment already folds completion_rate
  // into a single [0.2,1.2] multiplier, but task 3 asks for
  // completion_rate and the milestone span to each participate in
  // ranking in their own right, not merely be implied by commitment:
  //   - completionRateBonus: a small ADDITIVE term proportional to
  //     completion_rate itself (0 for an unattempted/never-finished
  //     chain, up to COMPLETION_RATE_BONUS_MAX for one that always
  //     finishes) — this is what lets a mature, high-walk-through-rate
  //     chain win a close race even when two chains happen to share a
  //     similar macro_commitment;
  //   - milestoneSpanBonus: a small ADDITIVE term proportional to how
  //     many splits this chain jumps in one shot — a 4-step chain that
  //     crosses 2 real milestones is worth MORE than one that only
  //     crosses 1, all else equal, since it is doing more real route
  //     work per decision round.
  // Both are bounded well below wikiBonus (0.5)/directionPenalty (0.4) by
  // construction (same discipline eligibilityContribution/
  // RESUME_ARC_MOMENTUM_FLOOR already follow), so neither can ever
  // override the Wiki-direction logic — they only ever break a close tie
  // between otherwise-similar multi-step candidates. A chain that keeps
  // breaking halfway (low completion_rate, macro_commitment pulled down
  // toward its 0.2 floor) gets NEITHER term, so its base score collapses
  // toward (or below) a comparable single-step candidate's own UCB score
  // — this is the "自动降级退回单步" (auto-degrade back to single-step)
  // behavior: nothing here forcibly disables the chain, it simply stops
  // being able to out-score the safer alternative once its own real
  // execution history says it is unreliable.
  const COMPLETION_RATE_BONUS_MAX = 0.2;
  const MILESTONE_SPAN_BONUS_PER_SPLIT = 0.08;
  const MILESTONE_SPAN_BONUS_MAX = 0.24;
  let completionRateBonus = 0;
  let milestoneSpanBonus = 0;
  if (isMultiStepCandidate) {
    if (Number.isFinite(candidate.completion_rate)) {
      completionRateBonus = Math.max(0, Math.min(1, candidate.completion_rate)) * COMPLETION_RATE_BONUS_MAX;
    }
    if (Number.isFinite(candidate.span_from_idx) && Number.isFinite(candidate.span_to_idx)) {
      const splitsCrossed = Math.max(0, candidate.span_to_idx - candidate.span_from_idx);
      milestoneSpanBonus = Math.min(MILESTONE_SPAN_BONUS_MAX, splitsCrossed * MILESTONE_SPAN_BONUS_PER_SPLIT);
    }
  }

  // Persona knobs (task 2): all five are plain multipliers/bonus, each
  // defaulting to a fully-neutral value (1 for multipliers, 0 for the
  // momentum bonus) when `persona` is not given at all — so every existing
  // caller/test that never passes `persona` behaves exactly as before this
  // upgrade. See persona.mjs's doc comment for what each knob means.
  const wikiDriveMult = Number.isFinite(persona?.wiki_drive) ? persona.wiki_drive : 1;
  const exploreAppetiteMult = Number.isFinite(persona?.explore_appetite) ? persona.explore_appetite : 1;
  const gatherHoardMult = Number.isFinite(persona?.gather_hoard) ? persona.gather_hoard : 1;
  const safetyCautionMult = Number.isFinite(persona?.safety_caution) ? persona.safety_caution : 1;
  const momentumBonusMagnitude = Number.isFinite(persona?.momentum_bonus) ? persona.momentum_bonus : 0;

  // directionDeviated only ever means "a candidate that actually advances
  // the route was AVAILABLE and something else got picked instead" — not
  // "nothing in the pool happens to advance the route" (e.g. every
  // candidate this round is an exploration move because nothing useful is
  // visible yet). Without the anyHitsNext gate, a forced-explore round
  // would log a false direction deviation every single time, since none of
  // its go_to candidates can ever set hitsNextSplit. A reserve-gather
  // candidate (isReserveGather: true — see candidates.mjs's "keep a real
  // fork in the road" fix) is a deliberate, legitimate alternative to the
  // main-line candidate, not a wrong turn — winning over a hitsNextSplit
  // candidate must never count as a direction deviation for it either,
  // exactly like the existing isSafety carve-out below.
  let directionDeviated = false;
  let directionAdjustment = 0;
  if (candidate.hitsNextSplit) {
    directionAdjustment = wikiBonus * wikiDriveMult;
  } else if (!candidate.isSafety && !candidate.isReserveGather) {
    directionAdjustment = -directionPenalty;
    if (anyHitsNext) directionDeviated = true;
  }

  // Short-term failure cooldown (in-memory only, never persisted/read from
  // decisions.jsonl or policy_snapshot.json): a candidate that just failed
  // repeatedly THIS RUN gets pushed down hard so a stuck direction/target
  // (e.g. explore_e repeatedly timing out against unwalkable terrain) does
  // not get picked again immediately just because its UCB score still
  // looks fine from stale history.
  const failCount = Number.isFinite(recentFailures?.[candidate.key])
    ? recentFailures[candidate.key]
    : Number.isFinite(recentFailures?.[candidate.id])
      ? recentFailures[candidate.id]
      : 0;
  const failurePenalty = failCount > 0 ? failCount * 5 : 0;

  // Eligibility-trace bonus: a small, decayed additive term (see
  // decayedEligibility() above) — deliberately kept lightweight (same
  // 0..~1-ish magnitude as prior_confidence, not scaled by weight) so it
  // acts as a tie-break/ranking nudge among otherwise-similar UCB scores
  // rather than a dominant factor. A candidate with no eligibility field at
  // all contributes exactly 0, so this is fully backward-compatible with
  // policy tables written before this field existed.
  const currentRound = Number.isFinite(policyTable?.total_rounds) ? policyTable.total_rounds : 0;
  const eligibilityNow = decayedEligibility(entry, currentRound);
  // Applied at ELIGIBILITY_SCORE_FACTOR (0.3x): see that constant's doc
  // comment — this keeps the maximum possible contribution (0.3) strictly
  // below wikiBonus (0.5) and directionPenalty (0.4) by construction, so
  // eligibility can nudge rankings but never overrule the Wiki-direction
  // bonus/penalty or dominate the UCB1 base score.
  const eligibilityContribution = eligibilityNow * ELIGIBILITY_SCORE_FACTOR;

  // weight <= 0 pushes the candidate to the bottom of the ranking without
  // removing it outright (it can still be chosen if it is the only option).
  const weightFactor = weight > 0 ? weight : 0.001;
  let score = base * weightFactor + directionAdjustment - failurePenalty + eligibilityContribution + completionRateBonus + milestoneSpanBonus;

  // Persona preference multiplier (task 2): applied to the whole score so
  // far, so a persona that favors exploration/hoarding/safety amplifies a
  // candidate's EXISTING standing rather than injecting a flat bonus that
  // could outrank a much stronger UCB/Wiki-direction case on its own. Only
  // one of these three ever applies per candidate (explore vs. gather vs.
  // safety are mutually exclusive candidate shapes in candidates.mjs), so
  // there is no risk of double-multiplying the same candidate.
  if (candidate.source === 'explore') {
    score *= exploreAppetiteMult;
  } else if (candidate.isReserveGather || (typeof candidate.key === 'string' && candidate.key.startsWith('gather:'))) {
    score *= gatherHoardMult;
  } else if (candidate.isSafety) {
    score *= safetyCautionMult;
  }

  // Momentum bonus (task 2): a flat additive nudge when this candidate's
  // action family (gather/craft/move/...) matches the PREVIOUS round's
  // chosen action family — `lastChosenKey` is pure in-memory context the
  // caller (auto_loop.mjs/tools_adapter.mjs) tracks itself per process,
  // never read from decisions.jsonl/policy_snapshot.json here. Magnitude
  // comes straight from persona.momentum_bonus (0 when no persona given),
  // so a 'balanced' persona's small default still nudges continuity
  // slightly, while 'speedrunner' leans harder into "keep doing what's
  // working" and a hand-rolled neutral persona (momentum_bonus: 0) turns
  // this off entirely.
  //
  // A suspend/resume candidate (candidates.mjs's isResumeArc: true — see
  // its own doc comment) is treated as automatically "same phase" as
  // whatever ran last, regardless of lastChosenKey's own action family:
  // it IS the literal continuation of a chain that was already underway
  // before an emergency interrupted it, not a coincidental family match,
  // so it earns this SAME bonus unconditionally (task 2's "享同阶段
  // momentum_bonus"). RESUME_ARC_MOMENTUM_FLOOR guarantees a small nudge
  // even under a neutral/no-persona caller (momentum_bonus: 0) — without
  // it, a 'balanced'-style zero-momentum persona would give a resumed
  // chain no help at all picking back up over a freshly-offered
  // alternative, defeating the point of suspending it in the first place.
  const isSameFamilyMomentum = actionFamilyOf(candidate.key) === actionFamilyOf(lastChosenKey);
  if (candidate.isResumeArc) {
    score += Math.max(momentumBonusMagnitude, RESUME_ARC_MOMENTUM_FLOOR);
  } else if (momentumBonusMagnitude > 0 && isSameFamilyMomentum) {
    score += momentumBonusMagnitude;
  }

  return { score, weight, priorConfidence, n, hasPrecedent, directionDeviated, bucketHit, failCount, eligibilityNow, eligibilityContribution, macroCommitmentMultiplier, completionRateBonus, milestoneSpanBonus };
}

/**
 * Choose the best candidate using only the policy snapshot (no history
 * recomputation). Safe on an empty candidate list.
 *
 * @param {object[]} candidates   from candidates.enumerateCandidates()
 * @param {object} policyTable    from policy_table.readPolicyTable()
 * @param {object} [options]
 * @param {number} [options.prior=10]            UCB prior for cold-start candidates
 * @param {number} [options.wikiBonus=0.5]        bonus for hitting the next Wiki split
 * @param {number} [options.directionPenalty=0.4] penalty for non-safety, off-route candidates
 * @param {string} [options.stateBucket]          computeStateBucket() id for the current
 *   state (see candidates.mjs); when given, each candidate's policy lookup
 *   prefers `entries["${stateBucket}::${key}"]` and falls back to the
 *   global `entries[key]` only when that bucket has zero samples yet.
 * @param {Record<string,number>} [options.recentFailures]  in-memory-only
 *   map of candidate id/key -> consecutive fail count THIS RUN (never read
 *   from decisions.jsonl/policy_snapshot.json — the caller, e.g.
 *   auto_loop.mjs/tools_adapter.mjs, tracks this itself per process). A
 *   nonzero count applies a `failCount * 5` score penalty so a candidate
 *   that just failed repeatedly yields to an untried alternative instead of
 *   being picked again purely on stale UCB history.
 * @param {object} [options.persona]  resolved persona preset (see
 *   persona.mjs's resolvePersona()) — plain multipliers/bonus read by
 *   scoreCandidate(); omitted entirely (or any individual knob missing)
 *   falls back to fully-neutral (1 for multipliers, 0 for momentum_bonus),
 *   so every pre-persona caller/test is completely unaffected.
 * @param {string} [options.lastChosenKey]  the PREVIOUS round's chosen
 *   candidate key, pure in-memory context the caller tracks itself (never
 *   read from decisions.jsonl/policy_snapshot.json here) — used only for
 *   persona.momentum_bonus's "same action family as last round" check.
 * @returns {{chosen: object|null, ranked: object[], directionDeviated: boolean}}
 */
export function chooseCandidate(candidates, policyTable, { prior = 10, wikiBonus = 0.5, directionPenalty = 0.4, stateBucket, recentFailures, persona, lastChosenKey } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) {
    return { chosen: null, ranked: [], directionDeviated: false };
  }

  const anyHitsNext = list.some(c => c.hitsNextSplit);

  const ranked = list
    .map(candidate => {
      const scored = scoreCandidate(candidate, policyTable, { prior, wikiBonus, directionPenalty, stateBucket, anyHitsNext, recentFailures, persona, lastChosenKey });
      return { candidate, ...scored };
    })
    .sort((a, b) => b.score - a.score);

  const chosen = ranked[0].candidate;
  const directionDeviated = ranked[0].directionDeviated;

  return { chosen, ranked, directionDeviated };
}
