// brain/macro_executor.mjs — shared, side-effect-free step execution logic
// factored out of auto_loop.mjs so it can be imported directly by
// brain.test.mjs without ever triggering auto_loop.mjs's own top-level
// main().catch(...) call (which connects to a real Minecraft server the
// instant the module is imported — unsafe to pull into a unit test).
//
// Pure with respect to decisions.jsonl/policy_snapshot.json: nothing here
// reads or writes either file. It only executes real game tools (passed in
// by the caller) against a live bot/observe pair also passed in by the
// caller, exactly like auto_loop.mjs's runStep() used to do inline.

/**
 * Per-tool-type step timeouts (ms), chosen to match how long the REAL tool
 * implementations actually tend to take for one bounded unit of work
 * (gather one block and its drop, smelt/mine one step, one craft/place
 * call, one short go_to hop) rather than one flat number for every tool.
 * This is a SEPARATE, shorter ceiling than the tool's own much longer
 * internal timeoutMs (GATHER_MS=120000 etc. in src/tools/game/runtime.js)
 * — it exists purely so one slow/stuck real step cannot eat the whole
 * --steps budget, not to replace the tool's own internal deadline.
 */
const LONG_ACTION_TOOLS = new Set(['gather', 'smelt', 'break_block', 'break_area']);
const SHORT_ACTION_TOOLS = new Set(['craft', 'place', 'eat', 'flee']);
const DEFAULT_STEP_TIMEOUT_MS = {
  long: 12000, // gather/smelt/mine-class: real tree/ore mining regularly takes 6-10s
  goTo: 8000, // go_to: short exploration/approach hops
  short: 6000, // craft/place/eat/flee: usually resolves in 1-3s once reachable
  fallback: 8000, // any other tool not explicitly classified above
};

// Count-aware timeout scaling (task 1): once candidates.mjs started sizing
// a `gather` candidate's `args.count` to the WHOLE remaining shortage
// (computeTotalShortage(), capped at GATHER_COUNT_CAP=4) instead of always
// 1, the flat `long` 12000ms ceiling above stopped being enough — asking
// the real gather tool for 3-4 units in one call legitimately takes
// several times as long as mining one block, since it has to re-path to
// (and mine) each additional block in turn. BASE_WITH_COUNT_MS applies ONLY
// to LONG_ACTION_TOOLS (gather/smelt/mine-class) when a finite `count` > 1
// is present on the step's own args — every other tool/step shape keeps
// exactly the old DEFAULT_STEP_TIMEOUT_MS behavior unchanged.
const COUNT_AWARE_BASE_MS = 6000;
const COUNT_AWARE_PER_UNIT_MS = 5000;

/**
 * Resolve the per-step timeout for one tool call: start from the per-tool-
 * type default above (or, for a LONG_ACTION_TOOLS step with a finite
 * `count` arg > 1, the count-scaled `6000ms + count * 5000ms` formula —
 * see COUNT_AWARE_BASE_MS/COUNT_AWARE_PER_UNIT_MS above), then apply
 * `overrideCap` (the CLI's --step-timeout-ms, when given) as an upper
 * bound — never a value LARGER than what the caller explicitly capped it
 * at, but never silently forced down to one flat number for every tool
 * either. Fixes a real false-failure bug: a previous flat 5000ms default
 * made a real `gather` call (which can legitimately take several seconds
 * to path to a tree and mine it) get aborted and recorded as a failure
 * almost every time.
 *
 * @param {string} toolName
 * @param {number|null} [overrideCap]
 * @param {number} [count]  the step's own args.count, when known (task 1);
 *   omitted/non-finite/<=1 falls back to the old flat per-tool-type
 *   default exactly as before this upgrade.
 */
export function timeoutMsForTool(toolName, overrideCap, count) {
  const isLongAction = LONG_ACTION_TOOLS.has(toolName);
  const hasScalableCount = isLongAction && Number.isFinite(count) && count > 1;
  const base = hasScalableCount
    ? COUNT_AWARE_BASE_MS + count * COUNT_AWARE_PER_UNIT_MS
    : isLongAction
      ? DEFAULT_STEP_TIMEOUT_MS.long
      : toolName === 'go_to'
        ? DEFAULT_STEP_TIMEOUT_MS.goTo
        : SHORT_ACTION_TOOLS.has(toolName)
          ? DEFAULT_STEP_TIMEOUT_MS.short
          : DEFAULT_STEP_TIMEOUT_MS.fallback;
  return Number.isFinite(overrideCap) && overrideCap > 0 ? Math.min(base, overrideCap) : base;
}

/**
 * Run one real game tool with a step-local AbortController tied to its
 * timeout, instead of only racing a bare Promise.race() with no signal at
 * all.
 *
 * Why this matters (root cause of a `MaxListenersExceededWarning: N
 * pi_hit listeners` seen over a run of real steps): src/tools/game/core.js
 * (a base file this task must not modify) attaches `bot.on('pi_hit',
 * onHit)` for every body-tool call and removes it in a `finally` — but that
 * `finally` only runs once the tool's OWN internal runner.run() settles,
 * which waits up to its own per-tool timeoutMs default (GATHER_MS=120000,
 * CRAFT_MS=60000, SMELT_MS=120000, etc. — see src/tools/game/runtime.js).
 * Calling `tool.execute(decisionId, args, undefined)` with `signal` always
 * undefined, then racing a SEPARATE outer timeout against it, would leave
 * the real tool call — and its still-attached `pi_hit` listener — running
 * in the background until ITS OWN internal timeout fired once the outer
 * race lost. Passing a real AbortSignal into tool.execute() makes
 * core.js's own `runner.run(toolName, invoke, { signal, timeoutMs })`
 * forward the abort into its internal controller immediately, so the
 * tool's own `finally` (and therefore `bot.off('pi_hit', onHit)`) runs
 * promptly on timeout instead of only after the tool's own much longer
 * internal deadline. No src/ file is touched — this only supplies the
 * signal argument core.js's `execute(_id, args, signal)` already accepts.
 */
export function runToolWithAbort(tool, decisionId, args, ms, label) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label} timed out after ${ms}ms`));
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([tool.execute(decisionId, args, controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Check whether a step's declared `requires` are satisfied by the CURRENT
 * inventory/nearbyBlocks right before that step actually runs — same shape
 * candidates.mjs's own requiresSatisfied() checks (`{inv,count}` or
 * `{block}` or `{dimension}`), reimplemented here as a tiny standalone
 * check (candidates.mjs does not export its own) purely as a light
 * pre-flight guard for a multi-step macro: if the state drifted between
 * steps (e.g. a block despawned, inventory got consumed differently than
 * expected) the macro stops cleanly with a clear code instead of calling a
 * real tool doomed to fail against stale args.
 */
export function requiresStillSatisfied(requires, inventory, nearbyBlocks, dimension) {
  if (!Array.isArray(requires)) return true;
  return requires.every(req => {
    if (req.inv !== undefined) return (inventory?.[req.inv] ?? 0) >= (req.count ?? 1);
    if (req.block !== undefined) return (nearbyBlocks ?? []).includes(req.block);
    if (req.dimension !== undefined) return dimension === req.dimension;
    return false;
  });
}

/**
 * Task 2 ("半路跳过"): is a step's declared `ensures` ALREADY true of the
 * CURRENT inventory/nearbyBlocks/dimension, meaning this step's own goal
 * is already met and running its real tool call again would be pure
 * redundant (and possibly tool-rejected) labor? Same `{inv,count}` /
 * `{block}` / `{dimension}` shape every ensures/requires array in this
 * codebase uses. An empty/missing `ensures` (no declared effect at all —
 * e.g. a safety/explore step) is never "already satisfied": there is
 * nothing to check, so there is nothing to skip, keeping this
 * conservative by construction.
 */
export function ensuresAlreadySatisfied(ensures, inventory, nearbyBlocks, dimension) {
  if (!Array.isArray(ensures) || !ensures.length) return false;
  return ensures.every(e => {
    if (e.inv !== undefined) return (inventory?.[e.inv] ?? 0) >= (e.count ?? 1);
    if (e.block !== undefined) return (nearbyBlocks ?? []).includes(e.block);
    if (e.dimension !== undefined) return dimension === e.dimension;
    return false;
  });
}

/**
 * Physical-result alignment check (final polish round): a tool call can
 * report `ok: true` (its own internal "did the call itself error out"
 * signal) while the WORLD still does not actually show the effect the
 * step claimed (`ensures`) — e.g. a `gather` call "succeeds" against a
 * block that despawned a tick earlier and yields nothing, or a server-side
 * desync briefly reports success with no real inventory change. Comparing
 * the state right before this step ran (`beforeInventory`/
 * `beforeNearbyBlocks`) against the state right after
 * (`afterInventory`/`afterNearbyBlocks`) catches exactly that gap: if
 * `ensures` is declared and NEITHER already held true before the step NOR
 * became true after it, the step's own `ok: true` is almost certainly a
 * "假成功" (false success) that should not be trusted as real progress.
 *
 * Deliberately permissive/conservative in every direction a real
 * alignment checker should be:
 *   - no `ensures` declared at all (e.g. flee/eat/explore steps) has
 *     nothing to verify, so it is always `aligned: true` — this check
 *     only ever flags a step that explicitly PROMISED a concrete,
 *     checkable effect and then did not deliver it;
 *   - `ensures` already true BEFORE the step ran (e.g. the bot already
 *     held enough of the item from an earlier action) stays aligned —
 *     this is not evidence the step itself lied, just that its effect was
 *     redundant;
 *   - a missing/unknown after-state (e.g. the caller could not
 *     re-observe) never reports `aligned: false` on a guess — it reports
 *     `aligned: null` ("unknown", distinct from a confirmed mismatch), so
 *     a genuinely unverifiable round is never misrecorded as a caught lie.
 *
 * Pure, read-only, no bot/network access of its own — both state
 * snapshots are passed in by the caller (executeChosenSteps() below),
 * exactly the same normalized `{inventory, nearbyBlocks, dimension}`
 * shape every other requires/ensures check in this file already uses.
 *
 * @param {object[]} ensures
 * @param {{inventory?: object, nearbyBlocks?: string[], dimension?: string}|null} beforeState
 * @param {{inventory?: object, nearbyBlocks?: string[], dimension?: string}|null} afterState
 * @returns {boolean|null} true (aligned/nothing to check), false (a
 *   declared ensures condition never came true before OR after), or null
 *   (cannot be determined — no afterState to compare against)
 */
export function checkAlignment(ensures, beforeState, afterState) {
  if (!Array.isArray(ensures) || !ensures.length) return true; // nothing declared -> nothing to misalign
  const satisfiedAgainst = state =>
    state
      ? ensures.every(e => {
          if (e.inv !== undefined) return (state.inventory?.[e.inv] ?? 0) >= (e.count ?? 1);
          if (e.block !== undefined) return (state.nearbyBlocks ?? []).includes(e.block);
          if (e.dimension !== undefined) return state.dimension === e.dimension;
          return false;
        })
      : null;
  if (satisfiedAgainst(beforeState) === true) return true; // already true before the step ran -> not this step's claim to verify
  const afterResult = satisfiedAgainst(afterState);
  if (afterResult === null) return null; // no after-state available -> unknown, not a confirmed mismatch
  return afterResult;
}

/**
 * Find the real game tool matching `toolName` in a createGameTools() array.
 */
function findTool(gameTools, toolName) {
  return gameTools.find(t => t.name === toolName) ?? null;
}

/**
 * Re-ground a `place` step's args against a CURRENT position right before
 * that step actually executes, mirroring candidates.mjs's own
 * regroundPlacementArgs() (not imported from there — this module
 * deliberately has no candidates.mjs/decide.mjs dependency of its own, see
 * this file's header comment) so a stitched macro's historical `place`
 * coordinates (deliberate.mjs's relativizeMacroArgs() strips them to
 * `relativePlacement: true` on write) are never fired as stale absolute
 * x/y/z against a world the bot has since moved around in — this matters
 * especially for a multi-step macro's LATER `place` step, executed after
 * the bot has already moved from wherever it was when this round's
 * candidate was first proposed/re-grounded by candidates.mjs.
 *
 * `args.relativePlacement` missing (every non-place tool, or a place args
 * object that was never marked relative) passes through unchanged — this
 * is purely additive/backward-compatible with a plain already-concrete
 * place call.
 *
 * @param {string} tool
 * @param {object} args
 * @param {{x:number,y:number,z:number}|null|undefined} pos
 */
function regroundPlacementArgsAtExecution(tool, args, pos) {
  const a = args ?? {};
  if (tool !== 'place' || !a.relativePlacement) return a;
  const { relativePlacement, ...rest } = a;
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return rest;
  return { ...rest, x: Math.floor(pos.x) + 1, y: Math.floor(pos.y), z: Math.floor(pos.z) };
}

/**
 * Execute one chosen candidate: either a single real tool call (the common
 * case), or — when `chosen.steps` is a validated 2-3 step chain from a
 * stitched multi-step macro (see deliberate.mjs's extractMultiStepMacros())
 * — each step IN ORDER, stopping immediately at the first failure.
 *
 * Each step gets its own fresh AbortController/timeout (via
 * runToolWithAbort, sized by timeoutMsForTool() for THAT step's own tool —
 * a `smelt` step inside a chain still gets the long-action timeout even if
 * the chain's first step was a quick `craft`) and its own requires
 * pre-check against a freshly re-observed state, so a macro never blindly
 * fires stale args at a world that has since changed.
 *
 * Only ok:true when EVERY step in the chain (or the lone single step)
 * succeeded; any failure anywhere stops the whole macro right there and
 * reports that step's own code, with `stepsCompleted` showing how far it
 * got — this never partially-credits a macro as successful.
 *
 * @param {object} opts
 * @param {object} opts.bot        live mineflayer bot (or a test double)
 * @param {Function} opts.observe  observation function (same shape auto_loop.mjs/
 *   tools_adapter.mjs pass into liveNormalizedState())
 * @param {object[]} opts.gameTools  createGameTools() output (or a test double array)
 * @param {object} opts.chosen    the chosen candidate (may carry `steps`)
 * @param {string} opts.decisionId
 * @param {number|null} [opts.overrideCap]  --step-timeout-ms style cap, or null
 * @param {Function} [opts.liveNormalizedState]  (bot, observe) -> normalized
 *   state; defaults to a minimal inline version so this module needs no
 *   import from candidates.mjs/auto_loop.mjs — callers that already have
 *   their own (e.g. auto_loop.mjs) may inject it so there is exactly one
 *   implementation of the observe->normalize step in the real run path.
 * @returns {Promise<{ok: boolean, code: string, stepsCompleted: number, stepsTotal: number}>}
 */
// Same "drop everything and flee" threshold candidates.mjs's own
// nearbyHostiles safety candidate uses: a hostile that walked into melee
// range BETWEEN two steps of a multi-step macro (the whole point of this
// mid-macro guard — the world moves between steps, a macro template
// cannot see that) must stop the chain right there, exactly like a fresh
// decide.mjs round would have offered `flee` instead of continuing the
// production chain had it re-observed from scratch.
function hasAdjacentHostileThreat(freshState) {
  return Number.isFinite(freshState?.nearbyHostiles) && freshState.nearbyHostiles > 0;
}

export async function executeChosenSteps({ bot, observe, gameTools, chosen, decisionId, overrideCap, liveNormalizedState }) {
  const steps = Array.isArray(chosen.steps) && chosen.steps.length > 1
    ? chosen.steps
    : [{ key: chosen.key, tool: chosen.tool, args: chosen.args, requires: chosen.requires, ensures: chosen.ensures }];

  let stepsCompleted = 0;
  // Per-step results for every step that actually ran and SUCCEEDED, kept
  // around so a mid-chain interruption can report "steps 1..k-1 genuinely
  // succeeded, step k is what broke" instead of only a bare count — this is
  // what lets environment B's macro_flow_summary (deliberate.mjs) tell a
  // chain that fully completed apart from "never even got going" from one
  // that quit on step 1 (see this function's return shape doc comment).
  const completedStepKeys = [];
  // Alignment check (final polish round, see checkAlignment()'s doc
  // comment): one entry per step that actually ran its real tool call
  // (skipped/never-reached steps never get an entry), `true`/`false`/
  // `null` in call order — surfaced on the return value as
  // `alignmentResults`/overall `aligned` so auto_loop.mjs/tools_adapter.mjs
  // can flag a "假成功" (tool said ok:true but the world never actually
  // changed) in the outcome record without ever silently treating it as
  // ordinary success feeding deliberate.mjs's learning math.
  const alignmentResults = [];
  // Current position, best-effort: bot.entity.position for the very first
  // step (always live/current), refreshed from each subsequent step's own
  // freshState.pos once re-observed below — used only to re-ground a
  // `place` step's relative args (regroundPlacementArgsAtExecution()); a
  // non-place step ignores this entirely.
  let currentPos = bot?.entity?.position ?? null;
  // Best-known normalized state snapshot, refreshed every time this
  // function re-observes for ANY reason (mid-chain pre-check, or the
  // alignment post-check below) — reused as the "before" snapshot for
  // whichever step runs next, so a chain never pays for more than one
  // observe() call per step boundary.
  let lastKnownState = null;

  for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
    const step = steps[stepIdx];
    // Pre-check requires AND a point-blank hostile threat against a
    // freshly re-observed state for every step AFTER the first (the first
    // step's requires were already the basis candidates.mjs/decide.mjs
    // picked this candidate on this round, so re-observing before it too
    // would just be a redundant extra observe() call with no new
    // information; a hostile already being in range at the moment of
    // proposal is likewise something decide.mjs's own safety candidates
    // already had the chance to react to before this macro was ever
    // chosen). This is the mid-macro "optimistic lock": a stitched macro
    // commits to several steps worth of real-world tool calls, so the
    // world — a block despawning, inventory draining differently than
    // expected, a zombie walking up mid-chain — must be allowed to break
    // the commitment cleanly rather than the macro blindly firing stale
    // args/ignoring new danger.
    if (stepsCompleted > 0 && typeof liveNormalizedState === 'function') {
      const freshState = await liveNormalizedState(bot, observe);
      lastKnownState = freshState; // becomes this step's "before" snapshot for the alignment check below
      if (hasAdjacentHostileThreat(freshState)) {
        return {
          ok: false,
          code: `macro_step_${stepsCompleted + 1}_hostile_nearby`,
          stepsCompleted,
          stepsTotal: steps.length,
          breakAt: stepsCompleted + 1,
          breakReason: 'hostile_nearby',
          completedStepKeys: [...completedStepKeys],
        };
      }

      // Task 2 ("半路跳过"): if THIS step's own declared `ensures` is
      // already true of the current world (e.g. an earlier step's real
      // side effect also happened to satisfy a later step's goal, or the
      // bot already picked up a stray drop of the same resource), running
      // it again would be pure wasted labor and risks a spurious "break"
      // if the real tool refuses a redundant call (e.g. "already have
      // enough planks"). Skip straight to the NEXT step without calling
      // any tool, crediting this one as completed — this is a genuine
      // skip, not a failure, so stepsCompleted/completedStepKeys advance
      // exactly as if the step had actually run and succeeded. Checked
      // AFTER the hostile-threat guard (a threat still must interrupt the
      // chain even if this step's goal happens to already be met) but
      // BEFORE the requires check below (an already-satisfied step's own
      // requires are moot — there is nothing left to gate).
      if (ensuresAlreadySatisfied(step.ensures, freshState.inventory, freshState.nearbyBlocks, freshState.dimension)) {
        stepsCompleted += 1;
        completedStepKeys.push(step.key ?? null);
        if (freshState.pos) currentPos = freshState.pos;
        continue;
      }

      if (!requiresStillSatisfied(step.requires, freshState.inventory, freshState.nearbyBlocks, freshState.dimension)) {
        return {
          ok: false,
          code: `macro_step_${stepsCompleted + 1}_requires_unmet`,
          stepsCompleted,
          stepsTotal: steps.length,
          breakAt: stepsCompleted + 1,
          breakReason: 'requires_unmet',
          completedStepKeys: [...completedStepKeys],
        };
      }
      if (freshState.pos) currentPos = freshState.pos;
    }

    const tool = findTool(gameTools, step.tool);
    if (!tool) {
      return {
        ok: false,
        code: `macro_step_${stepsCompleted + 1}_tool_not_found`,
        stepsCompleted,
        stepsTotal: steps.length,
        breakAt: stepsCompleted + 1,
        breakReason: 'tool_not_found',
        completedStepKeys: [...completedStepKeys],
      };
    }

    // Re-ground a relative `place` step's x/y/z against the CURRENT
    // position right before this step runs (see
    // regroundPlacementArgsAtExecution()'s doc comment) — never whatever
    // frozen historical coordinate the stitched macro template carried.
    const execArgs = regroundPlacementArgsAtExecution(step.tool, step.args, currentPos);

    const timeoutMs = timeoutMsForTool(step.tool, overrideCap, execArgs?.count);
    let result;
    try {
      result = await runToolWithAbort(tool, `${decisionId}-s${stepsCompleted + 1}`, execArgs, timeoutMs, step.tool);
    } catch (error) {
      // Partial-gather credit (root-cause repair round): real log evidence
      // showed `gather(count:3)` legitimately mining 2 of the 3 requested
      // logs before this step's own OUTER timeout (see timeoutMsForTool())
      // fired — the real tool call was genuinely making progress, not
      // stuck, and the previous behavior (blaming the whole step as a flat
      // failure) threw away a real inventory gain and fed decide.mjs a
      // wrong "this failed" signal for a step that actually mostly
      // succeeded. On a TIMEOUT (never on any other exception — a network
      // drop/crash is not "progress", it's a real failure) for a `gather`
      // step specifically, re-observe once and compare the step's own
      // declared `ensures` target against the BEFORE snapshot
      // (`lastKnownState`, or this chain's very first step has no snapshot
      // yet — see below): if the target inventory count genuinely went up,
      // credit this as `ok: true, code: 'partial_gather'` instead of a
      // hard failure, continuing the chain exactly like any other
      // successful step (stepsCompleted/completedStepKeys advance, and the
      // alignment check below still runs against the real before/after
      // state it already has).
      const isTimeout = /timed out after/.test(String(error?.message ?? error));
      if (isTimeout && step.tool === 'gather' && typeof liveNormalizedState === 'function') {
        const targetName = step.args?.block ?? step.ensures?.find(e => e.inv)?.inv ?? null;
        if (targetName) {
          try {
            // beforeCount: 0 both when lastKnownState is null (this
            // chain's very first step, nothing observed yet) and when the
            // target genuinely was not held before — either way, "0" is
            // the correct baseline to compare the AFTER snapshot against;
            // there is no third, different meaning for "unknown" here, so
            // this deliberately does not require lastKnownState to exist
            // first the way checkAlignment()'s own beforeState does.
            const beforeCount = lastKnownState?.inventory?.[targetName] ?? 0;
            const freshAfterTimeout = await liveNormalizedState(bot, observe);
            const afterCount = freshAfterTimeout?.inventory?.[targetName] ?? 0;
            if (afterCount > beforeCount) {
              const beforeStateForAlignment = lastKnownState;
              lastKnownState = freshAfterTimeout;
              if (freshAfterTimeout.pos) currentPos = freshAfterTimeout.pos;
              alignmentResults.push(checkAlignment(step.ensures, beforeStateForAlignment, freshAfterTimeout));
              stepsCompleted += 1;
              completedStepKeys.push(step.key ?? null);
              continue;
            }
            // Timed out AND no gain at all: fall through to the ordinary
            // timeout failure below — this is a genuine stuck/unproductive
            // call (e.g. mining a tree with drops stuck in leaves), not
            // partial progress worth crediting.
          } catch {
            // Re-observe itself failed: cannot verify partial progress,
            // fall through to the ordinary timeout failure below.
          }
        }
      }
      return {
        ok: false,
        code: String(error?.message ?? error).slice(0, 64),
        stepsCompleted,
        stepsTotal: steps.length,
        breakAt: stepsCompleted + 1,
        breakReason: 'exception',
        completedStepKeys: [...completedStepKeys],
      };
    }
    const stepOk = !result?.isError;
    if (!stepOk) {
      const code = String(result?.content?.[0]?.text ?? 'tool_error').slice(0, 64);
      return {
        ok: false,
        code,
        stepsCompleted,
        stepsTotal: steps.length,
        breakAt: stepsCompleted + 1,
        breakReason: 'tool_error',
        completedStepKeys: [...completedStepKeys],
      };
    }

    // Drops-missed downgrade (root-cause repair round): the real `gather`
    // tool (src/tools/game/gathering.js, a locked base file this task must
    // not modify) can report `isError: false` (the tool call itself did
    // not throw) while its OWN response payload explicitly says
    // `dropsMissed` — "mined blocks but no drops reached your inventory;
    // they may be stuck in leaves, water or out of reach" — i.e. a
    // confirmed "假成功" the tool itself already knows about, not merely
    // this module's own after-the-fact alignment guess. Blindly treating
    // that as a full `ok: true` success (as before this fix) fed
    // deliberate.mjs a reward signal for a step that produced ZERO real
    // inventory gain. Detected by checking the response text for the
    // tool's own `dropsMissed` marker string — scoped to `gather` steps
    // only, since no other tool emits this field.
    if (step.tool === 'gather') {
      const responseText = String(result?.content?.[0]?.text ?? '');
      if (/dropsMissed|no drops reached your inventory/.test(responseText)) {
        return {
          ok: false,
          code: 'drops_missed',
          stepsCompleted,
          stepsTotal: steps.length,
          breakAt: stepsCompleted + 1,
          breakReason: 'drops_missed',
          completedStepKeys: [...completedStepKeys],
        };
      }
    }

    // Physical-result alignment check (final polish round): the tool call
    // itself just reported ok:true — now actually verify the world shows
    // the effect this step CLAIMED (`step.ensures`), instead of trusting
    // the tool's own "ok" at face value. Re-observes once more (reusing
    // `liveNormalizedState`, the SAME observe path every other re-check in
    // this function already uses) to get the AFTER snapshot; `lastKnownState`
    // (set above, or null for this chain's very first step — see
    // checkAlignment()'s own "no afterState" -> null contract) is the
    // BEFORE snapshot. Never throws/blocks execution on a mismatch — a
    // misaligned step still counts as completed exactly as before (this
    // check is diagnostic/observational, not a new way to fail a macro);
    // it only ever ADDS the `aligned` signal onto the per-step record for
    // the caller (auto_loop.mjs/tools_adapter.mjs) to log/flag.
    const beforeStateForAlignment = lastKnownState;
    let afterStateForAlignment = null;
    if (typeof liveNormalizedState === 'function') {
      try {
        afterStateForAlignment = await liveNormalizedState(bot, observe);
        lastKnownState = afterStateForAlignment; // doubles as the NEXT step's "before" snapshot, no extra observe() needed
        if (afterStateForAlignment.pos) currentPos = afterStateForAlignment.pos;
      } catch {
        // best-effort: a failed re-observe only means "alignment unknown
        // for this step", never a reason to fail an otherwise-successful
        // tool call.
        afterStateForAlignment = null;
      }
    }
    alignmentResults.push(checkAlignment(step.ensures, beforeStateForAlignment, afterStateForAlignment));

    stepsCompleted += 1;
    completedStepKeys.push(step.key ?? null);
  }

  // Overall `aligned`: false if ANY step that actually ran came back a
  // CONFIRMED mismatch (false); true only if every step that could be
  // checked was aligned AND at least one step actually had something
  // checkable; null when nothing could be verified either way (e.g. no
  // liveNormalizedState injected at all, or every step had no `ensures`
  // to check) — kept distinct from `true` so a caller never mistakes "we
  // never actually checked" for "we checked and it was fine".
  const hasConfirmedMismatch = alignmentResults.some(a => a === false);
  const hasAnyCheckedTrue = alignmentResults.some(a => a === true);
  const overallAligned = hasConfirmedMismatch ? false : hasAnyCheckedTrue ? true : null;

  return {
    ok: true,
    code: steps.length > 1 ? 'macro_executed' : 'executed',
    stepsCompleted,
    stepsTotal: steps.length,
    breakAt: null,
    breakReason: null,
    aligned: overallAligned,
    alignmentResults: [...alignmentResults],
    completedStepKeys,
  };
}
