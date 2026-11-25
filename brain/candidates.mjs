// brain/candidates.mjs — environment A, generation half: turn a raw world
// observation into a flat, deterministic state plus a pool of concrete,
// currently-executable candidate actions (the "collage" the low-dimensional
// decider in decide.mjs picks from).
//
// Pure and read-only with respect to decisions.jsonl: this module never
// imports stream.mjs/slice.mjs. It only looks at the observation handed to
// it (and, optionally, Wiki-verified stitched macros handed in by the
// caller) — never at raw history.
//
// recipe_planner.mjs (also pure, no bot/decisions.jsonl) supplies the
// tool-progression chain's next craft/place/gather step via minecraft-data
// + prismarine-recipe recipe expansion, replacing what used to be a
// hand-written if-chain per target item (and fixing a real gap the old
// hand-written wooden_pickaxe branch had: it never accounted for sticks).

import { planNextForTarget, computeTotalShortage } from './recipe_planner.mjs';

// Task 1: single-step-starvation fix. A `gather` candidate used to always
// ask for 1 unit — fine for the FIRST log, but once planks/the table/
// sticks/the pickaxe itself all turn out to need MORE than that one log,
// the bot kept re-discovering the shortfall one round (and one more log)
// at a time. GATHER_COUNT_CAP bounds how large a single `gather` call's
// `args.count` is ever allowed to grow to in one go, regardless of how big
// the real total shortage is — a single real gather tool call already
// walks to/mines one block at a time internally and can run long; asking
// for the ENTIRE remaining gap (which could be large after a death/
// inventory wipe) in one call risks an unbounded-length single action
// instead of several shorter, individually-progress-tracked ones.
//
// Root-cause repair round: lowered from 4 to 2. Real log evidence showed
// `gather(count:3)` legitimately taking 21s and getting cut off by
// macro_executor.mjs's count-scaled timeout (6000 + count*5000ms) right
// as it had already mined 2 of the 3 requested logs — a real tool call
// asking for 3-4 units at once routinely needs more re-pathing/re-mining
// than the timeout budget comfortably covers. At count<=2 the same
// formula gives 16000ms (6000+2*5000), which in the live re-test
// comfortably covers one real gather call; macro_executor.mjs additionally
// now credits a timeout that still produced a real inventory gain as
// `partial_gather` (see its own doc comment) rather than blaming the whole
// call, as a second line of defense for the rare case where even 2 units
// runs long.
const GATHER_COUNT_CAP = 2;

/**
 * How many more units of `leafResourceName` should a gather candidate for
 * it ask for THIS round, given the whole-package total shortage already
 * computed for the bot's current progression target (see
 * computeTotalShortage()'s doc comment)? Falls back to 1 (the old,
 * always-one-unit behavior) when the target has no known shortage for this
 * resource at all (e.g. the shortage map came back empty, or this resource
 * is not actually on the path to the current target) — this is purely
 * additive: a caller that never had a shortageMap for this resource before
 * sees no behavior change.
 */
function gatherCountFor(shortageMap, leafResourceName) {
  const needed = shortageMap?.[leafResourceName];
  if (!Number.isFinite(needed) || needed <= 0) return 1;
  return Math.max(1, Math.min(GATHER_COUNT_CAP, Math.round(needed)));
}

const WOOD_LOG_NAMES = new Set([
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'bamboo_block',
]);

const COBBLESTONE_LIKE_NAMES = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate']);

// Ground-block-aware exploration/placement fix (root-cause repair round):
// real-log evidence showed `move:explore_*`/`place:crafting_table` blindly
// using `Math.floor(s.pos.y)` for every target — on hilly/mountainous
// terrain the target cell ends up half-buried in a hillside or hanging
// over a cliff edge, which is exactly what produced the repeated real
// `go_to` failures ("No route exists" / "stuck jumping in place") and
// `place` failures ("No solid block touches ..., so it needs a support")
// seen in the 3-episode live test. SOLID_GROUND_NAMES is the set of block
// names treated as "a real, walkable/placeable surface" when picking a
// target cell from `state.nearbyGroundBlocks` (see normalizeObsState()
// below) — deliberately generic terrain/ground block names, not ore/log/
// decoration names, since those are never good footing to stand a target
// cell on.
const SOLID_GROUND_NAMES = new Set([
  'grass_block',
  'dirt',
  'coarse_dirt',
  'podzol',
  'mycelium',
  'stone',
  'cobblestone',
  'deepslate',
  'cobbled_deepslate',
  'sand',
  'red_sand',
  'gravel',
  'sandstone',
  'terracotta',
  'clay',
  'snow_block',
  'ice',
  'packed_ice',
  'netherrack',
  'end_stone',
  'moss_block',
]);

// iron ore block names: mining either with a stone (or better) pickaxe
// drops raw_iron directly — the real `gather` tool's own block-name
// parameter is a single concrete name, so both ore variants need their own
// candidate id/key the same way gather:wood_log picks one concrete log
// species per round above.
const IRON_ORE_NAMES = new Set(['iron_ore', 'deepslate_iron_ore']);

const HOSTILE_MOB_NAMES = new Set([
  'zombie',
  'skeleton',
  'spider',
  'cave_spider',
  'creeper',
  'enderman',
  'witch',
  'drowned',
  'husk',
  'phantom',
  'pillager',
  'vindicator',
  'evoker',
  'blaze',
  'ghast',
  'magma_cube',
  'slime',
  'stray',
]);

/**
 * Compress the output of createObservation() (or an equivalent live read)
 * into a flat, JSON-safe snapshot that every downstream pure function in
 * this module (and decide.mjs) can work from without touching mineflayer
 * objects. Pure: never reads `decisions.jsonl`, never touches the network.
 *
 * `obsState.dimension` is read as a plain field (default null) — callers
 * that have a live `bot` (tools_adapter.mjs, run_win.mjs) are responsible
 * for merging `bot.game.dimension` into the object they pass in here;
 * normalizeObsState itself never reaches into a bot/game object.
 *
 * @param {object} obsState shape produced by src/tools/game/observation.js's
 *   createObservation(), optionally with an extra `dimension` field merged in
 * @returns {object} { pos, health, food, dimension, inventory, nearbyBlocks, nearbyHostiles }
 */
// src/tools/game/combat.js's real `flee` tool only reacts to hostiles
// within 16 blocks (`hostilesWithin(16)`) — it literally refuses to flee
// ("no hostile is within 16 blocks") if asked to react to something
// farther out. Threat detection here is kept slightly tighter than that
// (14 blocks) so a `flee` candidate is only ever offered when the real
// tool can actually ground it, now that observe() scans out to 48 blocks
// for production candidates (gather/craft targets) and would otherwise
// see — and over-react to — hostiles the flee tool itself cannot reach.
const HOSTILE_THREAT_RANGE = 14;

function distance3(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Pick the best REAL ground block in roughly the given horizontal
 * direction `(dirDx, dirDz)`, among `groundBlocks` (see
 * normalizeObsState()'s `nearbyGroundBlocks` — each entry already carries
 * a real, observed `{name, position}`), within `[minDist, maxDist]` of
 * `pos`. "Roughly that direction" is a positive dot product between the
 * candidate block's offset from `pos` and the requested direction vector
 * — this does not need to be exactly on the compass line, just generally
 * the right way, since the real `go_to` tool already pathfinds the final
 * approach. Among matches, prefers the FARTHEST one within range (more
 * actual ground covered per hop, same intent the old fixed-10-block
 * `move:explore_*` offset had), breaking ties by smallest angular
 * deviation from the exact requested direction.
 *
 * Pure: no bot/network access, only arithmetic over the already-observed
 * `groundBlocks` array.
 *
 * @param {{x:number,y:number,z:number}} pos
 * @param {number} dirDx
 * @param {number} dirDz
 * @param {object[]} groundBlocks  `nearbyGroundBlocks` entries
 * @param {number} [minDist=5]
 * @param {number} [maxDist=10]
 * @returns {{x:number,y:number,z:number}|null}  a REAL observed ground
 *   block's position (the caller adds +1 to y to stand ON it), or null
 *   when nothing in `groundBlocks` falls in that direction/range — the
 *   caller falls back to the old flat-y heuristic in that case, so this
 *   is purely an upgrade, never a new way to withhold a candidate
 *   entirely.
 */
function pickGroundTargetInDirection(pos, dirDx, dirDz, groundBlocks, minDist = 5, maxDist = 10) {
  if (!pos || !Array.isArray(groundBlocks) || !groundBlocks.length) return null;
  const dirLen = Math.sqrt(dirDx * dirDx + dirDz * dirDz) || 1;
  const ndx = dirDx / dirLen;
  const ndz = dirDz / dirLen;

  let best = null;
  let bestScore = -Infinity;
  for (const b of groundBlocks) {
    const bx = b.position.x;
    const bz = b.position.z;
    const offDx = bx - pos.x;
    const offDz = bz - pos.z;
    const horizDist = Math.sqrt(offDx * offDx + offDz * offDz);
    if (horizDist < minDist || horizDist > maxDist) continue;
    const dot = (offDx * ndx + offDz * ndz) / (horizDist || 1); // cos(angle), 1 = exact direction
    if (dot <= 0.3) continue; // roughly "that way", not sideways/behind
    // Prefer farther (more ground covered) first, then straighter
    // alignment with the requested direction as a tie-break.
    const score = horizDist * 10 + dot;
    if (score > bestScore) {
      bestScore = score;
      best = { x: b.position.x, y: b.position.y, z: b.position.z };
    }
  }
  return best;
}

/**
 * Pick the nearest REAL ground block within `maxDist` of `pos` (any
 * direction), for `place:crafting_table`'s own target cell — a table must
 * land on genuine footing, not float over a cliff edge or clip into a
 * slope, which is exactly the real "No solid block touches ..., so it
 * needs a support" failure seen in the live 3-episode test. Falls back to
 * null (caller uses the old flat-y heuristic) when nothing is in range —
 * same non-withholding contract as pickGroundTargetInDirection() above.
 *
 * @param {{x:number,y:number,z:number}} pos
 * @param {object[]} groundBlocks
 * @param {number} [maxDist=3]
 * @returns {{x:number,y:number,z:number}|null}
 */
function pickNearestGroundTarget(pos, groundBlocks, maxDist = 3) {
  if (!pos || !Array.isArray(groundBlocks) || !groundBlocks.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const b of groundBlocks) {
    const d = distance3(pos, b.position);
    if (d <= maxDist && d < bestDist) {
      bestDist = d;
      best = { x: b.position.x, y: b.position.y, z: b.position.z };
    }
  }
  return best;
}

export function normalizeObsState(obsState) {
  const s = obsState ?? {};
  const pos = s.position && Number.isFinite(s.position.x) ? { x: s.position.x, y: s.position.y, z: s.position.z } : null;

  const inventory = {};
  const items = s.inventory?.items ?? [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.name) continue;
    const count = Number.isFinite(item.count) ? item.count : 0;
    inventory[item.name] = (inventory[item.name] ?? 0) + count;
  }

  const blocks = Array.isArray(s.blocks) ? s.blocks : [];
  const nearbyBlocks = blocks.map(b => b?.name).filter(Boolean);

  // nearbyGroundBlocks (root-cause repair round): every visible block whose
  // name is in SOLID_GROUND_NAMES, carrying its real position — this is
  // what lets move:explore_*/place:crafting_table below pick an ACTUAL
  // walkable/placeable surface cell instead of blindly reusing the bot's
  // own current y at an arbitrary x/z offset (which on hilly terrain is
  // routinely half-buried in a hillside or hanging over a drop). Kept as
  // its own array (not folded into nearbyBlocks, which stays name-only for
  // every existing caller) so this is purely additive.
  const nearbyGroundBlocks = blocks.filter(b => b?.name && SOLID_GROUND_NAMES.has(b.name) && b.position && Number.isFinite(b.position.x));

  // Nearest actual crafting_table BLOCK position (not just "is the name in
  // nearbyBlocks"), so a table-requiring craft can tell "already in reach"
  // apart from "visible but far away and needs a go_to leg first" — see
  // recipe_planner.mjs's tableAvailable()/TABLE_REACH usage below.
  const tableBlocks = blocks.filter(b => b?.name === 'crafting_table' && b.position && Number.isFinite(b.position.x));
  let nearbyTablePos = null;
  if (pos && tableBlocks.length) {
    let best = null;
    let bestDist = Infinity;
    for (const b of tableBlocks) {
      const d = distance3(pos, b.position);
      if (d < bestDist) {
        bestDist = d;
        best = { x: b.position.x, y: b.position.y, z: b.position.z };
      }
    }
    nearbyTablePos = best;
  }

  const entities = Array.isArray(s.entities) ? s.entities : [];
  const nearbyHostiles = entities.filter(e => {
    if (!HOSTILE_MOB_NAMES.has(e?.name)) return false;
    // No known position for either side: cannot verify range, so do not
    // count it as a close threat (fail closed toward "not a flee reason",
    // matching the real flee tool's own "no hostile is within 16 blocks"
    // behavior when it cannot ground a target either).
    if (!pos || !e?.position) return false;
    return distance3(pos, e.position) <= HOSTILE_THREAT_RANGE;
  }).length;

  return {
    pos,
    health: Number.isFinite(s.health) ? s.health : null,
    food: Number.isFinite(s.food) ? s.food : null,
    dimension: typeof s.dimension === 'string' ? s.dimension.replace(/^minecraft:/, '') : (s.dimension ?? null),
    inventory,
    nearbyBlocks,
    nearbyGroundBlocks,
    nearbyTablePos,
    nearbyHostiles,
  };
}

function has(inventory, name, count = 1) {
  return (inventory?.[name] ?? 0) >= count;
}

function anyNearby(nearbyBlocks, names) {
  return nearbyBlocks.some(n => names.has(n));
}

/**
 * Does executing `ensures` conditions put the bot over the next route split?
 * Mirrors the shape `wiki.mjs`'s conditionSatisfied() expects: `{inv,count}`
 * or `{dimension}`. An action "hits" the split if at least one of its
 * `ensures` entries would satisfy one of the split's `conditions` once
 * applied — a coarse but safe heuristic since `ensures` describes the
 * concrete inventory/dimension delta the action produces.
 */
function computeHitsNextSplit(ensures, nextSplit) {
  if (!nextSplit || !Array.isArray(nextSplit.conditions) || !Array.isArray(ensures)) return false;
  return nextSplit.conditions.some(cond =>
    ensures.some(e => {
      if (cond.inv !== undefined) return e.inv === cond.inv && (e.count ?? 1) >= (cond.count ?? 1);
      if (cond.dimension !== undefined) return e.dimension === cond.dimension;
      return false;
    }),
  );
}

function makeCandidate(base, nextSplit) {
  const hitsNextSplit = computeHitsNextSplit(base.ensures, nextSplit);
  return {
    id: base.id,
    key: base.key ?? base.id,
    tool: base.tool,
    args: base.args ?? {},
    requires: base.requires ?? [],
    ensures: base.ensures ?? [],
    source: base.source ?? 'atomic',
    isSafety: Boolean(base.isSafety),
    hitsNextSplit,
    // isReserveGather (task 2): true when this is a gather candidate for a
    // resource the inventory ALREADY holds enough of to proceed with the
    // next craft/place step this same round — i.e. gathering more is
    // optional stockpiling, not the only path forward. A real fork in the
    // road: different personas (gather_hoard vs. wiki_drive knobs, see
    // persona.mjs/decide.mjs) can legitimately disagree about whether to
    // take it. Always `false` unless the caller below explicitly sets it;
    // never present at all on a non-gather candidate (kept out of the
    // returned object entirely rather than forced to `false` so a `steps`-
    // bearing stitched macro candidate's shape stays exactly as before).
    ...(base.isReserveGather ? { isReserveGather: true } : {}),
  };
}

/**
 * Re-ground a stitched macro step's `place` args against the CURRENT
 * position, instead of whatever frozen absolute x/y/z it was recorded
 * under the one time it was lifted into policy_snapshot.json (see
 * deliberate.mjs's relativizeMacroArgs(), which strips x/y/z and sets
 * `relativePlacement: true` on write). Mirrors the exact same relative
 * offset the hand-written place:crafting_table candidate above already
 * uses (one block to the side of the bot's feet, at the bot's own floor
 * level) — the real `place` tool only needs SOME adjacent, currently-legal
 * integer cell, not that specific historical one.
 *
 * Pure: reads only the `pos` already carried on the normalized state this
 * module works from; no bot/network access. A step whose args are not
 * marked `relativePlacement` (e.g. every non-place tool, or a place step
 * from before this upgrade) is returned unchanged — this is purely
 * additive/backward-compatible.
 *
 * @param {string|null} tool
 * @param {object} args
 * @param {{x:number,y:number,z:number}|null} pos
 * @returns {object} args with x/y/z resolved against the current position
 *   (or left as-is when there is nothing to resolve, or no position known)
 */
function regroundPlacementArgs(tool, args, pos, groundBlocks = []) {
  const a = args ?? {};
  if (tool !== 'place' || !a.relativePlacement) return a;
  const { relativePlacement, ...rest } = a;
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
    // No current position known: cannot ground a concrete cell this round.
    // Drop the marker but leave x/y/z absent rather than inventing a bogus
    // coordinate — candidates.mjs's own place:crafting_table candidate
    // above already withholds itself entirely when s.pos is null, and a
    // stitched `place` macro with no resolvable cell should behave the
    // same way: callers (e.g. macro_executor.mjs) that see x/y/z missing
    // on a place step simply cannot ground it either.
    return rest;
  }
  // Root-cause repair round: prefer a REAL observed solid ground block
  // within 3 blocks of the bot over the old blind "+1 x, same y, same z"
  // offset — that fixed offset routinely clipped into a slope or hung
  // over a drop on anything but flat terrain, producing the real
  // "No solid block touches ..., so it needs a support" failure seen in
  // the live 3-episode test. Falls back to the exact old formula when no
  // ground block is in range (e.g. a test double with no
  // nearbyGroundBlocks at all), so this is purely an upgrade.
  const groundTarget = pickNearestGroundTarget(pos, groundBlocks, 3);
  if (groundTarget) {
    return { ...rest, x: groundTarget.x, y: groundTarget.y + 1, z: groundTarget.z };
  }
  return {
    ...rest,
    x: Math.floor(pos.x) + 1,
    y: Math.floor(pos.y),
    z: Math.floor(pos.z),
  };
}

/** Wood species -> planks item name, same transform planksNameFor() below uses. */
function planksNameForSpecies(logName) {
  return logName ? logName.replace(/_log$|_block$/, '_planks') : null;
}

/**
 * Object/material "slot" re-binding (task 2): a stitched macro's `gather`
 * step for a wood log (and the `craft` step right after it, for planks)
 * was recorded against whichever ONE species happened to be visible/held
 * the one time this macro was first lifted from real history — e.g.
 * `{block:'oak_log'}` / `{item:'oak_planks'}`. Replaying that frozen
 * species verbatim on a LATER run that spawned in a birch/spruce forest
 * (with no oak anywhere nearby, and none in the inventory either) would
 * try to gather a block that is not actually there, or craft from a plank
 * species never held — dead on arrival exactly the same way a frozen
 * `place` x/y/z would be (see regroundPlacementArgs() above, same
 * "re-derive against CURRENT world state, never the frozen template"
 * principle). This re-derives the step's species slot against the CURRENT
 * normalized state every round:
 *   - a `gather` step whose `args.block` names a wood log is rebound to
 *     whichever species is actually visible nearby right now (falling
 *     back to whatever species is already HELD, so a macro that already
 *     has logs in hand but no more trees in view can still proceed to
 *     craft), or left exactly as recorded if the state has neither (so a
 *     requires-gated stitched macro that legitimately cannot run this
 *     round still fails its OWN requires check downstream rather than
 *     being silently rewritten into something ungroundable);
 *   - a `craft` step whose `args.item` names wood planks is rebound to
 *     match whichever species is ACTUALLY held (never nearby-only — you
 *     cannot craft planks from a tree you have not chopped), falling back
 *     to the state's visible species if nothing is held yet (so the first
 *     step's own gather target and this step's craft target always agree
 *     on species even before the gather has actually run).
 *
 * Every other tool/arg shape (cobblestone/iron_ore — already
 * species-agnostic block names — and every non-wood item) passes through
 * completely unchanged; this is purely additive/backward-compatible with
 * a macro step that already matches the current species exactly (the
 * common case once a macro has been running against a stable world).
 *
 * @param {string|null} tool
 * @param {object} args
 * @param {object} state  normalizeObsState() output (inventory/nearbyBlocks)
 * @returns {object}
 */
function regroundSlotArgs(tool, args, state) {
  const a = args ?? {};
  const nearby = state?.nearbyBlocks ?? [];
  const inv = state?.inventory ?? {};

  if (tool === 'gather' && typeof a.block === 'string' && WOOD_LOG_NAMES.has(a.block)) {
    const visibleSpecies = nearby.find(n => WOOD_LOG_NAMES.has(n));
    const heldSpecies = [...WOOD_LOG_NAMES].find(name => (inv[name] ?? 0) > 0);
    const resolved = visibleSpecies ?? heldSpecies ?? a.block;
    if (resolved === a.block) return a;
    return { ...a, block: resolved };
  }

  if (tool === 'craft' && typeof a.item === 'string' && /_planks$/.test(a.item)) {
    const heldSpecies = [...WOOD_LOG_NAMES].find(name => (inv[name] ?? 0) > 0);
    const visibleSpecies = nearby.find(n => WOOD_LOG_NAMES.has(n));
    const resolvedSpecies = heldSpecies ?? visibleSpecies ?? null;
    const resolvedPlanks = resolvedSpecies ? planksNameForSpecies(resolvedSpecies) : null;
    if (!resolvedPlanks || resolvedPlanks === a.item) return a;
    return { ...a, item: resolvedPlanks };
  }

  return a;
}

/**
 * Check whether a stitched macro's declared `requires` are satisfied by the
 * current normalized state. `requires` entries use the same shape as a
 * candidate's own `requires`: `{inv,count}` (inventory) or `{block}`
 * (a nearby block name) or `{dimension}`.
 */
function requiresSatisfied(requires, state) {
  if (!Array.isArray(requires)) return true;
  return requires.every(req => {
    if (req.inv !== undefined) return has(state.inventory, req.inv, req.count ?? 1);
    if (req.block !== undefined) return state.nearbyBlocks.includes(req.block);
    if (req.dimension !== undefined) return state.dimension === req.dimension;
    return false;
  });
}

/**
 * Task 2 ("半路跳过"): is a step's declared `ensures` ALREADY true of the
 * current state, meaning running that step again this round would be pure
 * redundant labor (e.g. the inventory already holds the planks/sticks this
 * step exists to produce, from some earlier unrelated action)? Same
 * `{inv,count}` shape `ensures` entries always use elsewhere in this
 * codebase (candidates.mjs's computeHitsNextSplit(), macro_executor.mjs's
 * requiresStillSatisfied() for `requires`) — an empty/missing `ensures`
 * array (a step with no declared effect, or a safety/explore step) is
 * never considered "already satisfied" (there is nothing to check, so
 * there is nothing to skip), which keeps this conservative: only a step
 * with an EXPLICIT, ALREADY-true effect is ever skipped.
 */
function ensuresAlreadySatisfied(ensures, state) {
  if (!Array.isArray(ensures) || !ensures.length) return false;
  return ensures.every(e => {
    if (e.inv !== undefined) return has(state.inventory, e.inv, e.count ?? 1);
    if (e.block !== undefined) return state.nearbyBlocks.includes(e.block);
    if (e.dimension !== undefined) return state.dimension === e.dimension;
    return false;
  });
}

/**
 * Enumerate the pool of candidate actions actually executable right now,
 * from the normalized state plus (optionally) the next unmet Wiki split and
 * any deliberation-verified stitched macros.
 *
 * Every candidate has the fixed shape:
 *   { id, key, tool, args, requires, ensures, source, isSafety, hitsNextSplit }
 *
 * @param {object} state  output of normalizeObsState()
 * @param {object} [opts]
 * @param {object|null} [opts.nextSplit]      splits.json entry not yet satisfied
 * @param {object[]} [opts.stitchedMacros]    candidate-shaped macros verified by environment B
 * @param {boolean} [opts.forceExploreFallback=false]  when true, also offer
 *   move:explore_* even though a production candidate exists. The caller
 *   (auto_loop.mjs/tools_adapter.mjs) sets this once its own in-memory
 *   recentFailures shows the CURRENT production candidate has already
 *   failed at least once this run — e.g. a visible oak_log that is
 *   physically unreachable (across water, behind a cliff) would otherwise
 *   be the sole candidate every round, and no amount of decide.mjs's
 *   failure-cooldown scoring can make it "lose" to an alternative that was
 *   never offered. This keeps candidates.mjs itself free of any
 *   decisions.jsonl/history access — the failure signal is passed in by
 *   the caller as a plain boolean, never read from disk here.
 * @returns {object[]}
 */
export function enumerateCandidates(state, { nextSplit = null, stitchedMacros = [], forceExploreFallback = false, suspendedArc = null } = {}) {
  const s = state ?? normalizeObsState(null);
  const inv = s.inventory ?? {};
  const nearby = s.nearbyBlocks ?? [];
  const candidates = [];

  // --- suspend/resume (task 2): pick up a long chain where it left off ----
  // suspendedArc (see auto_loop.mjs's doc comment on the exact shape:
  // { macroId, macroKey, nextStepIndex, steps, spanToIdx, ttl }) is pure
  // in-memory context the CALLER tracks itself across rounds — never read
  // from decisions.jsonl/policy_snapshot.json here, exactly like
  // forceExploreFallback/recentFailures above. When present and still
  // "alive" (ttl > 0, checked by the caller before passing it in — this
  // function itself does not decrement or inspect ttl beyond requiring a
  // non-null suspendedArc, since ttl bookkeeping is the caller's own
  // round-counting job), this offers ONE extra candidate that resumes the
  // interrupted chain starting at `nextStepIndex`, so a multi-step macro
  // broken by a mid-chain emergency (hostile/low health/low food) does not
  // have to restart from step 1 or be abandoned outright once the
  // emergency clears.
  if (suspendedArc && Array.isArray(suspendedArc.steps) && Number.isFinite(suspendedArc.nextStepIndex)) {
    let remainingRaw = suspendedArc.steps.slice(suspendedArc.nextStepIndex);
    // Same half-way skip the ordinary stitched-macro loop below applies
    // (ensuresAlreadySatisfied()): a resume point is sometimes only
    // approximately known (e.g. tools_adapter.mjs's LLM-facing path
    // conservatively always resumes at index 0 — see its own doc comment
    // on why it cannot report a precise break step) — skipping any
    // LEADING already-satisfied step here means an imprecise resume index
    // still naturally fast-forwards to the real first remaining step
    // instead of redundantly re-running ones that, in fact, already
    // succeeded before the interruption.
    while (remainingRaw.length > 1 && ensuresAlreadySatisfied(remainingRaw[0]?.ensures, s)) {
      remainingRaw = remainingRaw.slice(1);
    }
    if (remainingRaw.length && requiresSatisfied(remainingRaw[0]?.requires, s)) {
      // Slot re-binding + place re-grounding, exactly like an ordinary
      // stitched-macro candidate below — a suspended chain's wood-species
      // slot or place cell must be re-derived against the CURRENT state,
      // never whatever it was when the chain was first offered (the world
      // had time to change during the interruption itself).
      const remaining = remainingRaw.map(step => ({
        ...step,
        args: regroundPlacementArgs(step.tool, regroundSlotArgs(step.tool, step.args, s), s.pos, s.nearbyGroundBlocks),
      }));
      const first = remaining[0];
      const resumeCandidate = makeCandidate(
        {
          id: `resume:${suspendedArc.macroId ?? suspendedArc.macroKey ?? 'arc'}:${suspendedArc.nextStepIndex}`,
          key: suspendedArc.macroKey ?? first.key,
          tool: first.tool,
          args: first.args,
          requires: first.requires ?? [],
          ensures: first.ensures ?? [],
          source: 'resume',
        },
        nextSplit,
      );
      if (remaining.length > 1) resumeCandidate.steps = remaining;
      // isResumeArc (task 2): read by decide.mjs's scoreCandidate() to
      // apply the SAME momentum_bonus a persona would grant a candidate
      // that merely shares its action-family prefix with last round's
      // choice — a resumed chain deserves at least that same "same phase,
      // keep going" nudge, since it IS the exact continuation of what was
      // already underway before the interruption, not a coincidental
      // family match.
      resumeCandidate.isResumeArc = true;
      if (Number.isFinite(suspendedArc.spanToIdx)) resumeCandidate.span_to_idx = suspendedArc.spanToIdx;
      candidates.push(resumeCandidate);
    }
  }

  // --- safety first: low health / low food / hostiles nearby -------------
  // tool 'flee' is the real tool (src/tools/game/combat.js); every one of
  // its args (id/distance/seconds/wall) is optional, so {} is a valid call.
  //
  // Root-cause repair round: the real flee tool ONLY reacts to an actual
  // nearby hostile (`hostilesWithin(16)`) — real log evidence showed
  // `flee:low_health` repeatedly offered (and chosen) with ZERO hostiles
  // in range, and the real tool rejecting every single call with
  // "Nothing has hurt you recently and no hostile is within 16 blocks" —
  // pure wasted rounds that this candidate should never have been able to
  // win in the first place. Gated on `s.nearbyHostiles > 0` now, exactly
  // like the separate flee:hostile_nearby candidate below (low health
  // WITHOUT a visible threat is not something fleeing can address at all
  // — eating, below, is the actually-available safety response for that
  // case instead).
  if (Number.isFinite(s.health) && s.health <= 6 && (s.nearbyHostiles ?? 0) > 0) {
    candidates.push(
      makeCandidate(
        {
          id: 'flee:low_health',
          key: 'flee',
          tool: 'flee',
          args: {},
          requires: [],
          ensures: [],
          isSafety: true,
        },
        nextSplit,
      ),
    );
  }
  // tool 'eat' is the real tool (src/tools/game/items.js), args { item: name }.
  if (Number.isFinite(s.food) && s.food <= 10 && Object.keys(inv).length) {
    const edible = Object.keys(inv).find(name => /bread|cooked_|apple|carrot|potato|beef|porkchop|mutton|chicken|rabbit|fish|cod|salmon|stew|melon|berries/.test(name));
    if (edible) {
      candidates.push(
        makeCandidate(
          {
            id: `eat:${edible}`,
            key: 'eat',
            tool: 'eat',
            args: { item: edible },
            requires: [{ inv: edible, count: 1 }],
            ensures: [],
            isSafety: true,
          },
          nextSplit,
        ),
      );
    }
  }
  if ((s.nearbyHostiles ?? 0) > 0) {
    candidates.push(
      makeCandidate(
        {
          id: 'flee:hostile_nearby',
          key: 'flee',
          tool: 'flee',
          args: {},
          requires: [],
          ensures: [],
          isSafety: true,
        },
        nextSplit,
      ),
    );
  }

  // --- survival progression chain ----------------------------------------

  // Whole-package total shortage (task 1) for whichever pickaxe tier is
  // the bot's current progression target (the first of the three not
  // already held — mirrors the SAME order the recipe_planner loop below
  // iterates in, so "current target" never disagrees between the two).
  // Computed ONCE per round, read-only, and reused by every gather
  // candidate below to size its `args.count` — see gatherCountFor()'s doc
  // comment. An empty object (not null) when every tier is already held
  // (nothing left to size against), so gatherCountFor() safely falls back
  // to its old 1-unit default.
  const currentPickaxeTarget = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe'].find(t => !has(inv, t, 1)) ?? null;
  const totalShortage = currentPickaxeTarget
    ? computeTotalShortage(currentPickaxeTarget, 1, inv, nearby, s.pos, { nearbyTablePos: s.nearbyTablePos })
    : {};

  // gather:wood_log — whichever loggable wood species is actually visible
  // nearby (never hardcoded to oak_log: a birch/spruce/jungle start must
  // still be able to gather its own starting tree). tool 'gather' is the
  // real tool registered in src/tools/game/gathering.js
  // (add('gather', ..., { block: name, count, near: object(coords) }, ...));
  // its `block` argument is a single concrete block-type name.
  const foundLog = nearby.find(n => WOOD_LOG_NAMES.has(n)) ?? null;
  // The planks recipe this log species actually produces. Falls back to
  // 'oak_planks' only if somehow no concrete species was found (candidate
  // below is gated on `has(inv, foundLog...)` so that fallback never fires
  // without real inventory to back it).
  const planksNameFor = logName => (logName ? logName.replace(/_log$|_block$/, '_planks') : 'oak_planks');

  // Computed BEFORE the gather:wood_log candidate below so that candidate
  // can mark itself isReserveGather when a log is already held: gathering
  // another one right now is then optional stockpiling (craft:wood_planks
  // is already a real alternative this same round), not the only way
  // forward — see makeCandidate()'s isReserveGather doc comment. This is
  // the real "fork in the road" task 2 asks for: without this flag, a
  // persona with a high gather_hoard knob would have nothing of its own to
  // actually prefer here, since the two candidates would be indistinguishable
  // from "the only path" gather offered when the inventory is still empty.
  const heldLogForReserveCheck = [...WOOD_LOG_NAMES].find(name => has(inv, name, 1)) ?? null;

  if (foundLog) {
    // Task 1: size this round's gather call to the WHOLE remaining
    // oak_log-equivalent shortage (capped at GATHER_COUNT_CAP), not always
    // 1 — see gatherCountFor()/computeTotalShortage()'s doc comments. The
    // `ensures` entry is deliberately kept at the REQUESTED count (not
    // hardcoded 1): candidates.mjs's own computeHitsNextSplit()/
    // requiresSatisfied() already compare `ensures[].count` against a
    // split's/step's needed count, so a larger request correctly "ensures"
    // that many units once it actually succeeds.
    const wantCount = gatherCountFor(totalShortage, foundLog);
    candidates.push(
      makeCandidate(
        {
          id: `gather:${foundLog}`,
          key: 'gather:wood_log',
          tool: 'gather',
          args: { block: foundLog, count: wantCount },
          requires: [],
          ensures: [{ inv: foundLog, count: wantCount }],
          isReserveGather: Boolean(heldLogForReserveCheck),
        },
        nextSplit,
      ),
    );
  }

  // craft:wood_planks — needs at least one log of whichever species is in
  // the inventory (checks every known log species, not just oak_log).
  const heldLog = heldLogForReserveCheck;
  if (heldLog) {
    const planksName = planksNameFor(heldLog);
    candidates.push(
      makeCandidate(
        {
          id: `craft:${planksName}`,
          key: 'craft:wood_planks',
          tool: 'craft',
          args: { item: planksName, count: 4 },
          requires: [{ inv: heldLog, count: 1 }],
          ensures: [{ inv: planksName, count: 4 }],
        },
        nextSplit,
      ),
    );
  }

  // craft:crafting_table is now produced by the recipe_planner.mjs loop
  // below (as a prerequisite step toward wooden_pickaxe/stone_pickaxe),
  // which also handles non-oak plank species — no separate hand-written
  // branch here anymore (it used to duplicate the same candidate id).

  // place:crafting_table — have one in inventory, not yet placed nearby.
  // tool 'place' is the real tool (src/tools/game/building.js), required
  // args ['x','y','z','block'] as real numbers. normalizeObsState() already
  // keeps `s.pos` ({x,y,z}, plain JSON, no bot object).
  //
  // Root-cause repair round: the placement cell now prefers a REAL
  // observed solid ground block within 3 blocks (s.nearbyGroundBlocks —
  // see pickNearestGroundTarget()'s doc comment), falling back to the old
  // "one block to the side of the bot's feet, at the bot's own floor
  // level" heuristic only when nothing solid is in range — this is what
  // fixes the real "No solid block touches ..., so it needs a support"
  // failures seen on sloped/uneven terrain in the live 3-episode test. No
  // position known (`s.pos === null`) means this candidate cannot be
  // grounded yet, so it is simply not offered this round — unchanged.
  if (has(inv, 'crafting_table', 1) && !nearby.includes('crafting_table') && s.pos) {
    const groundTarget = pickNearestGroundTarget(s.pos, s.nearbyGroundBlocks, 3);
    const placeArgs = groundTarget
      ? { block: 'crafting_table', x: groundTarget.x, y: groundTarget.y + 1, z: groundTarget.z }
      : { block: 'crafting_table', x: Math.floor(s.pos.x) + 1, y: Math.floor(s.pos.y), z: Math.floor(s.pos.z) };
    candidates.push(
      makeCandidate(
        {
          id: 'place:crafting_table',
          key: 'place:crafting_table',
          tool: 'place',
          args: placeArgs,
          requires: [{ inv: 'crafting_table', count: 1 }],
          ensures: [],
        },
        nextSplit,
      ),
    );
  }

  // gather:cobblestone — needs a wooden (or better) pickaxe and stone visible
  if (has(inv, 'wooden_pickaxe', 1) && anyNearby(nearby, COBBLESTONE_LIKE_NAMES)) {
    // Reserve stockpiling once the stone_pickaxe tier is ALREADY reached
    // (cobblestone's whole purpose on the route) and the bot already holds
    // at least one unit of cobblestone — mining more right now is optional
    // backup supply, not the only path forward. Mirrors the gather:wood_log
    // reserve check above.
    const alreadyAdvancedPastCobble = has(inv, 'stone_pickaxe', 1) && has(inv, 'cobblestone', 1);
    const wantCobbleCount = gatherCountFor(totalShortage, 'cobblestone');
    candidates.push(
      makeCandidate(
        {
          id: 'gather:cobblestone',
          key: 'gather:cobblestone',
          tool: 'gather',
          args: { block: 'cobblestone', count: wantCobbleCount },
          requires: [{ inv: 'wooden_pickaxe', count: 1 }],
          ensures: [{ inv: 'cobblestone', count: wantCobbleCount }],
          isReserveGather: alreadyAdvancedPastCobble,
        },
        nextSplit,
      ),
    );
  }

  // gather:iron_ore / gather:deepslate_iron_ore — needs a stone (or better)
  // pickaxe and an iron ore variant visible nearby. Mirrors the
  // gather:cobblestone gate above: mining iron_ore/deepslate_iron_ore
  // without at least a stone_pickaxe fails the real gather tool's own
  // canHarvest() check (src/tools/game/gathering.js's mineOne — "needs a
  // better tool to harvest"), so this candidate is simply not offered
  // until that prerequisite is actually held.
  if (has(inv, 'stone_pickaxe', 1)) {
    const foundOre = nearby.find(n => IRON_ORE_NAMES.has(n)) ?? null;
    if (foundOre) {
      // Reserve stockpiling once the iron_pickaxe tier is ALREADY reached
      // (iron_ore's whole purpose on the route) and the bot already holds
      // at least one unit of raw_iron — mining more right now is optional
      // backup supply, not the only path forward. Mirrors the
      // gather:cobblestone/gather:wood_log reserve checks above.
      const alreadyAdvancedPastIron = has(inv, 'iron_pickaxe', 1) && has(inv, 'raw_iron', 1);
      const wantIronCount = gatherCountFor(totalShortage, 'raw_iron');
      candidates.push(
        makeCandidate(
          {
            id: `gather:${foundOre}`,
            key: 'gather:iron_ore',
            tool: 'gather',
            args: { block: foundOre, count: wantIronCount },
            requires: [{ inv: 'stone_pickaxe', count: 1 }],
            ensures: [{ inv: 'raw_iron', count: wantIronCount }],
            isReserveGather: alreadyAdvancedPastIron,
          },
          nextSplit,
        ),
      );
    }
  }

  // craft:wooden_pickaxe / craft:stone_pickaxe / craft:iron_pickaxe —
  // driven by recipe_planner.mjs instead of a hand-written if-chain: it
  // recursively resolves sticks, planks, the crafting_table prerequisite,
  // AND (for iron_pickaxe) the furnace+fuel+smelt prerequisite chain from
  // live minecraft-data + prismarine-recipe data, so adding a future
  // target item needs no new branch here. Only offered once the tool is
  // not already held, so it never competes with itself once crafted.
  for (const pickaxeTarget of ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe']) {
    if (has(inv, pickaxeTarget, 1)) continue;
    const plan = planNextForTarget(pickaxeTarget, 1, inv, nearby, s.pos, { nearbyTablePos: s.nearbyTablePos });
    if (!plan || !plan.step) continue;
    // 'craft'/'place'/'go_to' (table-approach)/'smelt' (furnace step for
    // iron_ingot) steps become candidates here — 'gather' steps for raw
    // materials (oak_log, cobblestone, raw_iron/iron_ore) are already
    // covered by this function's own gather candidates above, which also
    // carry the stricter prerequisite checks (e.g. wooden_pickaxe before
    // mining cobblestone, stone_pickaxe before mining iron ore) that
    // recipe_planner intentionally does not re-derive.
    if (!['craft', 'place', 'go_to', 'smelt'].includes(plan.step)) continue;
    candidates.push(
      makeCandidate(
        {
          id: `${plan.step}:${plan.item}`,
          key: `${plan.step}:${plan.item}`,
          tool: plan.step,
          args: plan.args,
          requires: plan.requires,
          ensures: plan.ensures,
        },
        nextSplit,
      ),
    );
  }

  // --- exploration candidates ---------------------------------------------
  // Normally only offered when no production candidate exists at all (the
  // bot has nothing useful visible within view range — most often because
  // it is standing in foliage/underground/water with no loggable tree or
  // exposed stone nearby). Previously this meant chooseCandidate() returned
  // null and the caller just waited in place forever. Instead, offer a
  // handful of bounded go_to moves in different compass directions so UCB1
  // can explore which direction actually has something.
  //
  // A production candidate for the active goal always wins on score when
  // exploration is only a fallback (exploration candidates never set
  // hitsNextSplit, so a production candidate that does gets the Wiki bonus
  // and outranks these) — but a VISIBLE-yet-unreachable production target
  // (e.g. an oak_log across water) can otherwise become the pool's only
  // candidate round after round: no failure-cooldown penalty in decide.mjs
  // can make a sole candidate "lose", since there is nothing else to lose
  // to. `forceExploreFallback` (set by the caller once its own in-memory
  // recentFailures shows the current production candidate has already
  // failed at least once) adds the explore candidates ALONGSIDE the
  // production ones in that case, so the failure-cooldown scoring actually
  // has an alternative to rotate to.
  const hasProductionCandidate = candidates.some(c => !c.isSafety);
  if ((!hasProductionCandidate || forceExploreFallback) && s.pos && Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y) && Number.isFinite(s.pos.z)) {
    // Shortened from 16 to 10 blocks, and distance tolerance loosened from
    // 2 to 3: a 16-block blind go_to too often pathfound into unwalkable
    // terrain (water, cliffs, dense foliage) and timed out at 15s rather
    // than reaching anywhere useful. A shorter hop with a looser stop
    // tolerance resolves faster and lets decide.mjs's recentFailures
    // cooldown (see decide.mjs) rotate to the next compass direction
    // sooner instead of one candidate eating the whole step budget.
    //
    // Root-cause repair round: each direction now prefers a REAL observed
    // ground block roughly that way (pickGroundTargetInDirection(), 5-10
    // blocks out) over the old blind "same y as the bot, fixed x/z
    // offset" target — on hilly/mountainous terrain that fixed-y target
    // routinely ended up half-buried in a hillside or hanging over a
    // cliff edge, which is exactly what produced the repeated real
    // `go_to` "No route exists"/"stuck jumping in place" failures seen in
    // the live 3-episode test. Falls back to the exact old flat-y formula
    // when nothing solid is observed in that direction (e.g. looking out
    // over open water, or a test double with no nearbyGroundBlocks at
    // all) — this is purely an upgrade, never a new way to withhold a
    // direction entirely.
    const STEP = 10;
    const DIRECTIONS = [
      { suffix: 'n', dx: 0, dz: -STEP },
      { suffix: 'e', dx: STEP, dz: 0 },
      { suffix: 's', dx: 0, dz: STEP },
      { suffix: 'w', dx: -STEP, dz: 0 },
    ];
    for (const dir of DIRECTIONS) {
      const groundTarget = pickGroundTargetInDirection(s.pos, dir.dx, dir.dz, s.nearbyGroundBlocks, 5, STEP);
      const args = groundTarget
        ? { x: groundTarget.x, y: groundTarget.y + 1, z: groundTarget.z, distance: 3 }
        : { x: Math.floor(s.pos.x) + dir.dx, y: Math.floor(s.pos.y), z: Math.floor(s.pos.z) + dir.dz, distance: 3 };
      candidates.push(
        makeCandidate(
          {
            id: `move:explore_${dir.suffix}`,
            key: `move:explore_${dir.suffix}`,
            tool: 'go_to',
            args,
            requires: [],
            ensures: [],
            source: 'explore',
          },
          nextSplit,
        ),
      );
    }
  }

  // --- stitched macros: deliberation-verified successful sequences --------
  // A macro always EXECUTES as its own tool/args — including a multi-step
  // one (see deliberate.mjs's extractMultiStepMacros()): only its FIRST
  // verified step's `requires` gate whether it is offered this round, never
  // a guess about later steps the state hasn't reached yet. The optional
  // `steps` array (present only on multi-step macros) is carried through
  // onto the candidate unchanged, purely as provenance/observability —
  // nothing here or in decide.mjs executes more than the one tool call
  // already named by `tool`/`args`.
  for (const macro of Array.isArray(stitchedMacros) ? stitchedMacros : []) {
    if (!macro || typeof macro !== 'object') continue;
    if (!requiresSatisfied(macro.requires, s)) continue;

    // Task 2: half-way skip. If one or more of this macro's LEADING steps
    // already have their `ensures` satisfied by the CURRENT state (e.g. a
    // reserve of planks/sticks already in the inventory from an earlier,
    // unrelated action), running them again would be pure wasted labor —
    // and could even misreport as a "break" if the real tool refuses a
    // redundant call. Skip forward past every such already-satisfied
    // leading step and re-root the macro at the first step that still
    // needs doing, carrying the REST of the chain through unchanged. Only
    // ever skips from the FRONT (never a middle/later step, which might
    // depend on a leading step's side effect this check cannot see) and
    // never skips the chain down to zero steps (a macro whose every step
    // is already satisfied is simply redundant this round — it is left
    // whole here and will naturally lose to a more useful candidate, or
    // its own first step's requires-check will skip it below like today).
    const rawSteps = Array.isArray(macro.steps) && macro.steps.length ? macro.steps : null;
    let effectiveSteps = rawSteps;
    if (rawSteps) {
      let skipCount = 0;
      while (skipCount < rawSteps.length - 1 && ensuresAlreadySatisfied(rawSteps[skipCount]?.ensures, s)) {
        skipCount += 1;
      }
      effectiveSteps = skipCount > 0 ? rawSteps.slice(skipCount) : rawSteps;
    }
    // The candidate's own top-level tool/args/requires/ensures always
    // reflect whichever step is now EFFECTIVELY first (post-skip) — never
    // the macro's original first step — so decide.mjs/macro_executor.mjs
    // always see a candidate whose own requires/tool/args genuinely
    // matches what will actually run first.
    const effectiveFirst = effectiveSteps ? effectiveSteps[0] : null;
    const effectiveTool = effectiveFirst?.tool ?? macro.tool;
    const effectiveArgsRaw = effectiveFirst?.args ?? macro.args;
    const effectiveRequires = effectiveFirst?.requires ?? macro.requires ?? [];
    const effectiveEnsures = effectiveFirst?.ensures ?? macro.ensures ?? [];
    const effectiveKey = effectiveFirst?.key ?? macro.key ?? macro.id;

    const candidate = makeCandidate(
      {
        id: macro.id ?? `stitched:${macro.key ?? 'macro'}`,
        key: effectiveKey,
        tool: effectiveTool,
        // Slot re-binding (wood species, task 2) THEN relative-placement
        // re-grounding — order matters for a `place` step (species does
        // not apply to it) but composes safely either way since each
        // function only ever touches its own tool's args shape.
        args: regroundPlacementArgs(effectiveTool, regroundSlotArgs(effectiveTool, effectiveArgsRaw, s), s.pos, s.nearbyGroundBlocks),
        requires: effectiveRequires,
        ensures: effectiveEnsures,
        source: 'stitched',
        isSafety: Boolean(macro.isSafety),
      },
      nextSplit,
    );
    if (effectiveSteps && effectiveSteps.length > 1) {
      // Same slot re-binding + re-grounding applied per-step, so a
      // multi-step chain's LATER steps (not just the now-effective first
      // one) also carry a currently-valid species/cell if
      // macro_executor.mjs's between-step re-observe reaches them — see
      // executeChosenSteps()'s doc comment.
      candidate.steps = effectiveSteps.map(step => ({
        ...step,
        args: regroundPlacementArgs(step.tool, regroundSlotArgs(step.tool, step.args, s), s.pos, s.nearbyGroundBlocks),
      }));
    }
    // Long-chain flow-shape provenance (carried through unchanged, never
    // recomputed here — this module stays pure/history-free): decide.mjs
    // reads `macro_commitment` as its OWN separate step-2/3 confidence
    // multiplier, strictly distinct from entries[key].weight (the
    // low-dimensional quota knob) — see deliberate.mjs's
    // computeMacroFlowSummary()/decide.mjs's doc comment on this
    // boundary. Omitted entirely when the macro has none (a macro never
    // attempted as a chain yet, or lifted before this upgrade), which
    // decide.mjs already treats as "no commitment evidence yet".
    if (Number.isFinite(macro.macro_commitment)) candidate.macro_commitment = macro.macro_commitment;
    if (Number.isFinite(macro.completion_rate)) candidate.completion_rate = macro.completion_rate;
    // Milestone span provenance (task 3, "跨里程碑推进跨度"): how many
    // Wiki splits this chain was actually observed carrying the bot
    // across in one shot (span_to_idx - span_from_idx) — read by
    // decide.mjs as its OWN additional fair-competition term, alongside
    // (never instead of) macro_commitment/completion_rate above. Omitted
    // entirely when the macro has neither field (same backward-compatible
    // treatment as macro_commitment/completion_rate themselves).
    if (Number.isFinite(macro.span_from_idx)) candidate.span_from_idx = macro.span_from_idx;
    if (Number.isFinite(macro.span_to_idx)) candidate.span_to_idx = macro.span_to_idx;
    candidates.push(candidate);
  }

  return candidates;
}

/**
 * Compute a short, stable discrete bucket id for the current state, so
 * environment B (deliberate.mjs) can keep per-state-bucket statistics
 * instead of averaging a candidate's success rate across every state it
 * was ever tried in (e.g. gather:wood_log succeeding near spawn vs. failing
 * underground would otherwise wash into one misleading global number).
 *
 * Pure, deterministic, and usable by both environment A (decide.mjs, via
 * the caller) and environment B (deliberate.mjs) without either one
 * needing to recompute it differently — both just call this with the same
 * `state`/`cur_idx` and get the same bucket id.
 *
 * @param {object} state   output of normalizeObsState() (or the `state`
 *   field already stored on a decisions.jsonl record, same shape)
 * @param {number} curIdx  wiki.evaluate()'s cur_idx at the time of state
 * @returns {string}  e.g. "idx2_tbl1_wpick1_spick0"
 */
export function computeStateBucket(state, curIdx) {
  const inv = state?.inventory ?? {};
  const nearby = Array.isArray(state?.nearbyBlocks) ? state.nearbyBlocks : [];
  const idx = Number.isFinite(curIdx) ? curIdx : -1;
  const hasTable = (inv.crafting_table ?? 0) > 0 || nearby.includes('crafting_table') ? 1 : 0;
  const hasWoodPick = (inv.wooden_pickaxe ?? 0) > 0 ? 1 : 0;
  const hasStonePick = (inv.stone_pickaxe ?? 0) > 0 ? 1 : 0;
  return `idx${idx}_tbl${hasTable}_wpick${hasWoodPick}_spick${hasStonePick}`;
}
