// brain/_archive/brain.mjs — ARCHIVED EARLY PROTOTYPE, NOT PART OF THE
// CURRENT BRAIN. Kept for history only; nothing in brain/ or src/ imports
// this file (verified by grep before archiving — see brain/README.md's
// "历史与归档" section). Superseded end-to-end by:
//   candidates.mjs      (candidate generation, this file's buildCandidates())
//   decide.mjs          (UCB1 scoring, this file's scoreCandidates())
//   macro_executor.mjs  (tool execution, this file's execute())
//   deliberate.mjs      (environment B periodic review — did not exist here)
//   auto_loop.mjs       (the 0-token live driver that replaced this main loop)
// Left in place, unmodified, purely as a historical reference for how the
// project started before the A/B environment split existed. Do not run
// this directly against a real server expecting current behavior — it
// predates the Wiki-bucketed policy table, stitched macros, personas, and
// every other upgrade documented in brain/README.md.
//
// --- original header below, unchanged ---
//
// brain/brain.mjs — the main loop. Connects a plain mineflayer bot (not the
// harness's LLM agent), observes the world, checks route progress against
// brain/splits.json, generates a handful of candidate actions, scores them
// with UCB1 using history read back from decisions.jsonl, executes the
// winner, and appends one record per round. No LLM involved by design.
//
// Run: node brain/brain.mjs
// Stop: Ctrl+C

import { createBot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';

const { pathfinder, Movements, goals } = pathfinderPkg;
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { evaluate } from './wiki.mjs';
import { append, lastIncomplete } from './stream.mjs';
import { stats, totalRounds } from './slice.mjs';
import { ucb } from './formulas.mjs';
import { logDeviation } from './log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPLITS = JSON.parse(readFileSync(join(__dirname, 'splits.json'), 'utf8'));

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25565);
const USERNAME = process.env.MC_USERNAME || 'BrainBot';
const ROUND_MS = Number(process.env.BRAIN_ROUND_MS || 2500);
const STALL_ROUNDS_FOR_DEVIATION = 5;

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

function observe(bot) {
  const inventory = {};
  for (const item of bot.inventory.items()) {
    inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
  }
  const pos = bot.entity?.position;
  return {
    pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
    hp: bot.health ?? null,
    food: bot.food ?? null,
    inv: inventory,
    dimension: bot.game?.dimension ?? null,
  };
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

const WOOD_LOG_NAMES = new Set([
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
]);

const ORE_BLOCK_NAMES = new Set([
  'coal_ore',
  'deepslate_coal_ore',
  'iron_ore',
  'deepslate_iron_ore',
  'diamond_ore',
  'deepslate_diamond_ore',
]);

/**
 * Build the candidate list for this round: things the bot could try next.
 * Each candidate has a stable `id` (used as the UCB arm key), a `label`,
 * and a `kind` + enough payload to execute it later.
 */
function buildCandidates(bot, mcData, state) {
  const candidates = [];

  // MINE: nearest loggable wood block within reach.
  const logBlock = bot.findBlock({
    matching: block => WOOD_LOG_NAMES.has(block?.name),
    maxDistance: 32,
  });
  if (logBlock) {
    candidates.push({
      id: `mine:${logBlock.name}`,
      label: `Mine ${logBlock.name}`,
      kind: 'mine',
      blockName: logBlock.name,
      position: logBlock.position,
      prior: 8,
    });
  }

  // MINE: nearest stone/ore if we already have a pickaxe-worthy progression.
  const oreBlock = bot.findBlock({
    matching: block => ORE_BLOCK_NAMES.has(block?.name) || block?.name === 'stone',
    maxDistance: 24,
  });
  if (oreBlock) {
    candidates.push({
      id: `mine:${oreBlock.name}`,
      label: `Mine ${oreBlock.name}`,
      kind: 'mine',
      blockName: oreBlock.name,
      position: oreBlock.position,
      prior: 6,
    });
  }

  // CRAFT: anything the player currently has enough raw materials for,
  // restricted to items that appear in splits.json so the bot doesn't
  // wander off crafting unrelated junk.
  const craftTargets = ['oak_planks', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe'];
  for (const itemName of craftTargets) {
    const itemId = mcData.itemsByName[itemName]?.id;
    if (itemId === undefined) continue;
    const noTable = bot.recipesFor(itemId, null, 1, null);
    const withTable = noTable.length ? [] : bot.recipesFor(itemId, null, 1, true);
    const recipe = noTable[0] ?? withTable[0];
    if (!recipe) continue;
    candidates.push({
      id: `craft:${itemName}`,
      label: `Craft ${itemName}`,
      kind: 'craft',
      itemName,
      needsTable: !noTable.length,
      prior: 9,
    });
  }

  // WAIT: always available fallback so there's never an empty candidate set.
  candidates.push({ id: 'wait', label: 'Wait and look around', kind: 'wait', prior: 1 });

  return candidates;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreCandidates(candidates) {
  const agg = stats({});
  const t = totalRounds() + 1;
  return candidates.map(c => {
    const hist = agg[c.id];
    const n = hist?.n ?? 0;
    const sum = hist?.sum ?? 0;
    const score = ucb(n, sum, t, c.prior ?? 5);
    return { id: c.id, label: c.label, score, n, mu: hist?.mu ?? 0, candidate: c };
  });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function execute(bot, scored) {
  const c = scored.candidate;
  try {
    if (c.kind === 'wait') {
      await sleep(500);
      return { ok: true, code: 'waited' };
    }

    if (c.kind === 'mine') {
      const block = bot.blockAt(c.position);
      if (!block || block.name !== c.blockName) {
        return { ok: false, code: 'block_gone' };
      }
      await gotoNear(bot, c.position, 2);
      await bot.dig(block);
      return { ok: true, code: 'mined' };
    }

    if (c.kind === 'craft') {
      const mcData = minecraftData(bot.version);
      const itemId = mcData.itemsByName[c.itemName]?.id;
      let table = null;
      if (c.needsTable) {
        table = bot.findBlock({ matching: b => b?.name === 'crafting_table', maxDistance: 16 });
        if (!table) return { ok: false, code: 'no_table' };
        await gotoNear(bot, table.position, 2);
      }
      const recipes = bot.recipesFor(itemId, null, 1, table ?? (c.needsTable ? true : null));
      const recipe = recipes[0];
      if (!recipe) return { ok: false, code: 'no_recipe' };
      await bot.craft(recipe, 1, table ?? undefined);
      return { ok: true, code: 'crafted' };
    }

    return { ok: false, code: 'unknown_kind' };
  } catch (err) {
    return { ok: false, code: 'error', message: String(err?.message ?? err).slice(0, 160) };
  }
}

async function gotoNear(bot, position, range) {
  const Movements_ = new Movements(bot);
  bot.pathfinder.setMovements(Movements_);
  const goal = new goals.GoalNear(position.x, position.y, position.z, range);
  await bot.pathfinder.goto(goal);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function buildState(obs) {
  return { inventory: obs.inv, dimension: obs.dimension };
}

async function main() {
  console.log(`[brain] connecting to ${HOST}:${PORT} as ${USERNAME}`);
  const resumed = lastIncomplete();
  if (resumed) {
    console.log(`[brain] resuming: last recorded decision_id=${resumed.decision_id}, cur_idx=${resumed.reference?.step}`);
  }

  const bot = createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    auth: 'offline',
    version: false,
  });

  bot.loadPlugin(pathfinder);

  let decisionCounter = 0;
  let stallRounds = 0;
  let lastIdx = -1;

  bot.once('spawn', () => {
    console.log('[brain] spawned, starting decision loop');
    const mcData = minecraftData(bot.version);
    const interval = setInterval(() => {
      runRound(bot, mcData).catch(err => console.error('[brain] round error:', err));
    }, ROUND_MS);
    bot.once('end', () => clearInterval(interval));
  });

  async function runRound(bot, mcData) {
    const obs = observe(bot);
    const state = buildState(obs);
    const before = evaluate(SPLITS, state);

    const candidates = buildCandidates(bot, mcData, state);
    const scored = scoreCandidates(candidates);
    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0];

    const result = await execute(bot, winner);

    const obsAfter = observe(bot);
    const stateAfter = buildState(obsAfter);
    const after = evaluate(SPLITS, stateAfter);

    const advanced = after.cur_idx > before.cur_idx;
    decisionCounter += 1;

    append({
      decision_id: decisionCounter,
      time: Date.now(),
      seen: { pos: obs.pos, hp: obs.hp, food: obs.food, inv: obs.inv },
      reference: {
        wiki_id: SPLITS[before.cur_idx]?.id ?? null,
        step: before.cur_idx,
        next: before.next?.id ?? null,
        matched: before.satisfied,
      },
      before_idx: before.cur_idx,
      after_idx: after.cur_idx,
      advanced,
      candidates: scored.map(s => ({ id: s.id, label: s.label, score: Number(s.score.toFixed(4)), n: s.n, mu: s.mu })),
      chosen: winner.id,
      why: `ucb score ${winner.score.toFixed(4)} (n=${winner.n})`,
      result,
    });

    if (advanced) {
      stallRounds = 0;
      lastIdx = after.cur_idx;
    } else {
      stallRounds += 1;
    }

    if (stallRounds >= STALL_ROUNDS_FOR_DEVIATION) {
      logDeviation('progress', {
        decision_id: decisionCounter,
        stuck_at_idx: lastIdx,
        rounds_without_progress: stallRounds,
        next_target: before.next?.id ?? null,
      });
      stallRounds = 0; // avoid spamming one deviation record every round forever
    }

    console.log(
      `[brain] #${decisionCounter} chose=${winner.id} ok=${result.ok} idx ${before.cur_idx}->${after.cur_idx}${advanced ? ' (advanced)' : ''}`,
    );
  }

  bot.on('kicked', reason => console.error('[brain] kicked:', reason));
  bot.on('error', err => console.error('[brain] error:', err?.message ?? err));
}

main().catch(err => {
  console.error('[brain] fatal:', err);
  process.exitCode = 1;
});
