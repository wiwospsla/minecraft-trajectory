// brain/deliberate.mjs — environment B: periodic, high-dimensional review.
//
// This module is the ONLY place allowed to read the full decisions.jsonl
// history (via slice.mjs) and recompute policy. It consumes the stream,
// looks at the four "flow shapes" (learning index / weight / confidence /
// proficiency) plus Wiki deviation, and atomically republishes
// policy_snapshot.json for environment A to read on its next decision.
//
// It must NEVER drive the game (no bot/tool calls here), and must NEVER
// rewrite splits.json — the Wiki route itself is a fixed target, only the
// policy table (how confidently/eagerly each candidate is chosen) adapts.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as slice from './slice.mjs';
import { LOG_PATH } from './stream.mjs';
import { evaluate } from './wiki.mjs';
import { logDeviation } from './log.mjs';
import { POLICY_PATH, readPolicyTable, writePolicyTableAtomic, mergeWikiPriorsColdStart } from './policy_table.mjs';
import { computeStateBucket } from './candidates.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SPLITS_PATH = join(__dirname, 'splits.json');
export const CONFIRM_PATH = join(__dirname, '..', 'pending_confirm.jsonl');
export const AUDIT_PATH = join(__dirname, '..', 'confirm_audit.jsonl');

function readSplits(splitsPath) {
  try {
    return JSON.parse(readFileSync(splitsPath, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Build the {inventory, dimension} state wiki.evaluate() expects out of the
 * most recent record in the stream that actually carries observed state.
 * Decision proposals and outcome records both carry `state` (see
 * tools_adapter.mjs); this picks the newest one so deliberation reflects the
 * freshest known world state even if the very last record is an outcome
 * line with no fresh observation of its own.
 */
function latestKnownState(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (rec && rec.kind !== 'deviation' && rec.state && typeof rec.state === 'object') {
      return rec.state;
    }
  }
  return { inventory: {}, dimension: null };
}

/**
 * Per-candidate-key cur_idx trail across the window, oldest first, taken
 * only from outcome records (the ones that carry a result and therefore a
 * meaningful "did progress happen" signal). Proposal-only records (not yet
 * resolved by brain_record_outcome) are skipped since they have no result.
 */
function outcomeRecordsOf(records) {
  return records.filter(rec => rec && rec.kind !== 'deviation' && rec.result !== undefined && rec.chosen);
}

/**
 * Learning index: has the global route index (`cur_idx`) advanced recently?
 * Looks at the last `stallK` outcome records' own recorded `cur_idx` (taken
 * at decision time) and flags a stall when none of them show an advance
 * relative to the earliest one in that window.
 */
function learningIndexStalled(outcomes, stallK) {
  if (outcomes.length < stallK) return { stalled: false, window: outcomes };
  const windowed = outcomes.slice(-stallK);
  const idxs = windowed.map(r => (Number.isFinite(r.cur_idx) ? r.cur_idx : -1));
  const first = idxs[0];
  const stalled = idxs.every(idx => idx <= first);
  return { stalled, window: windowed, first, last: idxs[idxs.length - 1] };
}

/**
 * Weight shape: is one candidate crowding out everything else? Returns the
 * share (0..1) held by the most-chosen candidate in the window.
 */
function dominantShare(agg) {
  const counts = Object.values(agg).map(a => a.n);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return { share: 0, total: 0 };
  const top = Math.max(...counts);
  return { share: top / total, total };
}

/**
 * Confidence shape: fraction of candidates in the window that have fewer
 * than `minSamples` observations (i.e. are still statistically shaky).
 */
function lowSampleShare(agg, minSamples = 3) {
  const keys = Object.keys(agg);
  if (!keys.length) return 0;
  const low = keys.filter(k => agg[k].n < minSamples).length;
  return low / keys.length;
}

/**
 * Proficiency shape: recent success rate and its volatility (stdev of the
 * 0/1 reward sequence) across the whole window, regardless of candidate.
 * Deliberately stays a plain 0/1 success rate (not the efficiency reward
 * below) — this is a diagnostic "how often does anything succeed" shape,
 * not the per-candidate policy reward decide.mjs's UCB math consumes.
 */
function proficiencyShape(outcomes) {
  if (!outcomes.length) return { successRate: 0, volatility: 0, n: 0 };
  const rewards = outcomes.map(r => (r?.result?.ok ? 1 : 0));
  const n = rewards.length;
  const mu = rewards.reduce((a, b) => a + b, 0) / n;
  const variance = rewards.reduce((acc, r) => acc + (r - mu) ** 2, 0) / n;
  return { successRate: mu, volatility: Math.sqrt(variance), n };
}

// Efficiency reward (task 1): rewards not just succeeding, but succeeding
// FAST, so the second time through a route segment that already worked
// once can actually outscore a slower repeat of the same success —
// otherwise two equally-"ok:true" outcomes always looked identical to the
// UCB math regardless of how many real seconds either one burned.
//   reward = ok ? max(0.3, 1 - min(duration_ms, 20000) / 28000) : 0
// At duration_ms=0 this is 1.0 (fastest possible full reward); at
// duration_ms>=20000 (the cap) it bottoms out at 1 - 20000/28000 ≈ 0.286,
// which the outer max(0.3, ...) floors to 0.3 — a slow-but-successful
// action still earns a solid reward, just visibly less than a fast one, and
// never collapses toward the 0 a real failure gets.
const EFFICIENCY_DURATION_CAP_MS = 20000;
const EFFICIENCY_DURATION_DIVISOR_MS = 28000;
const EFFICIENCY_REWARD_FLOOR = 0.3;

/**
 * Pure reward function for one outcome record. Backward-compatible: a
 * record written before duration_ms existed (or one missing it for any
 * other reason) falls back to the plain `ok ? 1 : 0` this module always
 * used before this upgrade, so re-deliberating over old decisions.jsonl
 * history never changes its past behavior.
 *
 * Task 3 ("跨尺度粒度对齐"): before applying the duration-based efficiency
 * formula, a MULTI-STEP outcome's own `duration_ms` (the WALL-CLOCK time
 * for the WHOLE chain, e.g. 4 real tool calls back to back) is first
 * amortized across however many steps it actually completed —
 * `effectiveDurationMs = duration_ms / max(1, completedSteps)` — so a
 * genuinely efficient 4-step chain that took 8000ms total (2000ms/step)
 * is scored on that PER-STEP 2000ms, not unfairly compared on its raw
 * 8000ms total against a single 2-second atomic action. Without this, a
 * long chain's aggregate duration would almost always exceed a single
 * step's, making every multi-step macro look "slow" by this formula no
 * matter how fast each of its own steps actually ran — exactly the unfair
 * ruler task 3 calls out. A plain single-step outcome (completedSteps
 * absent, or <= 1) is completely unaffected: effectiveDurationMs reduces
 * to the original duration_ms unchanged.
 *
 * @param {{result?: {ok?: boolean}, duration_ms?: number, macro_completed_steps?: number}} rec
 * @returns {number}
 */
function efficiencyReward(rec) {
  const ok = Boolean(rec?.result?.ok);
  if (!ok) return 0;
  if (!Number.isFinite(rec?.duration_ms)) return 1; // old log / missing field: pre-upgrade behavior
  const completedSteps = Number.isFinite(rec?.macro_completed_steps) ? rec.macro_completed_steps : 1;
  const effectiveDurationMs = rec.duration_ms / Math.max(1, completedSteps);
  const cappedMs = Math.min(effectiveDurationMs, EFFICIENCY_DURATION_CAP_MS);
  return Math.max(EFFICIENCY_REWARD_FLOOR, 1 - cappedMs / EFFICIENCY_DURATION_DIVISOR_MS);
}

/**
 * Per-candidate-key efficiency-reward stats computed directly from outcome
 * records (NOT slice.stats(), which only ever gives a plain 0/1 reward and
 * is a basic file this task must not change). Same {n,sum,mu} shape
 * slice.stats() returns, so it is a drop-in replacement everywhere
 * runDeliberation() turns window stats into policy entries.
 *
 * @param {object[]} outcomes  outcomeRecordsOf() output
 * @returns {Record<string, {n:number, sum:number, mu:number}>}
 */
function efficiencyStatsOf(outcomes) {
  const agg = {};
  for (const rec of outcomes) {
    const key = rec.chosen;
    if (!key) continue;
    agg[key] ??= { n: 0, sum: 0, mu: 0 };
    agg[key].n += 1;
    agg[key].sum += efficiencyReward(rec);
  }
  for (const key of Object.keys(agg)) {
    agg[key].mu = agg[key].n > 0 ? agg[key].sum / agg[key].n : 0;
  }
  return agg;
}

/**
 * Has this exact stall already been flagged? Dedupe key is
 * (reason, stuck_at_idx, decision_id of the last window record) so a
 * repeated deliberation pass over an unchanged tail doesn't spam
 * pending_confirm.jsonl with duplicate entries every time it's called.
 */
function alreadyPendingForStall(confirmPath, dedupeKey) {
  if (!existsSync(confirmPath)) return false;
  let raw;
  try {
    raw = readFileSync(confirmPath, 'utf8');
  } catch {
    return false;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (rec?.dedupeKey === dedupeKey) return true;
    } catch {
      // ignore corrupt trailing line, same tolerance as stream.readAll
    }
    break; // only need to check the most recent entry to avoid immediate re-spam
  }
  return false;
}

function appendPendingConfirm(confirmPath, record) {
  appendFileSync(confirmPath, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Read every parseable line of a JSONL file, tolerating a missing file or
 * a corrupt trailing line (same contract as stream.readAll(), reimplemented
 * here rather than imported since this reads confirm/audit files, not
 * decisions.jsonl — the stream.mjs/slice.mjs import ban only concerns the
 * decision log itself).
 */
function readJsonlFile(path) {
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // tolerate a corrupt/partial trailing line, same as stream.readAll()
    }
  }
  return out;
}

/**
 * HITL confirmation intake — the ONLY place a human-written `confirmed:
 * true` record in pending_confirm.jsonl can take effect, and it never
 * self-approves anything: runDeliberation() only ever WRITES `pending:
 * true` records there (see the progress-stall block above); a record only
 * becomes actionable once a human has edited/appended `confirmed: true` to
 * it (or appended a brand new confirmed record with the same `dedupeKey`)
 * by hand. This function never flips `pending` to `confirmed` itself and
 * never touches splits.json.
 *
 * Idempotent: each confirmed record's `dedupeKey` is checked against every
 * `dedupeKey` already present in confirm_audit.jsonl; if found, that
 * confirmation already took effect and is skipped (so calling
 * runDeliberation() repeatedly, or a human leaving an old confirmed record
 * in place, can never re-apply the same adjustment twice). Exactly one
 * audit line is appended per newly-applied confirmation.
 *
 * Supported `decision_action` values:
 *   - 'penalize_stalled': halves the stalled candidate's weight (floor 0.1)
 *   - 'boost_explore':    sets every move:explore_* candidate's weight to 1.5
 *
 * @returns {{applied: number}}
 */
function applyHumanConfirmations(entries, confirmPath, auditPath) {
  const pendingRecords = readJsonlFile(confirmPath).filter(r => r?.confirmed === true && typeof r?.dedupeKey === 'string');
  if (!pendingRecords.length) return { applied: 0 };

  const alreadyAudited = new Set(readJsonlFile(auditPath).map(r => r?.dedupeKey).filter(Boolean));

  let applied = 0;
  for (const record of pendingRecords) {
    if (alreadyAudited.has(record.dedupeKey)) continue; // already applied once; never re-apply

    const action = record.decision_action;
    let affectedKeys = [];

    if (action === 'penalize_stalled') {
      // Penalize the specific stalled candidate named on the record (its
      // own `chosen`/`next_target` from the original progress_stall entry
      // — see the block that writes pending records above), if present;
      // otherwise this confirmation names nothing to act on and is
      // recorded as a no-op audit entry rather than silently guessing.
      const targetKey = typeof record.chosen === 'string' ? record.chosen : null;
      if (targetKey && entries[targetKey]) {
        entries[targetKey] = {
          ...entries[targetKey],
          weight: Math.max(0.1, (Number.isFinite(entries[targetKey].weight) ? entries[targetKey].weight : 1) * 0.5),
        };
        affectedKeys = [targetKey];
      }
    } else if (action === 'boost_explore') {
      for (const key of Object.keys(entries)) {
        if (!key.includes('move:explore_')) continue;
        entries[key] = { ...entries[key], weight: 1.5 };
        affectedKeys.push(key);
      }
    }
    // Unknown/missing decision_action: still audited (so it is never
    // silently re-read every pass) but applies no weight change.

    appendPendingConfirm(auditPath, {
      dedupeKey: record.dedupeKey,
      decision_action: action ?? null,
      affectedKeys,
      appliedAt: new Date().toISOString(),
    });
    applied += 1;
  }
  return { applied };
}

/**
 * Strip historical absolute world coordinates out of a macro step's `args`
 * before it is ever saved into policy_snapshot.json — a `place` step's
 * x/y/z were only ever valid relative to wherever the bot happened to be
 * standing the one time this macro was recorded; replaying those exact
 * absolute coordinates on a LATER run (a different spawn/position
 * entirely) would try to place a block nowhere near the bot, or inside
 * solid terrain. Instead, the saved template keeps `relativePlacement:
 * true` as a marker and drops x/y/z entirely — candidates.mjs (when
 * collaging a stitched macro into a candidate) and macro_executor.mjs
 * (when actually about to run a `place` step) both re-derive a concrete,
 * currently-valid placement cell from whatever the CURRENT obsState.pos /
 * bot.entity.position is at the moment it is actually offered/executed —
 * never from this frozen template.
 *
 * Every other tool's args (gather/craft/smelt/go_to) are position-
 * independent in the real tool signatures (block name, item name, counts)
 * except go_to's own x/y/z — but go_to targets are either exploration
 * candidates (never lifted into a stitched macro; candidates.mjs always
 * regenerates them fresh) or a `go_to crafting_table` step toward a
 * specific placed table recipe_planner.mjs already resolved live each
 * round, so only `place` needs this treatment.
 */
function relativizeMacroArgs(tool, args) {
  const a = args ?? {};
  if (tool !== 'place') return a;
  const { x, y, z, ...rest } = a;
  return { ...rest, relativePlacement: true };
}

/**
 * Pull reusable "stitched macro" templates out of the window: outcome
 * records whose action both succeeded (`result.ok === true`) AND advanced
 * the route (`cur_idx` recorded on that outcome's matching proposal is
 * higher than the proposal's own prior cur_idx would suggest — approximated
 * here via the proposal's `cur_idx` compared against the NEXT proposal's
 * `cur_idx` in the stream, since outcome records don't carry a before/after
 * pair of their own). Deduplicated by candidate key, newest first, capped
 * at 10. These become `source: 'stitched'` candidates for environment A on
 * its next policy_snapshot.json read — never executed directly by this
 * module (deliberate.mjs never drives the bot).
 */
function extractStitchedMacros(records) {
  // Build decision_id -> proposal record. Proposals carry `cur_idx` (route
  // position at proposal time) and `chosen_spec` (the full executable shape
  // of the candidate that was proposed: tool/args/requires/ensures), so a
  // later outcome can be matched back to exactly what was run, with no need
  // to re-derive tool/args from candidates.mjs by id.
  const proposalsById = new Map();
  for (const rec of records) {
    if (rec && rec.kind !== 'deviation' && rec.proposed !== undefined && rec.decision_id !== undefined) {
      proposalsById.set(rec.decision_id, rec);
    }
  }

  // Route progress is measured proposal-to-proposal: find the next proposal
  // AFTER a given one in stream order and compare cur_idx.
  const proposalsInOrder = records.filter(rec => rec && rec.kind !== 'deviation' && rec.proposed !== undefined);

  const macros = [];
  const seenKeys = new Set();
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (!rec || rec.kind === 'deviation' || rec.result === undefined || !rec.chosen) continue;
    if (!rec.result.ok) continue;
    if (seenKeys.has(rec.chosen)) continue;

    const proposal = proposalsById.get(rec.decision_id);
    const spec = proposal?.chosen_spec;
    if (!proposal || !spec || spec.key !== rec.chosen) continue;

    const proposalIndex = proposalsInOrder.indexOf(proposal);
    const nextProposal = proposalIndex >= 0 ? proposalsInOrder[proposalIndex + 1] : undefined;
    const advanced = nextProposal && Number.isFinite(nextProposal.cur_idx) && Number.isFinite(proposal.cur_idx)
      ? nextProposal.cur_idx > proposal.cur_idx
      : false;
    if (!advanced) continue;

    macros.push({
      id: spec.id ?? rec.chosen,
      key: spec.key ?? rec.chosen,
      tool: spec.tool ?? null,
      args: relativizeMacroArgs(spec.tool, spec.args),
      requires: Array.isArray(spec.requires) ? spec.requires : [],
      ensures: Array.isArray(spec.ensures) ? spec.ensures : [],
      // Single-step player-chapter metadata, same meaning as the
      // multi-step chain's own span_from_idx/span_to_idx/phase_label below
      // — one verified step still carries a real (tiny) milestone span.
      span_from_idx: proposal.cur_idx,
      span_to_idx: proposal.cur_idx + 1,
      phase_label: `idx ${proposal.cur_idx} -> idx ${proposal.cur_idx + 1}`,
      smoothness: 'direct',
    });
    seenKeys.add(rec.chosen);
    if (macros.length >= 10) break;
  }
  return macros;
}

/**
 * Pull reusable MULTI-STEP "stitched macro" templates out of the window
 * (stage 4 upgrade to extractStitchedMacros() above, which only ever lifts
 * ONE verified action at a time): a run of 2-3 CONSECUTIVE proposals in
 * stream order where EVERY step both succeeded (`result.ok === true`) and
 * strictly advanced `cur_idx` relative to the step before it. Only
 * genuinely-verified sequences qualify — this never guesses or stitches
 * together actions that merely look compatible; every step in the chain
 * must have actually run and actually advanced the route, exactly once,
 * in exactly this order, in real decisions.jsonl history.
 *
 * The resulting macro executes as its FIRST step's tool/args (so it stays
 * a single real tool call candidates.mjs can offer this round, with no new
 * multi-call execution machinery needed) but carries the full validated
 * `steps` array as metadata, and its `requires` are gated on the first
 * step's own requires — candidates.mjs only ever offers it when THAT
 * prerequisite is satisfied by the current state (see its stitched-macro
 * loop), never on a guess about later steps.
 *
 * @param {object[]} records  slice.window() output, oldest first
 * @returns {object[]} macros shaped like
 *   { id, key, tool, args, requires, ensures, steps: [{key,tool,args,requires,ensures}, ...] }
 */
// A step is "exploratory/reactive" (never counted as a real production
// step inside a multi-step chain, even when it happens to succeed) when
// its key is a blind compass hop (move:explore_*) or a reactive safety
// action (flee/eat) — these are never the kind of repeatable "same-stage
// combo" task 1 asks for (e.g. gather:wood_log -> craft:oak_planks), they
// are either generic probing or situational reactions that say nothing
// about a reusable production sequence.
function isExploratoryOrSafetyKey(key) {
  return typeof key === 'string' && (key.startsWith('move:explore_') || key === 'flee' || key === 'eat');
}

/**
 * Is this proposal pure noise that a real production chain should be
 * allowed to see straight THROUGH (never counted as a chain member, never
 * breaking adjacency either) — a successful exploration hop, a successful
 * safety reaction (flee/eat), or any outright FAILED proposal (`result.ok
 * === false`)? This is the anti-noise relaxation task 1 asks for: a bot
 * that gathers a log, takes one blind explore_n hop while deciding what to
 * do next, flees a zombie that wandered by, and THEN crafts planks did
 * genuinely execute "gather -> craft" back to back in every sense that
 * matters for a reusable macro — the intervening hop/flee were never part
 * of that combo and must not be allowed to sever it. A failed candidate
 * (of any kind, including a failed production action) is noise in the
 * same sense: it never actually produced anything, so it cannot be a
 * meaningful link in a causal chain either way.
 *
 * This is NOT the same thing as "transparent to the chain" for a step that
 * genuinely ran and succeeded as a DIFFERENT production action — that case
 * still correctly breaks adjacency below (an unrelated successful
 * production step in between really did happen and really did sit between
 * the two real chain steps, so stitching across it would misrepresent what
 * actually ran in sequence).
 */
function isSkippableNoise(proposal) {
  const spec = proposal?.chosen_spec;
  const key = spec?.key;
  if (isExploratoryOrSafetyKey(key)) {
    // Only skippable if it actually ran as logged, i.e. has a matching
    // outcome — an unresolved proposal (no outcome yet) is handled by the
    // caller's own outcomesById lookup below, not here.
    return true;
  }
  return false;
}

function extractMultiStepMacros(records) {
  const outcomesById = new Map();
  for (const rec of records) {
    if (rec && rec.kind !== 'deviation' && rec.result !== undefined && rec.decision_id !== undefined) {
      outcomesById.set(rec.decision_id, rec);
    }
  }
  const proposalsInOrder = records.filter(rec => rec && rec.kind !== 'deviation' && rec.proposed !== undefined);

  // For each proposal in order, resolve whether it is a "verified step": it
  // has a matching outcome with result.ok === true for the SAME
  // chosen_spec.key (so an outcome for a different/unrelated decision_id
  // can never be mismatched onto this proposal) and is not a pure
  // exploration/safety action (see isExploratoryOrSafetyKey() above), plus
  // whether THIS STEP ITSELF actually advanced cur_idx (checked against the
  // very next proposal's own cur_idx — the same proposal-to-proposal
  // measurement extractStitchedMacros()'s single-step `advanced` already
  // uses, so a step only ever counts as "advancing" when IT caused the
  // jump, not merely because it happened to run after some earlier step's
  // jump already landed cur_idx higher).
  function verifiedStepOf(proposal, index) {
    const spec = proposal?.chosen_spec;
    if (!spec || !Number.isFinite(proposal?.cur_idx)) return null;
    if (isExploratoryOrSafetyKey(spec.key)) return null;
    const outcome = outcomesById.get(proposal.decision_id);
    if (!outcome || outcome.chosen !== spec.key || !outcome.result?.ok) return null;
    const nextProposal = proposalsInOrder[index + 1];
    const advancedBySelf = Boolean(
      nextProposal && Number.isFinite(nextProposal.cur_idx) && nextProposal.cur_idx > proposal.cur_idx,
    );
    return {
      key: spec.key,
      tool: spec.tool ?? null,
      args: relativizeMacroArgs(spec.tool, spec.args),
      requires: Array.isArray(spec.requires) ? spec.requires : [],
      ensures: Array.isArray(spec.ensures) ? spec.ensures : [],
      cur_idx: proposal.cur_idx,
      advancedBySelf,
    };
  }

  // Noise this backward walk is allowed to see straight THROUGH, never
  // counting it as a chain member and never breaking adjacency on it: a
  // successful exploration/safety proposal (isSkippableNoise()), or any
  // proposal whose own outcome resolved to a real FAILURE — a failed
  // attempt never produced anything, so (unlike an unrelated successful
  // production step, which really did happen and really does break the
  // causal story) it carries no information that should ever sever two
  // real successful production steps found on either side of it.
  function isFailedProposal(proposal) {
    const outcome = outcomesById.get(proposal?.decision_id);
    return Boolean(outcome) && outcome.result?.ok === false;
  }
  function isWalkableNoise(proposal) {
    return isSkippableNoise(proposal) || isFailedProposal(proposal);
  }

  const MAX_CHAIN = 3;
  const macros = [];
  const seenChainKeys = new Set();

  // Task 1 relaxation: a chain's LAST step must be the one that actually
  // caused a cur_idx jump (advancedBySelf === true) — that boundary rule
  // from the previous upgrade is UNCHANGED and still what truncates the
  // macro exactly at the jump, never dragging in whatever ran right after
  // it. What is relaxed is which steps are allowed to lead UP TO that jump:
  // instead of requiring every single one of them to ALSO have caused its
  // own jump (which made any real multi-step combo — e.g.
  // gather:wood_log -> craft:oak_planks, where gathering a log never
  // itself crosses a Wiki split — impossible to ever qualify), each
  // leading step only needs to be a verified, successful, non-exploratory
  // PRODUCTION action that precedes the jump step in the stream, skipping
  // straight through any amount of exploration/safety/failed noise in
  // between (isWalkableNoise() above) — this is the anti-noise fix: a real
  // "gather wood -> explore a bit -> flee a zombie -> craft planks"
  // sequence from real decisions.jsonl history must still be recognized as
  // the reusable "gather -> craft" combo it actually is, instead of the
  // exploration/flee noise silently preventing it from ever qualifying.
  // This still never guesses: every CHAIN MEMBER step genuinely ran,
  // genuinely succeeded, and is kept in the exact order it was really
  // executed — only the noise in between is skipped over, never
  // relabeled or counted as part of the chain itself.
  //
  // Scan every possible jump point, newest-first, so the freshest proven
  // sequences are preferred when capping at 10 total.
  for (let j = proposalsInOrder.length - 1; j >= 0; j--) {
    const jumpStep = verifiedStepOf(proposalsInOrder[j], j);
    if (!jumpStep || !jumpStep.advancedBySelf) continue; // chain must END on an actual jump

    // Walk backward from the jump step, collecting consecutive verified
    // successful production steps (oldest-first once reversed below),
    // skipping straight through any amount of exploration/safety/failed
    // noise (isWalkableNoise()) in between without counting it as a chain
    // member — this is the anti-noise fix itself. A NOISE_SCAN_LIMIT bound
    // (rather than scanning backward to the start of the whole window on
    // every jump point) keeps this O(records) overall instead of
    // O(records^2): once that many consecutive noise proposals have been
    // skipped with no real production step found, this jump point's walk
    // gives up exactly like hitting an unrelated production step would.
    const NOISE_SCAN_LIMIT = 6;
    const chainReversed = [jumpStep];
    let cursor = j - 1;
    let noiseSkipped = 0;
    let anyNoiseSkippedInThisChain = false;
    while (chainReversed.length < MAX_CHAIN && cursor >= 0) {
      const candidateProposal = proposalsInOrder[cursor];
      const step = verifiedStepOf(candidateProposal, cursor);
      if (step) {
        chainReversed.push(step);
        cursor -= 1;
        noiseSkipped = 0;
        continue;
      }
      if (isWalkableNoise(candidateProposal) && noiseSkipped < NOISE_SCAN_LIMIT) {
        // Exploration/safety/failed proposal: transparent to the chain,
        // never a member, never breaks adjacency — skip past it and keep
        // looking further back for the next real production step.
        noiseSkipped += 1;
        anyNoiseSkippedInThisChain = true;
        cursor -= 1;
        continue;
      }
      break; // an unrelated verified production step (or noise limit hit) genuinely breaks adjacency
    }
    if (chainReversed.length < 2) continue; // only 2-3 step chains count as "multi-step"

    const chain = chainReversed.reverse(); // oldest-first, jump step last

    const chainId = chain.map(s => s.key).join('->');
    if (seenChainKeys.has(chainId)) continue;
    seenChainKeys.add(chainId);

    const first = chain[0];
    const last = chain[chain.length - 1];
    macros.push({
      id: `stitched_chain:${chainId}`,
      key: first.key,
      tool: first.tool,
      args: first.args,
      requires: first.requires,
      ensures: first.ensures,
      steps: chain.map(s => ({ key: s.key, tool: s.tool, args: s.args, requires: s.requires, ensures: s.ensures })),
      // Player-chapter metadata (this upgrade): which Wiki milestone span
      // this chain was actually observed carrying the bot across, in real
      // decisions.jsonl history — first.cur_idx is the route position
      // BEFORE the chain's first real step ran; last.cur_idx is the route
      // position the LAST step's own proposal was made AT, one tick before
      // the jump it itself causes lands, so span_to_idx adds 1 to represent
      // that landed jump.
      span_from_idx: first.cur_idx,
      span_to_idx: last.cur_idx + 1,
      phase_label: `idx ${first.cur_idx} -> idx ${last.cur_idx + 1}`,
      // smoothness: did this chain run with ZERO noise stitched through it
      // (a textbook back-to-back combo, 'direct') or did its construction
      // have to skip over real exploration/safety/failure in between
      // ('noisy', still a genuinely verified chain, just a rougher one in
      // the actual play history it was lifted from)? Purely descriptive
      // provenance for status_report.mjs/macro_flow_summary — never fed
      // back into scoring on its own; completion_rate/macro_commitment
      // (computed later from actual execution history) are what feeds
      // decide.mjs.
      smoothness: anyNoiseSkippedInThisChain ? 'noisy' : 'direct',
    });
    if (macros.length >= 10) break;
  }
  return macros;
}

const MAX_STITCHED_CHAIN_STEPS = 6;

/**
 * Flatten any already-extracted macro (single-step from
 * extractStitchedMacros(), or multi-step from extractMultiStepMacros())
 * into its plain `steps` array — a single-step macro has no `steps` field
 * of its own (see policy_table.mjs's sanitizeStitchedMacro() doc comment:
 * `steps` is omitted entirely for a single verified action), so this
 * synthesizes the equivalent one-entry array from the macro's own
 * key/tool/args/requires/ensures instead.
 */
function stepsOf(macro) {
  if (Array.isArray(macro.steps) && macro.steps.length) return macro.steps;
  return [{ key: macro.key, tool: macro.tool, args: macro.args, requires: macro.requires, ensures: macro.ensures }];
}

/**
 * Does macro A's `ensures` satisfy macro B's `requires`? Same `{inv,count}`
 * / `{block}` / `{dimension}` shape every requires/ensures array in this
 * codebase uses (candidates.mjs's requiresSatisfied(), macro_executor.mjs's
 * requiresStillSatisfied()). Every one of B's requires entries must be
 * covered by at least one of A's ensures entries — a partial match (B
 * needs two things, A only provides one) is NOT good enough: stitching
 * must never produce a chain whose second half still has an unmet
 * precondition the first half never actually promised to satisfy.
 */
function ensuresSatisfiesRequires(ensuresA, requiresB) {
  if (!Array.isArray(requiresB) || !requiresB.length) return false; // nothing to satisfy -> not a real causal link
  if (!Array.isArray(ensuresA)) return false;
  return requiresB.every(req =>
    ensuresA.some(e => {
      if (req.inv !== undefined) return e.inv === req.inv && (e.count ?? 1) >= (req.count ?? 1);
      if (req.block !== undefined) return e.block === req.block;
      if (req.dimension !== undefined) return e.dimension === req.dimension;
      return false;
    }),
  );
}

/**
 * Conservative cross-episode ("Long-Chain Stitching") causal splice: given
 * the already-extracted, individually-VERIFIED short macros (both the
 * single-step and multi-step kinds — stitching never invents a step that
 * was not itself already a real, successfully-executed, cur_idx-advancing
 * sequence from actual decisions.jsonl history), find pairs (A, B) where
 * A's `ensures` genuinely satisfies B's `requires` (ensuresSatisfiesRequires()
 * above) and splice them into one longer `stitched_chain:A->B` macro.
 *
 * Conservation principle (task 1's "保守守恒原则"): this NEVER guesses or
 * invents a step — A and B are both macros this exact same deliberation
 * pass already verified ran successfully and advanced the route in real
 * history; stitching only records "these two real, proven short combos
 * chain causally", it does not simulate or assume any NEW execution never
 * actually observed. A `place` step inside either half keeps its dynamic
 * relative-coordinate marker (`relativePlacement: true`, set by
 * relativizeMacroArgs() when the half was first extracted) completely
 * unchanged — this function never touches step args at all, so a spliced
 * chain's `place` step is re-grounded against wherever the bot actually is
 * at execution time exactly like an unspliced one already is (see
 * candidates.mjs's regroundPlacementArgs()/macro_executor.mjs's
 * regroundPlacementArgsAtExecution()).
 *
 * Guardrails:
 *   - total spliced step count must stay <= MAX_STITCHED_CHAIN_STEPS (6);
 *   - a splice whose combined step-key sequence contains an immediately
 *     repeated key (A's own last step key === B's own first step key) is
 *     rejected as a "meaningless self-loop" — gluing a macro to another
 *     copy of its own tail step teaches nothing a single copy didn't
 *     already teach;
 *   - A and B must be two DIFFERENT macros (never spliced to itself);
 *   - deduplicated by the resulting step-key chain id, newest/shortest
 *     pairs preferred implicitly by input order (callers pass newest-first
 *     macro lists, same convention extractStitchedMacros()/
 *     extractMultiStepMacros() already use).
 *
 * @param {object[]} shortMacros  already-extracted, newest-first short
 *   macros (single-step and/or multi-step), each with real
 *   requires/ensures and (for multi-step) a real steps[] array
 * @returns {object[]} longer `stitched_chain:...` macros, same shape as
 *   extractMultiStepMacros()'s output, each carrying its own
 *   span_from_idx/span_to_idx/phase_label spanning BOTH halves
 */
function stitchCrossEpisodeChains(shortMacros) {
  const list = Array.isArray(shortMacros) ? shortMacros : [];
  const stitched = [];
  const seenChainIds = new Set();

  for (const macroA of list) {
    const stepsA = stepsOf(macroA);
    if (!stepsA.length) continue;
    const lastStepOfA = stepsA[stepsA.length - 1];

    for (const macroB of list) {
      if (macroB === macroA) continue; // never splice a macro to itself
      const stepsB = stepsOf(macroB);
      if (!stepsB.length) continue;
      const firstStepOfB = stepsB[0];

      // The causal check MUST compare what A actually produces once it
      // finishes running (its LAST step's own `ensures`) against what B
      // needs before its FIRST step can run (its own `requires`) — NOT
      // the macro's top-level `ensures`/`requires`, which on a multi-step
      // macro are deliberately the FIRST step's own fields (see
      // extractMultiStepMacros()'s own macro.ensures = first.ensures;
      // that field exists so candidates.mjs/decide.mjs gate the whole
      // macro on its first step's prerequisites, it is NOT "what this
      // macro ultimately produces"). Using the wrong end here previously
      // caused both a wrong causal match AND a collapsed/wrong
      // span_from_idx/span_to_idx once spliced.
      if (!ensuresSatisfiesRequires(lastStepOfA.ensures, firstStepOfB.requires)) continue;

      const combinedSteps = [...stepsA, ...stepsB];
      if (combinedSteps.length > MAX_STITCHED_CHAIN_STEPS) continue;

      // Meaningless self-loop guard: gluing on a second copy of the exact
      // same step that A's chain already ends on teaches nothing new.
      if (lastStepOfA.key === firstStepOfB.key) continue;

      const chainId = combinedSteps.map(s => s.key).join('->');
      if (seenChainIds.has(chainId)) continue;

      // Player-chapter span: the earliest from-idx either half was
      // observed starting at, through the latest to-idx either half was
      // observed landing at — a real splice should widen the visible
      // milestone span, never narrow it relative to either half alone.
      const spanFrom = Number.isFinite(macroA.span_from_idx) ? macroA.span_from_idx : null;
      const spanTo = Number.isFinite(macroB.span_to_idx) ? macroB.span_to_idx : (Number.isFinite(macroA.span_to_idx) ? macroA.span_to_idx : null);

      seenChainIds.add(chainId);
      const first = combinedSteps[0];
      stitched.push({
        id: `stitched_chain:${chainId}`,
        key: first.key,
        tool: first.tool,
        args: first.args,
        requires: first.requires,
        ensures: first.ensures,
        steps: combinedSteps,
        span_from_idx: spanFrom,
        span_to_idx: spanTo,
        phase_label: Number.isFinite(spanFrom) && Number.isFinite(spanTo) ? `idx ${spanFrom} -> idx ${spanTo}` : null,
        // A cross-episode splice is always 'noisy' in the loose sense that
        // it is two SEPARATE verified episodes glued by a causal
        // requires/ensures match rather than one single unbroken stream
        // run — distinct from extractMultiStepMacros()'s 'direct'/'noisy'
        // (which describes noise WITHIN one continuous window), so this
        // uses its own explicit provenance tag instead of overloading that
        // field with a different meaning.
        smoothness: 'spliced',
      });
      if (stitched.length >= 10) return stitched;
    }
  }
  return stitched;
}

// --- High-dimensional long-chain "flow shape" (macro_flow_summary) -------
//
// IMPORTANT SEMANTIC BOUNDARY (do not blur these two concepts):
//   - entries[key].weight is the LOW-DIMENSIONAL QUOTA/DESIRE knob only —
//     it exists purely to keep one action from crowding out the rest of
//     the candidate pool's exploration budget (see dominantShare() above)
//     and to let a human confirmation / persona config adjust how eagerly
//     environment A reaches for a candidate. It must NEVER be driven by
//     whether a long chain tends to finish or break halfway.
//   - completion_rate / macro_commitment (computed here, from REAL
//     macro_completed_steps/macro_total_steps/macro_break_at execution
//     records in decisions.jsonl — never from candidate counts) describe a
//     totally different thing: how PROFICIENT/TRUSTWORTHY this particular
//     multi-step combo has proven to be once actually attempted in full.
//     A macro that reliably runs all its steps earns a HIGHER commitment
//     (decide.mjs is allowed to trust its later steps more); one that
//     keeps dying on step 2/3 earns a LOWER commitment, so low-dimensional
//     decision-making backs off toward safer single-step choices instead
//     of re-committing to a habit that keeps failing partway through. This
//     is deliberately kept out of `weight` and applied in decide.mjs as its
//     own separate multiplier on the step-2/3 confidence term — see
//     decide.mjs's macroCommitmentMultiplier.

const MACRO_COMMITMENT_MIN = 0.2;
const MACRO_COMMITMENT_MAX = 1.2;
const MACRO_COMMITMENT_NEUTRAL = 1.0;

/**
 * Real macro execution attempts recorded in the window: outcome records
 * that carry `macro_total_steps > 1` (auto_loop.mjs only ever writes this
 * trio of fields for an actually multi-step chosen candidate — see its own
 * doc comment), matched back to the macro id via `chosen_id` (the macro's
 * own `id`, e.g. `stitched_chain:gather:oak_log->craft:oak_planks`).
 *
 * @returns {Record<string, {attempts:number, completions:number, breakStepCounts:Record<number,number>, totalSteps:number, cur_idx_before:number|null}>}
 */
function macroAttemptStatsOf(records) {
  const byId = {};
  for (const rec of records) {
    if (!rec || rec.kind === 'deviation' || rec.result === undefined) continue;
    if (!Number.isFinite(rec.macro_total_steps) || rec.macro_total_steps <= 1) continue;
    const id = typeof rec.chosen_id === 'string' && rec.chosen_id ? rec.chosen_id : null;
    if (!id) continue;
    byId[id] ??= { attempts: 0, completions: 0, breakStepCounts: {}, totalSteps: rec.macro_total_steps };
    byId[id].attempts += 1;
    const completedAll = Boolean(rec.result.ok) && rec.macro_completed_steps === rec.macro_total_steps;
    if (completedAll) {
      byId[id].completions += 1;
    } else {
      const breakStep = Number.isFinite(rec.macro_break_at) ? rec.macro_break_at : (Number.isFinite(rec.macro_completed_steps) ? rec.macro_completed_steps + 1 : null);
      if (Number.isFinite(breakStep)) {
        byId[id].breakStepCounts[breakStep] = (byId[id].breakStepCounts[breakStep] ?? 0) + 1;
      }
    }
  }
  return byId;
}

/**
 * Derive this pass's macro_flow_summary: per-macro completion_rate (0..1,
 * `completions / attempts`, only present for a macro with at least one
 * REAL multi-step attempt logged — a macro never actually attempted as a
 * chain yet has no completion_rate at all, not a fake 0 or 1), the most
 * common break step (`common_break_step`, the step index most attempts
 * died on, or null if every attempt that ran actually completed / there
 * were no attempts), and the derived `macro_commitment` multiplier
 * (clamped to [MACRO_COMMITMENT_MIN, MACRO_COMMITMENT_MAX]) decide.mjs
 * reads to scale its OWN step-2/3 confidence term — never `weight`.
 *
 * A macro with zero real attempts yet gets the fully-neutral commitment
 * (1.0, "no evidence either way") rather than being penalized just for
 * being new — this mirrors has_precedent's own cold-start treatment
 * elsewhere in this file.
 *
 * @param {object[]} stitchedMacros  this pass's full candidate macro pool
 *   (single-step + multi-step + spliced), each with a unique `id`
 * @param {object[]} records        slice.window() output (oldest-first)
 * @returns {object[]} [{ id, span_from_idx, span_to_idx, phase_label, steps,
 *   attempts, completion_rate, common_break_step, macro_commitment }]
 */
function computeMacroFlowSummary(stitchedMacros, records) {
  const attemptStats = macroAttemptStatsOf(records);
  const summary = [];
  for (const macro of stitchedMacros) {
    const stepCount = Array.isArray(macro.steps) ? macro.steps.length : 1;
    if (stepCount < 2) continue; // flow summary is specifically about multi-step chains
    const stats = attemptStats[macro.id];
    let completionRate = null;
    let commonBreakStep = null;
    // Task 1 fix: a macro that has NEVER been attempted as a chain yet
    // (stats.attempts === 0, the common case for a freshly-seeded
    // wiki_prior, or any brand-new native macro the very round it is
    // first extracted) keeps whatever macro_commitment it ALREADY carries
    // on the incoming object — wiki_priors.json intentionally seeds a
    // modest 0.6 (below neutral) so a never-yet-tried prior does not
    // outrank a proven native alternative purely on the generic
    // "no evidence either way" neutral default this file gives every
    // OTHER cold-start field. A native macro, which never carries a
    // pre-set macro_commitment field of its own before this function
    // ever runs, still correctly falls back to the fully-neutral 1.0 —
    // this is purely a preserve-if-present fix, not a behavior change for
    // the native path.
    let macroCommitment = Number.isFinite(macro.macro_commitment) ? macro.macro_commitment : MACRO_COMMITMENT_NEUTRAL;
    if (stats && stats.attempts > 0) {
      completionRate = stats.completions / stats.attempts;
      const breakEntries = Object.entries(stats.breakStepCounts);
      if (breakEntries.length) {
        breakEntries.sort((a, b) => b[1] - a[1]);
        commonBreakStep = Number(breakEntries[0][0]);
      }
      // Linear map: completion_rate 0 -> MACRO_COMMITMENT_MIN (0.2),
      // completion_rate 1 -> MACRO_COMMITMENT_MAX (1.2), so a chain that
      // NEVER finishes gets pushed well below the neutral 1.0 (decide.mjs
      // should back off toward single-step alternatives) while one that
      // ALWAYS finishes earns a real, but still bounded, above-neutral
      // trust bump — bounded the same deliberate way eligibility's score
      // contribution is bounded elsewhere in this file, so this can never
      // itself swamp the Wiki-direction/UCB base terms in decide.mjs.
      macroCommitment = MACRO_COMMITMENT_MIN + completionRate * (MACRO_COMMITMENT_MAX - MACRO_COMMITMENT_MIN);
    }
    summary.push({
      id: macro.id,
      span_from_idx: Number.isFinite(macro.span_from_idx) ? macro.span_from_idx : null,
      span_to_idx: Number.isFinite(macro.span_to_idx) ? macro.span_to_idx : null,
      phase_label: macro.phase_label ?? null,
      steps: stepCount,
      attempts: stats?.attempts ?? 0,
      completion_rate: completionRate,
      common_break_step: commonBreakStep,
      macro_commitment: Math.min(MACRO_COMMITMENT_MAX, Math.max(MACRO_COMMITMENT_MIN, macroCommitment)),
    });
  }
  return summary;
}

/**
 * Per-(state_bucket, candidate_key) outcome stats, computed directly from
 * the raw records (not from slice.stats(), which only keys by candidate —
 * it has no concept of state buckets and is a basic file we must not
 * change). Each outcome record is matched back to its own proposal (by
 * decision_id) to recover the `state`/`cur_idx` it was proposed under, then
 * bucketed via candidates.mjs's computeStateBucket() — the SAME pure
 * function environment A's decide.mjs path uses, so a bucket id computed
 * here and one computed live by tools_adapter.mjs/auto_loop.mjs can never
 * drift apart.
 *
 * @returns {Record<string, {n:number, sum:number, mu:number}>}  keyed by
 *   `${bucket}::${candidateKey}`
 */
function bucketedStatsOf(records) {
  const proposalsById = new Map();
  for (const rec of records) {
    if (rec && rec.kind !== 'deviation' && rec.proposed !== undefined && rec.decision_id !== undefined) {
      proposalsById.set(rec.decision_id, rec);
    }
  }

  const agg = {};
  for (const rec of records) {
    if (!rec || rec.kind === 'deviation' || rec.result === undefined || !rec.chosen) continue;
    const proposal = proposalsById.get(rec.decision_id);
    if (!proposal || !proposal.state) continue; // no matching proposal -> cannot bucket, skip
    const bucket = computeStateBucket(proposal.state, proposal.cur_idx);
    const bucketedKey = `${bucket}::${rec.chosen}`;
    agg[bucketedKey] ??= { n: 0, sum: 0, mu: 0 };
    agg[bucketedKey].n += 1;
    agg[bucketedKey].sum += efficiencyReward(rec);
  }
  for (const key of Object.keys(agg)) {
    agg[key].mu = agg[key].n > 0 ? agg[key].sum / agg[key].n : 0;
  }
  return agg;
}

/**
 * Run one deliberation pass: observe the four flow shapes over a recent
 * window of decisions.jsonl, compare against the Wiki route, and atomically
 * republish policy_snapshot.json for environment A.
 *
 * @param {object} [opts]
 * @param {number} [opts.lastN=50]     window size for slice.window/slice.stats
 * @param {number} [opts.stallK=5]     consecutive no-advance outcomes => progress deviation
 * @param {string} [opts.streamPath]   decisions.jsonl path override (tests)
 * @param {string} [opts.splitsPath]   splits.json path override (tests)
 * @param {string} [opts.policyPath]   policy_snapshot.json path override (tests)
 * @param {string} [opts.confirmPath]  pending_confirm.jsonl path override (tests)
 * @param {string} [opts.auditPath]    confirm_audit.jsonl path override (tests)
 * @returns {object} diagnostic summary of this pass
 */
export function runDeliberation({
  lastN = 50,
  stallK = 5,
  streamPath = LOG_PATH,
  splitsPath = SPLITS_PATH,
  policyPath = POLICY_PATH,
  confirmPath = CONFIRM_PATH,
  auditPath = AUDIT_PATH,
  // activePersona (task 2a): the persona NAME the caller (auto_loop.mjs/
  // run_win.mjs) is currently running with, passed through purely so it
  // can be stamped onto policy_snapshot.json as provenance — this module
  // never reads persona.mjs itself and never lets the persona name affect
  // any of the policy math above; it is written to the snapshot and
  // nothing else. undefined/omitted (e.g. an existing test call, or a
  // caller that predates this field) preserves whatever active_persona
  // the previous snapshot already had, so this is purely additive.
  activePersona,
  // mode (task 4, "局间四定义复盘"): 'in_episode' (default, unchanged
  // behavior — every existing caller/test) runs the ordinary periodic
  // policy-table refresh documented above. 'inter_episode' additionally
  // (never INSTEAD of) appends one summary row to
  // policy_snapshot.json.episode_history — meant to be called once right
  // as one episode ends/resets (a death, a deliberate full inventory
  // reset, or a test harness's own episode boundary), summarizing THIS
  // episode's run from `episodeMeta` (steps/final cur_idx/avg step
  // duration/failure rate/death-or-stuck reason) rather than recomputing
  // any of that from decisions.jsonl itself — environment B's periodic
  // window-based policy math above still runs exactly the same either way,
  // this is purely an ADDITIVE extra write.
  mode = 'in_episode',
  // episodeMeta ({ totalSteps, finalCurIdx, avgStepDurationMs, failureRate,
  // deathOrStuckReason }): the one-episode summary the CALLER (auto_loop.mjs/
  // multi_episode_eval.mjs/a test) already tracked itself across its own
  // step loop — deliberate.mjs never recomputes any of these fields from
  // decisions.jsonl; it only validates/sanitizes and appends them. Ignored
  // entirely when mode !== 'inter_episode'.
  episodeMeta = null,
} = {}) {
  const splits = readSplits(splitsPath);
  const records = slice.window({ lastN, path: streamPath });
  const agg = slice.stats({ lastN, path: streamPath });
  const totalRounds = slice.totalRounds(streamPath);

  const state = latestKnownState(records);
  const { cur_idx, next } = evaluate(splits, state);

  const outcomes = outcomeRecordsOf(records);

  // Efficiency-reward aggregation (task 1): same {n,sum,mu} shape as
  // slice.stats()'s `agg` above, but `mu`/`sum` are built from
  // efficiencyReward() (duration-aware) instead of a plain ok?1:0 — this is
  // what actually feeds prior_confidence/sum_reward below, so a fast
  // success scores higher than a slow one even though both are `ok: true`.
  // `agg` itself (slice.stats(), a basic file) is kept untouched and still
  // drives the weight-shape diagnostics (dominantShare/lowSampleShare)
  // below, which are about "how is the CHOICE distribution skewed", not
  // about reward magnitude.
  const efficiencyAgg = efficiencyStatsOf(outcomes);

  // --- learning index -------------------------------------------------
  const learning = learningIndexStalled(outcomes, stallK);
  let progressDeviationLogged = false;
  if (learning.stalled) {
    const lastRec = learning.window[learning.window.length - 1];
    const dedupeKey = `progress_stall:${cur_idx}:${lastRec?.decision_id ?? ''}`;
    if (!alreadyPendingForStall(confirmPath, dedupeKey)) {
      const details = {
        decision_id: lastRec?.decision_id ?? null,
        stuck_at_idx: cur_idx,
        rounds_without_progress: learning.window.length,
        next_target: next?.id ?? null,
      };
      logDeviation('progress', details);
      appendPendingConfirm(confirmPath, {
        pending: true,
        reason: 'progress_stall',
        dedupeKey,
        time: Date.now(),
        ...details,
      });
      progressDeviationLogged = true;
    }
  }

  // --- weight shape -----------------------------------------------------
  const { share: dominantWeightShare, total: windowTotal } = dominantShare(agg);

  // --- confidence shape ---------------------------------------------------
  const lowSample = lowSampleShare(agg);

  // --- proficiency shape --------------------------------------------------
  const proficiency = proficiencyShape(outcomes);

  // --- recompute per-candidate policy entries -----------------------------
  const prevPolicy = readPolicyTable(policyPath);
  const entries = { ...prevPolicy.entries };

  for (const [key, hist] of Object.entries(agg)) {
    const prevEntry = entries[key] ?? { weight: 1, prior_confidence: 0, proficiency_count: 0, has_precedent: false, sum_reward: 0 };

    // Candidates that dominate far beyond their fair share get a lowered
    // weight next round, to push exploration back toward the rest of the
    // pool; everything else holds a neutral weight of 1 unless it already
    // has a custom weight that deserves to persist. `hist` here (from
    // slice.stats()'s `agg`, a basic file) only ever drives this
    // choice-distribution math (n/fairShare) — the actual reward fields
    // below (prior_confidence/sum_reward) come from `efficiencyAgg`
    // instead, see that aggregation's doc comment.
    const fairShare = windowTotal > 0 ? hist.n / windowTotal : 0;
    const overDominant = windowTotal > 0 && fairShare > 0.6 && Object.keys(agg).length > 1;
    const weight = overDominant ? Math.max(0.2, prevEntry.weight * 0.7) : Math.max(prevEntry.weight, 1);

    // Efficiency-reward view of this same candidate/window (see
    // efficiencyStatsOf() above) — falls back to `hist` itself (plain
    // ok?1:0) in the pathological case where it is somehow missing an entry
    // `agg` has (cannot happen in practice: both are built from the same
    // `outcomes` array over the same window), so this can never throw.
    const effHist = efficiencyAgg[key] ?? hist;

    // --- eligibility trace (TD-lambda style) -----------------------------
    // `eligibility` is a smoothed cumulative progress score: an exponential
    // moving average of this candidate's success rate across deliberation
    // passes (0.5 smoothing — half weight to the freshest window, half to
    // whatever it already was), NOT the raw per-pass mu alone, so one noisy
    // window cannot swing it to either extreme. `last_updated_round` stamps
    // the `total_rounds` value AT THE TIME this entry was last touched here
    // — decide.mjs (environment A, read-only) uses the gap between that and
    // the CURRENT total_rounds to decay eligibility toward 0 for candidates
    // that have not been revisited in a long time, so a long-stale high
    // score can never keep outranking a recently-active one purely on
    // history. Both fields are purely additive/backward-compatible: an
    // older snapshot or a hand-seeded entry with neither field simply has
    // no eligibility signal (decide.mjs treats that as "no decay applied").
    const prevEligibility = Number.isFinite(prevEntry.eligibility) ? prevEntry.eligibility : 0;
    // Clamped into [0,1] right where it is computed: effHist.mu is already
    // a 0..1 efficiency reward, and the EMA of two [0,1] values stays in
    // [0,1] mathematically — this clamp is belt-and-suspenders against a
    // corrupt/hand-edited prevEntry.eligibility outside that range ever
    // propagating forward, matching decide.mjs's own defensive clamp on
    // read (see its decayedEligibility()).
    const eligibility = Math.min(1, Math.max(0, prevEligibility * 0.5 + effHist.mu * 0.5));

    entries[key] = {
      weight,
      prior_confidence: effHist.mu,
      proficiency_count: effHist.n,
      has_precedent: effHist.n > 0,
      sum_reward: effHist.sum,
      eligibility,
      last_updated_round: totalRounds,
    };
  }

  // --- state-bucketed entries (upgrade 3) --------------------------------
  // Written ALONGSIDE the global per-candidate keys above (never replacing
  // or deleting them — the global key stays the backward-compatible
  // fallback decide.mjs reads when a bucket has no samples yet). Keyed as
  // `${bucket}::${candidateKey}` so a candidate's statistics in one world
  // state (e.g. "no table yet") never bleed into its statistics in a
  // different state (e.g. "table placed") the way a single global average
  // would.
  const bucketedAgg = bucketedStatsOf(records);
  for (const [bucketedKey, hist] of Object.entries(bucketedAgg)) {
    const prevEntry = entries[bucketedKey] ?? { weight: 1, prior_confidence: 0, proficiency_count: 0, has_precedent: false, sum_reward: 0 };
    const prevBucketEligibility = Number.isFinite(prevEntry.eligibility) ? prevEntry.eligibility : 0;
    entries[bucketedKey] = {
      weight: Math.max(prevEntry.weight, 1),
      prior_confidence: hist.mu,
      proficiency_count: hist.n,
      has_precedent: hist.n > 0,
      sum_reward: hist.sum,
      eligibility: Math.min(1, Math.max(0, prevBucketEligibility * 0.5 + hist.mu * 0.5)),
      last_updated_round: totalRounds,
    };
  }

  // --- HITL confirmation intake (read-only consumption, never self-approves)
  const confirmation = applyHumanConfirmations(entries, confirmPath, auditPath);

  // --- stitched macros: successful, route-advancing action templates -----
  // Single-step macros (one verified action) and multi-step macros (2-3
  // consecutive verified, cur_idx-advancing actions, see
  // extractMultiStepMacros()'s doc comment) are both written into the same
  // stitched_macros array — candidates.mjs treats every entry the same way
  // (its own `requires` gates whether it is offered this round), so there
  // is no need for a separate top-level field. Single-step entries are
  // deduped against any multi-step chain that already starts with the same
  // key, so a key is never offered twice as two separate candidates.
  const singleStepMacros = extractStitchedMacros(records);
  const multiStepMacros = extractMultiStepMacros(records);
  const multiStepFirstKeys = new Set(multiStepMacros.map(m => m.key));
  const dedupedShortMacros = [...multiStepMacros, ...singleStepMacros.filter(m => !multiStepFirstKeys.has(m.key))];

  // Conservative cross-episode causal splice (task 1's "因果首尾二阶拼接"):
  // only ever combines short macros THIS SAME PASS already verified ran
  // successfully and advanced the route — see stitchCrossEpisodeChains()'s
  // doc comment for the exact conservation/guardrail rules.
  const splicedChains = stitchCrossEpisodeChains(dedupedShortMacros);
  const splicedChainKeys = new Set(splicedChains.map(m => m.key));
  const nativeStitchedMacros = [
    ...splicedChains,
    ...dedupedShortMacros.filter(m => !splicedChainKeys.has(m.key)),
  ].slice(0, 10);

  // --- Wiki-prior cold-start seeding (task 1) ----------------------------
  // Only injected on an actual COLD START — "空快照冷启动初始化时" (task
  // 1) means no decisions.jsonl history has EVER been recorded yet
  // (totalRounds === 0, i.e. the stream this pass just read was
  // completely empty), not merely "this particular policyPath file
  // happens to be fresh". Using totalRounds (derived from the real
  // decisions.jsonl window this pass already read, same `records`/
  // `totalRounds` the rest of this function uses) rather than
  // prevPolicy.stitched_macros.length avoids a false cold-start trigger
  // every time a test (or a real restart with a fresh/relocated
  // policyPath but pre-existing decisions.jsonl history) legitimately
  // starts from an empty snapshot file while real history already exists
  // — that case is a hot-start re-read, not a cold start, and must not
  // re-seed priors that would then outnumber/out-order the real extracted
  // macros the very same pass is producing. Once seeded (totalRounds was
  // 0 the first time this ran), the priors persist via prevPolicy's own
  // stitched_macros carry-through on every later pass and keep getting a
  // fair chance to be overtaken by a native macro of the same key purely
  // through decide.mjs's existing macro_commitment-weighted scoring —
  // never through this file re-deciding anything on a later pass.
  const isColdStart = totalRounds === 0;
  const stitchedMacros = (isColdStart ? mergeWikiPriorsColdStart(nativeStitchedMacros) : nativeStitchedMacros).slice(0, 10);

  // --- high-dimensional long-chain flow shape (macro_flow_summary) -------
  // Computed from REAL macro_completed_steps/macro_total_steps/
  // macro_break_at execution records (never from candidate counts/weight),
  // then folded back into each stitched macro's own `completion_rate`/
  // `macro_commitment` fields so candidates.mjs can pass them through to
  // decide.mjs without decide.mjs ever needing to read decisions.jsonl
  // itself — this is the "反作用于低维" (feed back into low-dimensional
  // decision-making) step, done entirely through this dedicated pair of
  // fields, NEVER through entries[key].weight (see this block's own
  // top-of-file doc comment on that boundary).
  const macroFlowSummary = computeMacroFlowSummary(stitchedMacros, records);
  const flowById = new Map(macroFlowSummary.map(f => [f.id, f]));
  for (const macro of stitchedMacros) {
    const flow = flowById.get(macro.id);
    if (!flow) continue;
    macro.completion_rate = flow.completion_rate;
    macro.macro_commitment = flow.macro_commitment;
    macro.common_break_step = flow.common_break_step;
  }

  // active_persona (task 2a): keep whatever the previous snapshot already
  // had when this pass's caller did not pass one (e.g. an existing test
  // call, or a deliberation pass triggered with no persona context) —
  // never clobber a real recorded persona name with a blank just because
  // one particular call site forgot to pass it.
  const activePersonaForSnapshot = typeof activePersona === 'string' && activePersona ? activePersona : (prevPolicy.active_persona ?? null);

  // --- episode_history append (task 4, mode: 'inter_episode') ------------
  // Additive only: 'in_episode' passes (the default, every pre-existing
  // caller/test) carry the PREVIOUS episode_history through unchanged.
  // 'inter_episode' appends exactly one new summary row built from the
  // caller-supplied episodeMeta, oldest-first, capped at 20 by
  // policy_table.mjs's own sanitizeEpisodeHistory() (never recomputed from
  // decisions.jsonl here — see episodeMeta's own doc comment above).
  let episodeHistoryForSnapshot = Array.isArray(prevPolicy.episode_history) ? prevPolicy.episode_history : [];
  let episodeAppended = false;
  if (mode === 'inter_episode') {
    const meta = episodeMeta ?? {};
    const newEntry = {
      episodeId: typeof meta.episodeId === 'string' || Number.isFinite(meta.episodeId) ? meta.episodeId : episodeHistoryForSnapshot.length + 1,
      endedAt: new Date().toISOString(),
      totalSteps: Number.isFinite(meta.totalSteps) ? meta.totalSteps : 0,
      finalCurIdx: Number.isFinite(meta.finalCurIdx) ? meta.finalCurIdx : cur_idx,
      avgStepDurationMs: Number.isFinite(meta.avgStepDurationMs) ? meta.avgStepDurationMs : null,
      failureRate: Number.isFinite(meta.failureRate) ? meta.failureRate : null,
      deathOrStuckReason: typeof meta.deathOrStuckReason === 'string' && meta.deathOrStuckReason ? meta.deathOrStuckReason : null,
      // Same precedence as activePersonaForSnapshot above: an explicit
      // episodeMeta.activePersona wins, else fall back to whatever persona
      // this same call's activePersona resolved to, so a caller that
      // already passes activePersona once does not also need to repeat it
      // inside episodeMeta.
      activePersona: typeof meta.activePersona === 'string' && meta.activePersona ? meta.activePersona : activePersonaForSnapshot,
    };
    episodeHistoryForSnapshot = [...episodeHistoryForSnapshot, newEntry];
    episodeAppended = true;
  }

  const snapshot = writePolicyTableAtomic(
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      cur_idx,
      next_split_id: next?.id ?? null,
      total_rounds: totalRounds,
      entries,
      stitched_macros: stitchedMacros,
      active_persona: activePersonaForSnapshot,
      macro_flow_summary: macroFlowSummary,
      episode_history: episodeHistoryForSnapshot,
    },
    policyPath,
  );

  return {
    cur_idx,
    next_split_id: next?.id ?? null,
    windowSize: records.length,
    totalRounds,
    learningIndex: { stalled: learning.stalled, progressDeviationLogged },
    weightShape: { dominantWeightShare, candidateCount: Object.keys(agg).length },
    confidenceShape: { lowSampleShare: lowSample },
    proficiencyShape: proficiency,
    stitchedMacroCount: stitchedMacros.length,
    macroFlowSummary,
    confirmationsApplied: confirmation.applied,
    mode,
    episodeAppended,
    episodeHistoryCount: snapshot.episode_history.length,
    snapshot,
  };
}
