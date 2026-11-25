// brain/recipe_planner.mjs — environment A, pure recipe/prerequisite
// reasoning over minecraft-data + prismarine-recipe. No bot, no network, no
// decisions.jsonl/stream.mjs/slice.mjs access: given a target item, the
// current inventory/nearby blocks/position, it recursively expands missing
// intermediates (plank -> stick, log -> plank, crafting_table prerequisite)
// down to the next single executable craft/place/gather step — the same
// "what is the ONE next op toward this goal" question
// minecraft-jev-agent/packages/jev-agent/src/crafting.ts answers, done here
// as a small dependency-free Node module instead of a TS RecipeIndex class.
//
// candidates.mjs calls this to replace its hand-written if-chain for the
// tool-progression items (wooden_pickaxe, stone_pickaxe, iron_pickaxe, ...)
// with a general recipe-driven planner, so new target items need no new
// hardcoded branch.

import minecraftData from 'minecraft-data';
import prismarineRegistry from 'prismarine-registry';
import prismarineRecipe from 'prismarine-recipe';

const DEFAULT_VERSION = '1.21.6';

// Cached per Minecraft version: building the registry/recipe index is not
// free, and this module is called once per brain_next_step/auto_loop step.
const cache = new Map();

function loadRecipeEngine(version) {
  const cached = cache.get(version);
  if (cached) return cached;
  const registry = prismarineRegistry(version);
  const { Recipe } = prismarineRecipe(registry);
  const mcData = minecraftData(version);
  const engine = { registry, Recipe, mcData };
  cache.set(version, engine);
  return engine;
}

/**
 * Every recipe variant that produces `itemName`, normalized to item NAMES
 * (never raw numeric ids) and deduplicated by their exact ingredient
 * multiset — Recipe.find() returns one variant per interchangeable wood
 * species etc, which would otherwise look like distinct recipes.
 *
 * @returns {{ingredients: Record<string,number>, requiresTable: boolean, resultCount: number}[]}
 */
function recipeVariantsFor(itemName, { version = DEFAULT_VERSION } = {}) {
  const { registry, Recipe } = loadRecipeEngine(version);
  const itemId = registry.itemsByName?.[itemName]?.id;
  if (itemId === undefined) return [];
  const recipes = Recipe.find(itemId, null);
  const seen = new Set();
  const variants = [];
  for (const recipe of recipes) {
    const ingredients = {};
    for (const entry of recipe.delta) {
      if (entry.id === itemId) continue; // skip the result itself
      const name = registry.items[entry.id]?.name;
      if (!name || entry.count >= 0) continue; // only consumed ingredients (negative delta)
      ingredients[name] = (ingredients[name] ?? 0) + Math.abs(entry.count);
    }
    if (!Object.keys(ingredients).length) continue;
    const signature = Object.entries(ingredients)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${name}x${count}`)
      .join('+');
    if (seen.has(signature)) continue;
    seen.add(signature);
    const resultEntry = recipe.delta.find(e => e.id === itemId);
    variants.push({
      ingredients,
      requiresTable: Boolean(recipe.requiresTable),
      resultCount: resultEntry?.count ?? 1,
    });
  }
  return variants;
}

// Preference order used only as the LAST tie-break in pickVariant() below,
// so an otherwise-tied choice (e.g. every wood species equally absent from
// both inventory and view) lands on the same species splits.json's fixed
// conditions name (oak_log/oak_planks), instead of an arbitrary one decided
// by Recipe.find()'s internal ordering.
const DEFAULT_SPECIES_PREFERENCE = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo'];

function speciesRank(ingredientNames) {
  for (let i = 0; i < DEFAULT_SPECIES_PREFERENCE.length; i++) {
    if (ingredientNames.some(name => name.startsWith(DEFAULT_SPECIES_PREFERENCE[i]))) return i;
  }
  return DEFAULT_SPECIES_PREFERENCE.length;
}

/**
 * Pick the cheapest recipe variant the current inventory can already fully
 * satisfy (every ingredient held in sufficient count). When none is fully
 * satisfiable yet, break ties in this order so the plan converges on
 * whichever variant the bot is actually closest to, not an arbitrary one
 * that happens to come first out of Recipe.find():
 *   1. fewest distinct missing ingredient names (shallowest expansion gap);
 *   2. among those, the variant whose ingredients the inventory ALREADY
 *      holds the most total units of (e.g. holding 1 oak_log beats holding
 *      0 cherry_log, even though both still "need more");
 *   3. among those, the variant whose ingredients are visible in
 *      nearbyBlocks (so an empty-inventory bot standing in a birch forest
 *      plans toward birch, not oak, if that's what's actually in view);
 *   4. finally, a fixed default-species preference (oak first) so a
 *      genuinely tied cold-start (nothing held, nothing visible yet) always
 *      resolves the same deterministic way, matching splits.json's own
 *      oak_log/oak_planks conditions.
 */
function pickVariant(variants, inventory, nearbyBlocks = []) {
  if (!variants.length) return null;
  const satisfiable = variants.find(v => Object.entries(v.ingredients).every(([name, count]) => (inventory[name] ?? 0) >= count));
  if (satisfiable) return satisfiable;

  const heldUnits = v => Object.keys(v.ingredients).reduce((sum, name) => sum + (inventory[name] ?? 0), 0);
  const visibleNearby = v => Object.keys(v.ingredients).some(name => nearbyBlocks.includes(name)) ? 0 : 1;

  return [...variants].sort((a, b) => {
    const missingA = Object.entries(a.ingredients).filter(([name, count]) => (inventory[name] ?? 0) < count).length;
    const missingB = Object.entries(b.ingredients).filter(([name, count]) => (inventory[name] ?? 0) < count).length;
    if (missingA !== missingB) return missingA - missingB;

    const heldA = heldUnits(a);
    const heldB = heldUnits(b);
    if (heldA !== heldB) return heldB - heldA; // more already held wins

    const nearA = visibleNearby(a);
    const nearB = visibleNearby(b);
    if (nearA !== nearB) return nearA - nearB; // visible (0) beats not-visible (1)

    return speciesRank(Object.keys(a.ingredients)) - speciesRank(Object.keys(b.ingredients));
  })[0];
}

// The real `place` craft tool (src/tools/game/crafting.js's `craft`)
// already walks to a crafting table within 24 blocks on its own ("if the
// recipe needs a crafting table and none is in reach, it walks to one
// within 24 blocks"). Reuse that exact radius here instead of inventing a
// different one, so recipe_planner's "table already in reach" boundary
// matches what the real tool can actually ground without recipe_planner
// needing to hand it a go_to leg at all.
const TABLE_CRAFT_REACH = 24;

function distance3(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * True once a table-requiring craft can actually be grounded this round:
 * either a crafting_table is held (the craft tool places/re-collects one
 * from inventory itself), or a placed one is visible AND within the same
 * 24-block reach the craft tool itself would walk for — a table seen only
 * at the edge of the 48-block observation range still needs an explicit
 * go_to leg first (see planNextForTarget's nearbyTablePos handling).
 */
function tableAvailable(inventory, nearbyBlocks, pos, nearbyTablePos) {
  if ((inventory?.crafting_table ?? 0) > 0) return true;
  if (!(nearbyBlocks ?? []).includes('crafting_table')) return false;
  if (!pos || !nearbyTablePos) return true; // visible but position unknown: assume reachable (old behavior)
  return distance3(pos, nearbyTablePos) <= TABLE_CRAFT_REACH;
}

const GATHERABLE_FALLBACK = new Set([
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'cobblestone', 'stone', 'deepslate', 'cobbled_deepslate',
  'raw_iron', 'iron_ore', 'deepslate_iron_ore',
  'coal', 'coal_ore', 'deepslate_coal_ore',
]);

// --- smelting (furnace) prerequisite support ------------------------------
//
// prismarine-recipe's Recipe.find() only indexes actual crafting-table/
// inventory-grid recipes. A furnace transformation (raw_iron -> iron_ingot
// via smelt) is NOT a crafting recipe at all — the real `smelt` tool
// (src/tools/game/crafting.js) is the only thing that can produce
// iron_ingot from raw_iron, and Recipe.find('iron_ingot') actually returns
// two UNRELATED crafting recipes (uncrafting an iron_block, and 9
// iron_nugget -> 1 iron_ingot) that happen to share the same output item id
// but are never the raw_iron smelting path. Treating those as a generic
// pickVariant() candidate would make recipe_planner recommend a `craft`
// step the real craft tool cannot ground for raw_iron at all.
//
// SMELT_RECIPES therefore short-circuits the generic recipe lookup for
// known furnace-only outputs: the input material, any fuel already held
// (or gatherable), and a furnace (held, nearby, or craftable from
// cobblestone — exactly like the real smelt tool's own "walks to one within
// 24 blocks, or places one from your inventory" fallback) are all resolved
// before a `smelt` step is ever proposed.
const SMELT_RECIPES = {
  iron_ingot: { inputs: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'] },
  copper_ingot: { inputs: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'] },
  gold_ingot: { inputs: ['raw_gold', 'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'] },
};

// Fuel preference mirrors the real smelt tool's own FUEL_ORDER/fallback
// (src/tools/game/crafting.js: coal/charcoal preferred, else planks/logs/
// sticks) closely enough for recipe_planner to decide "is fuel already
// available" without needing to duplicate its exact per-item burn values.
const FUEL_CANDIDATES = [
  'coal', 'charcoal', 'coal_block',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'stick',
];

function heldFuel(inventory) {
  return FUEL_CANDIDATES.find(name => (inventory[name] ?? 0) > 0) ?? null;
}

/**
 * True once a `smelt` call can actually be grounded this round: a furnace
 * is held or visibly nearby. (A craftable-from-cobblestone furnace is
 * handled as its own missing-prerequisite step below, same shape as the
 * crafting_table prerequisite handling elsewhere in this file — the real
 * smelt tool would otherwise silently craft+place one itself, but
 * recipe_planner surfaces that as an explicit step so candidates.mjs/
 * decide.mjs can see and score it like any other action.)
 */
function furnaceAvailable(inventory, nearbyBlocks) {
  if ((inventory?.furnace ?? 0) > 0) return true;
  return (nearbyBlocks ?? []).some(n => n === 'furnace' || n === 'blast_furnace' || n === 'smoker');
}

/**
 * Smelt-aware planning for a known furnace-only output (see SMELT_RECIPES
 * above). Resolves, in order: the input material (recursing through
 * planNextForTarget exactly like a normal missing ingredient), a furnace
 * (held/nearby, else craft+place from cobblestone), and fuel (held, else
 * left to the real smelt tool's own fuel fallback — recipe_planner does
 * not invent a `gather:coal` step here since coal is already covered by
 * GATHERABLE_FALLBACK and the caller's normal leaf-gather handling once an
 * explicit need is surfaced).
 *
 * @returns {object|null} same step shape as planNextForTarget(), or null
 *   if targetItem is not a known smelt recipe.
 */
function planSmeltStep(targetItem, count, inventory, nearbyBlocks, pos, opts) {
  const recipe = SMELT_RECIPES[targetItem];
  if (!recipe) return null;
  const { version, _depth, nearbyTablePos } = opts;
  const inv = inventory ?? {};
  const nearby = nearbyBlocks ?? [];

  // 1) input material: whichever of the known inputs is already held wins;
  // otherwise plan toward the first (raw_iron is preferred over the ore
  // blocks themselves, since mining the ore already yields raw_iron/drops
  // directly via the real gather tool — see GATHERABLE_FALLBACK).
  const heldInput = recipe.inputs.find(name => (inv[name] ?? 0) > 0) ?? null;
  const inputName = heldInput ?? recipe.inputs[0];
  const haveInput = inv[inputName] ?? 0;
  if (haveInput < 1) {
    const sub = planNextForTarget(inputName, 1, inv, nearby, pos, { version, _depth: _depth + 1, nearbyTablePos });
    if (sub) return sub;
    return {
      step: null,
      item: inputName,
      args: {},
      requires: [],
      ensures: [],
      needsTable: false,
      reason: `missing 1x ${inputName} to smelt into ${targetItem}, no recipe/gather leaf found`,
    };
  }

  // 2) furnace prerequisite, mirroring the crafting_table handling below:
  // held/nearby wins outright; otherwise craft one from cobblestone (the
  // real smelt tool's own fallback), placing it only once it is actually
  // held, exactly like the crafting_table branch does.
  if (!furnaceAvailable(inv, nearby)) {
    if ((inv.furnace ?? 0) > 0) {
      // unreachable in practice (furnaceAvailable already true), kept for
      // symmetry with the crafting_table branch's own structure.
    }
    const furnaceVariants = recipeVariantsFor('furnace', { version });
    const furnaceVariant = pickVariant(furnaceVariants, inv, nearby);
    if (furnaceVariant) {
      const furnaceMissing = Object.entries(furnaceVariant.ingredients).filter(([name, need]) => (inv[name] ?? 0) < need);
      if (furnaceMissing.length === 0) {
        return {
          step: 'craft',
          item: 'furnace',
          args: { item: 'furnace', count: furnaceVariant.resultCount },
          requires: Object.entries(furnaceVariant.ingredients).map(([name, need]) => ({ inv: name, count: need })),
          ensures: [{ inv: 'furnace', count: furnaceVariant.resultCount }],
          needsTable: false,
          reason: `${targetItem} needs a furnace; have ingredients to craft one`,
        };
      }
      const [missingName, missingCount] = furnaceMissing[0];
      const sub = planNextForTarget(missingName, missingCount, inv, nearby, pos, { version, _depth: _depth + 1, nearbyTablePos });
      if (sub) return sub;
    }
    return {
      step: null,
      item: 'furnace',
      args: {},
      requires: [],
      ensures: [],
      needsTable: false,
      reason: `${targetItem} needs a furnace and none can be resolved yet (need 8x cobblestone to craft one)`,
    };
  }

  // 3) everything needed is in place: propose the real smelt step. Fuel is
  // intentionally NOT hard-required here (held fuel is passed when known,
  // but omitted otherwise) — the real smelt tool already auto-selects
  // coal/charcoal/planks/logs/sticks on its own when `fuel` is not given,
  // so recipe_planner only needs to confirm at least one fuel-shaped item
  // is actually held; if none is, that is surfaced as a named gap instead
  // of proposing a smelt call doomed to fail with "no fuel".
  const fuel = heldFuel(inv);
  if (!fuel) {
    return {
      step: null,
      item: 'coal',
      args: {},
      requires: [],
      ensures: [],
      needsTable: false,
      reason: `${targetItem} needs fuel to smelt (coal/charcoal/planks/logs/sticks) and none is held`,
    };
  }

  return {
    step: 'smelt',
    item: targetItem,
    args: { input: inputName, count, fuel },
    requires: [{ inv: inputName, count: 1 }, { inv: fuel, count: 1 }],
    ensures: [{ inv: targetItem, count }],
    needsTable: false,
    reason: `all inputs+fuel+furnace available to smelt ${inputName} into ${targetItem}`,
  };
}

/**
 * Recursively plan the single next executable step toward `targetItem`,
 * expanding missing intermediates depth-first until it reaches either:
 *   - a craft/place step the current inventory+surroundings can run NOW, or
 *   - a leaf item with no known recipe (assumed gatherable — the caller's
 *     own gather candidates already cover these; recipe_planner just names
 *     what is missing so candidates.mjs can decide whether to offer one), or
 *   - null, if the target cannot be resolved at all (unknown item, or a
 *     table-gated recipe with no table and no crafting_table in inventory
 *     to place — the caller falls back to its existing place: handling).
 *
 * Pure: no bot, no decisions.jsonl. `inventory`/`nearbyBlocks`/`pos` come
 * from candidates.mjs's already-normalized state.
 *
 * @param {string} targetItem   e.g. 'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe'
 * @param {number} count        how many of targetItem are ultimately wanted
 * @param {Record<string,number>} inventory
 * @param {string[]} nearbyBlocks
 * @param {{x:number,y:number,z:number}|null} pos
 * @param {{version?: string, _depth?: number, nearbyTablePos?: {x:number,y:number,z:number}|null}} [opts]
 * @returns {{
 *   step: 'craft'|'place'|'go_to'|'gather'|null,
 *   item: string,
 *   args: object,
 *   requires: object[],
 *   ensures: object[],
 *   needsTable: boolean,
 *   reason: string,
 * } | null}
 */
export function planNextForTarget(targetItem, count, inventory, nearbyBlocks, pos, opts = {}) {
  const { version = DEFAULT_VERSION, _depth = 0, nearbyTablePos = null } = opts;
  const inv = inventory ?? {};
  const nearby = Array.isArray(nearbyBlocks) ? nearbyBlocks : [];

  if (_depth > 6) return null; // safety ceiling: recipe trees are shallow in practice

  if ((inv[targetItem] ?? 0) >= count) {
    return null; // already have enough; nothing to plan
  }

  // Furnace-only outputs (iron_ingot, etc.) are checked BEFORE the generic
  // crafting-recipe lookup below: Recipe.find() returns unrelated crafting
  // recipes for these item ids (see SMELT_RECIPES's doc comment) that would
  // otherwise be picked by pickVariant() and produce a bogus `craft` step
  // the real craft tool cannot execute for a furnace-only transformation.
  if (SMELT_RECIPES[targetItem]) {
    return planSmeltStep(targetItem, count, inv, nearby, pos, { version, _depth, nearbyTablePos });
  }

  // Explicit gatherable leaves (raw_iron, cobblestone, logs, ...) are
  // resolved BEFORE the generic crafting-recipe lookup too, for the same
  // reason: raw_iron/raw_copper/raw_gold each have exactly one spurious
  // Recipe.find() entry ("uncraft 1 raw_iron_block into 9 raw_iron") that
  // is not how the real game or the real `gather` tool produces them
  // (mining iron_ore/deepslate_iron_ore directly drops raw_iron) — without
  // this priority check, pickVariant() would pick that recipe and recurse
  // into needing a raw_iron_block, a dead end with no gather leaf of its
  // own. GATHERABLE_FALLBACK membership is an explicit, curated signal that
  // this item is gathered, not crafted, so it always wins outright here.
  if (GATHERABLE_FALLBACK.has(targetItem)) {
    return {
      step: 'gather',
      item: targetItem,
      args: { block: targetItem, count: 1 },
      requires: [],
      ensures: [{ inv: targetItem, count: 1 }],
      needsTable: false,
      reason: `${targetItem} is a known gatherable leaf; skip any crafting-recipe lookup for it`,
    };
  }

  const variants = recipeVariantsFor(targetItem, { version });

  if (!variants.length) {
    // No known recipe: targetItem is a raw/gatherable leaf (or unknown to
    // this Minecraft version). Report it as a gather leaf so candidates.mjs
    // can decide whether a gather candidate applies, without recipe_planner
    // inventing a tool name it cannot verify.
    if (GATHERABLE_FALLBACK.has(targetItem) || nearby.includes(targetItem)) {
      return {
        step: 'gather',
        item: targetItem,
        args: { block: targetItem, count: 1 },
        requires: [],
        ensures: [{ inv: targetItem, count: 1 }],
        needsTable: false,
        reason: `${targetItem} has no known recipe; treat as a gatherable leaf`,
      };
    }
    return null;
  }

  const variant = pickVariant(variants, inv, nearby);
  if (!variant) return null;

  const missing = Object.entries(variant.ingredients).filter(([name, need]) => (inv[name] ?? 0) < need);

  if (missing.length > 0) {
    // Recurse into the first missing ingredient (deepest-first: resolve one
    // prerequisite at a time, exactly like crafting.ts's recursive
    // craftItem()/planNextCraftStep does over its RecipeIndex).
    const [missingName, missingCount] = missing[0];
    const sub = planNextForTarget(missingName, missingCount, inv, nearby, pos, { version, _depth: _depth + 1, nearbyTablePos });
    if (sub) return sub;
    // The missing ingredient itself has no known recipe and isn't visibly
    // gatherable right now — surface it as a named gap rather than silently
    // returning null, so a caller could log/escalate if it wanted to.
    return {
      step: null,
      item: missingName,
      args: {},
      requires: [],
      ensures: [],
      needsTable: false,
      reason: `missing ${missingCount}x ${missingName} for ${targetItem}, no recipe/gather leaf found`,
    };
  }

  // Every ingredient is held: the craft itself is the next step, but a
  // table-gated recipe needs a table prerequisite resolved first — either
  // walking to a visible-but-distant one, placing/crafting a new one, or
  // walking to one already within the real craft tool's own 24-block reach
  // (in which case tableAvailable() is already true and this whole branch
  // is skipped, letting the craft step below run directly).
  if (variant.requiresTable && !tableAvailable(inv, nearby, pos, nearbyTablePos)) {
    // A table IS visible, just farther than the craft tool's own 24-block
    // reach: walk to it explicitly rather than crafting another one.
    if (nearby.includes('crafting_table') && pos && nearbyTablePos) {
      return {
        step: 'go_to',
        item: 'crafting_table',
        args: { x: Math.floor(nearbyTablePos.x), y: Math.floor(nearbyTablePos.y), z: Math.floor(nearbyTablePos.z), distance: 3 },
        requires: [],
        ensures: [],
        needsTable: false,
        reason: `${targetItem} needs a crafting table; one is visible but farther than ${TABLE_CRAFT_REACH} blocks`,
      };
    }
    if ((inv.crafting_table ?? 0) > 0 && pos) {
      return {
        step: 'place',
        item: 'crafting_table',
        args: { block: 'crafting_table', x: Math.floor(pos.x) + 1, y: Math.floor(pos.y), z: Math.floor(pos.z) },
        requires: [{ inv: 'crafting_table', count: 1 }],
        ensures: [],
        needsTable: false,
        reason: `${targetItem} needs a crafting table; one is held but not placed`,
      };
    }
    const tableVariants = recipeVariantsFor('crafting_table', { version });
    const tableVariant = pickVariant(tableVariants, inv, nearby);
    if (tableVariant) {
      const tableMissing = Object.entries(tableVariant.ingredients).filter(([name, need]) => (inv[name] ?? 0) < need);
      if (tableMissing.length === 0) {
        return {
          step: 'craft',
          item: 'crafting_table',
          args: { item: 'crafting_table', count: 1 },
          requires: Object.entries(tableVariant.ingredients).map(([name, need]) => ({ inv: name, count: need })),
          ensures: [{ inv: 'crafting_table', count: tableVariant.resultCount }],
          needsTable: false,
          reason: `${targetItem} needs a crafting table; have ingredients to craft one`,
        };
      }
      const [missingName, missingCount] = tableMissing[0];
      const sub = planNextForTarget(missingName, missingCount, inv, nearby, pos, { version, _depth: _depth + 1, nearbyTablePos });
      if (sub) return sub;
    }
    return {
      step: null,
      item: 'crafting_table',
      args: {},
      requires: [],
      ensures: [],
      needsTable: true,
      reason: `${targetItem} needs a crafting table and none can be resolved yet`,
    };
  }

  return {
    step: 'craft',
    item: targetItem,
    args: { item: targetItem, count: variant.resultCount },
    requires: Object.entries(variant.ingredients).map(([name, need]) => ({ inv: name, count: need })),
    ensures: [{ inv: targetItem, count: variant.resultCount }],
    needsTable: false,
    reason: `all ingredients held for ${targetItem}`,
  };
}

// --- whole-package total-shortage estimation (task 1) ---------------------
//
// planNextForTarget() above only ever resolves ONE next executable step —
// by design, so candidates.mjs/decide.mjs always see a single concrete
// action per round. That design is exactly why an empty-inventory bot
// aiming for wooden_pickaxe used to gather a SINGLE oak_log, see its
// ensures (`{inv:'oak_log',count:1}`) already satisfied, and only then
// (one full decide.mjs round later) discover planks/the table/sticks each
// need MORE log than the one already in hand — it kept re-gathering one
// log at a time, re-discovering the next shortfall every round. This
// section instead walks the SAME recipe tree (same recipeVariantsFor()/
// pickVariant()/SMELT_RECIPES data, same pickVariant() tie-break order) to
// accumulate the TOTAL units of each base-gatherable leaf resource still
// needed to reach `count` of targetItem from a GIVEN (possibly empty)
// inventory — e.g. wooden_pickaxe from nothing needs 3x oak_log in total
// (1 for the pickaxe's own 2 planks + 1 stick's worth of planks + 1 for the
// table's 4 planks, rounded up by whole planks-per-log crafting yield) —
// so a single `gather` candidate can be sized to the WHOLE remaining gap in
// one shot instead of one unit at a time.
//
// Pure and read-only, exactly like planNextForTarget() itself: no bot, no
// decisions.jsonl, no mutation of the `inventory` object passed in (an
// internal working copy is cloned once at the top and only that copy is
// ever mutated as the walk "pretends" to craft intermediates forward).

const SHORTAGE_RECURSION_LIMIT = 8;

function cloneInventory(inventory) {
  return { ...(inventory ?? {}) };
}

/**
 * Recursively accumulate into `shortageOut` (mutated in place, keyed by
 * leaf resource name -> total additional units still needed) how many more
 * units of each GATHERABLE leaf resource are needed to produce `count`
 * more of `targetItem`, starting from `workingInv` (a working copy that
 * this function "pretends-crafts" forward as it resolves each
 * intermediate, so a shared ingredient — e.g. planks needed by both the
 * table AND the pickaxe AND the sticks — is only double-counted for the
 * portion actually still missing after the earlier step's pretend-craft
 * already reserved some of it).
 *
 * This intentionally mirrors planNextForTarget()'s own branch order
 * (smelt-recipe short-circuit, then GATHERABLE_FALLBACK leaf, then generic
 * recipe lookup via the SAME pickVariant() tie-break) so the two functions
 * can never disagree about which recipe/species a given target resolves
 * to — this is a parallel ACCUMULATING walk of the identical tree, not an
 * independent reimplementation that could drift.
 */
function accumulateShortage(targetItem, count, workingInv, nearbyBlocks, pos, opts, shortageOut) {
  const { version, _depth, nearbyTablePos } = opts;
  if (_depth > SHORTAGE_RECURSION_LIMIT) return;
  const have = workingInv[targetItem] ?? 0;
  if (have >= count) return; // this branch of the tree is already fully satisfied
  const stillNeeded = count - have;

  // Furnace-only outputs: walk the input material + treat the output as
  // "produced" by the smelt (reserve it in workingInv) without trying to
  // recurse into a bogus generic recipe for it (see SMELT_RECIPES's doc
  // comment on why Recipe.find() is unusable for these).
  const smeltRecipe = SMELT_RECIPES[targetItem];
  if (smeltRecipe) {
    const heldInput = smeltRecipe.inputs.find(name => (workingInv[name] ?? 0) > 0) ?? smeltRecipe.inputs[0];
    accumulateShortage(heldInput, stillNeeded, workingInv, nearbyBlocks, pos, { version, _depth: _depth + 1, nearbyTablePos }, shortageOut);
    workingInv[heldInput] = Math.max(0, (workingInv[heldInput] ?? 0) - stillNeeded);
    workingInv[targetItem] = (workingInv[targetItem] ?? 0) + stillNeeded;
    return;
  }

  // Gatherable leaf: this is exactly the quantity still needed of a raw
  // resource — accumulate it directly, no further recursion.
  if (GATHERABLE_FALLBACK.has(targetItem)) {
    shortageOut[targetItem] = (shortageOut[targetItem] ?? 0) + stillNeeded;
    workingInv[targetItem] = (workingInv[targetItem] ?? 0) + stillNeeded;
    return;
  }

  const variants = recipeVariantsFor(targetItem, { version });
  if (!variants.length) {
    // Unknown item with no recipe at all: still treat it as a leaf (same
    // fallback planNextForTarget() itself uses) so an unanticipated target
    // item never silently vanishes from the shortage tally.
    shortageOut[targetItem] = (shortageOut[targetItem] ?? 0) + stillNeeded;
    workingInv[targetItem] = (workingInv[targetItem] ?? 0) + stillNeeded;
    return;
  }

  const variant = pickVariant(variants, workingInv, nearbyBlocks);
  if (!variant) return;

  // How many TIMES must this recipe run to produce `stillNeeded` more
  // units (a craft call yields `resultCount` per call — e.g. 4 planks per
  // log — so needing 3 planks still only consumes a whole 1-log batch).
  const batches = Math.ceil(stillNeeded / Math.max(1, variant.resultCount));

  for (const [ingredientName, perBatch] of Object.entries(variant.ingredients)) {
    const totalIngredientNeeded = perBatch * batches;
    accumulateShortage(ingredientName, totalIngredientNeeded, workingInv, nearbyBlocks, pos, { version, _depth: _depth + 1, nearbyTablePos }, shortageOut);
    workingInv[ingredientName] = Math.max(0, (workingInv[ingredientName] ?? 0) - totalIngredientNeeded);
  }
  workingInv[targetItem] = (workingInv[targetItem] ?? 0) + batches * variant.resultCount;

  // A table-gated recipe needs exactly one crafting_table, not one per
  // batch — reserve it in the shortage tally the same way
  // planNextForTarget() treats it as a one-time prerequisite, only when
  // one is not already available.
  if (variant.requiresTable && !tableAvailable(workingInv, nearbyBlocks, pos, nearbyTablePos) && (workingInv.crafting_table ?? 0) < 1) {
    accumulateShortage('crafting_table', 1, workingInv, nearbyBlocks, pos, { version, _depth: _depth + 1, nearbyTablePos }, shortageOut);
  }
}

/**
 * Compute the TOTAL additional units of every gatherable leaf resource
 * needed to reach `count` of `targetItem` from the given inventory — e.g.
 * `computeTotalShortage('wooden_pickaxe', 1, {}, [], null)` reports
 * `{ oak_log: 3 }` (one log each for the table's planks, the pickaxe's own
 * planks, and the sticks' planks, each rounded up to whole logs). Pure,
 * read-only, safe to call every round from candidates.mjs/auto_loop.mjs —
 * it never mutates the `inventory` object passed in.
 *
 * @param {string} targetItem
 * @param {number} count
 * @param {Record<string,number>} inventory
 * @param {string[]} nearbyBlocks
 * @param {{x:number,y:number,z:number}|null} pos
 * @param {{version?: string, nearbyTablePos?: object|null}} [opts]
 * @returns {Record<string, number>} leaf resource name -> total additional units needed
 */
export function computeTotalShortage(targetItem, count, inventory, nearbyBlocks, pos, opts = {}) {
  const { version = DEFAULT_VERSION, nearbyTablePos = null } = opts;
  const shortage = {};
  const workingInv = cloneInventory(inventory);
  const nearby = Array.isArray(nearbyBlocks) ? nearbyBlocks : [];
  accumulateShortage(targetItem, count, workingInv, nearby, pos, { version, _depth: 0, nearbyTablePos }, shortage);
  return shortage;
}
