// brain/auto_loop.mjs — 0-token live closed-loop tester.
//
// Drives the brain's full observe -> decide -> execute -> record -> (every
// 5th outcome) deliberate loop directly against a real Minecraft server,
// with NO LLM in the path at all: no createMinecraftSession, no API key,
// no network call to any model provider. Every decision comes from
// candidates.mjs + decide.mjs + the on-disk policy_snapshot.json, exactly
// like tools_adapter.mjs's brain_next_step/brain_record_outcome would do
// for an LLM caller — this file just IS that caller, mechanically, so the
// whole environment-A/environment-B pipeline can be exercised and verified
// for the cost of zero API tokens.
//
// Run: node brain/auto_loop.mjs --port 25566 --steps 8
// Stop: Ctrl+C (or let --steps run out)

import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { once } from 'node:events';

import { initBot } from '../src/body/bot.js';
import { createObservation, createActionRunner } from '../src/tools/game-tools.js';
import { setSettings } from '../src/skills/settings.js';
import * as perception from '../src/skills/perception.js';
import * as world from '../src/skills/world.js';

import { normalizeObsState, enumerateCandidates, computeStateBucket } from './candidates.mjs';
import { chooseCandidate } from './decide.mjs';
import { readPolicyTable, writePolicyTableAtomic, POLICY_PATH } from './policy_table.mjs';
import { runDeliberation } from './deliberate.mjs';
import { evaluate } from './wiki.mjs';
import { append } from './stream.mjs';
import { logDeviation } from './log.mjs';
import { LOG_PATH as DECISIONS_LOG_PATH } from './stream.mjs';
import { executeChosenSteps } from './macro_executor.mjs';
import { resolvePersona, DEFAULT_PERSONA_NAME } from './persona.mjs';
import { getDefaultClaimBridge, chunkKeyFor } from './claim_bridge.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPLITS_PATH = join(__dirname, 'splits.json');

// Load .env from the current working directory (same convention run_win.mjs
// uses) BEFORE reading process.env.BRAIN_PERSONA below, so a project-root
// .env's BRAIN_PERSONA=companion_builder works the same way whether this
// script or run_win.mjs is the one launched. Silently does nothing when no
// .env file exists — this is a convenience default, never a requirement.
function loadDotEnv(cwd) {
  const file = join(cwd, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
loadDotEnv(process.cwd());

const OPTIONS = {
  host: { type: 'string' },
  port: { type: 'string' },
  'mc-version': { type: 'string' },
  name: { type: 'string' },
  steps: { type: 'string' },
  'step-timeout-ms': { type: 'string' },
  persona: { type: 'string' },
};

function parseCli(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true });
  return {
    host: values.host ?? '127.0.0.1',
    port: Number(values.port ?? 25566),
    minecraftVersion: values['mc-version'] ?? '1.21.6',
    // --persona (CLI) takes priority over BRAIN_PERSONA (.env/environment),
    // which in turn takes priority over persona.mjs's own neutral default.
    personaName: values.persona ?? process.env.BRAIN_PERSONA ?? DEFAULT_PERSONA_NAME,
    // --name explicit: used verbatim, no collision suffix (the caller is
    // presumably already picking something distinct on purpose). --name
    // omitted: a short per-process suffix added automatically so two
    // experiment runs started back-to-back never race over the same
    // in-game player name — see defaultBotName()'s doc comment.
    name: values.name ?? defaultBotName(),
    nameWasExplicit: values.name !== undefined,
    steps: Number.isFinite(Number(values.steps)) ? Number(values.steps) : 8,
    // null (not set) means "use the per-tool defaults below, uncapped";
    // when given, --step-timeout-ms now acts as an UPPER BOUND applied on
    // top of those per-tool defaults (see timeoutMsForTool()), not a single
    // flat value for every tool — fixes a real false-failure bug: the
    // previous flat 5000ms default made a real `gather` call (which can
    // legitimately take several seconds to path to a tree and mine it) get
    // aborted and recorded as a failure almost every time.
    stepTimeoutMsOverrideCap: Number.isFinite(Number(values['step-timeout-ms'])) ? Number(values['step-timeout-ms']) : null,
  };
}

// Default --name anti-collision short id (task 2d): back-to-back
// experiment runs that both omit --name would otherwise both try to log in
// as the literal string 'AutoBrainBot', which a real Minecraft server
// resolves as the SAME player — the second connection either kicks the
// first (duplicate login) or silently takes over its session, a race that
// has nothing to do with brain logic and is easy to hit by just running
// this script twice in a row without remembering to pass --name each time.
// Suffixing a short base36 slice of Date.now() (not a UUID — this only
// needs to be short and distinct between two runs started seconds apart,
// not globally unique) keeps the default usable out of the box while still
// avoiding that collision; an explicit --name always overrides this and is
// used verbatim.
function defaultBotName() {
  return `AutoBrainBot-${Date.now().toString(36).slice(-5)}`;
}

function readSplits() {
  try {
    return JSON.parse(readFileSync(SPLITS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read the bot's current state directly and normalize it, merging in
 * bot.game.dimension exactly the way tools_adapter.mjs does (candidates.mjs
 * itself never reaches into a bot/game object — see its normalizeObsState
 * doc comment). Passed into macro_executor.mjs's executeChosenSteps() as
 * its injected liveNormalizedState, so a multi-step macro's between-step
 * requires re-check uses this exact same observe/normalize path.
 */
async function liveNormalizedState(bot, observe) {
  // range: 48 — matches tools_adapter.mjs's brain_next_step; the default 16
  // is often too short to see any loggable tree or exposed stone.
  const { state } = await observe({ image: false, range: 48 });
  const rawDimension = bot.game?.dimension;
  const dimension = typeof rawDimension === 'string' ? rawDimension.replace(/^minecraft:/, '') : null;
  return normalizeObsState({ ...state, dimension });
}

let decisionCounter = 0;

// In-memory-only, per-process short-term failure cooldown: candidate id ->
// consecutive fail count THIS RUN. Never persisted to decisions.jsonl or
// policy_snapshot.json, and never read back from them either — it exists
// purely so a candidate that just failed repeatedly (e.g. explore_e timing
// out against unwalkable terrain) yields to an untried alternative on the
// very next decision instead of waiting for a full deliberation pass to
// catch up. Reset to 0 on success, incremented on failure.
const recentFailures = {};

function recordFailureCooldown(candidateKey, candidateId, ok) {
  for (const k of [candidateKey, candidateId]) {
    if (!k) continue;
    if (ok) {
      delete recentFailures[k];
    } else {
      recentFailures[k] = (recentFailures[k] ?? 0) + 1;
    }
  }
}

// In-memory-only, per-process "what did we choose last round" context
// (task 2's momentum_bonus) — never persisted to decisions.jsonl/
// policy_snapshot.json, never read back from them either. Reset to null at
// process start, updated after every step regardless of outcome (momentum
// is about which action FAMILY was attempted, not whether it succeeded).
let lastChosenKey = null;

// Suspend/resume (task 2): in-memory-only, per-process pointer to an
// interrupted multi-step macro, so a hostile/low-health/low-food
// emergency that breaks a long chain mid-way does not have to throw the
// whole chain away — once the emergency clears, the NEXT round's
// enumerateCandidates() call offers a resume candidate picking up exactly
// where it left off (see candidates.mjs's own suspendedArc doc comment).
// Never persisted to decisions.jsonl/policy_snapshot.json (strictly
// environment-A-local state, same isolation guarantee as
// recentFailures/lastChosenKey above) and never read from either file.
//
// Shape: { macroId, macroKey, nextStepIndex, steps, spanToIdx, ttl } or
// null when nothing is currently suspended. `ttl` counts down by 1 every
// round this arc is NOT yet resumed/cleared (see maintainSuspendedArc()
// below) — once it hits 0, the arc is dropped even if the interrupted
// chain's own steps would still technically apply, so a VERY old
// interruption (the bot wandered off and did something else entirely for
// many rounds) can never suddenly resurrect itself far later.
let suspendedArc = null;

const SUSPENDED_ARC_INITIAL_TTL = 4;

// --- claim_bridge.mjs integration (optional, degrades to no-op) --------
//
// Area-pitfall memory is layered on top of this file's EXISTING
// recentFailures contract (see decide.mjs's `failCount * 5` penalty) —
// no change to decide.mjs/candidates.mjs is needed, because a chunk's
// recalled warning is simply merged into the SAME in-memory recentFailures
// map this file already builds and passes to chooseCandidate(), keyed by
// the specific `move:explore_*`/chosen candidate key that targets that
// chunk. This keeps the hard A/B isolation boundary intact: decide.mjs
// still only ever sees "some candidate key has N recent failures", with no
// idea any of that came from a persisted cross-episode memory layer.
//
// In-memory-only, per-process per-chunk consecutive-failure counter (never
// persisted itself — only once it crosses PITFALL_FAIL_THRESHOLD does a
// *consolidated* pitfall claim get written via claim_bridge.mjs, which IS
// cross-episode/cross-process persistent).
const chunkFailCounts = {};
// chunkKey -> most recent still-open pitfall block_id, so a later success
// in that chunk can call resolvePitfall() on the right claim.
const chunkPitfallBlockIds = {};

const PITFALL_FAIL_THRESHOLD = 2;

/**
 * Best-effort chunk-pitfall bookkeeping, called once per step AFTER the
 * outcome is known. Never throws: claim_bridge.mjs's bridge is already
 * fully degrade-safe on its own, and every call here is additionally
 * wrapped so a transient store error can never take down the live 0-token
 * loop over what is strictly a bonus memory layer.
 *
 * @param {object} bridge       claim_bridge.mjs bridge instance
 * @param {object|null} chosen  the chosen candidate (may target a chunk
 *   via its go_to args.x/args.z, e.g. move:explore_* candidates)
 * @param {boolean} ok
 * @param {string} decisionId
 */
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
  } catch (error) {
    console.error(`[auto_loop] claim_bridge pitfall bookkeeping skipped: ${String(error?.message ?? error).slice(0, 200)}`);
  }
}

/**
 * Merge persisted cross-episode pitfall warnings for the bot's CURRENT
 * chunk into this run's recentFailures map, as a soft, bounded penalty —
 * never an outright block. A recalled warning adds at most
 * PITFALL_RECALL_PENALTY_COUNT "equivalent recent failures" worth of
 * pressure (decide.mjs's existing `failCount * 5` formula), which is
 * enough to make an already-known-bad direction lose to an untried
 * alternative without making it literally unselectable if genuinely
 * nothing else is viable. Only ever touches explore-direction candidate
 * keys (`move:explore_n/e/s/w`) that this chunk's own 10-block step would
 * actually land in — a mismatch (recall returns nothing, or nothing
 * targets this chunk) leaves recentFailures completely untouched.
 *
 * @param {object} bridge
 * @param {object} state  normalizeObsState() output (state.pos)
 * @param {object[]} candidates  enumerateCandidates() output this round
 * @param {Record<string, number>} recentFailures  mutated in place
 */
async function applyAreaPitfallRecall(bridge, state, candidates, recentFailures) {
  if (!bridge?.available || !state?.pos) return;
  const here = chunkKeyFor(state.pos.x, state.pos.z);
  if (!here) return;
  try {
    const { warnings } = await bridge.recallAreaWarnings(here);
    if (!warnings.length) return;
    const PITFALL_RECALL_PENALTY_COUNT = 1;
    for (const c of candidates) {
      const cx = Number.isFinite(c.args?.x) ? c.args.x : null;
      const cz = Number.isFinite(c.args?.z) ? c.args.z : null;
      const targetChunk = chunkKeyFor(cx, cz);
      if (targetChunk && targetChunk === here && c.source === 'explore') {
        // The explore target itself is a few blocks away from `here`, so
        // comparing against `here` only matches when the bot is already
        // deep enough into a known-bad chunk that a short hop stays
        // inside it — intentionally conservative (never penalizes a
        // direction that would actually LEAVE the bad chunk).
        recentFailures[c.key] = (recentFailures[c.key] ?? 0) + PITFALL_RECALL_PENALTY_COUNT;
      }
    }
    console.log(`[auto_loop] claim_bridge: ${warnings.length} pitfall warning(s) recalled for ${here}`);
  } catch (error) {
    console.error(`[auto_loop] claim_bridge recall skipped: ${String(error?.message ?? error).slice(0, 200)}`);
  }
}

/**
 * Called once per round, AFTER this round's outcome is known, to maintain
 * suspendedArc's lifecycle:
 *   - a macro that just broke mid-chain (stepsCompleted < stepsTotal, i.e.
 *     breakAt is set and breakAt <= stepsTotal) becomes the new
 *     suspendedArc, pointing at the first step it never got to;
 *   - a round that successfully resumed/continued the CURRENTLY suspended
 *     arc (chosen.key/chosen.id matches what maintainSuspendedArc itself
 *     offered) advances nextStepIndex by however many steps that round
 *     actually completed, or clears it entirely once the arc's own steps
 *     are exhausted;
 *   - any other round (an unrelated candidate was chosen, or ttl has
 *     counted down to 0) decrements ttl, clearing the arc once it reaches 0.
 *
 * Pure in-memory bookkeeping; never touches decisions.jsonl/
 * policy_snapshot.json.
 */
function maintainSuspendedArc({ chosen, ok, stepsInfo, breakAt, curIdx }) {
  const isResumeRound = Boolean(suspendedArc) && chosen?.key === suspendedArc.macroKey;

  if (isResumeRound) {
    const completedThisRound = Number.isFinite(stepsInfo?.stepsCompleted) ? stepsInfo.stepsCompleted : (ok ? 1 : 0);
    const newIndex = suspendedArc.nextStepIndex + completedThisRound;
    if (ok && newIndex >= suspendedArc.steps.length) {
      suspendedArc = null; // chain fully resumed and completed — nothing left to suspend
      return;
    }
    if (ok) {
      suspendedArc = { ...suspendedArc, nextStepIndex: newIndex, ttl: SUSPENDED_ARC_INITIAL_TTL };
      return;
    }
    // Resume attempt itself failed: let the ttl-decrement branch below
    // handle it (still the same arc, just not advanced) rather than
    // duplicating that logic here.
  }

  // A fresh multi-step break THIS round (stepsInfo.stepsTotal > 1, and it
  // did not fully complete) always takes priority over maintaining
  // whatever was already suspended — the bot cannot be mid-TWO chains at
  // once, and the newest interruption is the one actually relevant to
  // react to right now.
  if (stepsInfo && Number.isFinite(stepsInfo.stepsTotal) && stepsInfo.stepsTotal > 1 && stepsInfo.stepsCompleted < stepsInfo.stepsTotal && Number.isFinite(breakAt) && Array.isArray(chosen?.steps)) {
    suspendedArc = {
      macroId: chosen.id,
      macroKey: chosen.key,
      nextStepIndex: breakAt - 1, // breakAt is 1-based "which step broke"; resume AT that same step
      steps: chosen.steps,
      spanToIdx: Number.isFinite(curIdx) ? curIdx + stepsInfo.stepsTotal : null,
      ttl: SUSPENDED_ARC_INITIAL_TTL,
    };
    return;
  }

  if (suspendedArc) {
    const nextTtl = suspendedArc.ttl - 1;
    suspendedArc = nextTtl > 0 && suspendedArc.nextStepIndex < suspendedArc.steps.length ? { ...suspendedArc, ttl: nextTtl } : null;
  }
}

async function runStep({ bot, observe, gameTools, actionRunner, stepTimeoutMsOverrideCap, persona, claimBridge }) {
  // a) observe + normalize
  const state = await liveNormalizedState(bot, observe);

  // b) Wiki route position
  const splits = readSplits();
  const { cur_idx, next } = evaluate(splits, state);

  // c) read-only policy snapshot -> candidates -> choice (environment A;
  //    never reads decisions.jsonl, exactly like tools_adapter.mjs). If any
  //    non-exploration candidate already failed at least once THIS RUN
  //    (per the in-memory recentFailures map — never read from disk),
  //    force exploration candidates in alongside it: a visible-but-
  //    unreachable production target (oak_log across water, etc.) must
  //    not become the pool's only candidate round after round just
  //    because nothing else was ever offered to rotate to.
  const policyTable = readPolicyTable();
  const forceExploreFallback = Object.entries(recentFailures).some(
    ([key, count]) => count > 0 && !key.startsWith('move:explore_') && key !== 'flee' && key !== 'eat',
  );
  // Suspend/resume (task 2): only ever handed to enumerateCandidates()
  // while it is still "alive" (ttl > 0 AND the interrupted chain has not
  // already reached its own recorded spanToIdx) — once either condition
  // fails, the arc is stale and must not keep being offered as a resume
  // candidate. Mirrors the module-level `suspendedArc`'s own doc comment.
  const liveSuspendedArc = suspendedArc && suspendedArc.ttl > 0 && (!Number.isFinite(suspendedArc.spanToIdx) || cur_idx < suspendedArc.spanToIdx)
    ? suspendedArc
    : null;
  const candidates = enumerateCandidates(state, {
    nextSplit: next,
    stitchedMacros: policyTable.stitched_macros,
    forceExploreFallback,
    suspendedArc: liveSuspendedArc,
  });
  const stateBucket = computeStateBucket(state, cur_idx);
  // claim_bridge.mjs (optional, degrade-safe): merge any persisted
  // cross-episode pitfall warning for the CURRENT chunk into this round's
  // recentFailures map before scoring — decide.mjs itself is untouched,
  // it just sees a slightly higher failCount on the affected explore
  // candidate key(s), exactly like a same-run repeated failure would
  // produce. See applyAreaPitfallRecall()'s own doc comment.
  await applyAreaPitfallRecall(claimBridge, state, candidates, recentFailures);
  const { chosen, ranked, directionDeviated } = chooseCandidate(candidates, policyTable, { stateBucket, recentFailures, persona, lastChosenKey });

  decisionCounter += 1;
  const decision_id = `auto-${Date.now()}-${decisionCounter}`;

  if (!chosen) {
    console.log(`[auto_loop] #${decisionCounter} no candidates available, waiting 1s`);
    await sleep(1000);
    return { decision_id, chosen: null, ok: null };
  }

  lastChosenKey = chosen.key;

  if (directionDeviated) {
    logDeviation('direction', { decision_id, chosen: chosen.key, cur_idx, next_split: next?.id ?? null });
  }

  // d) write the proposal, same shape tools_adapter.mjs writes.
  append({
    decision_id,
    time: Date.now(),
    state,
    goalHint: 'auto_loop: 0-token mechanical driver',
    cur_idx,
    next_split: next?.id ?? null,
    proposed: chosen.key,
    chosen_spec: { id: chosen.id, key: chosen.key, tool: chosen.tool, args: chosen.args, requires: chosen.requires, ensures: chosen.ensures },
    candidates: ranked.slice(0, 10).map(r => ({
      id: r.candidate.id,
      key: r.candidate.key,
      score: Number.isFinite(r.score) ? Number(r.score.toFixed(4)) : null,
      source: r.candidate.source,
    })),
    directionDeviated,
  });

  console.log(`[auto_loop] #${decisionCounter} proposed ${chosen.id} (tool=${chosen.tool}) cur_idx=${cur_idx} next_split=${next?.id ?? null}`);

  // e) execute the real game tool(s): a single tool call for a normal
  //    candidate, or the full validated step chain in order for a
  //    multi-step stitched macro (chosen.steps.length > 1) — see
  //    executeChosenSteps()'s doc comment. Per-tool-type timeout (not one
  //    flat value) and exception capture: one failing step must never
  //    crash the loop.
  const stepStartedAt = Date.now();
  let ok = false;
  let code = 'unknown';
  let stepsInfo = null;
  let breakAt = null;
  let breakReason = null;
  // Physical-result alignment check (final polish round): macro_executor.mjs's
  // executeChosenSteps() compares each step's declared `ensures` against
  // the REAL before/after world state, not just the tool call's own
  // self-reported ok:true — see its checkAlignment() doc comment. `aligned`
  // is `true`/`false`/`null` ("unknown", e.g. no outcome to compare, or
  // nothing checkable) and is surfaced on the recorded outcome below
  // purely as a diagnostic flag; it never changes `ok`/`code`/stepsInfo,
  // so nothing about the existing success/failure contract changes.
  let aligned = null;
  try {
    const outcome = await executeChosenSteps({ bot, observe, gameTools, chosen, decisionId: decision_id, overrideCap: stepTimeoutMsOverrideCap, liveNormalizedState });
    ok = outcome.ok;
    code = outcome.code;
    stepsInfo = { stepsCompleted: outcome.stepsCompleted, stepsTotal: outcome.stepsTotal };
    breakAt = outcome.breakAt ?? null;
    breakReason = outcome.breakReason ?? null;
    aligned = outcome.aligned ?? null;
  } catch (error) {
    ok = false;
    code = String(error?.message ?? error).slice(0, 64);
  }
  const duration_ms = Date.now() - stepStartedAt;

  // f) record the outcome immediately, including the real wall-clock time
  // this step actually took (duration_ms) — see deliberate.mjs's
  // efficiency-reward formula, which reads this field back (never read
  // here/by candidates.mjs/decide.mjs — those stay history-free).
  //
  // For a multi-step macro, also record macro_completed_steps/
  // macro_total_steps/macro_break_at/macro_break_reason — this is the raw
  // "how far did the long chain actually get, and why did it stop" signal
  // deliberate.mjs's macro_flow_summary (environment B's high-dimensional
  // flow-shape view) reads back later; a single-step candidate (the common
  // case) never carries any of this, exactly like before this upgrade.
  append({
    decision_id,
    time: Date.now(),
    chosen: chosen.key,
    chosen_id: chosen.id,
    result: { ok, code },
    duration_ms,
    // aligned (final polish round): only ever recorded when ok:true AND
    // the executor actually had something checkable — an ok:false outcome
    // already failed on its own terms, so there is nothing additional an
    // alignment mismatch would tell deliberate.mjs; `null` (unknown, e.g.
    // no liveNormalizedState path or nothing with a declared `ensures`)
    // is omitted rather than written as a misleading `false`.
    ...(ok && aligned !== null ? { aligned } : {}),
    ...(stepsInfo && stepsInfo.stepsTotal > 1
      ? {
          macroSteps: stepsInfo,
          macro_completed_steps: stepsInfo.stepsCompleted,
          macro_total_steps: stepsInfo.stepsTotal,
          macro_break_at: breakAt,
          macro_break_reason: breakReason,
        }
      : {}),
  });

  recordFailureCooldown(chosen.key, chosen.id, ok);
  maintainSuspendedArc({ chosen, ok, stepsInfo, breakAt, curIdx: cur_idx });
  await updateAreaPitfallMemory(claimBridge, chosen, ok, decision_id);
  if (suspendedArc) {
    console.log(`[auto_loop] #${decisionCounter} suspendedArc alive: ${suspendedArc.macroKey} nextStepIndex=${suspendedArc.nextStepIndex}/${suspendedArc.steps.length} ttl=${suspendedArc.ttl}`);
  }

  if (ok && aligned === false) {
    console.log(`[auto_loop] #${decisionCounter} ALIGNMENT WARNING: ${chosen.id} reported ok=true but its declared ensures was never actually observed in the world (possible false success)`);
  }

  const stepsSuffix = stepsInfo && stepsInfo.stepsTotal > 1 ? ` steps=${stepsInfo.stepsCompleted}/${stepsInfo.stepsTotal}` : '';
  console.log(`[auto_loop] #${decisionCounter} outcome ${chosen.id} ok=${ok} code=${code}${stepsSuffix}`);

  return { decision_id, chosen, ok, code };
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  const persona = resolvePersona(cli.personaName);
  console.log(`[auto_loop] persona=${persona.name} (${persona.label})`);
  console.log(
    cli.nameWasExplicit
      ? `[auto_loop] name=${cli.name} (explicit --name)`
      : `[auto_loop] name=${cli.name} (auto-generated anti-collision name; pass --name to pick your own)`,
  );

  // Startup hot-recovery: align policy_snapshot.json with any existing
  // decisions.jsonl history before touching the server, exactly like
  // run_win.mjs's own hot-start step.
  if (existsSync(DECISIONS_LOG_PATH)) {
    const raw = readFileSync(DECISIONS_LOG_PATH, 'utf8');
    const hasRecord = raw.split('\n').some(line => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }
    });
    if (hasRecord) {
      runDeliberation({ activePersona: persona.name });
      console.log('[auto_loop] hot-start: ran one deliberation pass over existing decisions.jsonl history');
    }
  } else {
    writePolicyTableAtomic(readPolicyTable(POLICY_PATH), POLICY_PATH);
    console.log(`[auto_loop] initialized empty policy_snapshot.json at ${POLICY_PATH}`);
  }

  setSettings({
    minecraft_version: cli.minecraftVersion,
    host: cli.host,
    port: cli.port,
    auth: 'offline',
  });

  // claim_bridge.mjs: optional, degrade-safe area-pitfall memory layer.
  // Created ONCE per process (not per-step) so the sibling SDK's in-memory
  // store cache is reused across every step this run makes. A missing
  // sibling agent-claim-memory checkout (or any other load failure) never
  // blocks startup — getDefaultClaimBridge() always resolves, to either a
  // live bridge or a documented no-op.
  const claimBridge = await getDefaultClaimBridge();
  console.log(
    claimBridge.available
      ? `[auto_loop] claim_bridge: area-pitfall memory active (namespace=${claimBridge.namespace}, dataDir=${claimBridge.dataDir})`
      : `[auto_loop] claim_bridge: degraded to no-op (${claimBridge.reason})`,
  );

  console.log(`[auto_loop] connecting to ${cli.host}:${cli.port} as ${cli.name} (0 LLM tokens, ${cli.steps} steps)`);
  const bot = initBot(cli.name);
  // Defensive second layer alongside macro_executor.mjs's runToolWithAbort(): mineflayer's
  // bot is a plain Node EventEmitter (10-listener default). Even with
  // prompt abort-driven cleanup, a slow 'end'/network teardown between
  // steps could transiently overlap two 'pi_hit' listeners; raising the
  // cap avoids a spurious MaxListenersExceededWarning without masking a
  // genuine leak (20 steps never needs anywhere near this many at once).
  bot.setMaxListeners?.(50);

  let closing = false;
  let actionRunner = null;

  const finish = async exitCode => {
    if (closing) return;
    closing = true;
    const hardStop = setTimeout(() => process.exit(exitCode), 3000);
    hardStop.unref?.();
    try {
      if (actionRunner && typeof actionRunner.stop === 'function') await actionRunner.stop();
    } catch {
      // best-effort
    }
    try {
      bot.quit('auto_loop done');
    } catch {
      // may already be disconnected
    }
    clearTimeout(hardStop);
    process.exitCode = exitCode;
    process.exit(exitCode);
  };

  process.once('SIGINT', () => void finish(0));
  process.once('SIGTERM', () => void finish(0));

  let spawned = false;
  bot.once('kicked', reason => {
    console.error('[auto_loop] kicked:', reason);
    void finish(1);
  });
  bot.once('end', reason => {
    if (closing) return;
    if (!spawned) {
      console.error(`[auto_loop] connection ended before spawn: ${reason}`);
      process.exitCode = 1;
      return;
    }
    void finish(0);
  });
  bot.on('error', error => console.error('[auto_loop] bot error:', error?.message ?? error));

  try {
    await once(bot, 'spawn', { signal: AbortSignal.timeout(60000) });
  } catch (error) {
    console.error(`[auto_loop] failed to spawn: ${error?.message ?? error}`);
    // Real bug fix: this used to just `return` with process.exitCode set,
    // but never actually quit the bot or called process.exit() — the
    // server log confirms a real-world case where the server itself DID
    // accept the login/spawn (AutoBrainBot joined the game) around the
    // same time this client-side AbortSignal.timeout(60000) fired, yet the
    // process stayed alive indefinitely afterward with the socket still
    // open and no further output, because nothing here ever told it to
    // stop. finish(1) does the same bot.quit()+hardStop+process.exit(1)
    // teardown every other exit path in this file already uses, so a
    // spawn failure/race can never again leave an orphaned node process
    // that has to be killed by hand.
    void finish(1);
    return;
  }
  spawned = true;
  console.log(`[auto_loop] spawned at ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)}`);

  actionRunner = createActionRunner(bot, { settleTimeoutMs: 8000, onFatal: () => void finish(1) });
  const observe = createObservation({ bot, perception, world });
  const gameTools = (await import('../src/tools/game-tools.js')).createGameTools({
    bot,
    observe,
    actionRunner,
    perception,
    world,
    skills: { ...(await import('../src/skills/skills.js')), ...(await import('../src/skills/survival.js')) },
  });

  let outcomesSinceDeliberation = 0;
  let lastSummary = null;

  // Episode-boundary bookkeeping (status_report.mjs's §5 episode_history):
  // this process-run itself IS one episode from auto_loop.mjs's point of
  // view, so its own step loop tracks the plain {totalSteps,finalCurIdx,
  // avgStepDurationMs,failureRate,deathOrStuckReason} summary
  // deliberate.mjs's runDeliberation({mode:'inter_episode'}) expects —
  // computed here from this run's OWN in-memory counters, never by
  // re-reading decisions.jsonl (that stays environment B's job).
  let episodeSteps = 0;
  let episodeFailures = 0;
  let episodeDurationSum = 0;
  let episodeFinalCurIdx = -1;
  let episodeStuckReason = null;

  for (let i = 0; i < cli.steps && !closing; i++) {
    const stepStartedAt = Date.now();
    const { ok, chosen, decision_id } = await runStep({ bot, observe, gameTools, actionRunner, stepTimeoutMsOverrideCap: cli.stepTimeoutMsOverrideCap, persona, claimBridge });
    if (chosen) {
      episodeSteps += 1;
      episodeDurationSum += Date.now() - stepStartedAt;
      if (!ok) episodeFailures += 1;
      outcomesSinceDeliberation += 1;
      if (outcomesSinceDeliberation >= 5) {
        outcomesSinceDeliberation = 0;
        const before = readPolicyTable();
        lastSummary = runDeliberation({ activePersona: persona.name });
        const after = readPolicyTable();
        episodeFinalCurIdx = Number.isFinite(after.cur_idx) ? after.cur_idx : episodeFinalCurIdx;
        console.log(
          `[auto_loop] deliberation: cur_idx ${before.cur_idx}->${after.cur_idx}, total_rounds ${before.total_rounds}->${after.total_rounds}, entries ${Object.keys(before.entries).length}->${Object.keys(after.entries).length}, stitched_macros ${before.stitched_macros.length}->${after.stitched_macros.length}`,
        );
      }
    } else {
      episodeStuckReason = episodeStuckReason ?? 'no_candidates_available';
    }
  }

  // Final catch-up: if steps ran out with unreflected outcomes still
  // pending (fewer than 5 since the last deliberation), run one more pass
  // so policy_snapshot.json never silently lags behind decisions.jsonl at
  // the end of a run.
  if (outcomesSinceDeliberation > 0) {
    const before = readPolicyTable();
    lastSummary = runDeliberation({ activePersona: persona.name });
    const after = readPolicyTable();
    episodeFinalCurIdx = Number.isFinite(after.cur_idx) ? after.cur_idx : episodeFinalCurIdx;
    console.log(
      `[auto_loop] final deliberation: cur_idx ${before.cur_idx}->${after.cur_idx}, total_rounds ${before.total_rounds}->${after.total_rounds}, entries ${Object.keys(before.entries).length}->${Object.keys(after.entries).length}, stitched_macros ${before.stitched_macros.length}->${after.stitched_macros.length}`,
    );
  }

  // One inter_episode summary row per auto_loop.mjs process run (task 2's
  // "跨局成长轨迹"): appended ADDITIONALLY (mode:'inter_episode' never
  // replaces the ordinary periodic policy-table refresh above, it only
  // adds one more row to policy_snapshot.json.episode_history) so
  // status_report.mjs's §5 has real cross-episode data from live
  // auto_loop.mjs runs, not just multi_episode_eval.mjs's offline
  // simulation. Only recorded when this run actually made at least one
  // decision — an episode with zero steps taken (e.g. spawn failure) has
  // nothing meaningful to summarize.
  if (episodeSteps > 0) {
    runDeliberation({
      activePersona: persona.name,
      mode: 'inter_episode',
      episodeMeta: {
        totalSteps: episodeSteps,
        finalCurIdx: episodeFinalCurIdx,
        avgStepDurationMs: Math.round(episodeDurationSum / episodeSteps),
        failureRate: episodeFailures / episodeSteps,
        deathOrStuckReason: episodeStuckReason,
      },
    });
    console.log(`[auto_loop] episode_history: recorded this run (steps=${episodeSteps}, finalCurIdx=${episodeFinalCurIdx}, failureRate=${(episodeFailures / episodeSteps).toFixed(2)})`);
  }

  console.log(`[auto_loop] done. ${cli.steps} steps completed. Final snapshot:`, JSON.stringify(lastSummary?.snapshot ?? readPolicyTable()));
  await finish(0);
}

main().catch(err => {
  console.error('[auto_loop] fatal:', err);
  process.exitCode = 1;
});
