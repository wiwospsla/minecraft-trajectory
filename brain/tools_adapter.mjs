// brain/tools_adapter.mjs — the LLM-facing seam between the harness's
// body/session layer (src/tools/extra-tools.js's createTools contract) and
// the brain's environment A / environment B split.
//
// This is where the physical isolation rule gets enforced end to end:
//   - brain_next_step reads bot state live, reads policy_snapshot.json
//     (read-only, via policy_table.readPolicyTable), enumerates candidates,
//     and calls decide.chooseCandidate — it NEVER recomputes from
//     decisions.jsonl history.
//   - brain_record_outcome is the only place here that writes to
//     decisions.jsonl (via stream.append), and periodically (every 5
//     recorded outcomes) triggers environment B's runDeliberation() to
//     atomically refresh policy_snapshot.json for the NEXT brain_next_step
//     call — never synchronously inside the same decision.
//
// Exports a default `createTools({ bot, name, schema })` per
// src/tools/extra-tools.js's loadToolsModule contract, so this file can be
// passed directly as --tools-module to the existing CLI/agent, unmodified.

import { createObservation } from './../src/tools/game/observation.js';
import { schema as defaultSchema } from './../src/tools/extra-tools.js';
import * as perception from './../src/skills/perception.js';
import * as world from './../src/skills/world.js';

import { normalizeObsState, enumerateCandidates, computeStateBucket } from './candidates.mjs';
import { chooseCandidate } from './decide.mjs';
import { readPolicyTable, POLICY_PATH } from './policy_table.mjs';
import { evaluate } from './wiki.mjs';
import { append, LOG_PATH } from './stream.mjs';
import { logDeviation } from './log.mjs';
import { runDeliberation } from './deliberate.mjs';
import { resolvePersona, DEFAULT_PERSONA_NAME } from './persona.mjs';
import { getDefaultClaimBridge, chunkKeyFor } from './claim_bridge.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPLITS_PATH = join(__dirname, 'splits.json');

function readSplits() {
  try {
    return JSON.parse(readFileSync(SPLITS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Read the bot's current state directly (no recipe/history reads) and
 * normalize it into the flat shape candidates.mjs expects, including
 * `dimension` merged in from `bot.game.dimension` — the one piece
 * createObservation() does not already carry (see candidates.mjs's doc
 * comment on normalizeObsState for why that merge happens here and not
 * inside the pure normalizer).
 */
async function liveNormalizedState(bot, observe) {
  // range: 48 — see 64 in observation.js's own 1..64 bound. The default 16
  // is often too short to see any loggable tree or exposed stone from
  // spawn, which previously left candidates.mjs with nothing to offer.
  const { state } = await observe({ image: false, range: 48 });
  const rawDimension = bot.game?.dimension;
  const dimension = typeof rawDimension === 'string' ? rawDimension.replace(/^minecraft:/, '') : null;
  return normalizeObsState({ ...state, dimension });
}

let decisionCounter = 0;
let outcomesSinceDeliberation = 0;
const DELIBERATION_EVERY_N_OUTCOMES = 5;

// In-memory-only, per-process short-term failure cooldown (see decide.mjs's
// `recentFailures` option): candidate id/key -> consecutive fail count THIS
// RUN. Never persisted to decisions.jsonl/policy_snapshot.json.
const recentFailures = {};

// In-memory-only, per-process "what did we choose last round" context (see
// decide.mjs's `lastChosenKey` option / persona.momentum_bonus) — never
// persisted to decisions.jsonl/policy_snapshot.json either.
let lastChosenKey = null;

// Suspend/resume (task 2): same in-memory-only, per-process pointer
// auto_loop.mjs's own `suspendedArc` carries, adapted to this file's very
// different execution shape — the LLM calling brain_next_step/
// brain_record_outcome itself runs each real game tool call, there is no
// local executeChosenSteps() loop here to report a precise "broke at step
// k" breakdown the way auto_loop.mjs's outcome.breakAt does. Instead: a
// multi-step macro candidate (chosen.steps.length > 1) whose outcome comes
// back ok:false is treated as suspended starting at nextStepIndex: 0 —
// conservative on purpose, since this file genuinely cannot tell which
// step the LLM was actually attempting when it reported failure, so the
// safest resume point is "start this arc's own ensures-already-satisfied
// skip logic over from the top" (candidates.mjs's enumerateCandidates()
// suspendedArc handling already skips any LEADING step whose ensures
// happen to already be met — see its own doc comment — so a resume that
// starts at index 0 still naturally fast-forwards past whatever actually
// did succeed before the break, without this file having to guess exactly
// where that was).
let suspendedArc = null;
const SUSPENDED_ARC_INITIAL_TTL = 4;

// --- claim_bridge.mjs integration (optional, degrades to no-op) --------
// Same contract as auto_loop.mjs's identical block: merges persisted
// cross-episode pitfall warnings into THIS process's recentFailures map
// (never touches decide.mjs/candidates.mjs directly), and separately
// surfaces an LLM-facing anti-compaction digest alongside
// brain_next_step's normal response. See claim_bridge.mjs's own doc
// comment for the full rationale; see auto_loop.mjs for the identical
// chunk-fail-count -> recordAreaPitfall()/resolvePitfall() bookkeeping,
// duplicated here rather than shared because this file's execution shape
// (LLM calls brain_next_step, then separately calls
// brain_record_outcome) has no single `runStep()` function to hang a
// shared helper off of the way auto_loop.mjs does.
let claimBridgePromise = null;
function getClaimBridge() {
  if (!claimBridgePromise) claimBridgePromise = getDefaultClaimBridge();
  return claimBridgePromise;
}

const chunkFailCounts = {};
const chunkPitfallBlockIds = {};
const PITFALL_FAIL_THRESHOLD = 2;
const PITFALL_RECALL_PENALTY_COUNT = 1;

async function applyAreaPitfallRecall(bridge, state, candidates, recentFailures) {
  if (!bridge?.available || !state?.pos) return;
  const here = chunkKeyFor(state.pos.x, state.pos.z);
  if (!here) return;
  try {
    const { warnings } = await bridge.recallAreaWarnings(here);
    if (!warnings.length) return;
    for (const c of candidates) {
      const cx = Number.isFinite(c.args?.x) ? c.args.x : null;
      const cz = Number.isFinite(c.args?.z) ? c.args.z : null;
      const targetChunk = chunkKeyFor(cx, cz);
      if (targetChunk && targetChunk === here && c.source === 'explore') {
        recentFailures[c.key] = (recentFailures[c.key] ?? 0) + PITFALL_RECALL_PENALTY_COUNT;
      }
    }
  } catch {
    // Best-effort only: never block brain_next_step's main response.
  }
  return here;
}

async function updateAreaPitfallMemory(bridge, chosen, ok, decisionId) {
  if (!bridge?.available || !chosen) return;
  const x = Number.isFinite(chosen.args?.x) ? chosen.args.x : null;
  const z = Number.isFinite(chosen.args?.z) ? chosen.args.z : null;
  const chunkKey = chunkKeyFor(x, z);
  if (!chunkKey) return;
  try {
    if (ok) {
      chunkFailCounts[chunkKey] = 0;
      const openBlockId = chunkPitfallBlockIds[chunkKey];
      if (openBlockId) {
        await bridge.resolvePitfall(openBlockId, { ref: decisionId });
        delete chunkPitfallBlockIds[chunkKey];
      }
      return;
    }
    const nextCount = (chunkFailCounts[chunkKey] ?? 0) + 1;
    chunkFailCounts[chunkKey] = nextCount;
    if (nextCount >= PITFALL_FAIL_THRESHOLD) {
      const { recorded, block_id } = await bridge.recordAreaPitfall({
        chunkKey,
        reason: `repeated_failure:${chosen.key}`,
        ref: decisionId,
      });
      if (recorded && block_id) chunkPitfallBlockIds[chunkKey] = block_id;
    }
  } catch {
    // Best-effort only.
  }
}

/**
 * Maintain suspendedArc's lifecycle after one brain_record_outcome call —
 * same three-way shape as auto_loop.mjs's maintainSuspendedArc(), adapted
 * to this file's coarser signal (just `ok`, no per-step breakdown):
 *   - resuming the CURRENTLY suspended arc (proposal.chosen.key matches)
 *     that now succeeded clears it once exhausted, or just refreshes its
 *     ttl otherwise (still conservatively resuming at index 0 next time —
 *     see this module's own doc comment above);
 *   - a FRESH multi-step macro (chosen.steps.length > 1) that just failed
 *     becomes the new suspendedArc, resume point index 0;
 *   - anything else decrements ttl, clearing the arc at 0.
 *
 * @param {object|undefined} proposal  the openProposals entry for this
 *   decision_id (undefined when brain_record_outcome was called with a
 *   decision_id that never went through brain_next_step — nothing to
 *   suspend/resume in that case either way).
 * @param {boolean} ok
 */
function maintainSuspendedArc(proposal, ok) {
  const chosen = proposal?.chosen;
  const isResumeRound = Boolean(suspendedArc) && chosen?.key === suspendedArc.macroKey;

  if (isResumeRound) {
    if (ok) {
      suspendedArc = null; // conservative: treat any successful resume attempt as having cleared the arc
    } else {
      const nextTtl = suspendedArc.ttl - 1;
      suspendedArc = nextTtl > 0 ? { ...suspendedArc, ttl: nextTtl } : null;
    }
    return;
  }

  if (!ok && chosen && Array.isArray(chosen.steps) && chosen.steps.length > 1) {
    suspendedArc = {
      macroId: chosen.id,
      macroKey: chosen.key,
      nextStepIndex: 0,
      steps: chosen.steps,
      spanToIdx: Number.isFinite(proposal?.cur_idx) ? proposal.cur_idx + chosen.steps.length : null,
      ttl: SUSPENDED_ARC_INITIAL_TTL,
    };
    return;
  }

  if (suspendedArc) {
    const nextTtl = suspendedArc.ttl - 1;
    suspendedArc = nextTtl > 0 ? { ...suspendedArc, ttl: nextTtl } : null;
  }
}

function recordFailureCooldown(candidateKey, candidateId, ok) {
  for (const k of [candidateKey, candidateId]) {
    if (!k) continue;
    if (ok) delete recentFailures[k];
    else recentFailures[k] = (recentFailures[k] ?? 0) + 1;
  }
}

// decision_id -> { chosen candidate object, state at proposal time, tool },
// so brain_record_outcome can resolve the chosen candidate's `key` (needed
// for the stream record) without re-deriving it from chosen_id alone. Also
// read by recordTelemetryFallback() below, which needs the still-open
// proposal's `chosen.tool` to match against a real game-tool telemetry
// event. Each entry also carries the exact streamPath/policyPath it was
// proposed under, so a test using injected tmp paths and a live run using
// the real project-root files can never cross-contaminate each other even
// though the map itself is process-wide module state.
const openProposals = new Map();

/**
 * Shared outcome-recording path: both brain_record_outcome's own run() and
 * recordTelemetryFallback()'s auto-fallback call through here, so there is
 * exactly one place that appends an outcome line and exactly one counter
 * driving the "every 5 outcomes" deliberation trigger — no matter which
 * caller actually recorded the result.
 *
 * `streamPath`/`policyPath` default to the real project-root files (used by
 * run_win.mjs / auto_loop.mjs in production); tests inject tmp paths so
 * nothing here ever touches the real decisions.jsonl/policy_snapshot.json.
 */
function recordOutcome({ decision_id, chosen_id, ok, code, autoFallback = false, streamPath = LOG_PATH, policyPath = POLICY_PATH, activePersona }) {
  const proposal = openProposals.get(decision_id);
  const key = proposal?.chosen?.key ?? chosen_id;
  // activePersona fallback: an explicit argument (brain_record_outcome's
  // own run(), which always passes the persona this createTools() closure
  // resolved) wins; recordTelemetryFallback() (module-level, no closure
  // over `persona`) instead reads it back off the same open proposal
  // brain_next_step stamped it onto (see openProposals.set() below) — this
  // is the fix for task 4's "activePersona 漏传" bug: without this, every
  // periodic runDeliberation() triggered from this file silently omitted
  // activePersona, which deliberate.mjs's own fallback then quietly reset
  // to whatever active_persona the snapshot already had (or null on a
  // fresh snapshot) instead of the persona actually driving this run.
  const personaForDeliberation = typeof activePersona === 'string' && activePersona ? activePersona : (proposal?.activePersona ?? undefined);
  openProposals.delete(decision_id);

  recordFailureCooldown(key, chosen_id, Boolean(ok));
  maintainSuspendedArc(proposal, Boolean(ok));
  // claim_bridge.mjs pitfall bookkeeping: deliberately fire-and-forget
  // (NOT awaited) — recordOutcome() must stay fully synchronous in its
  // return value (brain_record_outcome.run/recordTelemetryFallback both
  // return its result directly, and existing tests call
  // recordTelemetryFallback() synchronously and read `.recorded` off the
  // result immediately). The claim-memory write is a strictly optional
  // bonus side effect, not something any caller here waits on; any
  // rejection is swallowed so it can never surface as an unhandled
  // rejection.
  if (proposal?.chosen) {
    void getClaimBridge()
      .then(bridge => updateAreaPitfallMemory(bridge, proposal.chosen, Boolean(ok), decision_id))
      .catch(() => {});
  }

  // duration_ms: real wall-clock time between brain_next_step's proposal
  // (openProposals.set() below stamps `proposedAt`) and this outcome being
  // recorded — the LLM-facing path has no step-local timer of its own the
  // way auto_loop.mjs's runStep() does, so this is the only honest "how
  // long did this action actually take" signal available here. Omitted
  // (not defaulted to 0) when there is no matching open proposal (e.g. a
  // chosen_id the caller made up itself without ever calling
  // brain_next_step first), so deliberate.mjs's backward-compatible
  // fallback (`ok ? 1 : 0` when the field is absent) still applies exactly
  // as before for that edge case.
  const proposedAt = Number.isFinite(proposal?.proposedAt) ? proposal.proposedAt : null;
  const duration_ms = proposedAt !== null ? Math.max(0, Date.now() - proposedAt) : null;

  append(
    {
      decision_id,
      time: Date.now(),
      chosen: key,
      chosen_id,
      result: { ok: Boolean(ok), code: typeof code === 'string' ? code.slice(0, 64) : null },
      ...(duration_ms !== null ? { duration_ms } : {}),
      ...(autoFallback ? { autoFallback: true } : {}),
    },
    streamPath,
  );

  outcomesSinceDeliberation += 1;
  let deliberated = false;
  if (outcomesSinceDeliberation >= DELIBERATION_EVERY_N_OUTCOMES) {
    outcomesSinceDeliberation = 0;
    runDeliberation({ streamPath, policyPath, activePersona: personaForDeliberation });
    deliberated = true;
  }

  return { recorded: true, deliberated };
}

/**
 * @param {object} opts
 * @param {object} opts.bot            live mineflayer bot (or a test double)
 * @param {object} [opts.schema]       extra-tools.js schema helpers
 * @param {Function} [opts.observe]    observation function; defaults to the
 *   real createObservation({bot, perception, world}) — tests inject a fake
 *   one to avoid depending on src/body/bot.js's module-level mcdata (which
 *   only gets initialized by a real server login) or on bot.findBlocks().
 * @param {string} [opts.streamPath]   decisions.jsonl path override (tests)
 * @param {string} [opts.policyPath]   policy_snapshot.json path override (tests)
 * @param {string} [opts.personaName]  persona.json preset name (task 2),
 *   default 'balanced' — resolved ONCE via persona.mjs's resolvePersona()
 *   (pure config read, no decisions.jsonl/bot access) and reused for every
 *   brain_next_step call this process makes.
 */
export default async function createTools({
  bot,
  schema = defaultSchema,
  observe = createObservation({ bot, perception, world }),
  streamPath = LOG_PATH,
  policyPath = POLICY_PATH,
  personaName = DEFAULT_PERSONA_NAME,
} = {}) {
  const persona = resolvePersona(personaName);
  const brain_next_step = {
    name: 'brain_next_step',
    description:
      "Ask the brain what to do next. Reads your live state itself (no need to describe it), checks the Wiki route (splits.json) and the periodically-refreshed policy table, and proposes one candidate action plus runner-up alternatives. Call this before any meaningful game action, then call brain_record_outcome after you act.",
    properties: {
      goalHint: schema.text(200, 0),
    },
    required: [],
    run: async args => {
      const state = await liveNormalizedState(bot, observe);
      const splits = readSplits();
      const { cur_idx, next } = evaluate(splits, state);

      const policyTable = readPolicyTable(policyPath);
      // See auto_loop.mjs's identical check: if a non-exploration/non-safety
      // candidate already failed at least once this run, force explore
      // candidates in alongside it so a visible-but-unreachable production
      // target never becomes the pool's only option round after round.
      const forceExploreFallback = Object.entries(recentFailures).some(
        ([key, count]) => count > 0 && !key.startsWith('move:explore_') && key !== 'flee' && key !== 'eat',
      );
      // Suspend/resume (task 2): only offered while still "alive" (ttl > 0
      // AND the interrupted chain has not already reached its own
      // recorded spanToIdx) — mirrors auto_loop.mjs's identical check.
      const liveSuspendedArc = suspendedArc && suspendedArc.ttl > 0 && (!Number.isFinite(suspendedArc.spanToIdx) || cur_idx < suspendedArc.spanToIdx)
        ? suspendedArc
        : null;
      const candidates = enumerateCandidates(state, {
        nextSplit: next,
        stitchedMacros: policyTable.stitched_macros,
        forceExploreFallback,
        suspendedArc: liveSuspendedArc,
      });
      // claim_bridge.mjs (optional, degrade-safe): merge persisted
      // cross-episode pitfall warnings for the CURRENT chunk into this
      // round's recentFailures map — same contract as auto_loop.mjs, see
      // applyAreaPitfallRecall()'s doc comment there. decide.mjs itself
      // never learns anything came from a persisted memory layer.
      const claimBridge = await getClaimBridge();
      const currentChunkKey = await applyAreaPitfallRecall(claimBridge, state, candidates, recentFailures);
      const stateBucket = computeStateBucket(state, cur_idx);
      const { chosen, ranked, directionDeviated } = chooseCandidate(candidates, policyTable, { stateBucket, recentFailures, persona, lastChosenKey });
      if (chosen) lastChosenKey = chosen.key;

      // Anti-compaction digest (task 1b): at most 2-3 terse hint lines the
      // LLM can see directly in brain_next_step's response, so a long `pi`
      // conversation that later gets compacted/summarized never silently
      // drops a known area pitfall or hard constraint. Purely additive —
      // absent/empty when claim_bridge is unavailable or has nothing to
      // say for this chunk.
      const claimDigest = await claimBridge.compileConstraintsForPrompt({ chunkKey: currentChunkKey });

      decisionCounter += 1;
      const decision_id = `${Date.now()}-${decisionCounter}`;

      if (directionDeviated && chosen) {
        logDeviation('direction', {
          decision_id,
          chosen: chosen.key,
          cur_idx,
          next_split: next?.id ?? null,
        });
      }

      append(
        {
          decision_id,
          time: Date.now(),
          state,
          goalHint: typeof args?.goalHint === 'string' ? args.goalHint.slice(0, 200) : null,
          cur_idx,
          next_split: next?.id ?? null,
          proposed: chosen?.key ?? null,
          // Full executable shape of the chosen candidate, so environment B
          // (deliberate.mjs) can later lift a successful one straight into a
          // policy_snapshot.json stitched macro without guessing tool/args
          // back out of candidates.mjs by id — every record stays a complete,
          // independently-replayable account of what was actually proposed.
          chosen_spec: chosen
            ? { id: chosen.id, key: chosen.key, tool: chosen.tool, args: chosen.args, requires: chosen.requires, ensures: chosen.ensures }
            : null,
          candidates: ranked.slice(0, 10).map(r => ({
            id: r.candidate.id,
            key: r.candidate.key,
            score: Number.isFinite(r.score) ? Number(r.score.toFixed(4)) : null,
            source: r.candidate.source,
          })),
          directionDeviated,
        },
        streamPath,
      );

      if (chosen) openProposals.set(decision_id, { chosen, state, streamPath, policyPath, proposedAt: Date.now(), activePersona: persona.name, cur_idx });

      const top3 = ranked.slice(0, 3).map(r => ({
        id: r.candidate.id,
        key: r.candidate.key,
        tool: r.candidate.tool,
        args: r.candidate.args,
        score: Number.isFinite(r.score) ? Number(r.score.toFixed(4)) : null,
      }));

      // When `chosen` is a validated multi-step stitched macro (see
      // deliberate.mjs's extractMultiStepMacros()/candidates.mjs's
      // stitched-macro loop), surface its full `steps` sequence to the LLM
      // directly in the response — tool/args alone only show the FIRST
      // step, so without this the LLM has no way to know this proposal was
      // actually part of a proven 2-3 step chain it could keep following.
      // `nextStepHint` is a plain, model-readable instruction string; the
      // raw `steps` array is also included for a caller that wants to
      // inspect it programmatically. Purely additive: a normal single-step
      // candidate's response shape is completely unchanged (`steps`/
      // `nextStepHint` are simply absent).
      const isMultiStepMacro = Boolean(chosen) && Array.isArray(chosen.steps) && chosen.steps.length > 1;
      const macroInfo = isMultiStepMacro
        ? {
            steps: chosen.steps,
            nextStepHint: `This proposal is step 1 of a ${chosen.steps.length}-step proven sequence: ${chosen.steps.map((s, i) => `${i + 1}) ${s.key}`).join(' -> ')}. After this step succeeds and you call brain_record_outcome, call brain_next_step again — it will re-evaluate live state and should naturally propose step ${2} (${chosen.steps[1]?.key}) next if its prerequisites are still met.`,
          }
        : null;

      return {
        decision_id,
        chosen: chosen
          ? {
              id: chosen.id,
              key: chosen.key,
              tool: chosen.tool,
              args: chosen.args,
              isSafety: chosen.isSafety,
              ...(macroInfo ? macroInfo : {}),
            }
          : null,
        top3,
        cur_idx,
        next_split: next?.id ?? null,
        directionDeviated,
        // claim_bridge.mjs anti-compaction digest (task 1b): at most 2-3
        // short hint strings; empty array when claim_bridge is
        // unavailable/has nothing relevant. Never absent (so callers can
        // destructure without an existence check), never affects
        // decision_id/chosen/top3/cur_idx/directionDeviated above.
        pitfall_warnings: claimDigest.lines,
      };
    },
  };

  const brain_record_outcome = {
    name: 'brain_record_outcome',
    description:
      'Report what happened after you acted on a brain_next_step proposal (or your own choice). Pass the decision_id you got back, which candidate id you actually ran, whether it succeeded, and a short result code. This appends the outcome to the decision log and periodically refreshes the policy table used by future brain_next_step calls.',
    properties: {
      decision_id: schema.text(64, 1),
      chosen_id: schema.text(128, 1),
      ok: { type: 'boolean' },
      code: schema.text(64, 0),
    },
    required: ['decision_id', 'chosen_id', 'ok'],
    run: async args =>
      recordOutcome({ decision_id: args.decision_id, chosen_id: args.chosen_id, ok: args.ok, code: args.code, streamPath, policyPath, activePersona: persona.name }),
  };

  return [brain_next_step, brain_record_outcome];
}

/**
 * Fallback for when the LLM calls a real game tool (via brain_next_step's
 * suggestion or its own judgement) but never calls brain_record_outcome
 * afterward. Wire this into the harness's `telemetry` callback (see
 * run_win.mjs): every real tool-call event it receives is checked against
 * openProposals — if exactly one still-open proposal's `chosen.tool`
 * matches the event's tool name, that proposal is assumed to be the one
 * being executed and its outcome is recorded automatically, tagged
 * `autoFallback: true` so it's distinguishable from a real
 * brain_record_outcome call in decisions.jsonl.
 *
 * Ignores brain_next_step/brain_record_outcome's own telemetry events (so
 * calling brain_next_step doesn't accidentally "complete" itself), and is a
 * no-op once the matching proposal has already been resolved (by the LLM's
 * own brain_record_outcome call, or by an earlier fallback) — openProposals
 * no longer has an entry for it, so nothing double-writes.
 *
 * @param {object} event  a telemetry event as passed to run_win.mjs's
 *   `telemetry` callback — expected to carry at least `{ tool, success }`
 *   (the exact shape used by src/model/session.js's telemetry calls).
 */
export function recordTelemetryFallback(event) {
  const toolName = event?.tool;
  if (!toolName || toolName === 'brain_next_step' || toolName === 'brain_record_outcome') return null;

  // Find the open proposal(s) whose chosen tool matches this event. Only
  // act when there's exactly one unambiguous match — with more than one
  // open proposal on the same tool, guessing which one just ran risks
  // crediting the wrong decision_id, so the fallback stays silent and lets
  // the LLM's own brain_record_outcome (or the next unambiguous event)
  // resolve it instead.
  const matches = [...openProposals.entries()].filter(([, p]) => p.chosen?.tool === toolName);
  if (matches.length !== 1) return null;

  const [decision_id, proposal] = matches[0];
  const ok = event?.success !== false;
  const code = ok ? 'auto_fallback_ok' : String(event?.failureCode ?? 'auto_fallback_failed').slice(0, 64);

  // Use the exact streamPath/policyPath the matching proposal was created
  // under (set by createTools()'s brain_next_step), so a test using
  // injected tmp paths never leaks a write into the real project-root
  // files just because recordTelemetryFallback() itself has no explicit
  // path arguments of its own.
  return recordOutcome({
    decision_id,
    chosen_id: proposal.chosen.id,
    ok,
    code,
    autoFallback: true,
    streamPath: proposal.streamPath ?? LOG_PATH,
    policyPath: proposal.policyPath ?? POLICY_PATH,
    activePersona: proposal.activePersona,
  });
}

// Also exported by name, so a future standalone entry point (e.g. inside
// run_win.mjs) can pull the specs without re-importing the default export
// under a different local name.
export { createTools };
