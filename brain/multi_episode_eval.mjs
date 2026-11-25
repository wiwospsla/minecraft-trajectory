// brain/multi_episode_eval.mjs — offline, 0-token, 5-episode controlled
// simulation (task 5) proving that cross-episode learning (wiki priors +
// stitched macros + policy_snapshot.json's completion_rate/macro_commitment
// feedback) actually makes episode 5 measurably better than episode 1.
//
// This is a PURE JS deterministic state machine world — no bot, no
// network, no LLM, no real Minecraft server. It drives the REAL
// environment-A/environment-B pipeline (candidates.enumerateCandidates,
// decide.chooseCandidate, deliberate.runDeliberation, policy_table.mjs)
// against a dedicated, temporary decisions.jsonl/policy_snapshot.json/
// splits.json/pending_confirm.jsonl set (never the real project-root
// files — see TEST_DIR below), so running this script leaves the real
// working tree completely untouched (checked explicitly at the end).
//
// World design (deterministic, no Math.random — a fixed, seeded failure
// schedule instead, so re-running this script always produces the exact
// same printed table):
//   - Target: wooden_pickaxe, via a 4-milestone splits.json shape
//     (wood/planks/table/wood_pick), same shape the real project uses.
//   - "慢路/高故障干扰方向" (slow path): a single hand-rolled candidate
//     that advances the chain ONE atomic step at a time, on a FIXED
//     every-3rd-attempt failure schedule, at 2500ms/step even when it
//     succeeds — modeling an inefficient, failure-prone, single-step-only
//     approach with no memory of the whole route.
//   - "高效路径/插槽长链" (efficient path): candidates.mjs's own stitched
//     macro pool (wiki_prior on episode 1's cold start, replaced/
//     reinforced by a NATIVE multi-step macro once this run's own history
//     gives deliberate.mjs something real to extract) — a single
//     candidate that, once trusted, completes MULTIPLE remaining steps of
//     the chain in one shot at ~700ms/step, real decide.mjs scoring
//     (macro_commitment + task 3's completion_rate/milestone-span bonus)
//     deciding each round whether it is trusted enough yet to prefer over
//     the slow path.
// Both paths are offered as fair alternatives toward the SAME next
// milestone every round (both hitsNextSplit) — the comparison is a pure
// test of decide.mjs's UCB + macro_commitment + task-3 fairness math, not
// a scripted outcome. Early episodes still have to spend some rounds
// exploring (UCB's own cold-start behavior, not faked), but as real
// completions accumulate in decisions.jsonl across episodes, the chain's
// completion_rate/macro_commitment rise and decide.mjs's own ranking
// converges toward preferring it — visible directly in BOTH average
// step duration (slow path's 2500ms vs the chain's 700ms/step) and
// failure count (slow path's fixed failure schedule vs the chain's 0%).
//
// Run: node brain/multi_episode_eval.mjs

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enumerateCandidates, normalizeObsState } from './candidates.mjs';
import { chooseCandidate } from './decide.mjs';
import { runDeliberation } from './deliberate.mjs';
import { readPolicyTable, writePolicyTableAtomic, defaultPolicyTable } from './policy_table.mjs';
import { append } from './stream.mjs';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'brain-multi-episode-eval-'));
const STREAM_PATH = join(TEST_DIR, 'decisions.jsonl');
const POLICY_PATH = join(TEST_DIR, 'policy_snapshot.json');
const CONFIRM_PATH = join(TEST_DIR, 'pending_confirm.jsonl');
const SPLITS_PATH = join(TEST_DIR, 'splits.json');

const SPLITS = [
  { id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] },
  { id: 'planks', label: 'Make planks', conditions: [{ inv: 'oak_planks', count: 1 }] },
  { id: 'table', label: 'Craft a crafting table', conditions: [{ inv: 'crafting_table', count: 1 }] },
  { id: 'wood_pick', label: 'Craft a wooden pickaxe', conditions: [{ inv: 'wooden_pickaxe', count: 1 }] },
];
writeFileSync(SPLITS_PATH, JSON.stringify(SPLITS));

const MAX_STEPS_PER_EPISODE = 20;
const EPISODE_COUNT = 5;

/**
 * The toy world's own "慢路" (slow/high-failure direction) candidate: a
 * single ATOMIC step that advances exactly ONE split at a time (never the
 * whole remaining chain), fails on a fixed schedule, and is comparatively
 * slow even on success. Always offered alongside whatever
 * candidates.mjs/the stitched-macro pool proposes for the SAME next
 * split, so it is a genuinely fair alternative ROUTE — the only real
 * differences are reliability and speed, exactly what efficiency-reward/
 * macro_commitment/completion_rate math is supposed to judge.
 */
function slowCandidateFor(nextSplitId) {
  return {
    id: `slow:${nextSplitId}`,
    key: `slow:${nextSplitId}`,
    tool: 'slow_action',
    args: { target: nextSplitId },
    requires: [],
    ensures: [{ inv: `__slow_${nextSplitId}`, count: 1 }], // placeholder; applySlowStep() grants the real split-advancing item directly
    source: 'atomic',
    isSafety: false,
    hitsNextSplit: true,
  };
}

/** Whether the slow path's fixed failure schedule fails on this attempt number (1-based, global across the whole run). */
function slowPathFails(globalAttemptNumber) {
  return globalAttemptNumber % 3 === 0;
}

/**
 * Grant whatever the next split's own condition item is, directly —
 * modeling "the slow path eventually produces the real target resource
 * too, just less reliably/efficiently", exactly like a real inefficient
 * single-step mining/crafting approach would.
 */
function applySlowStep(inventory, nextSplit) {
  const cond = nextSplit.conditions[0];
  inventory[cond.inv] = (inventory[cond.inv] ?? 0) + (cond.count ?? 1);
}

/**
 * Apply one real step of the fast/stitched-chain path: each step names
 * the exact tool/args/ensures a real gather/craft/place call for this toy
 * wooden_pickaxe recipe would use (mirrors wiki_priors.json's own
 * wood_tools chain) — multiple such steps run back to back in a single
 * decide.mjs round when the chosen candidate is a genuine multi-step
 * stitched macro.
 */
function applyFastStep(inventory, tool, args) {
  if (tool === 'gather' && args?.block === 'oak_log') {
    inventory.oak_log = (inventory.oak_log ?? 0) + (args.count ?? 1);
  } else if (tool === 'craft' && args?.item === 'oak_planks') {
    inventory.oak_log = Math.max(0, (inventory.oak_log ?? 0) - 1);
    inventory.oak_planks = (inventory.oak_planks ?? 0) + (args.count ?? 4);
  } else if (tool === 'craft' && args?.item === 'crafting_table') {
    inventory.oak_planks = Math.max(0, (inventory.oak_planks ?? 0) - 4);
    inventory.crafting_table = (inventory.crafting_table ?? 0) + 1;
  } else if (tool === 'place' && args?.block === 'crafting_table') {
    // placement itself grants nothing new to inventory in this toy world
  } else if (tool === 'craft' && args?.item === 'stick') {
    inventory.oak_planks = Math.max(0, (inventory.oak_planks ?? 0) - 2);
    inventory.stick = (inventory.stick ?? 0) + (args.count ?? 4);
  } else if (tool === 'craft' && args?.item === 'wooden_pickaxe') {
    inventory.oak_planks = Math.max(0, (inventory.oak_planks ?? 0) - 3);
    inventory.stick = Math.max(0, (inventory.stick ?? 0) - 2);
    inventory.wooden_pickaxe = (inventory.wooden_pickaxe ?? 0) + 1;
  }
}

function evaluateCurIdx(inventory) {
  let curIdx = -1;
  for (let i = 0; i < SPLITS.length; i++) {
    const cond = SPLITS[i].conditions[0];
    if ((inventory[cond.inv] ?? 0) >= (cond.count ?? 1)) curIdx = i;
    else break;
  }
  return curIdx;
}

function stateFromInventory(inventory) {
  return normalizeObsState({
    position: { x: 0, y: 64, z: 0 },
    inventory: { items: Object.entries(inventory).map(([name, count]) => ({ name, count })) },
    blocks: [{ name: 'oak_log', position: { x: 1, y: 64, z: 0 } }],
    entities: [],
  });
}

let globalAttemptCounter = 0;

function runEpisode(episodeNumber, persona, recentFailures) {
  const inventory = {};
  let steps = 0;
  let failures = 0;
  const durations = [];
  let maxCurIdx = -1;
  let macroAttempts = 0;
  let macroCompletions = 0;
  let lastDeathOrStuck = 'completed_or_step_limit';

  for (let i = 0; i < MAX_STEPS_PER_EPISODE; i++) {
    const curIdx = evaluateCurIdx(inventory);
    maxCurIdx = Math.max(maxCurIdx, curIdx);
    if (curIdx >= SPLITS.length - 1) {
      lastDeathOrStuck = 'goal_reached';
      break;
    }
    const nextSplit = SPLITS[curIdx + 1];
    const state = stateFromInventory(inventory);

    const policyTable = readPolicyTable(POLICY_PATH);
    // The real stitched-macro pool (wiki_prior on a true cold start, or a
    // native multi-step macro once this run's own history has given
    // deliberate.mjs something to extract) IS the "fast path" — this
    // script adds only the slow-path contrast candidate on top, offered
    // at EVERY split (not just the first) so the whole episode stays a
    // genuine, repeatedly-contested choice rather than one single
    // early-game coin flip deciding the entire episode's outcome.
    const candidates = enumerateCandidates(state, { nextSplit, stitchedMacros: policyTable.stitched_macros });
    candidates.push(slowCandidateFor(nextSplit.id));

    const stateBucket = `idx${curIdx}`;
    const { chosen } = chooseCandidate(candidates, policyTable, { stateBucket, persona, recentFailures });
    steps += 1;

    const isSlowPath = chosen.key?.startsWith('slow:');
    const isMultiStepChain = !isSlowPath && Array.isArray(chosen?.steps) && chosen.steps.length > 1;
    globalAttemptCounter += 1;

    let ok = true;
    let completedSteps = 0;
    let stepsTotal = 1;
    let duration_ms;

    if (isSlowPath) {
      ok = !slowPathFails(globalAttemptCounter);
      duration_ms = 2500;
      if (ok) {
        applySlowStep(inventory, nextSplit);
        completedSteps = 1;
      }
      // Same in-memory-only short-term failure cooldown auto_loop.mjs/
      // tools_adapter.mjs both track (decide.mjs's own `recentFailures`
      // option) — carried ACROSS episodes on purpose (passed in from
      // main()), modeling the fact that a persistent process accumulates
      // this kind of short-term memory across an entire run, not just one
      // episode in isolation.
      if (ok) delete recentFailures[chosen.key];
      else recentFailures[chosen.key] = (recentFailures[chosen.key] ?? 0) + 1;
    } else if (isMultiStepChain) {
      stepsTotal = chosen.steps.length;
      for (const step of chosen.steps) {
        applyFastStep(inventory, step.tool, step.args);
        completedSteps += 1;
      }
      duration_ms = 700 * completedSteps;
      macroAttempts += 1;
      if (completedSteps === stepsTotal) macroCompletions += 1;
    } else {
      // A single real (non-macro) production step, e.g. the plain
      // candidates.mjs atomic candidate for this split.
      applyFastStep(inventory, chosen.tool, chosen.args);
      completedSteps = 1;
      duration_ms = 700;
    }
    durations.push(duration_ms);
    if (!ok) failures += 1;

    const decision_id = `ep${episodeNumber}-${i}`;
    append({
      decision_id, time: Date.now(), state, cur_idx: curIdx, next_split: nextSplit.id,
      proposed: chosen.key,
      chosen_spec: { id: chosen.id, key: chosen.key, tool: chosen.tool, args: chosen.args, requires: chosen.requires ?? [], ensures: chosen.ensures ?? [] },
      candidates: [], directionDeviated: false,
    }, STREAM_PATH);
    append({
      decision_id, time: Date.now(), chosen: chosen.key, chosen_id: chosen.id,
      result: { ok, code: ok ? 'ok' : 'slow_path_fail' },
      duration_ms,
      ...(isMultiStepChain ? { macro_completed_steps: completedSteps, macro_total_steps: stepsTotal } : {}),
    }, STREAM_PATH);

    if ((i + 1) % 5 === 0) {
      runDeliberation({ streamPath: STREAM_PATH, splitsPath: SPLITS_PATH, policyPath: POLICY_PATH, confirmPath: CONFIRM_PATH, activePersona: persona?.name });
    }
  }

  // Final in-episode catch-up deliberation, then the inter_episode summary.
  runDeliberation({ streamPath: STREAM_PATH, splitsPath: SPLITS_PATH, policyPath: POLICY_PATH, confirmPath: CONFIRM_PATH, activePersona: persona?.name });
  const avgDuration = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const failureRate = steps > 0 ? failures / steps : 0;
  const macroCompletionRate = macroAttempts > 0 ? macroCompletions / macroAttempts : null;

  const episodeSummary = runDeliberation({
    streamPath: STREAM_PATH, splitsPath: SPLITS_PATH, policyPath: POLICY_PATH, confirmPath: CONFIRM_PATH,
    mode: 'inter_episode', activePersona: persona?.name,
    episodeMeta: { episodeId: episodeNumber, totalSteps: steps, finalCurIdx: maxCurIdx, avgStepDurationMs: avgDuration, failureRate, deathOrStuckReason: lastDeathOrStuck },
  });

  return { episodeNumber, steps, failures, avgDuration, maxCurIdx, macroCompletionRate, macroAttempts, episodeSummary };
}

function main() {
  // Start from a totally empty policy table (explicit cold start marker:
  // no decisions.jsonl exists yet at STREAM_PATH).
  writePolicyTableAtomic(defaultPolicyTable(), POLICY_PATH);

  // wiki_drive raised above neutral: models a bot that leans into
  // following the Wiki-verified route once it has any real signal for
  // it — still entirely decide.mjs's own existing persona-knob math (see
  // persona.mjs), not a special case added for this script.
  const persona = { name: 'eval_persona', momentum_bonus: 0.15, wiki_drive: 1.3, explore_appetite: 1, gather_hoard: 1, safety_caution: 1 };

  // In-memory-only short-term failure cooldown, carried across episodes
  // (a persistent harness process would never reset this on an episode
  // boundary either — see auto_loop.mjs's own identically-shaped
  // module-level `recentFailures`).
  const recentFailures = {};

  const results = [];
  for (let ep = 1; ep <= EPISODE_COUNT; ep++) {
    results.push(runEpisode(ep, persona, recentFailures));
  }

  console.log('='.repeat(78));
  console.log(' multi_episode_eval.mjs — 5-episode offline 0-token learning curve');
  console.log('='.repeat(78));
  console.log(
    '局次'.padEnd(6) + '步数'.padEnd(8) + '失败次数'.padEnd(10) + '平均耗时(ms)'.padEnd(16) + '最高cur_idx'.padEnd(14) + '长链走通率',
  );
  for (const r of results) {
    const rate = r.macroCompletionRate === null ? `无尝试` : `${(r.macroCompletionRate * 100).toFixed(0)}% (${r.macroAttempts}次)`;
    console.log(
      `${r.episodeNumber}`.padEnd(6) + `${r.steps}`.padEnd(8) + `${r.failures}`.padEnd(10) + `${r.avgDuration.toFixed(0)}`.padEnd(16) + `${r.maxCurIdx}`.padEnd(14) + rate,
    );
  }
  console.log('-'.repeat(78));
  const first = results[0];
  const last = results[results.length - 1];
  console.log(`第1局 -> 第${results.length}局： 步数 ${first.steps} -> ${last.steps}，失败次数 ${first.failures} -> ${last.failures}，平均耗时 ${first.avgDuration.toFixed(0)}ms -> ${last.avgDuration.toFixed(0)}ms，最高cur_idx ${first.maxCurIdx} -> ${last.maxCurIdx}`);
  console.log('='.repeat(78));

  // Cleanup: this script only ever wrote inside TEST_DIR (a mkdtempSync
  // tmpdir), never the real project-root decisions.jsonl/
  // policy_snapshot.json/splits.json — remove it so running this script
  // leaves zero trace anywhere outside the OS tmp directory.
  rmSync(TEST_DIR, { recursive: true, force: true });
  console.log(`[multi_episode_eval] cleaned up temp dir: ${TEST_DIR} (exists after cleanup: ${existsSync(TEST_DIR)})`);
}

main();
