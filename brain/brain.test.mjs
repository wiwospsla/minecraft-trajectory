// brain/brain.test.mjs — node --test coverage for the brain subsystem.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mean, ucb, clampFinite } from './formulas.mjs';
import { append, readAll, lastIncomplete, LOG_PATH } from './stream.mjs';
import { chooseCandidate } from './decide.mjs';
import { enumerateCandidates, computeStateBucket, normalizeObsState } from './candidates.mjs';
import { planNextForTarget } from './recipe_planner.mjs';
import { runDeliberation } from './deliberate.mjs';
import { defaultPolicyTable, writePolicyTableAtomic, readPolicyTable } from './policy_table.mjs';
import { resolvePersona } from './persona.mjs';
import { createClaimBridge, chunkKeyFor } from './claim_bridge.mjs';

function tmpFile(name) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-test-'));
  return join(dir, name);
}

// --- Root decisions.jsonl isolation (task 2) --------------------------
//
// Every test above deliberately injects its own tmpFile() `streamPath` into
// runDeliberation()/append() calls — EXCEPT log.mjs's logDeviation(), which
// is a locked base file we must not modify: it always calls stream.mjs's
// append() with stream.mjs's own hardcoded default LOG_PATH (the real
// project-root decisions.jsonl), no matter what path any test or caller
// passes elsewhere. runDeliberation()'s own progress-stall path calls
// logDeviation() directly (see deliberate.mjs), so simply running this test
// suite — even though every OTHER write in it is sandboxed to a tmpdir —
// still appends real 'deviation' lines to the real root decisions.jsonl.
//
// Fix: snapshot the root decisions.jsonl's exact bytes (or its absence)
// before any test runs, and restore that exact state after the whole suite
// finishes, so running `node brain/brain.test.mjs` leaves the working tree
// 100% byte-identical to how it started — no matter how many logDeviation()
// calls happened in between.
let rootDecisionsBackupPath = null;
let rootDecisionsExistedBefore = false;

before(() => {
  rootDecisionsExistedBefore = existsSync(LOG_PATH);
  if (rootDecisionsExistedBefore) {
    rootDecisionsBackupPath = join(mkdtempSync(join(tmpdir(), 'brain-test-root-backup-')), 'decisions.jsonl');
    copyFileSync(LOG_PATH, rootDecisionsBackupPath);
  }
});

after(() => {
  if (rootDecisionsExistedBefore) {
    copyFileSync(rootDecisionsBackupPath, LOG_PATH);
  } else if (existsSync(LOG_PATH)) {
    // Root decisions.jsonl did not exist before this run: any file now at
    // that path was created purely by this test suite's logDeviation()
    // calls (or a stray append()) — delete it so the working tree is 100%
    // clean, not left with a test-generated file a fresh clone never had.
    unlinkSync(LOG_PATH);
  }
});

// 1) formulas.mjs edge cases -------------------------------------------------
test('formulas: n=0, t=0, NaN never crash and stay finite', () => {
  assert.equal(Number.isFinite(mean(0, 0)), true);
  assert.equal(mean(0, 0), 0);
  assert.equal(Number.isFinite(mean(NaN, 5)), true);
  assert.equal(Number.isFinite(ucb(0, 0, 0)), true);
  assert.equal(ucb(0, 0, 0), 10);
  assert.equal(Number.isFinite(ucb(NaN, NaN, NaN)), true);
  assert.equal(Number.isFinite(clampFinite(NaN, 0, 10, 3)), true);
  assert.equal(clampFinite(NaN, 0, 10, 3), 3);
});

// 2) stream.mjs write + corrupt-tail tolerance -------------------------------
test('stream: appends parse back, and a corrupt trailing line is skipped', () => {
  const path = tmpFile('decisions.jsonl');
  append({ decision_id: 1, chosen: 'a' }, path);
  append({ decision_id: 2, chosen: 'b' }, path);
  appendFileSync(path, '{not valid json\n');
  const all = readAll(path);
  assert.equal(all.length, 2);
  assert.equal(all[1].chosen, 'b');
  assert.equal(lastIncomplete(path).decision_id, 2);
});

// 3) decide.mjs runs fully offline, no decisions.jsonl dependency -----------
test('decide: chooses with only candidates+policyTable, empty list is safe', () => {
  const empty = chooseCandidate([], defaultPolicyTable());
  assert.deepEqual(empty, { chosen: null, ranked: [], directionDeviated: false });

  const candidates = [
    { id: 'gather:oak_log', key: 'gather:oak_log', tool: 't', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'atomic' },
    { id: 'craft:oak_planks', key: 'craft:oak_planks', tool: 't', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: true, source: 'atomic' },
  ];
  const policyTable = { ...defaultPolicyTable(), entries: { 'gather:oak_log': { weight: 1, prior_confidence: 0, proficiency_count: 0, has_precedent: false, sum_reward: 0 } } };
  const result = chooseCandidate(candidates, policyTable);
  assert.equal(result.chosen.id, 'craft:oak_planks'); // hits next split -> wins despite no precedent
  assert.equal(result.directionDeviated, false);
});

test('decide.mjs has no import of stream.mjs/slice.mjs (comments mentioning the ban are fine)', () => {
  const src = readFileSync(new URL('./decide.mjs', import.meta.url), 'utf8');
  const importLines = src.split('\n').filter(line => /^\s*import\b/.test(line));
  const forbidden = importLines.some(line => /stream\.mjs|slice\.mjs/.test(line));
  assert.equal(forbidden, false);
});

// 4) deliberate.mjs: K-step stall writes a progress deviation + pending_confirm
test('deliberate: stalled cur_idx for stallK rounds logs progress deviation and queues pending_confirm', () => {
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(splitsPath, JSON.stringify([{ id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] }]));

  const state = { inventory: {}, dimension: 'overworld' }; // never satisfies "wood" -> cur_idx stays -1
  for (let i = 0; i < 5; i++) {
    append({ decision_id: i, chosen: 'gather:oak_log', state, cur_idx: -1, result: { ok: false, code: 'block_gone' } }, streamPath);
  }

  const summary = runDeliberation({ stallK: 5, streamPath, splitsPath, policyPath, confirmPath });
  assert.equal(summary.learningIndex.stalled, true);
  // logDeviation() (brain/log.mjs, an existing file we must not modify) always
  // appends to the real project-root decisions.jsonl, not to our injected
  // streamPath — so the observable contract we can assert here, without
  // touching that real file from a test, is this returned flag plus the
  // pending_confirm.jsonl entry that deliberate.mjs itself fully controls.
  assert.equal(summary.learningIndex.progressDeviationLogged, true);

  assert.equal(existsSync(confirmPath), true);
  const confirmLines = readFileSync(confirmPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(confirmLines.length, 1);
  assert.equal(confirmLines[0].pending, true);
  assert.equal(confirmLines[0].reason, 'progress_stall');

  // A second deliberation pass over the SAME unchanged tail must not duplicate the pending entry.
  runDeliberation({ stallK: 5, streamPath, splitsPath, policyPath, confirmPath });
  const confirmLines2 = readFileSync(confirmPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(confirmLines2.length, 1, 'stall dedupe must not spam pending_confirm.jsonl');
});

// 5) 5-step offline closed-loop replay is reproducible -----------------------
test('5-step offline closed loop (propose -> record -> deliberate -> re-decide) is reproducible', () => {
  function runLoop() {
    const streamPath = tmpFile('decisions.jsonl');
    const policyPath = tmpFile('policy_snapshot.json');
    const confirmPath = tmpFile('pending_confirm.jsonl');
    const splitsPath = tmpFile('splits.json');
    writeFileSync(
      splitsPath,
      JSON.stringify([{ id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] }]),
    );
    writePolicyTableAtomic(defaultPolicyTable(), policyPath);

    const candidates = [
      { id: 'gather:oak_log', key: 'gather:oak_log', tool: 't', args: {}, requires: [], ensures: [{ inv: 'oak_log', count: 1 }], isSafety: false, hitsNextSplit: true, source: 'atomic' },
      { id: 'wait', key: 'wait', tool: 't', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'atomic' },
    ];

    return { streamPath, policyPath, confirmPath, splitsPath, candidates };
  }

  async function playFive({ streamPath, policyPath, confirmPath, splitsPath, candidates }) {
    const { readPolicyTable } = await import('./policy_table.mjs');
    const choices = [];
    for (let step = 0; step < 5; step++) {
      const policyTable = readPolicyTable(policyPath);
      const { chosen } = chooseCandidate(candidates, policyTable);
      choices.push(chosen.id);
      const decision_id = `d${step}`;
      append({ decision_id, chosen: chosen.key, state: { inventory: {}, dimension: 'overworld' }, cur_idx: -1 }, streamPath);
      const ok = chosen.id === 'gather:oak_log' ? step % 2 === 0 : true; // deterministic outcome pattern
      append({ decision_id, time: Date.now(), chosen: chosen.key, result: { ok, code: ok ? 'ok' : 'failed' } }, streamPath);
      if ((step + 1) % 5 === 0) {
        runDeliberation({ stallK: 5, streamPath, splitsPath, policyPath, confirmPath });
      }
    }
    return choices;
  }

  return (async () => {
    const runA = runLoop();
    const choicesA = await playFive(runA);

    const runB = runLoop();
    const choicesB = await playFive(runB);

    assert.deepEqual(choicesA, choicesB, 'identical offline replay must produce identical choice sequence');
    assert.equal(choicesA.length, 5);
  })();
});

// 6) stitched macros: environment B extracts them, environment A (via a
//    restart that only reads policy_snapshot.json) can collage them in.
test('runDeliberation() lifts a successful, route-advancing action into stitched_macros, and candidates.mjs picks it up on a cold re-read', () => {
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(
    splitsPath,
    JSON.stringify([
      { id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] },
      { id: 'planks', label: 'Make planks', conditions: [{ inv: 'oak_planks', count: 1 }] },
    ]),
  );

  const proposal = {
    decision_id: 'd1',
    time: Date.now(),
    state: { inventory: {}, dimension: 'overworld' },
    cur_idx: -1,
    next_split: 'wood',
    proposed: 'gather:oak_log',
    chosen_spec: {
      id: 'gather:oak_log',
      key: 'gather:oak_log',
      tool: 'gather', // real tool name (src/tools/game/gathering.js)
      args: { block: 'oak_log', count: 1 },
      requires: [],
      ensures: [{ inv: 'oak_log', count: 1 }],
    },
    candidates: [{ id: 'gather:oak_log', key: 'gather:oak_log', score: 9.6, source: 'atomic' }],
    directionDeviated: false,
  };
  const outcome = {
    decision_id: 'd1',
    time: Date.now(),
    chosen: 'gather:oak_log',
    chosen_id: 'gather:oak_log',
    result: { ok: true, code: 'got_1_oak_log' },
  };
  // A second proposal AFTER the outcome, with a higher cur_idx, is what
  // proves the first action actually advanced the route.
  const nextProposal = {
    decision_id: 'd2',
    time: Date.now(),
    state: { inventory: { oak_log: 1 }, dimension: 'overworld' },
    cur_idx: 0,
    next_split: 'planks',
    proposed: 'craft:oak_planks',
    chosen_spec: {
      id: 'craft:oak_planks',
      key: 'craft:oak_planks',
      tool: 'craft', // real tool name (src/tools/game/crafting.js)
      args: { item: 'oak_planks', count: 4 },
      requires: [{ inv: 'oak_log', count: 1 }],
      ensures: [{ inv: 'oak_planks', count: 4 }],
    },
    candidates: [{ id: 'craft:oak_planks', key: 'craft:oak_planks', score: 10.5, source: 'atomic' }],
    directionDeviated: false,
  };

  append(proposal, streamPath);
  append(outcome, streamPath);
  append(nextProposal, streamPath);

  const summary = runDeliberation({ stallK: 5, streamPath, splitsPath, policyPath, confirmPath });
  assert.equal(summary.stitchedMacroCount, 1);

  // Cold re-read: a fresh readPolicyTable() call (simulating a brand new
  // environment-A process / restart) must see the macro purely from the
  // snapshot file, with no access to decisions.jsonl at all.
  const reloaded = readPolicyTable(policyPath);
  assert.equal(reloaded.stitched_macros.length, 1);
  assert.equal(reloaded.stitched_macros[0].key, 'gather:oak_log');

  // candidates.mjs must collage it into the pool as source:'stitched' when
  // its `requires` are satisfied by the current state.
  const state = { pos: null, health: 20, food: 20, dimension: 'overworld', inventory: {}, nearbyBlocks: [], nearbyHostiles: 0 };
  const candidates = enumerateCandidates(state, { nextSplit: null, stitchedMacros: reloaded.stitched_macros });
  const stitched = candidates.find(c => c.key === 'gather:oak_log' && c.source === 'stitched');
  assert.ok(stitched, 'expected the stitched macro to appear as a source:"stitched" candidate');
});

// 7) recordTelemetryFallback: LLM calls a real game tool but forgets to call
// brain_record_outcome — the fallback must auto-fill the outcome exactly
// once, and a subsequent duplicate event must not double-write.
//
// createTools() is called with injected `observe`/`streamPath`/`policyPath`
// (tools_adapter.mjs supports this explicitly for testing), so this test
// never depends on a live server/bot (no src/body/bot.js mcdata
// initialization, no bot.findBlocks()) and never touches the real
// project-root decisions.jsonl/policy_snapshot.json.
test('recordTelemetryFallback auto-records a forgotten outcome exactly once', async () => {
  const { createTools, recordTelemetryFallback } = await import('./tools_adapter.mjs');
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');

  const bot = { game: { dimension: 'overworld' } };
  // Fake observation: a crafting_table in hand, standing at a known
  // position, so enumerateCandidates() offers exactly place:crafting_table
  // (tool 'place') with no need for any real block/entity scanning.
  const fakeObserve = async () => ({
    state: {
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20,
      inventory: { items: [{ name: 'crafting_table', count: 1, slot: 0 }] },
      blocks: [],
      entities: [],
    },
  });

  const tools = await createTools({ bot, observe: fakeObserve, streamPath, policyPath });
  const brainNextStep = tools.find(t => t.name === 'brain_next_step');
  assert.ok(brainNextStep);

  const proposal = await brainNextStep.run({ goalHint: '' });
  assert.ok(proposal.chosen, 'expected a candidate to be proposed with a crafting_table in hand');
  assert.equal(proposal.chosen.tool, 'place');

  // Simulate the LLM calling the real `place` tool but forgetting
  // brain_record_outcome: a telemetry event for that tool arrives instead.
  const fallbackResult = recordTelemetryFallback({ tool: 'place', success: true });
  assert.ok(fallbackResult, 'expected the fallback to record an outcome');
  assert.equal(fallbackResult.recorded, true);

  // A second, duplicate telemetry event for the same tool must NOT
  // double-write: the proposal was already removed from openProposals.
  const duplicate = recordTelemetryFallback({ tool: 'place', success: true });
  assert.equal(duplicate, null, 'expected the fallback to be a no-op once the proposal is already resolved');

  const lines = readAll(streamPath);
  const outcomeLines = lines.filter(r => r.decision_id === proposal.decision_id && r.result !== undefined);
  assert.equal(outcomeLines.length, 1, 'expected exactly one outcome line for this decision_id');
  assert.equal(outcomeLines[0].autoFallback, true);
});

// 9) recipe_planner.mjs: pure recursive prerequisite expansion ------------
test('recipe_planner: empty inventory toward wooden_pickaxe recurses down to a gatherable log leaf', () => {
  const plan = planNextForTarget('wooden_pickaxe', 1, {}, [], { x: 0, y: 64, z: 0 });
  assert.ok(plan, 'expected a plan');
  assert.equal(plan.step, 'gather');
  assert.equal(plan.item, 'oak_log'); // default species tie-break, see pickVariant()
});

test('recipe_planner: have planks+sticks but no table -> plans to craft a crafting_table first', () => {
  const plan = planNextForTarget('wooden_pickaxe', 1, { oak_planks: 4, stick: 2 }, [], { x: 0, y: 64, z: 0 });
  assert.ok(plan);
  assert.equal(plan.step, 'craft');
  assert.equal(plan.item, 'crafting_table');
});

test('recipe_planner: have everything + table nearby -> plans the final wooden_pickaxe craft', () => {
  const plan = planNextForTarget('wooden_pickaxe', 1, { oak_planks: 4, stick: 2 }, ['crafting_table'], { x: 0, y: 64, z: 0 });
  assert.ok(plan);
  assert.equal(plan.step, 'craft');
  assert.equal(plan.item, 'wooden_pickaxe');
});

test('recipe_planner: already holding the target returns null (nothing to plan)', () => {
  const plan = planNextForTarget('wooden_pickaxe', 1, { wooden_pickaxe: 1 }, [], { x: 0, y: 64, z: 0 });
  assert.equal(plan, null);
});

// 10) candidates.mjs: exploration candidates when no production candidate exists
test('enumerateCandidates: no visible target -> go_to exploration candidates, not an empty pool', () => {
  const state = { pos: { x: 10, y: 64, z: -5 }, health: 20, food: 20, dimension: 'overworld', inventory: {}, nearbyBlocks: ['oak_leaves'], nearbyHostiles: 0 };
  const candidates = enumerateCandidates(state, { nextSplit: null });
  assert.ok(candidates.length > 0, 'expected exploration candidates instead of an empty pool');
  assert.ok(candidates.every(c => c.tool === 'go_to'), 'expected only go_to exploration candidates');
  assert.equal(new Set(candidates.map(c => c.id)).size, candidates.length, 'expected 4 distinct directional candidates');
});

test('enumerateCandidates: a visible production target suppresses exploration candidates', () => {
  const state = { pos: { x: 10, y: 64, z: -5 }, health: 20, food: 20, dimension: 'overworld', inventory: {}, nearbyBlocks: ['oak_log'], nearbyHostiles: 0 };
  const candidates = enumerateCandidates(state, { nextSplit: null });
  assert.ok(candidates.some(c => c.id === 'gather:oak_log'));
  assert.ok(candidates.every(c => c.tool !== 'go_to'), 'expected no exploration candidates once a production one exists');
});

// 11) state bucketing (upgrade 3): isolation across buckets + global fallback
test('computeStateBucket: differs by cur_idx/table/pickaxe inventory, stable for identical inputs', () => {
  const noTable = computeStateBucket({ inventory: {}, nearbyBlocks: [] }, -1);
  const withTable = computeStateBucket({ inventory: { crafting_table: 1 }, nearbyBlocks: [] }, -1);
  assert.notEqual(noTable, withTable);
  const repeat = computeStateBucket({ inventory: {}, nearbyBlocks: [] }, -1);
  assert.equal(noTable, repeat);
});

test('deliberate.mjs bucketed stats keep the SAME candidate key isolated across two different state buckets, with global fallback for an unseen bucket', () => {
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(splitsPath, JSON.stringify([{ id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] }]));

  // Bucket A (no table, cur_idx -1): gather:wood_log fails every time.
  const stateA = { inventory: {}, nearbyBlocks: ['oak_log'], dimension: 'overworld' };
  for (let i = 0; i < 3; i++) {
    const decision_id = `a${i}`;
    append({ decision_id, state: stateA, cur_idx: -1, proposed: 'gather:wood_log', chosen_spec: { id: 'gather:oak_log', key: 'gather:wood_log', tool: 'gather', args: {}, requires: [], ensures: [] } }, streamPath);
    append({ decision_id, chosen: 'gather:wood_log', result: { ok: false, code: 'failed' } }, streamPath);
  }

  // Bucket B (has table, cur_idx 2): gather:wood_log succeeds every time —
  // same candidate KEY, deliberately different outcome, to prove the two
  // buckets' statistics do not blend into one misleading average.
  const stateB = { inventory: { crafting_table: 1 }, nearbyBlocks: ['oak_log'], dimension: 'overworld' };
  for (let i = 0; i < 3; i++) {
    const decision_id = `b${i}`;
    append({ decision_id, state: stateB, cur_idx: 2, proposed: 'gather:wood_log', chosen_spec: { id: 'gather:oak_log', key: 'gather:wood_log', tool: 'gather', args: {}, requires: [], ensures: [] } }, streamPath);
    append({ decision_id, chosen: 'gather:wood_log', result: { ok: true, code: 'ok' } }, streamPath);
  }

  runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath });
  const policy = readPolicyTable(policyPath);

  const bucketA = computeStateBucket(stateA, -1);
  const bucketB = computeStateBucket(stateB, 2);
  assert.notEqual(bucketA, bucketB);

  const entryA = policy.entries[`${bucketA}::gather:wood_log`];
  const entryB = policy.entries[`${bucketB}::gather:wood_log`];
  assert.ok(entryA, 'expected a bucketed entry for bucket A');
  assert.ok(entryB, 'expected a bucketed entry for bucket B');
  assert.equal(entryA.prior_confidence, 0, 'bucket A (all failures) must show 0 success rate');
  assert.equal(entryB.prior_confidence, 1, 'bucket B (all successes) must show 1.0 success rate, unpolluted by bucket A');

  // The global, non-bucketed key is still written (backward compatibility)
  // and reflects the blended 50% rate across both buckets, as expected.
  const globalEntry = policy.entries['gather:wood_log'];
  assert.ok(globalEntry);
  assert.equal(globalEntry.prior_confidence, 0.5);

  // decide.mjs must prefer the bucketed entry when given a stateBucket it
  // has samples for, and fall back to the global entry for an unseen one.
  const candidate = { id: 'gather:oak_log', key: 'gather:wood_log', tool: 'gather', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'atomic' };
  const resultInBucketA = chooseCandidate([candidate], policy, { stateBucket: bucketA });
  assert.equal(resultInBucketA.ranked[0].bucketHit, true);

  const unseenBucket = 'idx99_tbl0_wpick0_spick0';
  const resultUnseenBucket = chooseCandidate([candidate], policy, { stateBucket: unseenBucket });
  assert.equal(resultUnseenBucket.ranked[0].bucketHit, false, 'expected fallback to the global key for a bucket with zero samples');
});

// 12) flee threat-range fix: only hostiles within the real flee tool's own
// 16-block ground truth (kept slightly tighter here, 14 blocks) count.
test('normalizeObsState: a zombie 30 blocks away does not count as nearbyHostiles, one 10 blocks away does', () => {
  const far = normalizeObsState({
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: { items: [] },
    blocks: [],
    entities: [{ id: 1, name: 'zombie', position: { x: 30, y: 64, z: 0 } }],
  });
  assert.equal(far.nearbyHostiles, 0, 'a zombie 30 blocks away must not count (flee tool cannot reach it)');

  const near = normalizeObsState({
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: { items: [] },
    blocks: [],
    entities: [{ id: 2, name: 'zombie', position: { x: 10, y: 64, z: 0 } }],
  });
  assert.equal(near.nearbyHostiles, 1, 'a zombie 10 blocks away must count');
});

// 13) directionDeviated false-positive fix: a forced-explore round (no
// candidate anywhere in the pool hits the next split) must not report a
// direction deviation just because none of its go_to candidates can ever
// set hitsNextSplit.
test('chooseCandidate: forced exploration (no candidate hits nextSplit at all) never reports directionDeviated', () => {
  const exploreOnly = [
    { id: 'move:explore_n', key: 'move:explore_n', tool: 'go_to', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'explore' },
    { id: 'move:explore_e', key: 'move:explore_e', tool: 'go_to', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'explore' },
  ];
  const result = chooseCandidate(exploreOnly, defaultPolicyTable());
  assert.equal(result.directionDeviated, false, 'a fully-forced exploration round must not be flagged as a direction deviation');

  // Sanity check the OTHER direction still works: when a hitsNextSplit
  // candidate IS available but something else (non-safety, non-hitting)
  // wins anyway, that is a real deviation and must still be reported.
  const mixedPool = [
    { id: 'craft:oak_planks', key: 'craft:oak_planks', tool: 'craft', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: true, source: 'atomic' },
    { id: 'move:explore_n', key: 'move:explore_n', tool: 'go_to', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'explore' },
  ];
  // Force the non-hitting candidate to win via a huge weight advantage.
  const policyFavoringExplore = {
    ...defaultPolicyTable(),
    entries: { 'move:explore_n': { weight: 1000, prior_confidence: 1, proficiency_count: 5, has_precedent: true, sum_reward: 5 } },
  };
  const mixedResult = chooseCandidate(mixedPool, policyFavoringExplore);
  assert.equal(mixedResult.chosen.key, 'move:explore_n', 'expected the heavily-weighted explore candidate to win this contrived case');
  assert.equal(mixedResult.directionDeviated, true, 'a real deviation (a hitting candidate existed and lost) must still be reported');
});

// 14) recentFailures cooldown: a candidate that just failed repeatedly
// yields to an untried/less-penalized alternative immediately.
test('chooseCandidate: recentFailures cooldown makes a just-failed explore_e yield to explore_n', () => {
  const candidates = [
    { id: 'move:explore_e', key: 'move:explore_e', tool: 'go_to', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'explore' },
    { id: 'move:explore_n', key: 'move:explore_n', tool: 'go_to', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'explore' },
  ];
  // Without any failure history, both start equal (same prior/cold-start) —
  // the first one in list order wins ties from Array.sort's stability.
  const noCooldown = chooseCandidate(candidates, defaultPolicyTable());
  assert.equal(noCooldown.chosen.key, 'move:explore_e');

  // explore_e just failed once: with a recentFailures penalty of failCount*5,
  // it must now rank below explore_n even though both still have identical
  // policy-table history.
  const withCooldown = chooseCandidate(candidates, defaultPolicyTable(), { recentFailures: { 'move:explore_e': 1 } });
  assert.equal(withCooldown.chosen.key, 'move:explore_n', 'expected explore_e to yield to explore_n right after failing');
});

// 15) HITL confirmation intake: deliberate.mjs consumes a human-written
// `confirmed: true` record, applies it exactly once, and never
// self-approves (runDeliberation's own progress-stall writer only ever
// emits `pending: true`, never `confirmed: true`).
test('deliberate.mjs consumes a human-confirmed pending_confirm.jsonl record and writes confirm_audit.jsonl exactly once', () => {
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const auditPath = tmpFile('confirm_audit.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(splitsPath, JSON.stringify([{ id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] }]));

  // Seed a policy table with a pre-existing stalled candidate to penalize.
  writePolicyTableAtomic(
    {
      ...defaultPolicyTable(),
      entries: { 'move:explore_e': { weight: 1, prior_confidence: 0, proficiency_count: 3, has_precedent: true, sum_reward: 0 } },
    },
    policyPath,
  );

  // A human operator appends a confirmed record by hand (this is the ONLY
  // way `confirmed: true` can appear — runDeliberation() itself never
  // writes this field, only `pending: true`).
  appendFileSync(
    confirmPath,
    JSON.stringify({
      pending: true,
      confirmed: true,
      dedupeKey: 'progress_stall:-1:manual-1',
      reason: 'progress_stall',
      decision_action: 'penalize_stalled',
      chosen: 'move:explore_e',
    }) + '\n',
    'utf8',
  );

  const summary = runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath, auditPath });
  assert.equal(summary.confirmationsApplied, 1);

  const policy = readPolicyTable(policyPath);
  assert.equal(policy.entries['move:explore_e'].weight, 0.5, 'expected the stalled candidate\'s weight to be halved');

  const auditLines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(auditLines.length, 1);
  assert.equal(auditLines[0].dedupeKey, 'progress_stall:-1:manual-1');

  // A second deliberation pass over the SAME still-confirmed record must
  // NOT re-apply the penalty (0.5 * 0.5 = 0.25) — it must stay at 0.5.
  const summary2 = runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath, auditPath });
  assert.equal(summary2.confirmationsApplied, 0, 'expected the second pass to apply nothing new');
  const policyAfterSecondPass = readPolicyTable(policyPath);
  assert.equal(policyAfterSecondPass.entries['move:explore_e'].weight, 0.5, 'expected the weight to stay at 0.5, not be halved again');

  const auditLinesAfter = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(auditLinesAfter.length, 1, 'expected exactly one audit line total, not duplicated');
});

// 16) forceExploreFallback: a visible-but-unreachable production target
// (the only candidate the pool would otherwise ever offer) gets explore
// candidates alongside it once the caller signals it already failed.
test('enumerateCandidates: forceExploreFallback adds explore candidates ALONGSIDE an existing production candidate', () => {
  const state = { pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, dimension: 'overworld', inventory: {}, nearbyBlocks: ['oak_log'], nearbyHostiles: 0 };

  const withoutFallback = enumerateCandidates(state, { nextSplit: null });
  assert.deepEqual(withoutFallback.map(c => c.id), ['gather:oak_log'], 'expected only the production candidate by default');

  const withFallback = enumerateCandidates(state, { nextSplit: null, forceExploreFallback: true });
  assert.ok(withFallback.some(c => c.id === 'gather:oak_log'), 'expected the production candidate to still be offered');
  const exploreIds = withFallback.filter(c => c.tool === 'go_to').map(c => c.id);
  assert.equal(exploreIds.length, 4, 'expected all 4 directional explore candidates alongside the production one');
});

// --- Stage 4 upgrades ------------------------------------------------------

// 17) task 1 verification: 2 oak_planks + 4 stick, target wooden_pickaxe
// (or crafting_table), with oak_log visible — must fall back to gathering
// more wood, not wander off into exploration, since the inventory is still
// short the 4th plank wooden_pickaxe's real recipe needs.
test('real-scenario regression: 2 oak_planks + 4 stick + visible oak_log falls back to gather:oak_log, not exploration', () => {
  const state = {
    pos: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    dimension: 'overworld',
    inventory: { oak_planks: 2, stick: 4 },
    nearbyBlocks: ['oak_log'],
    nearbyHostiles: 0,
  };

  const planForPickaxe = planNextForTarget('wooden_pickaxe', 1, state.inventory, state.nearbyBlocks, state.pos);
  assert.ok(planForPickaxe, 'expected recipe_planner to find a next step');
  assert.equal(planForPickaxe.step, 'gather');
  assert.equal(planForPickaxe.item, 'oak_log');

  const planForTable = planNextForTarget('crafting_table', 1, state.inventory, state.nearbyBlocks, state.pos);
  assert.equal(planForTable.step, 'gather');
  assert.equal(planForTable.item, 'oak_log');

  const candidates = enumerateCandidates(state, { nextSplit: { id: 'wood_pick', conditions: [{ inv: 'wooden_pickaxe', count: 1 }] } });
  assert.deepEqual(candidates.map(c => c.id), ['gather:oak_log'], 'expected gather:oak_log as the sole candidate, no premature exploration');
});

// 18) task 2: the full stone->furnace->smelt->iron_pickaxe tool chain, each
// step checked against the real tool names/args the harness actually runs
// (gather/craft/smelt — see src/tools/game/crafting.js's real `smelt`
// signature { input, count, fuel }).
test('recipe_planner + candidates: iron chain (ore -> furnace -> smelt -> iron_pickaxe) uses real tool signatures', () => {
  const pos = { x: 0, y: 64, z: 0 };

  // Step 1: stone_pickaxe held, iron ore visible -> gather candidate exists
  // and requires the stone_pickaxe (gating matches the real gather tool's
  // own canHarvest() check).
  const oreState = {
    pos, health: 20, food: 20, dimension: 'overworld',
    inventory: { stone_pickaxe: 1 },
    nearbyBlocks: ['iron_ore'],
    nearbyHostiles: 0,
  };
  const oreCandidates = enumerateCandidates(oreState, { nextSplit: null });
  const oreCandidate = oreCandidates.find(c => c.key === 'gather:iron_ore');
  assert.ok(oreCandidate, 'expected a gather:iron_ore candidate once a stone_pickaxe is held and ore is visible');
  assert.equal(oreCandidate.tool, 'gather');
  assert.deepEqual(oreCandidate.requires, [{ inv: 'stone_pickaxe', count: 1 }]);

  // Without a stone_pickaxe, no gather:iron_ore candidate must appear at all
  // (mirrors gather:cobblestone's own wooden_pickaxe gate).
  const noPickState = { ...oreState, inventory: {} };
  assert.ok(!enumerateCandidates(noPickState, { nextSplit: null }).some(c => c.key === 'gather:iron_ore'));

  // Step 2: have raw_iron + cobblestone, no furnace -> recipe_planner plans
  // crafting a furnace (real craft tool, 8 cobblestone, matches the real
  // smelt tool's own "crafting one from 8 cobblestone first if needed").
  const furnacePlan = planNextForTarget('iron_pickaxe', 1, { stone_pickaxe: 1, raw_iron: 2, cobblestone: 10, oak_planks: 4 }, [], pos);
  assert.ok(furnacePlan);
  assert.equal(furnacePlan.step, 'craft');
  assert.equal(furnacePlan.item, 'furnace');
  assert.deepEqual(furnacePlan.requires, [{ inv: 'cobblestone', count: 8 }]);

  // Step 3: have raw_iron + furnace + coal -> recipe_planner proposes the
  // real `smelt` tool's exact argument shape: { input, count, fuel }.
  const smeltPlan = planNextForTarget('iron_pickaxe', 1, { stone_pickaxe: 1, raw_iron: 2, furnace: 1, coal: 3 }, [], pos);
  assert.ok(smeltPlan);
  assert.equal(smeltPlan.step, 'smelt');
  assert.equal(smeltPlan.item, 'iron_ingot');
  assert.equal(smeltPlan.args.input, 'raw_iron');
  assert.equal(smeltPlan.args.fuel, 'coal');
  assert.ok(Number.isFinite(smeltPlan.args.count));

  // candidates.mjs must surface that exact smelt step as a real candidate
  // once iron_pickaxe is the active goal (not yet held).
  const smeltState = {
    pos, health: 20, food: 20, dimension: 'overworld',
    inventory: { stone_pickaxe: 1, raw_iron: 2, furnace: 1, coal: 3 },
    nearbyBlocks: [],
    nearbyHostiles: 0,
  };
  const smeltCandidates = enumerateCandidates(smeltState, { nextSplit: null });
  const smeltCandidate = smeltCandidates.find(c => c.tool === 'smelt');
  assert.ok(smeltCandidate, 'expected a smelt candidate once raw_iron+furnace+fuel are all available');
  assert.equal(smeltCandidate.id, 'smelt:iron_ingot');
  assert.deepEqual(smeltCandidate.args, { input: 'raw_iron', count: smeltCandidate.args.count, fuel: 'coal' });

  // No fuel held -> recipe_planner surfaces the gap instead of proposing a
  // smelt call doomed to fail with "no fuel" against the real tool.
  const noFuelPlan = planNextForTarget('iron_pickaxe', 1, { stone_pickaxe: 1, raw_iron: 2, furnace: 1 }, [], pos);
  assert.equal(noFuelPlan.step, null);
  assert.equal(noFuelPlan.item, 'coal');

  // Step 4: have iron_ingot + stick + table nearby -> final craft:iron_pickaxe.
  const finalPlan = planNextForTarget('iron_pickaxe', 1, { iron_ingot: 3, stick: 2 }, ['crafting_table'], pos);
  assert.ok(finalPlan);
  assert.equal(finalPlan.step, 'craft');
  assert.equal(finalPlan.item, 'iron_pickaxe');
});

// 19) task 3a: eligibility trace decay — a long-stale entry must score
// below a recently-active, equally-successful one once decide.mjs applies
// decayedEligibility()'s Math.pow(0.9, roundsPassed) falloff.
test('decide.mjs: eligibility trace decay makes a long-stale candidate lose to a recently-active one with the same initial eligibility', () => {
  const candidates = [
    { id: 'craft:furnace', key: 'craft:furnace', tool: 'craft', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'atomic' },
    { id: 'craft:iron_pickaxe', key: 'craft:iron_pickaxe', tool: 'craft', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'atomic' },
  ];

  // Both entries start with the IDENTICAL eligibility (0.8) and identical
  // UCB-relevant fields, so any score difference can only come from the
  // eligibility decay term itself — isolating exactly what this test
  // claims to verify.
  const sameBase = { weight: 1, prior_confidence: 0.5, proficiency_count: 5, has_precedent: true, sum_reward: 2.5, eligibility: 0.8 };
  const policyTable = {
    ...defaultPolicyTable(),
    total_rounds: 100,
    entries: {
      'craft:furnace': { ...sameBase, last_updated_round: 5 }, // stale: 95 rounds ago
      'craft:iron_pickaxe': { ...sameBase, last_updated_round: 99 }, // fresh: 1 round ago
    },
  };

  const result = chooseCandidate(candidates, policyTable);
  const furnaceScore = result.ranked.find(r => r.candidate.key === 'craft:furnace').score;
  const pickaxeScore = result.ranked.find(r => r.candidate.key === 'craft:iron_pickaxe').score;
  assert.ok(pickaxeScore > furnaceScore, 'expected the recently-active candidate to outscore the long-stale one with the same initial eligibility');
  assert.equal(result.chosen.key, 'craft:iron_pickaxe');

  // Backward compatibility: an entry with no eligibility field at all must
  // behave exactly as before this upgrade (0 decay contribution).
  const noEligibilityTable = {
    ...defaultPolicyTable(),
    total_rounds: 100,
    entries: { 'craft:furnace': { weight: 1, prior_confidence: 0.5, proficiency_count: 5, has_precedent: true, sum_reward: 2.5 } },
  };
  const singleCandidate = [candidates[0]];
  const noEligibilityResult = chooseCandidate(singleCandidate, noEligibilityTable);
  assert.equal(noEligibilityResult.ranked[0].eligibilityNow, 0, 'expected 0 eligibility contribution when the field is absent');
});

// 20) task 3b: multi-step stitched macro extraction — a verified 2-step
// cur_idx-advancing sequence (gather:oak_log -> craft:oak_planks) must be
// lifted into policy_snapshot.json.stitched_macros with a `steps` array,
// and candidates.mjs must only offer it when the FIRST step's requires are
// satisfied by the current state.
test('deliberate.mjs extracts a verified 2-step cur_idx-advancing chain into stitched_macros with steps[], candidates.mjs gates it on the first step', () => {
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(
    splitsPath,
    JSON.stringify([
      { id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] },
      { id: 'planks', label: 'Make planks', conditions: [{ inv: 'oak_planks', count: 1 }] },
      { id: 'table', label: 'Craft a table', conditions: [{ inv: 'crafting_table', count: 1 }] },
    ]),
  );

  // Step A: gather:oak_log, proposed at cur_idx -1, succeeds.
  const proposalA = {
    decision_id: 'm1', time: Date.now(),
    state: { inventory: {}, dimension: 'overworld' },
    cur_idx: -1, next_split: 'wood', proposed: 'gather:oak_log',
    chosen_spec: { id: 'gather:oak_log', key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] },
    candidates: [], directionDeviated: false,
  };
  const outcomeA = { decision_id: 'm1', time: Date.now(), chosen: 'gather:oak_log', chosen_id: 'gather:oak_log', result: { ok: true, code: 'ok' } };

  // Step B: craft:oak_planks, proposed at cur_idx 0 (advanced past A), succeeds.
  const proposalB = {
    decision_id: 'm2', time: Date.now(),
    state: { inventory: { oak_log: 1 }, dimension: 'overworld' },
    cur_idx: 0, next_split: 'planks', proposed: 'craft:oak_planks',
    chosen_spec: { id: 'craft:oak_planks', key: 'craft:oak_planks', tool: 'craft', args: { item: 'oak_planks', count: 4 }, requires: [{ inv: 'oak_log', count: 1 }], ensures: [{ inv: 'oak_planks', count: 4 }] },
    candidates: [], directionDeviated: false,
  };
  const outcomeB = { decision_id: 'm2', time: Date.now(), chosen: 'craft:oak_planks', chosen_id: 'craft:oak_planks', result: { ok: true, code: 'ok' } };

  // A third proposal AFTER B, at an even higher cur_idx, is what proves B
  // itself advanced the route (same proposal-to-proposal measurement
  // extractStitchedMacros() already uses).
  const proposalC = {
    decision_id: 'm3', time: Date.now(),
    state: { inventory: { oak_planks: 4 }, dimension: 'overworld' },
    cur_idx: 1, next_split: 'table', proposed: 'craft:crafting_table',
    chosen_spec: { id: 'craft:crafting_table', key: 'craft:crafting_table', tool: 'craft', args: { item: 'crafting_table', count: 1 }, requires: [], ensures: [] },
    candidates: [], directionDeviated: false,
  };

  append(proposalA, streamPath);
  append(outcomeA, streamPath);
  append(proposalB, streamPath);
  append(outcomeB, streamPath);
  append(proposalC, streamPath);

  const summary = runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath });
  assert.ok(summary.stitchedMacroCount >= 1);

  const policy = readPolicyTable(policyPath);
  const chainMacro = policy.stitched_macros.find(m => Array.isArray(m.steps) && m.steps.length === 2);
  assert.ok(chainMacro, 'expected a 2-step chain macro in stitched_macros');
  assert.equal(chainMacro.key, 'gather:oak_log', 'expected the macro to execute as its FIRST verified step');
  assert.equal(chainMacro.tool, 'gather');
  assert.equal(chainMacro.steps[0].key, 'gather:oak_log');
  assert.equal(chainMacro.steps[1].key, 'craft:oak_planks');

  // candidates.mjs: offered when the FIRST step's requires are satisfied...
  const satisfiedState = { pos: null, health: 20, food: 20, dimension: 'overworld', inventory: {}, nearbyBlocks: [], nearbyHostiles: 0 };
  const offered = enumerateCandidates(satisfiedState, { nextSplit: null, stitchedMacros: policy.stitched_macros });
  const offeredChain = offered.find(c => c.id === chainMacro.id);
  assert.ok(offeredChain, 'expected the chain macro to be offered when its first step has no unmet requires');
  assert.deepEqual(offeredChain.steps, chainMacro.steps);

  // ...and withheld when the first step's requires are NOT satisfied (here:
  // craft:oak_planks's own requires would need oak_log, but we gate on
  // whatever the macro's top-level `requires` says — gather:oak_log itself
  // has none, so instead verify withholding via a synthetic macro whose
  // first-step requires are unmet).
  const gatedMacro = { id: 'stitched_chain:needs_pick', key: 'gather:cobblestone', tool: 'gather', args: { block: 'cobblestone', count: 1 }, requires: [{ inv: 'wooden_pickaxe', count: 1 }], ensures: [], steps: [{ key: 'gather:cobblestone', tool: 'gather', args: {}, requires: [{ inv: 'wooden_pickaxe', count: 1 }], ensures: [] }, { key: 'craft:stone_pickaxe', tool: 'craft', args: {}, requires: [], ensures: [] }] };
  const withheld = enumerateCandidates(satisfiedState, { nextSplit: null, stitchedMacros: [gatedMacro] });
  assert.ok(!withheld.some(c => c.id === gatedMacro.id), 'expected the chain macro to be withheld when its first step requires are unmet');
});

// --- Follow-up fixes: eligibility magnitude + multi-step macro execution ---

// 21) eligibility magnitude bug fix: even a MAXED-OUT eligibility (1.0,
// freshly updated so decay is zero) must never let a candidate that does
// NOT hit the next Wiki split outrank one that DOES, nor cancel out the
// directionPenalty applied to an off-route candidate — wikiBonus (0.5) and
// directionPenalty (0.4) must always dominate the eligibility contribution
// (capped at 1.0 * ELIGIBILITY_SCORE_FACTOR = 0.3 by construction).
test('decide.mjs: a maxed-out eligibility never outranks a candidate that hits the next Wiki split', () => {
  const policyTable = {
    ...defaultPolicyTable(),
    total_rounds: 10,
    entries: {
      // Off-route candidate: eligibility maxed at 1.0, just updated (zero
      // decay), identical UCB-relevant fields to the on-route one below —
      // isolates the claim to the eligibility contribution alone.
      'move:explore_n': { weight: 1, prior_confidence: 0.5, proficiency_count: 5, has_precedent: true, sum_reward: 2.5, eligibility: 1.0, last_updated_round: 10 },
      // On-route candidate: hits the next split, but has NO eligibility at
      // all (0 contribution) and otherwise-identical history — so if
      // eligibility's 0.3x cap works, the Wiki bonus must still win.
      'craft:oak_planks': { weight: 1, prior_confidence: 0.5, proficiency_count: 5, has_precedent: true, sum_reward: 2.5 },
    },
  };
  const candidates = [
    { id: 'move:explore_n', key: 'move:explore_n', tool: 'go_to', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'explore' },
    { id: 'craft:oak_planks', key: 'craft:oak_planks', tool: 'craft', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: true, source: 'atomic' },
  ];

  const result = chooseCandidate(candidates, policyTable);
  assert.equal(result.chosen.key, 'craft:oak_planks', 'expected the Wiki-split-hitting candidate to win despite the other having maxed-out eligibility');

  const exploreScore = result.ranked.find(r => r.candidate.key === 'move:explore_n');
  // Sanity: the eligibility contribution itself is really capped at 0.3,
  // not silently uncapped — this is the actual regression this test guards.
  assert.ok(exploreScore.eligibilityContribution <= 0.3 + 1e-9, `expected eligibility contribution <= 0.3, got ${exploreScore.eligibilityContribution}`);
  assert.ok(exploreScore.eligibilityContribution > 0, 'expected a nonzero eligibility contribution for this maxed-out entry (sanity: the field is actually being read)');
});

// 22) multi-step stitched macro execution: executeChosenSteps() (the
// shared helper auto_loop.mjs/tools_adapter.mjs's execution path would use)
// must run a 2-step chain in order against a fake gameTools array, and
// must stop immediately — never attempting step 2 — when step 1 fails.
test('macro_executor.executeChosenSteps runs a 2-step chain in order, and stops at step 1 on failure without running step 2', async () => {
  const { executeChosenSteps } = await import('./macro_executor.mjs');

  const calls = [];
  const makeFakeTool = (name, succeed) => ({
    name,
    execute: async (decisionId, args, signal) => {
      calls.push({ tool: name, decisionId, args });
      return succeed ? { isError: false, content: [{ type: 'text', text: 'ok' }] } : { isError: true, content: [{ type: 'text', text: `${name}_failed` }] };
    },
  });

  const fakeBot = { game: { dimension: 'overworld' } };
  const fakeObserve = async () => ({
    state: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: { items: [{ name: 'oak_log', count: 1 }] }, blocks: [], entities: [] },
  });
  const liveNormalizedState = async (bot, observe) => {
    const { state } = await observe();
    return { pos: state.position, health: state.health, food: state.food, dimension: 'overworld', inventory: { oak_log: 1 }, nearbyBlocks: [], nearbyHostiles: 0 };
  };

  const chosenSucceeding = {
    key: 'gather:oak_log',
    tool: 'gather',
    args: { block: 'oak_log', count: 1 },
    requires: [],
    ensures: [{ inv: 'oak_log', count: 1 }],
    steps: [
      { key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] },
      { key: 'craft:oak_planks', tool: 'craft', args: { item: 'oak_planks', count: 4 }, requires: [{ inv: 'oak_log', count: 1 }], ensures: [{ inv: 'oak_planks', count: 4 }] },
    ],
  };
  const gameToolsAllSucceed = [makeFakeTool('gather', true), makeFakeTool('craft', true)];

  const successResult = await executeChosenSteps({
    bot: fakeBot, observe: fakeObserve, gameTools: gameToolsAllSucceed,
    chosen: chosenSucceeding, decisionId: 'd1', overrideCap: null, liveNormalizedState,
  });
  assert.equal(successResult.ok, true);
  assert.equal(successResult.stepsCompleted, 2);
  assert.equal(successResult.stepsTotal, 2);
  assert.deepEqual(calls.map(c => c.tool), ['gather', 'craft'], 'expected both steps to run in order');

  // Now with step 1 (gather) failing: step 2 (craft) must NEVER be called.
  calls.length = 0;
  const gameToolsFirstFails = [makeFakeTool('gather', false), makeFakeTool('craft', true)];
  const failureResult = await executeChosenSteps({
    bot: fakeBot, observe: fakeObserve, gameTools: gameToolsFirstFails,
    chosen: chosenSucceeding, decisionId: 'd2', overrideCap: null, liveNormalizedState,
  });
  assert.equal(failureResult.ok, false);
  assert.equal(failureResult.stepsCompleted, 0, 'expected 0 steps completed since step 1 itself failed');
  assert.equal(failureResult.stepsTotal, 2);
  assert.deepEqual(calls.map(c => c.tool), ['gather'], 'expected step 2 (craft) to NEVER be called after step 1 failed');

  // A normal single-step candidate (no `steps` array) must still execute
  // exactly as one tool call, unaffected by the multi-step machinery.
  calls.length = 0;
  const singleStepChosen = { key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [] };
  const singleResult = await executeChosenSteps({
    bot: fakeBot, observe: fakeObserve, gameTools: gameToolsAllSucceed,
    chosen: singleStepChosen, decisionId: 'd3', overrideCap: null, liveNormalizedState,
  });
  assert.equal(singleResult.ok, true);
  assert.equal(singleResult.stepsTotal, 1);
  assert.deepEqual(calls.map(c => c.tool), ['gather']);
});

// --- Stage 5 (collage finale) upgrades --------------------------------

// 23) task 1 verification: efficiency reward — two outcomes of the SAME
// candidate, both ok:true, but one took 1s and the other 16s. The fast one
// must end up with a strictly higher prior_confidence in policy_snapshot
// after deliberation, proving "succeeding fast" actually outscores
// "succeeding slow" instead of both collapsing to the same reward=1.
test('deliberate.mjs: efficiency reward makes a fast success score higher than a slow success for the same candidate', () => {
  const streamPathFast = tmpFile('decisions.jsonl');
  const streamPathSlow = tmpFile('decisions.jsonl');
  const policyPathFast = tmpFile('policy_snapshot.json');
  const policyPathSlow = tmpFile('policy_snapshot.json');
  const confirmPathFast = tmpFile('pending_confirm.jsonl');
  const confirmPathSlow = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(splitsPath, JSON.stringify([{ id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] }]));

  const state = { inventory: {}, dimension: 'overworld' };

  // Fast run: 3 outcomes of gather:wood_log, each ok:true, duration_ms=1000.
  for (let i = 0; i < 3; i++) {
    const decision_id = `fast${i}`;
    append({ decision_id, state, cur_idx: -1, proposed: 'gather:wood_log', chosen_spec: { id: 'gather:oak_log', key: 'gather:wood_log', tool: 'gather', args: {}, requires: [], ensures: [] } }, streamPathFast);
    append({ decision_id, chosen: 'gather:wood_log', result: { ok: true, code: 'ok' }, duration_ms: 1000 }, streamPathFast);
  }
  // Slow run: identical candidate/outcomes, but duration_ms=16000.
  for (let i = 0; i < 3; i++) {
    const decision_id = `slow${i}`;
    append({ decision_id, state, cur_idx: -1, proposed: 'gather:wood_log', chosen_spec: { id: 'gather:oak_log', key: 'gather:wood_log', tool: 'gather', args: {}, requires: [], ensures: [] } }, streamPathSlow);
    append({ decision_id, chosen: 'gather:wood_log', result: { ok: true, code: 'ok' }, duration_ms: 16000 }, streamPathSlow);
  }

  runDeliberation({ stallK: 999, streamPath: streamPathFast, splitsPath, policyPath: policyPathFast, confirmPath: confirmPathFast });
  runDeliberation({ stallK: 999, streamPath: streamPathSlow, splitsPath, policyPath: policyPathSlow, confirmPath: confirmPathSlow });

  const fastPolicy = readPolicyTable(policyPathFast);
  const slowPolicy = readPolicyTable(policyPathSlow);

  const fastConfidence = fastPolicy.entries['gather:wood_log'].prior_confidence;
  const slowConfidence = slowPolicy.entries['gather:wood_log'].prior_confidence;

  assert.ok(fastConfidence > slowConfidence, `expected fast (1s) prior_confidence (${fastConfidence}) > slow (16s) prior_confidence (${slowConfidence})`);
  // Sanity-check against the exact documented formula: reward = max(0.3, 1 - min(duration,20000)/28000).
  assert.ok(Math.abs(fastConfidence - (1 - 1000 / 28000)) < 1e-9, `expected fast reward to match the documented formula, got ${fastConfidence}`);
  assert.ok(Math.abs(slowConfidence - (1 - 16000 / 28000)) < 1e-9, `expected slow reward to match the documented formula, got ${slowConfidence}`);

  // Backward compatibility: an old outcome record with NO duration_ms at
  // all must still score as a plain ok:true -> reward 1 (pre-upgrade
  // behavior), never silently defaulted to the 0.3 floor or to 0.
  const streamPathOld = tmpFile('decisions.jsonl');
  const policyPathOld = tmpFile('policy_snapshot.json');
  const confirmPathOld = tmpFile('pending_confirm.jsonl');
  append({ decision_id: 'old0', state, cur_idx: -1, proposed: 'gather:wood_log', chosen_spec: { id: 'gather:oak_log', key: 'gather:wood_log', tool: 'gather', args: {}, requires: [], ensures: [] } }, streamPathOld);
  append({ decision_id: 'old0', chosen: 'gather:wood_log', result: { ok: true, code: 'ok' } }, streamPathOld); // no duration_ms
  runDeliberation({ stallK: 999, streamPath: streamPathOld, splitsPath, policyPath: policyPathOld, confirmPath: confirmPathOld });
  const oldPolicy = readPolicyTable(policyPathOld);
  assert.equal(oldPolicy.entries['gather:wood_log'].prior_confidence, 1, 'expected a missing duration_ms to fall back to the pre-upgrade ok?1:0 reward');
});

// 24) task 2 verification: persona-driven preference differences — in the
// SAME observed state (enough wood held to craft, but a log still visible
// nearby), 'companion_builder' (high gather_hoard) and 'speedrunner' (high
// wiki_drive, low gather_hoard) must rank the reserve-gather candidate vs.
// the main-line candidate in opposite orders.
test("decide.mjs: 'companion_builder' vs 'speedrunner' personas rank reserve-gather vs. main-line candidates oppositely", () => {
  // Same state for both personas: 1 oak_log already held (so craft:wood_planks
  // is a real main-line, hitsNextSplit alternative this round) AND oak_log
  // still visible nearby (so gather:wood_log is offered too, marked
  // isReserveGather since the inventory already has enough to proceed).
  const state = {
    pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, dimension: 'overworld',
    inventory: { oak_log: 1 },
    nearbyBlocks: ['oak_log'],
    nearbyHostiles: 0,
  };
  const nextSplit = { id: 'planks', conditions: [{ inv: 'oak_planks', count: 1 }] };
  const candidates = enumerateCandidates(state, { nextSplit });

  const reserveGatherCandidate = candidates.find(c => c.key === 'gather:wood_log');
  const mainLineCandidate = candidates.find(c => c.key === 'craft:wood_planks');
  assert.ok(reserveGatherCandidate, 'expected a gather:wood_log candidate to still be offered as a real fork');
  assert.ok(reserveGatherCandidate.isReserveGather, 'expected gather:wood_log to be marked isReserveGather when a log is already held');
  assert.ok(mainLineCandidate, 'expected craft:wood_planks as the main-line alternative');
  assert.ok(mainLineCandidate.hitsNextSplit, 'expected craft:wood_planks to hit the next Wiki split');

  // Identical, neutral policy history for both candidates — any ranking
  // difference between the two persona runs can only come from the
  // persona knobs themselves (gather_hoard vs. wiki_drive), not from UCB
  // history.
  // Note: recipe_planner.mjs's own wooden_pickaxe/stone_pickaxe/iron_pickaxe
  // progression loop ALSO offers its own craft step toward oak_planks in
  // this state (id/key both 'craft:oak_planks', distinct from the
  // hand-written 'craft:wood_planks' key above) since oak_planks is a real
  // ingredient on the way to wooden_pickaxe. It needs the same seeded,
  // non-cold-start policy entry as the other two candidates — otherwise its
  // cold-start prior (10) would swamp every persona-driven score difference
  // this test is actually trying to isolate.
  const policyTable = {
    ...defaultPolicyTable(),
    total_rounds: 10,
    entries: {
      'gather:wood_log': { weight: 1, prior_confidence: 0.5, proficiency_count: 5, has_precedent: true, sum_reward: 2.5 },
      'craft:wood_planks': { weight: 1, prior_confidence: 0.5, proficiency_count: 5, has_precedent: true, sum_reward: 2.5 },
      'craft:oak_planks': { weight: 1, prior_confidence: 0.5, proficiency_count: 5, has_precedent: true, sum_reward: 2.5 },
    },
  };

  const companionPersona = resolvePersona('companion_builder');
  const speedrunnerPersona = resolvePersona('speedrunner');
  assert.ok(companionPersona.gather_hoard > speedrunnerPersona.gather_hoard, 'expected companion_builder to value hoarding more than speedrunner (sanity check on persona.json itself)');
  assert.ok(speedrunnerPersona.wiki_drive > companionPersona.wiki_drive, 'expected speedrunner to value wiki-direction more than companion_builder (sanity check on persona.json itself)');

  const companionResult = chooseCandidate(candidates, policyTable, { persona: companionPersona });
  const speedrunnerResult = chooseCandidate(candidates, policyTable, { persona: speedrunnerPersona });

  const companionGatherScore = companionResult.ranked.find(r => r.candidate.key === 'gather:wood_log').score;
  const companionCraftScore = companionResult.ranked.find(r => r.candidate.key === 'craft:wood_planks').score;
  const speedrunnerGatherScore = speedrunnerResult.ranked.find(r => r.candidate.key === 'gather:wood_log').score;
  const speedrunnerCraftScore = speedrunnerResult.ranked.find(r => r.candidate.key === 'craft:wood_planks').score;

  assert.ok(companionGatherScore > companionCraftScore, 'expected companion_builder (high gather_hoard) to prefer reserve-gathering over the main line');
  assert.ok(speedrunnerCraftScore > speedrunnerGatherScore, 'expected speedrunner (high wiki_drive, low gather_hoard) to prefer the main line over reserve-gathering');
  assert.equal(companionResult.chosen.key, 'gather:wood_log');
  assert.equal(speedrunnerResult.chosen.key, 'craft:wood_planks');

  // isReserveGather must never trigger a false directionDeviated report,
  // for EITHER persona, even when (as with companion_builder above) it
  // actually wins over a hitsNextSplit candidate.
  assert.equal(companionResult.directionDeviated, false, 'expected isReserveGather winning over the main line to never count as a direction deviation');
  assert.equal(speedrunnerResult.directionDeviated, false);
});

// 25) task 1 verification: stitched_macros boundary + relative place
// coordinates — a 3-proposal run where the jump happens on step 1
// (gather:oak_log) and step 2 (craft:oak_planks) does NOT itself advance
// cur_idx any further must produce a macro truncated at exactly 1 step
// (never dragging step 2 in), and a `place` step's coordinates must be
// stored relative (no frozen x/y/z) and re-grounded dynamically against
// the CURRENT position by both candidates.mjs and macro_executor.mjs.
test('deliberate.mjs: stitched macro truncates exactly at the cur_idx jump, and place coordinates are re-grounded to the current position', () => {
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(
    splitsPath,
    JSON.stringify([
      { id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] },
      { id: 'planks', label: 'Make planks', conditions: [{ inv: 'oak_planks', count: 1 }] },
    ]),
  );

  // P0: gather:oak_log proposed at cur_idx=-1, succeeds -> P1 shows cur_idx=1
  // (the jump happens ON this step, skipping straight past "wood" AND
  // "planks" in one shot — contrived but exercises the exact boundary bug:
  // a naive "is nextProposal.cur_idx > PREVIOUS chain entry's cur_idx"
  // check would wrongly drag P1 itself into the chain next).
  const p0 = {
    decision_id: 'b0', time: Date.now(),
    state: { inventory: {}, dimension: 'overworld' },
    cur_idx: -1, next_split: 'wood', proposed: 'gather:oak_log',
    chosen_spec: { id: 'gather:oak_log', key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] },
    candidates: [], directionDeviated: false,
  };
  const o0 = { decision_id: 'b0', time: Date.now(), chosen: 'gather:oak_log', chosen_id: 'gather:oak_log', result: { ok: true, code: 'ok' } };

  // P1: craft:oak_planks proposed at cur_idx=1 (already past the jump P0
  // caused) — THIS step itself does NOT advance any further (P2 below is
  // also cur_idx=1), so it must never be chained onto P0's macro.
  const p1 = {
    decision_id: 'b1', time: Date.now(),
    state: { inventory: { oak_log: 1 }, dimension: 'overworld' },
    cur_idx: 1, next_split: null, proposed: 'craft:oak_planks',
    chosen_spec: { id: 'craft:oak_planks', key: 'craft:oak_planks', tool: 'craft', args: { item: 'oak_planks', count: 4 }, requires: [{ inv: 'oak_log', count: 1 }], ensures: [{ inv: 'oak_planks', count: 4 }] },
    candidates: [], directionDeviated: false,
  };
  const o1 = { decision_id: 'b1', time: Date.now(), chosen: 'craft:oak_planks', chosen_id: 'craft:oak_planks', result: { ok: true, code: 'ok' } };

  // P2: some unrelated place step, proposed at the SAME cur_idx=1 as P1
  // (no further advance) — proves P1 is correctly excluded.
  const p2 = {
    decision_id: 'b2', time: Date.now(),
    state: { inventory: { oak_log: 1, oak_planks: 4 }, dimension: 'overworld' },
    cur_idx: 1, next_split: null, proposed: 'place:crafting_table',
    chosen_spec: { id: 'place:crafting_table', key: 'place:crafting_table', tool: 'place', args: { block: 'crafting_table', x: 100, y: 65, z: -200 }, requires: [{ inv: 'crafting_table', count: 1 }], ensures: [] },
    candidates: [], directionDeviated: false,
  };

  append(p0, streamPath);
  append(o0, streamPath);
  append(p1, streamPath);
  append(o1, streamPath);
  append(p2, streamPath);

  const summary = runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath });
  const policy = readPolicyTable(policyPath);

  // No 2+ step chain exists in stitched_macros: the only verified step
  // whose OWN execution advanced cur_idx is P0 (gather:oak_log), and the
  // very next step (P1, craft:oak_planks) did not itself advance further,
  // so the chain must stop at length 1 (below the "multi-step" floor of 2).
  const chainMacros = policy.stitched_macros.filter(m => Array.isArray(m.steps) && m.steps.length >= 2);
  assert.equal(chainMacros.length, 0, 'expected no multi-step chain: the step after the jump must never be dragged in');

  // The single-step macro for gather:oak_log must still exist (extractStitchedMacros()'s
  // own single-step path, independent of the multi-step chain logic).
  const singleMacro = policy.stitched_macros.find(m => m.key === 'gather:oak_log');
  assert.ok(singleMacro, 'expected the single successful, route-advancing gather:oak_log step to still be lifted as its own single-step macro');

  // A `place` step macro, if lifted at all (place:crafting_table did NOT
  // advance cur_idx here, so extractStitchedMacros() should actually
  // exclude it — sanity-check that too), must never carry the recorded
  // absolute x/y/z verbatim.
  const placeMacro = policy.stitched_macros.find(m => m.tool === 'place');
  assert.ok(!placeMacro, 'expected place:crafting_table (did not advance cur_idx) to be excluded from stitched_macros entirely');

  // Directly exercise the relativization + re-grounding path with a
  // synthetic macro (since this run's real history has no successful,
  // route-advancing place step to lift): deliberate.mjs's
  // relativizeMacroArgs() must strip x/y/z and mark relativePlacement, and
  // candidates.mjs must re-ground it against the CURRENT position when
  // collaging it into a candidate.
  const syntheticPlaceMacro = {
    id: 'stitched:place:crafting_table',
    key: 'place:crafting_table',
    tool: 'place',
    args: { block: 'crafting_table', relativePlacement: true }, // already-relativized shape
    requires: [{ inv: 'crafting_table', count: 1 }],
    ensures: [],
  };
  assert.equal(syntheticPlaceMacro.args.x, undefined, 'expected a relativized place macro template to carry no frozen x/y/z');

  const liveState = {
    pos: { x: 5, y: 70, z: 9 }, health: 20, food: 20, dimension: 'overworld',
    inventory: { crafting_table: 1 },
    nearbyBlocks: [],
    nearbyHostiles: 0,
  };
  const regrounded = enumerateCandidates(liveState, { nextSplit: null, stitchedMacros: [syntheticPlaceMacro] });
  const regroundedCandidate = regrounded.find(c => c.id === 'stitched:place:crafting_table');
  assert.ok(regroundedCandidate, 'expected the stitched place macro to be offered (requires satisfied)');
  assert.deepEqual(
    { x: regroundedCandidate.args.x, y: regroundedCandidate.args.y, z: regroundedCandidate.args.z },
    { x: Math.floor(liveState.pos.x) + 1, y: Math.floor(liveState.pos.y), z: Math.floor(liveState.pos.z) },
    'expected the place macro to be re-grounded to the CURRENT live position, not any frozen historical coordinate',
  );
  assert.equal(regroundedCandidate.args.relativePlacement, undefined, 'expected the relativePlacement marker to be consumed/removed once re-grounded to a concrete cell');
});

// --- Stage 6 (maturity pass) upgrades ----------------------------------

// 26) task 1 verification (relaxed extraction): a real-shaped "same-stage
// combo" — gather:wood_log (does NOT itself advance cur_idx) immediately
// followed by craft:wood_planks (THIS step is the one that advances
// cur_idx) — must now qualify as a genuine 2-step stitched macro. Under
// the PREVIOUS (overly strict) rule this was impossible: it required EVERY
// step in the chain to individually cause its own jump, and gathering a
// single log never crosses a Wiki split on its own.
test('deliberate.mjs (relaxed rule): a same-stage gather->craft combo where only the LAST step jumps cur_idx still qualifies as a 2-step macro', () => {
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(
    splitsPath,
    JSON.stringify([
      { id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] },
      { id: 'planks', label: 'Make planks', conditions: [{ inv: 'oak_planks', count: 1 }] },
    ]),
  );

  // Step 1: gather:wood_log, proposed at cur_idx=-1, succeeds. It does NOT
  // itself advance cur_idx — the very next proposal (step 2) is ALSO still
  // at cur_idx=-1 (the bot hasn't crafted planks yet, so neither "wood" nor
  // "planks" is satisfied the instant the log lands in inventory —
  // evaluate() only re-runs on the NEXT observe(), which is step 2's own
  // proposal, itself still before planks exist).
  const g1 = {
    decision_id: 'r1', time: Date.now(),
    state: { inventory: {}, dimension: 'overworld' },
    cur_idx: -1, next_split: 'wood', proposed: 'gather:wood_log',
    chosen_spec: { id: 'gather:oak_log', key: 'gather:wood_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] },
    candidates: [], directionDeviated: false,
  };
  const go1 = { decision_id: 'r1', time: Date.now(), chosen: 'gather:wood_log', chosen_id: 'gather:oak_log', result: { ok: true, code: 'ok' } };

  // Step 2: craft:wood_planks, proposed at cur_idx=-1 (same as step 1's
  // OWN cur_idx — this is exactly why the old strict rule rejected step 1
  // as "not advancing", since step 1's own cur_idx===step 2's cur_idx), but
  // crafting the planks IS what finally satisfies both "wood" and "planks"
  // splits at once, so THIS step itself genuinely jumps cur_idx forward.
  const c1 = {
    decision_id: 'r2', time: Date.now(),
    state: { inventory: { oak_log: 1 }, dimension: 'overworld' },
    cur_idx: -1, next_split: 'planks', proposed: 'craft:wood_planks',
    chosen_spec: { id: 'craft:oak_planks', key: 'craft:wood_planks', tool: 'craft', args: { item: 'oak_planks', count: 4 }, requires: [{ inv: 'oak_log', count: 1 }], ensures: [{ inv: 'oak_planks', count: 4 }] },
    candidates: [], directionDeviated: false,
  };
  const co1 = { decision_id: 'r2', time: Date.now(), chosen: 'craft:wood_planks', chosen_id: 'craft:oak_planks', result: { ok: true, code: 'ok' } };

  // Step 3: the proposal immediately after step 2 shows the jump (cur_idx
  // 1 — both "wood" and "planks" now satisfied at once), proving step 2
  // itself caused it.
  const n1 = {
    decision_id: 'r3', time: Date.now(),
    state: { inventory: { oak_log: 1, oak_planks: 4 }, dimension: 'overworld' },
    cur_idx: 1, next_split: null, proposed: 'move:explore_n',
    chosen_spec: { id: 'move:explore_n', key: 'move:explore_n', tool: 'go_to', args: {}, requires: [], ensures: [] },
    candidates: [], directionDeviated: false,
  };

  append(g1, streamPath);
  append(go1, streamPath);
  append(c1, streamPath);
  append(co1, streamPath);
  append(n1, streamPath);

  const summary = runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath });
  const policy = readPolicyTable(policyPath);

  const chainMacro = policy.stitched_macros.find(m => Array.isArray(m.steps) && m.steps.length === 2);
  assert.ok(chainMacro, 'expected the relaxed rule to lift gather:wood_log -> craft:wood_planks as a genuine 2-step macro');
  assert.equal(chainMacro.key, 'gather:wood_log', 'expected the macro to execute as its FIRST step');
  assert.equal(chainMacro.steps[0].key, 'gather:wood_log');
  assert.equal(chainMacro.steps[1].key, 'craft:wood_planks', 'expected the step that actually caused the jump to be the LAST step in the chain');
  assert.ok(summary.stitchedMacroCount >= 1);

  // The explore move AFTER the jump must still never be dragged into the
  // chain (the truncation-at-the-jump invariant from the previous upgrade
  // is unchanged by this relaxation).
  assert.ok(!chainMacro.steps.some(s => s.key === 'move:explore_n'), 'expected the post-jump explore step to never be chained in');
});

// 27) task 2 verification: running the full test suite leaves the REAL
// project-root decisions.jsonl byte-identical to how it started, even
// though runDeliberation()'s progress-stall path calls log.mjs's
// logDeviation() — a locked base file that always appends to
// stream.mjs's own hardcoded default LOG_PATH (the real root
// decisions.jsonl) no matter what streamPath this test injects elsewhere.
// This directly exercises that leak path (deliberately, inside a nested
// scope) and confirms the suite-level before()/after() hooks (see top of
// this file) genuinely restore the root file's exact prior bytes/absence
// afterward — not just "most tests don't touch it by accident".
test('suite-level before()/after() hooks restore the real root decisions.jsonl exactly, even when logDeviation() leaks into it mid-suite', () => {
  const beforeExists = existsSync(LOG_PATH);
  const beforeBytes = beforeExists ? readFileSync(LOG_PATH, 'utf8') : null;

  // Force a REAL progress-stall deliberation pass whose logDeviation() call
  // is known (per deliberate.mjs's own doc comment) to append a 'deviation'
  // line to the real root LOG_PATH, regardless of the tmp streamPath used
  // for everything else in this pass.
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(splitsPath, JSON.stringify([{ id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] }]));
  const state = { inventory: {}, dimension: 'overworld' };
  for (let i = 0; i < 5; i++) {
    append({ decision_id: `leak${i}`, chosen: 'gather:oak_log', state, cur_idx: -1, result: { ok: false, code: 'block_gone' } }, streamPath);
  }
  const summary = runDeliberation({ stallK: 5, streamPath, splitsPath, policyPath, confirmPath });
  assert.equal(summary.learningIndex.progressDeviationLogged, true, 'expected this pass to actually trigger logDeviation() (the real leak path)');

  // Prove the leak really happened: the real root file now differs from
  // its pre-test snapshot (or now exists when it didn't before) — this
  // assertion is what makes the eventual after()-hook restoration
  // meaningful rather than a no-op check.
  const afterLeakExists = existsSync(LOG_PATH);
  assert.equal(afterLeakExists, true, 'expected logDeviation() to have created/appended to the real root decisions.jsonl');
  if (beforeExists) {
    const afterLeakBytes = readFileSync(LOG_PATH, 'utf8');
    assert.notEqual(afterLeakBytes, beforeBytes, 'expected the real root file to have actually grown from this logDeviation() call');
  }

  // The suite-level after() hook (registered once, at module load time,
  // before any test ran) will restore this to `beforeBytes`/non-existence
  // once the ENTIRE suite finishes — not after this individual test. This
  // test's job is only to prove the leak is real and reproducible; the
  // final restoration is verified operationally by comparing a hash of
  // decisions.jsonl before and after the whole `node brain/brain.test.mjs`
  // process run (see brain/README.md §5 and the task report), since a
  // single test cannot observe node:test's own after() hook firing without
  // ending the process.
});

// --- This upgrade: anti-noise long-chain stitching + flow-shape feedback ---

// 28) anti-noise fix: a REAL run that gathers a log, takes one successful
// blind exploration hop, flees a hostile that wandered by, and THEN crafts
// planks (the craft is what actually crosses the Wiki split) must still be
// recognized as the reusable gather->craft combo it really is — the
// exploration/flee noise in between must never sever the chain.
test('deliberate.mjs extractMultiStepMacros skips over exploration/flee noise and still stitches gather:wood_log -> craft:oak_planks', () => {
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(
    splitsPath,
    JSON.stringify([
      { id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] },
      { id: 'planks', label: 'Make planks', conditions: [{ inv: 'oak_planks', count: 1 }] },
    ]),
  );

  // Step A: gather:oak_log succeeds, proposed at cur_idx -1.
  const proposalA = {
    decision_id: 'n1', time: Date.now(), state: { inventory: {}, dimension: 'overworld' },
    cur_idx: -1, next_split: 'wood', proposed: 'gather:oak_log',
    chosen_spec: { id: 'gather:oak_log', key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] },
    candidates: [], directionDeviated: false,
  };
  const outcomeA = { decision_id: 'n1', time: Date.now(), chosen: 'gather:oak_log', chosen_id: 'gather:oak_log', result: { ok: true, code: 'ok' } };

  // Noise 1: a successful blind exploration hop, cur_idx unchanged (-1).
  const proposalExplore = {
    decision_id: 'n2', time: Date.now(), state: { inventory: { oak_log: 1 }, dimension: 'overworld' },
    cur_idx: -1, next_split: 'wood', proposed: 'move:explore_n',
    chosen_spec: { id: 'move:explore_n', key: 'move:explore_n', tool: 'go_to', args: {}, requires: [], ensures: [] },
    candidates: [], directionDeviated: false,
  };
  const outcomeExplore = { decision_id: 'n2', time: Date.now(), chosen: 'move:explore_n', chosen_id: 'move:explore_n', result: { ok: true, code: 'executed' } };

  // Noise 2: a successful flee reaction, cur_idx still unchanged (-1).
  const proposalFlee = {
    decision_id: 'n3', time: Date.now(), state: { inventory: { oak_log: 1 }, dimension: 'overworld' },
    cur_idx: -1, next_split: 'wood', proposed: 'flee',
    chosen_spec: { id: 'flee:hostile_nearby', key: 'flee', tool: 'flee', args: {}, requires: [], ensures: [] },
    candidates: [], directionDeviated: false,
  };
  const outcomeFlee = { decision_id: 'n3', time: Date.now(), chosen: 'flee', chosen_id: 'flee:hostile_nearby', result: { ok: true, code: 'executed' } };

  // Step B: craft:oak_planks succeeds and advances cur_idx to 0 — THIS is
  // the jump step the chain must end on.
  const proposalB = {
    decision_id: 'n4', time: Date.now(), state: { inventory: { oak_log: 1 }, dimension: 'overworld' },
    cur_idx: 0, next_split: 'planks', proposed: 'craft:oak_planks',
    chosen_spec: { id: 'craft:oak_planks', key: 'craft:oak_planks', tool: 'craft', args: { item: 'oak_planks', count: 4 }, requires: [{ inv: 'oak_log', count: 1 }], ensures: [{ inv: 'oak_planks', count: 4 }] },
    candidates: [], directionDeviated: false,
  };
  const outcomeB = { decision_id: 'n4', time: Date.now(), chosen: 'craft:oak_planks', chosen_id: 'craft:oak_planks', result: { ok: true, code: 'ok' } };

  // Proposal C after B, at a higher cur_idx, proves B itself caused the jump.
  const proposalC = {
    decision_id: 'n5', time: Date.now(), state: { inventory: { oak_planks: 4 }, dimension: 'overworld' },
    cur_idx: 1, next_split: null, proposed: 'noop', chosen_spec: { id: 'noop', key: 'noop', tool: 'noop', args: {}, requires: [], ensures: [] },
    candidates: [], directionDeviated: false,
  };

  for (const rec of [proposalA, outcomeA, proposalExplore, outcomeExplore, proposalFlee, outcomeFlee, proposalB, outcomeB, proposalC]) {
    append(rec, streamPath);
  }

  const summary = runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath });
  assert.ok(summary.stitchedMacroCount >= 1);

  const policy = readPolicyTable(policyPath);
  const chainMacro = policy.stitched_macros.find(m => Array.isArray(m.steps) && m.steps.map(s => s.key).join('->') === 'gather:oak_log->craft:oak_planks');
  assert.ok(chainMacro, 'expected the anti-noise walk to still find gather:oak_log -> craft:oak_planks across the explore/flee noise');
  assert.equal(chainMacro.steps.length, 2, 'expected exactly the 2 real production steps, with explore/flee never counted as chain members');
  assert.equal(chainMacro.smoothness, 'noisy', 'expected this chain to be tagged as having skipped real noise during extraction');
  assert.equal(chainMacro.span_from_idx, -1);
  assert.equal(chainMacro.span_to_idx, 1);
});

// 29) causal cross-episode splice: two INDEPENDENT, already-verified short
// macros where A's ensures satisfies B's requires must be spliced into one
// longer stitched_chain, carrying a combined span_from_idx -> span_to_idx
// across both halves.
test('deliberate.mjs stitches two independent verified macros end-to-end into a longer chain with a combined span', () => {
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(
    splitsPath,
    JSON.stringify([
      { id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] },
      { id: 'planks', label: 'Make planks', conditions: [{ inv: 'oak_planks', count: 1 }] },
      { id: 'table', label: 'Craft a table', conditions: [{ inv: 'crafting_table', count: 1 }] },
      { id: 'placed', label: 'Place the table', conditions: [{ inv: 'placed_table', count: 1 }] },
    ]),
  );

  // Episode 1: gather:oak_log -> craft:oak_planks (cur_idx -1 -> 0).
  const p1 = { decision_id: 'e1', time: Date.now(), state: { inventory: {}, dimension: 'overworld' }, cur_idx: -1, next_split: 'wood', proposed: 'gather:oak_log',
    chosen_spec: { id: 'gather:oak_log', key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] }, candidates: [], directionDeviated: false };
  const o1 = { decision_id: 'e1', time: Date.now(), chosen: 'gather:oak_log', chosen_id: 'gather:oak_log', result: { ok: true, code: 'ok' } };
  const p2 = { decision_id: 'e2', time: Date.now(), state: { inventory: { oak_log: 1 }, dimension: 'overworld' }, cur_idx: 0, next_split: 'planks', proposed: 'craft:oak_planks',
    chosen_spec: { id: 'craft:oak_planks', key: 'craft:oak_planks', tool: 'craft', args: { item: 'oak_planks', count: 4 }, requires: [{ inv: 'oak_log', count: 1 }], ensures: [{ inv: 'oak_planks', count: 4 }] }, candidates: [], directionDeviated: false };
  const o2 = { decision_id: 'e2', time: Date.now(), chosen: 'craft:oak_planks', chosen_id: 'craft:oak_planks', result: { ok: true, code: 'ok' } };
  const p3 = { decision_id: 'e3', time: Date.now(), state: { inventory: { oak_planks: 4 }, dimension: 'overworld' }, cur_idx: 1, next_split: 'table', proposed: 'noop1',
    chosen_spec: { id: 'noop1', key: 'noop1', tool: 'noop', args: {}, requires: [], ensures: [] }, candidates: [], directionDeviated: false };

  // Episode 2 (independent window position): craft:crafting_table ->
  // place:crafting_table (cur_idx 1 -> 2), requiring oak_planks (episode
  // 1's own ensures) — so episode 1's ensures genuinely satisfies episode
  // 2's requires.
  const p4 = { decision_id: 'e4', time: Date.now(), state: { inventory: { oak_planks: 4 }, dimension: 'overworld' }, cur_idx: 1, next_split: 'table', proposed: 'craft:crafting_table',
    chosen_spec: { id: 'craft:crafting_table', key: 'craft:crafting_table', tool: 'craft', args: { item: 'crafting_table', count: 1 }, requires: [{ inv: 'oak_planks', count: 4 }], ensures: [{ inv: 'crafting_table', count: 1 }] }, candidates: [], directionDeviated: false };
  const o4 = { decision_id: 'e4', time: Date.now(), chosen: 'craft:crafting_table', chosen_id: 'craft:crafting_table', result: { ok: true, code: 'ok' } };
  const p5 = { decision_id: 'e5', time: Date.now(), state: { inventory: { crafting_table: 1 }, dimension: 'overworld' }, cur_idx: 2, next_split: 'placed', proposed: 'place:crafting_table',
    chosen_spec: { id: 'place:crafting_table', key: 'place:crafting_table', tool: 'place', args: { block: 'crafting_table', relativePlacement: true }, requires: [{ inv: 'crafting_table', count: 1 }], ensures: [{ inv: 'placed_table', count: 1 }] }, candidates: [], directionDeviated: false };
  const o5 = { decision_id: 'e5', time: Date.now(), chosen: 'place:crafting_table', chosen_id: 'place:crafting_table', result: { ok: true, code: 'ok' } };
  const p6 = { decision_id: 'e6', time: Date.now(), state: { inventory: { placed_table: 1 }, dimension: 'overworld' }, cur_idx: 3, next_split: null, proposed: 'noop2',
    chosen_spec: { id: 'noop2', key: 'noop2', tool: 'noop', args: {}, requires: [], ensures: [] }, candidates: [], directionDeviated: false };

  for (const rec of [p1, o1, p2, o2, p3, p4, o4, p5, o5, p6]) append(rec, streamPath);

  const summary = runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath });
  assert.ok(summary.stitchedMacroCount >= 1);

  const policy = readPolicyTable(policyPath);
  // The causal match compares the LAST step of one macro's own `ensures`
  // against the FIRST step of another macro's own `requires` (see
  // stitchCrossEpisodeChains()'s doc comment on exactly this — NOT the
  // top-level macro requires/ensures, which on a multi-step macro are the
  // FIRST step's own fields for a completely different reason: gating
  // candidates.mjs's offer check). That means the full causal chain here
  // genuinely runs all the way from the very first gather through to the
  // final place — this is the best-possible splice this history supports,
  // and the test asserts exactly that rather than a weaker one.
  const fullChain = policy.stitched_macros.find(m => m.id === 'stitched_chain:gather:oak_log->craft:oak_planks->craft:crafting_table->place:crafting_table');
  assert.ok(fullChain, 'expected the full 4-step causal chain spanning both episodes to be spliced');
  assert.equal(fullChain.smoothness, 'spliced');
  assert.equal(fullChain.steps.length, 4);
  assert.ok(fullChain.steps.length <= 6, 'expected the spliced chain to respect the <=6 step cap');
  assert.deepEqual(fullChain.steps.map(s => s.key), ['gather:oak_log', 'craft:oak_planks', 'craft:crafting_table', 'place:crafting_table']);
  assert.equal(fullChain.span_from_idx, -1, 'expected the spliced span to start at episode 1\'s own true start');
  assert.equal(fullChain.span_to_idx, 3, 'expected the spliced span to end at episode 2\'s own true end');

  // The original unspliced 2-step gather->craft chain is correctly
  // DROPPED from the final pool here, same existing dedup rule
  // multiStepFirstKeys already applies to single-step-vs-multi-step macros
  // (see runDeliberation()'s own splicedChainKeys dedup): candidates.mjs
  // must never offer two different candidates that share the exact same
  // `.key` (they would collide on the same policy_snapshot.json entry) —
  // the longer, strictly-more-complete 4-step chain correctly wins that
  // slot over its own shorter prefix.
  assert.ok(
    !policy.stitched_macros.some(m => m.id === 'stitched_chain:gather:oak_log->craft:oak_planks'),
    'expected the shorter 2-step prefix to be superseded by the longer 4-step chain sharing the same key, not offered twice',
  );

  // place step must stay dynamically relative, never dead-bound to an
  // absolute historical coordinate.
  const placeStep = fullChain.steps.find(s => s.tool === 'place');
  assert.ok(placeStep, 'expected a place step in the spliced chain');
  assert.equal(placeStep.args.relativePlacement, true, 'expected the place step to stay relativePlacement, never a dead absolute coordinate');
  assert.equal(placeStep.args.x, undefined, 'expected no frozen absolute x on the spliced place step');
});

// 30) high-dimensional long-chain flow feedback: a macro attempted several
// times that mostly breaks halfway must end up with a LOW completion_rate
// and a macro_commitment pushed toward the floor (0.2), while
// entries[key].weight (the quota knob) must stay completely untouched by
// this — weight only reacts to dominant-share crowding, never to macro
// completion history. macro_flow_summary must also be produced.
test('deliberate.mjs macro_flow_summary: a frequently-breaking long chain gets a LOW macro_commitment without touching entries[].weight', () => {
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(splitsPath, JSON.stringify([
    { id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] },
    { id: 'planks', label: 'Make planks', conditions: [{ inv: 'oak_planks', count: 1 }] },
  ]));

  // First establish the 2-step chain itself (same shape as test 28/the
  // existing stage-4 test) so it actually exists in stitched_macros.
  const p1 = { decision_id: 'f1', time: Date.now(), state: { inventory: {}, dimension: 'overworld' }, cur_idx: -1, next_split: 'wood', proposed: 'gather:oak_log',
    chosen_spec: { id: 'gather:oak_log', key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] }, candidates: [], directionDeviated: false };
  const o1 = { decision_id: 'f1', time: Date.now(), chosen: 'gather:oak_log', chosen_id: 'gather:oak_log', result: { ok: true, code: 'ok' } };
  const p2 = { decision_id: 'f2', time: Date.now(), state: { inventory: { oak_log: 1 }, dimension: 'overworld' }, cur_idx: 0, next_split: 'planks', proposed: 'craft:oak_planks',
    chosen_spec: { id: 'craft:oak_planks', key: 'craft:oak_planks', tool: 'craft', args: { item: 'oak_planks', count: 4 }, requires: [{ inv: 'oak_log', count: 1 }], ensures: [{ inv: 'oak_planks', count: 4 }] }, candidates: [], directionDeviated: false };
  const o2 = { decision_id: 'f2', time: Date.now(), chosen: 'craft:oak_planks', chosen_id: 'craft:oak_planks', result: { ok: true, code: 'ok' } };
  const p3 = { decision_id: 'f3', time: Date.now(), state: { inventory: { oak_planks: 4 }, dimension: 'overworld' }, cur_idx: 1, next_split: null, proposed: 'noop',
    chosen_spec: { id: 'noop', key: 'noop', tool: 'noop', args: {}, requires: [], ensures: [] }, candidates: [], directionDeviated: false };
  for (const rec of [p1, o1, p2, o2, p3]) append(rec, streamPath);

  // Dilute the candidate pool with unrelated outcome records for a
  // DIFFERENT key, so gather:oak_log's own choice-share stays <=60% of the
  // window (dominantShare()'s existing, unrelated-to-this-upgrade
  // crowding rule) — this isolates the test's actual claim (macro
  // completion history must never move weight) from that pre-existing,
  // unrelated dominant-share mechanic.
  for (let i = 0; i < 6; i++) {
    append({ decision_id: `dilute_${i}`, time: Date.now(), chosen: 'move:explore_n', chosen_id: `move:explore_n_${i}`, result: { ok: true, code: 'executed' } }, streamPath);
  }

  // Now simulate the SAME macro id having been ATTEMPTED as a chain 4
  // times: 3 break on step 2, 1 completes fully — a real auto_loop.mjs
  // run would write exactly these macro_completed_steps/macro_total_steps/
  // macro_break_at fields on the outcome record (see its own doc comment).
  const macroId = 'stitched_chain:gather:oak_log->craft:oak_planks';
  for (let i = 0; i < 3; i++) {
    append({
      decision_id: `attempt_break_${i}`, time: Date.now(), chosen: 'gather:oak_log', chosen_id: macroId,
      result: { ok: false, code: 'macro_step_2_requires_unmet' }, macro_completed_steps: 1, macro_total_steps: 2, macro_break_at: 2, macro_break_reason: 'requires_unmet',
    }, streamPath);
  }
  append({
    decision_id: 'attempt_complete', time: Date.now(), chosen: 'gather:oak_log', chosen_id: macroId,
    result: { ok: true, code: 'macro_executed' }, macro_completed_steps: 2, macro_total_steps: 2, macro_break_at: null, macro_break_reason: null,
  }, streamPath);

  const weightBefore = readPolicyTable(policyPath).entries['gather:oak_log']?.weight;

  const summary = runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath });
  assert.ok(Array.isArray(summary.macroFlowSummary) && summary.macroFlowSummary.length >= 1, 'expected a non-empty macro_flow_summary');

  const flow = summary.macroFlowSummary.find(f => f.id === macroId);
  assert.ok(flow, 'expected a flow-summary row for the attempted macro id');
  assert.equal(flow.attempts, 4);
  assert.ok(Math.abs(flow.completion_rate - 0.25) < 1e-9, `expected completion_rate 0.25, got ${flow.completion_rate}`);
  assert.equal(flow.common_break_step, 2, 'expected step 2 to be identified as the common break point');
  assert.ok(flow.macro_commitment < 0.5, `expected a low macro_commitment for a mostly-breaking chain, got ${flow.macro_commitment}`);
  assert.ok(flow.macro_commitment >= 0.2, 'expected macro_commitment to stay within its floor');

  const policy = readPolicyTable(policyPath);
  const macroEntry = policy.stitched_macros.find(m => m.id === macroId);
  assert.ok(macroEntry, 'expected the macro itself still present in stitched_macros');
  assert.ok(Math.abs(macroEntry.completion_rate - 0.25) < 1e-9);
  assert.ok(macroEntry.macro_commitment < 0.5);

  // The critical isolation assertion: entries['gather:oak_log'].weight must
  // be completely unaffected by this macro's poor completion history — it
  // only ever reacts to dominant-share crowding (dominantShare()), never to
  // macro_commitment/completion_rate.
  const weightAfter = policy.entries['gather:oak_log']?.weight;
  assert.equal(weightAfter, Math.max(weightBefore ?? 1, 1), 'expected entries[].weight to be driven only by the quota/dominant-share rule, unaffected by macro completion history');

  // decide.mjs: a low-commitment multi-step candidate must score lower
  // (relative to its own neutral baseline) than a macro_commitment:1 copy
  // of the same candidate — proving the multiplier actually reaches
  // decide.mjs's confidence term, applied separately from weight.
  const baseCandidate = {
    id: macroId, key: 'gather:oak_log', tool: 'gather', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'stitched',
    steps: [{ key: 'gather:oak_log', tool: 'gather', args: {} }, { key: 'craft:oak_planks', tool: 'craft', args: {} }],
  };
  const lowCommitmentCandidate = { ...baseCandidate, macro_commitment: macroEntry.macro_commitment, completion_rate: macroEntry.completion_rate };
  const neutralCommitmentCandidate = { ...baseCandidate, macro_commitment: 1.0 };
  const policyWithPrecedent = { ...policy, entries: { ...policy.entries, 'gather:oak_log': { ...policy.entries['gather:oak_log'], has_precedent: true, proficiency_count: 5, sum_reward: 2.5, prior_confidence: 0.5 } } };
  const lowResult = chooseCandidate([lowCommitmentCandidate], policyWithPrecedent);
  const neutralResult = chooseCandidate([neutralCommitmentCandidate], policyWithPrecedent);
  assert.ok(lowResult.ranked[0].score < neutralResult.ranked[0].score, 'expected the low-commitment macro to score lower than its neutral-commitment counterpart');
  assert.ok(Math.abs(lowResult.ranked[0].macroCommitmentMultiplier - macroEntry.macro_commitment) < 1e-9);
});

// 31) long macro mid-chain graceful interruption + per-step crediting: a
// 3-step macro whose step 2 requires becomes unmet right before it runs
// must credit step 1 as genuinely completed, stop at step 2 with a
// macro_break_at/macro_break_reason, and NEVER attempt step 3.
test('macro_executor.executeChosenSteps: a 3-step macro credits step 1, interrupts cleanly at step 2 with macro_break_at, and never runs step 3', async () => {
  const { executeChosenSteps } = await import('./macro_executor.mjs');

  const calls = [];
  const makeFakeTool = name => ({
    name,
    execute: async (decisionId, args) => {
      calls.push({ tool: name, decisionId, args });
      return { isError: false, content: [{ type: 'text', text: 'ok' }] };
    },
  });
  const gameTools = [makeFakeTool('gather'), makeFakeTool('craft'), makeFakeTool('place')];

  const fakeBot = { game: { dimension: 'overworld' } };
  const fakeObserve = async () => ({
    state: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: { items: [] }, blocks: [], entities: [] },
  });
  // After step 1, the freshly re-observed state is missing the inventory
  // item step 2 requires (cobblestone) — a real drift (e.g. the gathered
  // block never actually landed in inventory) that step 2's own
  // requires-precheck must catch BEFORE calling the real tool.
  const liveNormalizedState = async () => ({
    pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, dimension: 'overworld', inventory: {}, nearbyBlocks: [], nearbyHostiles: 0,
  });

  const chosen = {
    key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }],
    steps: [
      { key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] },
      { key: 'gather:cobblestone', tool: 'gather', args: { block: 'cobblestone', count: 1 }, requires: [{ inv: 'wooden_pickaxe', count: 1 }], ensures: [{ inv: 'cobblestone', count: 1 }] },
      { key: 'craft:stone_pickaxe', tool: 'craft', args: { item: 'stone_pickaxe', count: 1 }, requires: [{ inv: 'cobblestone', count: 1 }], ensures: [{ inv: 'stone_pickaxe', count: 1 }] },
    ],
  };

  const result = await executeChosenSteps({ bot: fakeBot, observe: fakeObserve, gameTools, chosen, decisionId: 'd1', overrideCap: null, liveNormalizedState });

  assert.equal(result.ok, false, 'expected the overall macro to report failure since it never fully completed');
  assert.equal(result.stepsCompleted, 1, 'expected step 1 to be credited as genuinely completed');
  assert.equal(result.stepsTotal, 3);
  assert.equal(result.breakAt, 2, 'expected the interruption to be attributed to step 2');
  assert.equal(result.breakReason, 'requires_unmet');
  assert.equal(result.code, 'macro_step_2_requires_unmet');
  assert.deepEqual(result.completedStepKeys, ['gather:oak_log'], 'expected step 1\'s own key recorded as completed');
  assert.deepEqual(calls.map(c => c.tool), ['gather'], 'expected step 2 (craft/gather cobblestone) and step 3 (craft stone_pickaxe) to NEVER be called');
});

// --- Final task-round (收官轮) additions: 5 tests below ---------------------

// 23) Wiki-prior cold-start + native override (task 1) ----------------------
test('wiki priors seed stitched_macros on a true cold start, and a native macro overtakes the prior for the same key', () => {
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(splitsPath, JSON.stringify([{ id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] }]));

  // Cold start: streamPath is completely empty (totalRounds === 0) -> the
  // wiki_prior macros must be injected into stitched_macros.
  const coldSummary = runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath });
  assert.equal(coldSummary.stitchedMacroCount > 0, true, 'expected wiki_prior macros to be seeded on a true cold start');
  const coldPolicy = readPolicyTable(policyPath);
  const priorMacro = coldPolicy.stitched_macros.find(m => m.source === 'wiki_prior' && m.key === 'gather:wood_log');
  assert.ok(priorMacro, 'expected a wiki_prior macro for gather:wood_log to be present after cold start');
  assert.ok(Array.isArray(priorMacro.steps) && priorMacro.steps.length >= 2, 'expected the wiki_prior macro to carry its full multi-step chain');

  // A cold-re-read via candidates.mjs must be able to offer it as a
  // source:'stitched' candidate once its own requires are met (empty
  // requires for the wood_log prior).
  const state = normalizeObsState({ position: { x: 0, y: 64, z: 0 }, inventory: { items: [] }, blocks: [], entities: [] });
  const candidates = enumerateCandidates(state, { stitchedMacros: coldPolicy.stitched_macros });
  const offered = candidates.find(c => c.key === 'gather:wood_log' && c.source === 'stitched');
  assert.ok(offered, 'expected the wiki_prior gather:wood_log macro to be offered as a stitched candidate');

  // Now simulate the prior LOSING repeatedly (fails every time it's tried)
  // while a NATIVE gather:wood_log single-step action succeeds and
  // advances the route — the native extraction must appear, and once it
  // does, mergeWikiPriorsColdStart() must stop re-injecting the prior for
  // that same key on any LATER pass (cold start already happened once).
  append({ decision_id: 'n0', time: Date.now(), state: { inventory: {}, dimension: 'overworld' }, cur_idx: -1, next_split: 'wood', proposed: 'gather:wood_log', chosen_spec: { id: 'gather:oak_log', key: 'gather:wood_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] }, candidates: [], directionDeviated: false }, streamPath);
  append({ decision_id: 'n0', time: Date.now(), chosen: 'gather:wood_log', chosen_id: 'gather:oak_log', result: { ok: true, code: 'ok' } }, streamPath);
  append({ decision_id: 'n1', time: Date.now(), state: { inventory: { oak_log: 1 }, dimension: 'overworld' }, cur_idx: 0, next_split: null, proposed: 'craft:oak_planks', chosen_spec: { id: 'craft:oak_planks', key: 'craft:oak_planks', tool: 'craft', args: { item: 'oak_planks', count: 4 }, requires: [{ inv: 'oak_log', count: 1 }], ensures: [{ inv: 'oak_planks', count: 4 }] }, candidates: [], directionDeviated: false }, streamPath);

  const laterSummary = runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath });
  const laterPolicy = readPolicyTable(policyPath);
  const nativeMacro = laterPolicy.stitched_macros.find(m => m.key === 'gather:wood_log' && m.source !== 'wiki_prior');
  assert.ok(nativeMacro, 'expected a native (non-wiki_prior) macro for gather:wood_log to appear once real history exists');
  const stillPrior = laterPolicy.stitched_macros.find(m => m.key === 'gather:wood_log' && m.source === 'wiki_prior');
  assert.equal(stillPrior, undefined, 'expected the wiki_prior for the same key to no longer be offered once a native macro exists for it');
  assert.equal(laterSummary.cur_idx, 0);
});

// 24) Whole-package total shortage drives gather count (task 1) -------------
test('recipe_planner.computeTotalShortage reports >= 3 oak_log for an empty-inventory wooden_pickaxe target, and candidates.mjs sizes gather:wood_log to it', async () => {
  const { computeTotalShortage } = await import('./recipe_planner.mjs');
  const shortage = computeTotalShortage('wooden_pickaxe', 1, {}, [], null);
  assert.ok(Number.isFinite(shortage.oak_log) && shortage.oak_log >= 3, `expected oak_log shortage >= 3, got ${JSON.stringify(shortage)}`);

  // candidates.mjs: an empty-inventory bot standing next to an oak tree,
  // with wooden_pickaxe as the current progression target, must offer a
  // gather:wood_log candidate whose args.count reflects that shortage,
  // capped at GATHER_COUNT_CAP. Root-cause repair round lowered the cap
  // from 4 to 2 (real log evidence: a count:3 gather call legitimately
  // took 21s and got cut off mid-way by the count-scaled timeout) — this
  // assertion follows that same cap rather than hardcoding the old value,
  // since computeTotalShortage()'s raw shortage (still >= 3, asserted
  // above) is always MEANT to be clamped down to whatever
  // GATHER_COUNT_CAP currently is.
  const state = normalizeObsState({ position: { x: 0, y: 64, z: 0 }, inventory: { items: [] }, blocks: [{ name: 'oak_log', position: { x: 1, y: 64, z: 0 } }], entities: [] });
  const candidates = enumerateCandidates(state, {});
  const gatherCandidate = candidates.find(c => c.key === 'gather:wood_log');
  assert.ok(gatherCandidate, 'expected a gather:wood_log candidate to be offered');
  assert.ok(gatherCandidate.args.count >= 1, `expected gather:wood_log args.count >= 1, got ${gatherCandidate.args.count}`);
  assert.ok(gatherCandidate.args.count <= 2, 'expected gather:wood_log args.count to respect the current GATHER_COUNT_CAP of 2');
});

// 25) Slot re-binding + half-way skip (task 2) -------------------------------
test('stitched macro slot re-binding adapts a non-oak species, and half-way skip bypasses an already-satisfied leading step', () => {
  // The recorded macro was lifted from an OAK run (steps named for
  // oak_log/oak_planks), but the CURRENT state has only BIRCH visible and
  // the planks step's own goal (4 oak_planks) is already satisfied by an
  // unrelated earlier action — both must be corrected live:
  //   - step 1 (gather oak_log) must be re-bound to birch_log, the
  //     species actually visible nearby;
  //   - step 2 (craft oak_planks) has its ensures already met by the
  //     current inventory (4 oak_planks already held) and must be SKIPPED,
  //     landing the effective candidate on step 3 (place crafting_table)
  //     instead, re-bound to the currently-held species where relevant.
  const macro = {
    id: 'stitched_chain:gather:wood_log->craft:wood_planks->place:crafting_table',
    key: 'gather:wood_log',
    tool: 'gather',
    args: { block: 'oak_log', count: 1 },
    requires: [],
    ensures: [{ inv: 'oak_log', count: 1 }],
    steps: [
      { key: 'gather:wood_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] },
      { key: 'craft:wood_planks', tool: 'craft', args: { item: 'oak_planks', count: 4 }, requires: [{ inv: 'oak_log', count: 1 }], ensures: [{ inv: 'oak_planks', count: 4 }] },
      { key: 'place:crafting_table', tool: 'place', args: { block: 'crafting_table', relativePlacement: true }, requires: [{ inv: 'crafting_table', count: 1 }], ensures: [] },
    ],
  };
  const state = normalizeObsState({
    position: { x: 10, y: 64, z: 10 },
    inventory: { items: [{ name: 'oak_log', count: 1 }, { name: 'oak_planks', count: 4 }, { name: 'crafting_table', count: 1 }] },
    blocks: [{ name: 'birch_log', position: { x: 11, y: 64, z: 10 } }],
    entities: [],
  });
  const candidates = enumerateCandidates(state, { stitchedMacros: [macro] });
  const offered = candidates.find(c => c.id === macro.id);
  assert.ok(offered, 'expected the macro to still be offered (its top-level requires are empty)');
  // Half-way skip: the effective first step must be place:crafting_table,
  // not gather:wood_log — both leading steps (gather+craft) had their
  // ensures already satisfied by the current state.
  assert.equal(offered.key, 'place:crafting_table', 'expected half-way skip to land on step 3 (place), skipping the already-satisfied gather+craft steps');
  assert.equal(offered.tool, 'place');

  // Slot re-binding, exercised directly on a macro whose leading step is
  // NOT yet satisfied (so it is not skipped) and whose species must be
  // rebound live: an empty inventory + only birch visible.
  const freshState = normalizeObsState({
    position: { x: 10, y: 64, z: 10 },
    inventory: { items: [] },
    blocks: [{ name: 'birch_log', position: { x: 11, y: 64, z: 10 } }],
    entities: [],
  });
  const freshCandidates = enumerateCandidates(freshState, { stitchedMacros: [macro] });
  const freshOffered = freshCandidates.find(c => c.id === macro.id);
  assert.ok(freshOffered, 'expected the macro to be offered against the fresh (empty-inventory, birch-visible) state');
  assert.equal(freshOffered.args.block, 'birch_log', 'expected the gather step to be re-bound to the visible birch_log species, not the frozen oak_log recording');
});

// 26) Suspend/resume across an interruption, with ttl exhaustion (task 2) ---
test('a 4-step macro interrupted at step 2 resumes from step 2 after the emergency clears, and ttl exhaustion clears the arc', async () => {
  const { executeChosenSteps } = await import('./macro_executor.mjs');

  function makeFakeTool(name) {
    return { name, execute: async () => ({ isError: false, content: [{ type: 'text', text: 'ok' }] }) };
  }
  const gameTools = [makeFakeTool('gather'), makeFakeTool('craft'), makeFakeTool('place')];
  const fakeBot = { game: { dimension: 'overworld' }, entity: { position: { x: 0, y: 64, z: 0 } } };
  const fakeObserve = async () => ({ state: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: { items: [] }, blocks: [], entities: [] } });

  const steps = [
    { key: 'gather:wood_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] },
    { key: 'craft:wood_planks', tool: 'craft', args: { item: 'oak_planks', count: 4 }, requires: [{ inv: 'oak_log', count: 1 }], ensures: [{ inv: 'oak_planks', count: 4 }] },
    { key: 'craft:stick', tool: 'craft', args: { item: 'stick', count: 4 }, requires: [{ inv: 'oak_planks', count: 2 }], ensures: [{ inv: 'stick', count: 4 }] },
    { key: 'craft:wooden_pickaxe', tool: 'craft', args: { item: 'wooden_pickaxe', count: 1 }, requires: [{ inv: 'oak_planks', count: 3 }, { inv: 'stick', count: 2 }], ensures: [{ inv: 'wooden_pickaxe', count: 1 }] },
  ];

  // Round 1: a hostile appears right after step 1 completes -> the chain
  // must interrupt cleanly at step 2 with breakReason 'hostile_nearby'.
  const hostileLiveState = async () => ({
    pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, dimension: 'overworld', inventory: { oak_log: 1 }, nearbyBlocks: [], nearbyHostiles: 1,
  });
  const chosen = { key: 'gather:wood_log', tool: 'gather', args: steps[0].args, requires: [], ensures: [], steps };
  const interrupted = await executeChosenSteps({ bot: fakeBot, observe: fakeObserve, gameTools, chosen, decisionId: 'r1', overrideCap: null, liveNormalizedState: hostileLiveState });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.stepsCompleted, 1);
  assert.equal(interrupted.breakAt, 2);
  assert.equal(interrupted.breakReason, 'hostile_nearby');

  // Build the suspendedArc exactly as auto_loop.mjs's maintainSuspendedArc()
  // would from this outcome: nextStepIndex = breakAt - 1 = 1.
  let suspendedArc = { macroId: 'macro1', macroKey: 'gather:wood_log', nextStepIndex: interrupted.breakAt - 1, steps, spanToIdx: 4, ttl: 4 };

  // "flee" 1 round (an unrelated candidate runs — this does not touch the
  // chain at all; simulated by simply not resuming it this round and
  // decrementing ttl, same bookkeeping auto_loop.mjs's maintainSuspendedArc
  // applies to a round where the suspended arc was not the one chosen).
  suspendedArc = { ...suspendedArc, ttl: suspendedArc.ttl - 1 };
  assert.equal(suspendedArc.ttl, 3, 'expected ttl to decrement by 1 during the flee round');

  // Crisis resolved: enumerateCandidates() with the live suspendedArc must
  // offer a resume candidate starting at step 2 (index 1), carrying the
  // REMAINING 3 steps (craft planks -> craft stick -> craft pickaxe).
  const clearState = normalizeObsState({ position: { x: 0, y: 64, z: 0 }, inventory: { items: [{ name: 'oak_log', count: 1 }] }, blocks: [], entities: [] });
  const resumeCandidates = enumerateCandidates(clearState, { suspendedArc });
  const resumeCandidate = resumeCandidates.find(c => c.isResumeArc === true);
  assert.ok(resumeCandidate, 'expected a resume candidate to be offered while suspendedArc is still alive (ttl > 0)');
  assert.equal(resumeCandidate.key, 'gather:wood_log');
  assert.equal(resumeCandidate.tool, 'craft', 'expected the resume candidate to start at step 2 (craft planks), not restart at step 1');
  assert.equal(Array.isArray(resumeCandidate.steps) ? resumeCandidate.steps.length : 1, 3, 'expected the resume candidate to carry the 3 remaining steps');

  // Run the resume: steps 2-4 all succeed this time.
  const resumeLiveState = async () => ({
    pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, dimension: 'overworld', inventory: { oak_log: 1, oak_planks: 4, stick: 4 }, nearbyBlocks: [], nearbyHostiles: 0,
  });
  const resumeChosen = { key: resumeCandidate.key, tool: resumeCandidate.tool, args: resumeCandidate.args, requires: resumeCandidate.requires, ensures: resumeCandidate.ensures, steps: resumeCandidate.steps };
  const resumed = await executeChosenSteps({ bot: fakeBot, observe: fakeObserve, gameTools, chosen: resumeChosen, decisionId: 'r2', overrideCap: null, liveNormalizedState: resumeLiveState });
  assert.equal(resumed.ok, true, 'expected steps 2-4 to run and complete successfully on resume');
  assert.equal(resumed.stepsCompleted, 3);

  // ttl exhaustion: a FRESH suspendedArc whose ttl counts down to 0 (4
  // rounds of something else chosen instead) must stop being offered —
  // enumerateCandidates() itself does not inspect ttl, so this asserts the
  // caller-side "only pass it through while ttl > 0" contract auto_loop.mjs/
  // tools_adapter.mjs both implement.
  let ttlArc = { macroId: 'macro2', macroKey: 'gather:cobblestone', nextStepIndex: 1, steps: [{ key: 'gather:cobblestone', tool: 'gather', args: {}, requires: [], ensures: [] }, { key: 'craft:stone_pickaxe', tool: 'craft', args: {}, requires: [], ensures: [] }], spanToIdx: 5, ttl: 1 };
  ttlArc = { ...ttlArc, ttl: ttlArc.ttl - 1 };
  assert.equal(ttlArc.ttl, 0);
  const liveArcAfterExhaustion = ttlArc.ttl > 0 ? ttlArc : null;
  assert.equal(liveArcAfterExhaustion, null, 'expected the arc to be cleared once ttl reaches 0');
  const noResumeCandidates = enumerateCandidates(clearState, { suspendedArc: liveArcAfterExhaustion });
  assert.equal(noResumeCandidates.some(c => c.isResumeArc), false, 'expected no resume candidate once the arc is cleared by ttl exhaustion');
});

// 27) Granularity alignment + inter_episode mode + activePersona (task 3+4) -
test('a 4-step, 3s/step, 2-milestone-spanning chain fairly beats a single 2s step, and mode: "inter_episode" records episode_history with the given activePersona', async () => {
  // --- granularity alignment (task 3) ---------------------------------
  const streamPath = tmpFile('decisions.jsonl');
  const policyPath = tmpFile('policy_snapshot.json');
  const confirmPath = tmpFile('pending_confirm.jsonl');
  const splitsPath = tmpFile('splits.json');
  writeFileSync(splitsPath, JSON.stringify([
    { id: 'wood', label: 'Gather wood', conditions: [{ inv: 'oak_log', count: 1 }] },
    { id: 'planks', label: 'Make planks', conditions: [{ inv: 'oak_planks', count: 1 }] },
    { id: 'table', label: 'Craft table', conditions: [{ inv: 'crafting_table', count: 1 }] },
  ]));

  // A 4-step chain whose own recorded duration_ms is 12000 (3000ms/step
  // amortized) and which advances cur_idx by 2 milestones in one shot.
  const macroId = 'stitched_chain:chain4';
  append({ decision_id: 'c1', time: Date.now(), chosen: macroId, chosen_id: macroId, result: { ok: true, code: 'ok' }, duration_ms: 12000, macro_completed_steps: 4, macro_total_steps: 4 }, streamPath);

  const summary = runDeliberation({ stallK: 999, streamPath, splitsPath, policyPath, confirmPath });
  void summary;

  const chainCandidate = {
    id: macroId, key: macroId, tool: 'gather', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'stitched',
    steps: [1, 2, 3, 4].map(n => ({ key: `step${n}`, tool: 'gather', args: {}, requires: [], ensures: [] })),
    macro_commitment: 1.1, completion_rate: 1, span_from_idx: -1, span_to_idx: 1,
  };
  const singleStepCandidate = {
    id: 'gather:cobblestone', key: 'gather:cobblestone', tool: 'gather', args: {}, requires: [], ensures: [], isSafety: false, hitsNextSplit: false, source: 'atomic',
  };
  const policyForScoring = {
    ...defaultPolicyTable(),
    entries: {
      [macroId]: { weight: 1, prior_confidence: 0.75, proficiency_count: 5, has_precedent: true, sum_reward: 3.75 },
      'gather:cobblestone': { weight: 1, prior_confidence: 0.7, proficiency_count: 5, has_precedent: true, sum_reward: 3.5 },
    },
    total_rounds: 10,
  };
  const { chosen } = chooseCandidate([chainCandidate, singleStepCandidate], policyForScoring);
  assert.equal(chosen.id, macroId, 'expected the fairly-amortized, milestone-spanning 4-step chain to beat a comparable single step');

  // --- inter_episode mode + activePersona (task 4) --------------------
  const episodeResult = runDeliberation({
    stallK: 999,
    streamPath,
    splitsPath,
    policyPath,
    confirmPath,
    mode: 'inter_episode',
    activePersona: 'speedrunner',
    episodeMeta: { totalSteps: 18, finalCurIdx: 1, avgStepDurationMs: 2500, failureRate: 0.1, deathOrStuckReason: 'none' },
  });
  assert.equal(episodeResult.mode, 'inter_episode');
  assert.equal(episodeResult.episodeAppended, true);
  const finalPolicy = readPolicyTable(policyPath);
  assert.equal(finalPolicy.episode_history.length, 1);
  assert.equal(finalPolicy.episode_history[0].totalSteps, 18);
  assert.equal(finalPolicy.episode_history[0].activePersona, 'speedrunner', 'expected the given activePersona to be recorded on the episode_history entry, never silently reset');
  assert.equal(finalPolicy.active_persona, 'speedrunner', 'expected active_persona on the snapshot itself to also reflect the given persona');
});

// 28) Physical-result alignment check (final polish round) -----------------
test('executeChosenSteps flags aligned:false when a tool reports ok:true but its declared ensures never actually came true in the world', async () => {
  const { executeChosenSteps, checkAlignment } = await import('./macro_executor.mjs');

  // Pure checkAlignment() unit coverage first: a step that claims
  // {inv:'oak_log',count:1} but the after-state still shows 0 is a
  // confirmed mismatch; one that already held the item before the step
  // ran is aligned regardless; one with no ensures at all is always
  // aligned; one with no after-state at all is "unknown" (null), never a
  // false accusation.
  assert.equal(checkAlignment([{ inv: 'oak_log', count: 1 }], { inventory: {} }, { inventory: {} }), false);
  assert.equal(checkAlignment([{ inv: 'oak_log', count: 1 }], { inventory: {} }, { inventory: { oak_log: 1 } }), true);
  assert.equal(checkAlignment([{ inv: 'oak_log', count: 1 }], { inventory: { oak_log: 1 } }, { inventory: {} }), true);
  assert.equal(checkAlignment([], { inventory: {} }, { inventory: {} }), true);
  assert.equal(checkAlignment([{ inv: 'oak_log', count: 1 }], { inventory: {} }, null), null);

  // End-to-end through executeChosenSteps(): a fake 'gather' tool that
  // always reports ok:true (isError: false) no matter what, but the
  // world's own inventory never actually gains oak_log — models a
  // despawned-block/server-desync "假成功".
  function makeFakeTool(name) {
    return { name, execute: async () => ({ isError: false, content: [{ type: 'text', text: 'ok' }] }) };
  }
  const gameTools = [makeFakeTool('gather')];
  const fakeBot = { game: { dimension: 'overworld' }, entity: { position: { x: 0, y: 64, z: 0 } } };
  const fakeObserve = async () => ({ state: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: { items: [] }, blocks: [], entities: [] } });
  // liveNormalizedState always reports an EMPTY inventory, no matter how
  // many times it's called — the tool "succeeded" but oak_log never
  // actually appeared.
  const staleLiveState = async () => ({
    pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, dimension: 'overworld', inventory: {}, nearbyBlocks: [], nearbyHostiles: 0,
  });

  const chosen = { key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] };
  const result = await executeChosenSteps({ bot: fakeBot, observe: fakeObserve, gameTools, chosen, decisionId: 'align1', overrideCap: null, liveNormalizedState: staleLiveState });

  assert.equal(result.ok, true, 'expected the tool-reported success to still be ok:true (alignment is diagnostic, never a new failure mode)');
  assert.equal(result.aligned, false, 'expected the overall aligned flag to catch the false success');
  assert.deepEqual(result.alignmentResults, [false]);

  // Contrast: a REAL success where the after-state genuinely shows the
  // claimed oak_log must report aligned:true, not merely "not false".
  const realLiveState = async () => ({
    pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, dimension: 'overworld', inventory: { oak_log: 1 }, nearbyBlocks: [], nearbyHostiles: 0,
  });
  const realResult = await executeChosenSteps({ bot: fakeBot, observe: fakeObserve, gameTools, chosen, decisionId: 'align2', overrideCap: null, liveNormalizedState: realLiveState });
  assert.equal(realResult.ok, true);
  assert.equal(realResult.aligned, true, 'expected a genuinely matching after-state to report aligned:true');
});

// --- Root-cause repair round: terrain-aware explore/place, partial gather,
//     drops-missed downgrade, no-flee-without-hostile ----------------------

// 29) Ground-block-aware exploration ----------------------------------------
test('enumerateCandidates: move:explore_* targets a REAL observed ground block in that direction, not a blind same-y offset', () => {
  // Bot standing at (0,100,0) on a floating/elevated platform with no
  // production target visible — real ground is far BELOW (y=64) and
  // slightly east, exactly the kind of mismatch that produced real
  // "No route exists"/"stuck jumping in place" go_to failures on
  // hilly terrain: a blind `y: Math.floor(s.pos.y)` target (old
  // behavior) would aim at y=100 going east, floating in mid-air, while
  // the real ground block sits at y=64.
  const state = normalizeObsState({
    position: { x: 0, y: 100, z: 0 },
    inventory: { items: [] },
    blocks: [{ name: 'stone', position: { x: 8, y: 64, z: 0 } }], // due east, real ground
    entities: [],
  });
  const candidates = enumerateCandidates(state, {});
  const exploreEast = candidates.find(c => c.key === 'move:explore_e');
  assert.ok(exploreEast, 'expected a move:explore_e candidate to be offered');
  assert.equal(exploreEast.args.x, 8, 'expected the explore_e target x to match the real observed ground block, not a blind +10 offset');
  assert.equal(exploreEast.args.y, 65, 'expected the explore_e target y to be ONE ABOVE the real ground block (64+1=65), never the blind Math.floor(s.pos.y)=100');
  assert.equal(exploreEast.args.z, 0);

  // A direction with NO observed ground block (north, nothing provided)
  // must still fall back to the old flat-y heuristic rather than being
  // withheld entirely — this is purely an upgrade, never a new way to
  // lose a direction.
  const exploreNorth = candidates.find(c => c.key === 'move:explore_n');
  assert.ok(exploreNorth, 'expected move:explore_n to still be offered via the flat-y fallback when nothing ground-like was observed that way');
  assert.equal(exploreNorth.args.y, 100, 'expected the fallback formula (Math.floor(s.pos.y)) when no real ground block was observed in that direction');
});

test('enumerateCandidates: place:crafting_table targets a REAL nearby ground block instead of a blind "+1 x, same y" offset', () => {
  const state = normalizeObsState({
    position: { x: 0, y: 70, z: 0 },
    inventory: { items: [{ name: 'crafting_table', count: 1, slot: 0 }] },
    // Real ground is 2 blocks below the bot's feet (e.g. standing on an
    // overhang) — the OLD "same y as bot" formula would try to place the
    // table floating at y=70, which the real `place` tool rejects with
    // "No solid block touches ..., so it needs a support".
    blocks: [{ name: 'grass_block', position: { x: 1, y: 68, z: 0 } }],
    entities: [],
  });
  const candidates = enumerateCandidates(state, {});
  const place = candidates.find(c => c.key === 'place:crafting_table');
  assert.ok(place, 'expected a place:crafting_table candidate to be offered');
  assert.equal(place.args.x, 1);
  assert.equal(place.args.y, 69, 'expected the target cell to sit ONE ABOVE the real ground block (68+1=69), never the blind same-y-as-bot (70) formula');
  assert.equal(place.args.z, 0);
});

// 30) Partial-gather credit on a productive timeout -------------------------
test('macro_executor.executeChosenSteps: a gather step that times out but already gained inventory is credited ok:true, code:partial_gather', async () => {
  const { executeChosenSteps } = await import('./macro_executor.mjs');

  // Fake gather tool that always "times out" (throws the exact error
  // shape runToolWithAbort() produces) — but the fake liveNormalizedState
  // below reports the inventory already went up by the time this fires,
  // modeling the real log evidence: gather(count:2) genuinely mined 1-2
  // logs before the outer timeout fired.
  function makeFakeTool(name) {
    return {
      name,
      execute: async () => {
        throw new Error('gather timed out after 16000ms');
      },
    };
  }
  const gameTools = [makeFakeTool('gather')];
  const fakeBot = { game: { dimension: 'overworld' }, entity: { position: { x: 0, y: 64, z: 0 } } };
  const fakeObserve = async () => ({ state: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: { items: [] }, blocks: [], entities: [] } });
  // Before this step ran, the bot held 0 oak_log (no prior step in this
  // single-step chain -> lastKnownState is null, so beforeCount reads as
  // null/0 via the `?? null` chain in macro_executor.mjs — the AFTER
  // re-observe below is what actually proves the gain).
  const afterTimeoutState = async () => ({
    pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, dimension: 'overworld', inventory: { oak_log: 1 }, nearbyBlocks: [], nearbyHostiles: 0,
  });

  const chosen = { key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 2 }, requires: [], ensures: [{ inv: 'oak_log', count: 2 }] };
  const result = await executeChosenSteps({ bot: fakeBot, observe: fakeObserve, gameTools, chosen, decisionId: 'partial1', overrideCap: null, liveNormalizedState: afterTimeoutState });

  assert.equal(result.ok, true, 'expected a timed-out-but-productive gather to be credited ok:true, not blamed as a flat failure');
  assert.equal(result.stepsCompleted, 1);

  // Contrast: a timeout with ZERO inventory gain must still fail normally
  // (this is the genuinely-stuck case, e.g. drops lost in leaves — not
  // worth crediting).
  const noGainState = async () => ({
    pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, dimension: 'overworld', inventory: {}, nearbyBlocks: [], nearbyHostiles: 0,
  });
  const failResult = await executeChosenSteps({ bot: fakeBot, observe: fakeObserve, gameTools, chosen, decisionId: 'partial2', overrideCap: null, liveNormalizedState: noGainState });
  assert.equal(failResult.ok, false, 'expected a timeout with zero inventory gain to still fail normally, not be falsely credited');
  assert.equal(failResult.stepsCompleted, 0);
});

// 31) Drops-missed downgrade: a tool-reported ok:true with zero real gain
//     must never be credited as a full success ------------------------------
test('macro_executor.executeChosenSteps: a gather tool reporting dropsMissed (ok:true but zero inventory gain) downgrades to ok:false, code:drops_missed', async () => {
  const { executeChosenSteps } = await import('./macro_executor.mjs');

  // Models the REAL src/tools/game/gathering.js response shape exactly:
  // isError:false (the tool call itself did not throw) but the response
  // text explicitly carries the tool's own dropsMissed marker because the
  // mined block's drops never reached the inventory (stuck in
  // leaves/water/out of reach) — a confirmed false success the tool
  // itself already flags, not merely this module's own alignment guess.
  function makeFakeTool(name) {
    return {
      name,
      execute: async () => ({
        isError: false,
        content: [{ type: 'text', text: JSON.stringify({ mined: 1, requested: 1, dropsMissed: 'Mined blocks but no drops reached your inventory; they may be stuck in leaves, water or out of reach.' }) }],
      }),
    };
  }
  const gameTools = [makeFakeTool('gather')];
  const fakeBot = { game: { dimension: 'overworld' }, entity: { position: { x: 0, y: 64, z: 0 } } };
  const fakeObserve = async () => ({ state: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: { items: [] }, blocks: [], entities: [] } });
  const liveNormalizedState = async () => ({
    pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, dimension: 'overworld', inventory: {}, nearbyBlocks: [], nearbyHostiles: 0,
  });

  const chosen = { key: 'gather:oak_log', tool: 'gather', args: { block: 'oak_log', count: 1 }, requires: [], ensures: [{ inv: 'oak_log', count: 1 }] };
  const result = await executeChosenSteps({ bot: fakeBot, observe: fakeObserve, gameTools, chosen, decisionId: 'drops1', overrideCap: null, liveNormalizedState });

  assert.equal(result.ok, false, 'expected a tool-confirmed dropsMissed response to be downgraded to ok:false, never a blind full success');
  assert.equal(result.code, 'drops_missed');
  assert.equal(result.stepsCompleted, 0, 'expected the drops-missed step itself to NOT be credited as completed');
});

// 32) No flee without an actual nearby hostile -------------------------------
test('enumerateCandidates: low health with ZERO nearby hostiles never offers flee:low_health (eat is the available safety response instead)', () => {
  // Real log evidence: flee:low_health was repeatedly offered/chosen with
  // nearbyHostiles===0, and the REAL flee tool rejected every call with
  // "Nothing has hurt you recently and no hostile is within 16 blocks" —
  // pure wasted rounds this candidate should never have been able to win.
  const lowHealthNoThreat = normalizeObsState({
    position: { x: 0, y: 64, z: 0 },
    health: 4,
    food: 20,
    inventory: { items: [] },
    blocks: [],
    entities: [], // no hostiles at all
  });
  const candidatesNoThreat = enumerateCandidates(lowHealthNoThreat, {});
  assert.equal(candidatesNoThreat.find(c => c.id === 'flee:low_health'), undefined, 'expected flee:low_health to be withheld entirely when nearbyHostiles is 0');

  // Contrast: the SAME low health WITH a real nearby hostile must still
  // offer flee:low_health exactly as before — this fix only removes the
  // false-positive case, never the genuine one.
  const lowHealthWithThreat = normalizeObsState({
    position: { x: 0, y: 64, z: 0 },
    health: 4,
    food: 20,
    inventory: { items: [] },
    blocks: [],
    entities: [{ name: 'zombie', position: { x: 2, y: 64, z: 0 } }],
  });
  const candidatesWithThreat = enumerateCandidates(lowHealthWithThreat, {});
  assert.ok(candidatesWithThreat.find(c => c.id === 'flee:low_health'), 'expected flee:low_health to still be offered when a real hostile is within range');

  // Low food + no hostile: `eat` must still be offered as the actually-
  // available safety response for this case (unaffected by this fix,
  // asserted here for completeness).
  const lowFoodNoThreat = normalizeObsState({
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 4,
    inventory: { items: [{ name: 'cooked_beef', count: 1, slot: 0 }] },
    blocks: [],
    entities: [],
  });
  const candidatesLowFood = enumerateCandidates(lowFoodNoThreat, {});
  assert.ok(candidatesLowFood.find(c => c.key === 'eat'), 'expected eat to be offered as the available safety response when food is low and there is no hostile to flee from');
});

// --- claim_bridge.mjs (agent-claim-memory integration) --------------------

test('claim_bridge: area pitfall recorded in one chunk persists cross-instance recall, and is scoped only to that chunk', async () => {
  const dataDir = tmpFile('claim-memory-data');

  // "Episode 1": record a pitfall after a run of failures in chunk_1_0.
  const bridgeEpisode1 = await createClaimBridge({ dataDir, namespace: 'brain-test' });
  assert.equal(bridgeEpisode1.available, true, 'expected the real sibling agent-claim-memory SDK to load in this dev checkout');

  const chunkKey = chunkKeyFor(20, 5); // -> chunk_1_0
  assert.equal(chunkKey, 'chunk_1_0');

  const record = await bridgeEpisode1.recordAreaPitfall({
    chunkKey,
    reason: 'repeated_timeout:move:explore_e',
    ref: 'episode1-decision-7',
  });
  assert.equal(record.recorded, true);
  assert.ok(record.block_id);

  // "Episode 2": a BRAND NEW createClaimBridge() instance (simulating a
  // fresh process / new auto_loop.mjs run / new LLM conversation) pointed
  // at the SAME dataDir must still recall the warning — this is the whole
  // point of cross-episode persistence, as opposed to auto_loop.mjs's own
  // purely in-memory recentFailures map which resets every process.
  const bridgeEpisode2 = await createClaimBridge({ dataDir, namespace: 'brain-test' });
  const recalled = await bridgeEpisode2.recallAreaWarnings(chunkKey);
  assert.equal(recalled.warnings.length, 1);
  assert.match(recalled.warnings[0], /chunk_1_0/);
  assert.match(recalled.warnings[0], /repeated_timeout/);

  // Exercise the SAME soft-penalty merge auto_loop.mjs/tools_adapter.mjs
  // perform: an explore candidate targeting the SAME (still risky) chunk
  // gets pushed down via recentFailures, a candidate targeting a
  // DIFFERENT, unrelated chunk (chunk_5_5) must be completely untouched.
  const candidatesHere = [
    { key: 'move:explore_e', source: 'explore', args: { x: 25, z: 5 } }, // stays inside chunk_1_0
    { key: 'move:explore_n', source: 'explore', args: { x: 20, z: 10 } }, // also stays inside chunk_1_0
  ];
  const recentFailures = {};
  const { warnings: hereWarnings } = await bridgeEpisode2.recallAreaWarnings(chunkKey);
  assert.ok(hereWarnings.length > 0);
  for (const c of candidatesHere) {
    const targetChunk = chunkKeyFor(c.args.x, c.args.z);
    if (targetChunk === chunkKey) recentFailures[c.key] = (recentFailures[c.key] ?? 0) + 1;
  }
  assert.equal(recentFailures['move:explore_e'], 1, 'expected the same-chunk candidate to receive the soft pitfall penalty');

  // A candidate whose target lands in an UNRELATED chunk (chunk_5_5, far
  // away) must never be touched by chunk_1_0's own pitfall memory.
  const recentFailuresOtherChunk = {};
  const unrelatedCandidate = { key: 'move:explore_s', source: 'explore', args: { x: 85, z: 85 } }; // -> chunk_5_5
  assert.equal(chunkKeyFor(85, 85), 'chunk_5_5');
  const { warnings: otherWarnings } = await bridgeEpisode2.recallAreaWarnings('chunk_5_5');
  assert.equal(otherWarnings.length, 0, 'expected chunk_5_5 to have zero pitfall warnings of its own');
  const otherTargetChunk = chunkKeyFor(unrelatedCandidate.args.x, unrelatedCandidate.args.z);
  if (otherTargetChunk === chunkKey) recentFailuresOtherChunk[unrelatedCandidate.key] = 1;
  assert.equal(recentFailuresOtherChunk['move:explore_s'], undefined, 'expected chunk_5_5 candidate to be completely unaffected by chunk_1_0 pitfall memory');

  // resolvePitfall() calls the SDK's own verifyClaim(ok:true), which is an
  // auditable "this held up" reinforcement (raises confidence/utility via
  // the ledger), NOT a delete — an 'active' pitfall claim stays 'active'
  // and still recalls (the SDK deliberately keeps the history auditable;
  // see adjudicator.mjs's verifyClaim doc comment). What resolvePitfall()
  // must do is never throw, and must genuinely reach the ledger: confirm
  // via getLedger() that the verify_ok entry was actually appended.
  const beforeResolve = await bridgeEpisode2.resolvePitfall(record.block_id, { ref: 'episode2-decision-3' });
  assert.equal(beforeResolve.resolved, true);
  const ledger = await bridgeEpisode2.recallAreaWarnings(chunkKey);
  assert.equal(ledger.warnings.length, 1, 'expected the reinforced pitfall to still be recallable (verify is reinforcement, not deletion)');
  assert.equal(ledger.pitfallClaims[0].confidence > 0.7, true, 'expected verify(ok:true) to have raised confidence above its initial 0.7');
});

test('claim_bridge: missing sibling agent-claim-memory checkout degrades to a safe no-op, never throws', async () => {
  const dataDir = tmpFile('claim-memory-data-degraded');
  const bridge = await createClaimBridge({
    dataDir,
    namespace: 'brain-test',
    sdkSpecifier: '../../../this-directory-does-not-exist-anywhere/src/memory_sdk.mjs',
  });

  assert.equal(bridge.available, false);
  assert.ok(typeof bridge.reason === 'string' && bridge.reason.length > 0);

  // Every method must still resolve (never reject/throw) to its documented
  // empty/no-op shape, so auto_loop.mjs/tools_adapter.mjs never need an
  // `if (bridge.available)` guard before calling through.
  const recorded = await bridge.recordAreaPitfall({ chunkKey: 'chunk_1_0', reason: 'x', ref: 'r' });
  assert.equal(recorded.recorded, false);

  const recalled = await bridge.recallAreaWarnings('chunk_1_0');
  assert.deepEqual(recalled.warnings, []);
  assert.deepEqual(recalled.pitfallClaims, []);

  const resolved = await bridge.resolvePitfall('some-block-id');
  assert.equal(resolved.resolved, false);

  const digest = await bridge.compileConstraintsForPrompt({ chunkKey: 'chunk_1_0' });
  assert.deepEqual(digest.lines, []);
  assert.equal(digest.text, '');
});
