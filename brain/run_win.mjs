// brain/run_win.mjs — Windows-safe direct launcher.
//
// src/agent.js (the stock entry point) unconditionally calls
// createWorkspaceTools() from src/tools/workspace-tools.js, which opens
// directory file descriptors with POSIX-only flags (O_DIRECTORY|O_NOFOLLOW)
// and fails hard on Windows. We are not allowed to modify src/*, so this
// file re-assembles the SAME startup sequence src/agent.js uses, minus that
// one call, straight from the existing, unmodified building blocks:
//   src/config.js        (.env + CLI flags -> config/settings)
//   src/body/bot.js       (initBot)
//   src/tools/game-tools.js (createObservation, createGameTools, createActionRunner)
//   src/model/session.js  (createMinecraftSession)
//   brain/tools_adapter.mjs (brain_next_step / brain_record_outcome)
//
// Run: node brain/run_win.mjs --objective "..." [--duration 30] [--name Bot]
// Stop: Ctrl+C

import { mkdirSync, existsSync, appendFileSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

import { resolveConfig, readConfigFile, fromEnv, toSettings, toAgentOptions, DEFAULTS } from '../src/config.js';
import { checkModel, EXIT, kickText, isFatalKick, connectionMessage, activityLine } from '../src/startup.js';
import { initBot } from '../src/body/bot.js';
import { createGameTools, createObservation, createActionRunner, installSkillCompatibility } from '../src/tools/game-tools.js';
import { schema } from '../src/tools/extra-tools.js';
import { createMinecraftSession } from '../src/model/session.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { setSettings } from '../src/skills/settings.js';
import * as skills from '../src/skills/skills.js';
import * as survival from '../src/skills/survival.js';
import * as perception from '../src/skills/perception.js';
import * as world from '../src/skills/world.js';

import createBrainTools, { recordTelemetryFallback } from './tools_adapter.mjs';
import { POLICY_PATH, readPolicyTable, writePolicyTableAtomic } from './policy_table.mjs';
import { runDeliberation } from './deliberate.mjs';
import { LOG_PATH as DECISIONS_LOG_PATH } from './stream.mjs';
import { DEFAULT_PERSONA_NAME } from './persona.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BRAIN_PROMPT_SUFFIX = `

BRAIN TOOLS: before any meaningful game action (gathering, crafting, placing, mining, fighting, fleeing, eating),
call brain_next_step first — it reads your live state itself and proposes the best next action plus runner-up
alternatives, grounded in the Wiki route and a periodically-refreshed policy table. After you act on it (or on
your own judgement), call brain_record_outcome with the decision_id, the candidate id you actually ran, whether
it succeeded, and a short result code. This keeps the policy table useful for your next brain_next_step call.`;

/**
 * If no policy_snapshot.json exists yet, write a safe empty default so the
 * very first brain_next_step call has something valid to read (environment
 * A never recomputes from decisions.jsonl itself, so it needs this file to
 * exist in at least its default shape before the first decision).
 */
function ensurePolicySnapshotInitialized(policyPath = POLICY_PATH) {
  if (existsSync(policyPath)) return { created: false };
  const table = readPolicyTable(policyPath); // missing file -> defaultPolicyTable()
  writePolicyTableAtomic(table, policyPath);
  return { created: true };
}

function loadDotEnv(cwd) {
  const file = path.join(cwd, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

const RUN_OPTIONS = {
  config: { type: 'string', short: 'c' },
  host: { type: 'string', short: 'H' },
  port: { type: 'string', short: 'p' },
  auth: { type: 'string' },
  'mc-version': { type: 'string' },
  name: { type: 'string', short: 'n' },
  objective: { type: 'string', short: 'o' },
  'game-mode': { type: 'string' },
  model: { type: 'string', short: 'm' },
  'base-url': { type: 'string' },
  'models-file': { type: 'string' },
  thinking: { type: 'string' },
  vision: { type: 'boolean' },
  'tick-rate': { type: 'string' },
  'state-dir': { type: 'string' },
  duration: { type: 'string' },
  'no-respawn': { type: 'boolean' },
  'allow-flight': { type: 'boolean' },
  personality: { type: 'string' },
  persona: { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
};

const FLAG_TO_KEY = {
  host: 'host',
  port: 'port',
  auth: 'auth',
  'mc-version': 'minecraftVersion',
  name: 'name',
  objective: 'objective',
  'game-mode': 'gameMode',
  model: 'model',
  'base-url': 'baseUrl',
  'models-file': 'modelsFile',
  thinking: 'thinking',
  vision: 'vision',
  'tick-rate': 'tickRate',
  'state-dir': 'stateDir',
  duration: 'durationMinutes',
  'allow-flight': 'allowFlight',
  personality: 'personality',
};

function flagsToConfig(values) {
  const out = {};
  for (const [flag, key] of Object.entries(FLAG_TO_KEY)) if (values[flag] !== undefined) out[key] = values[flag];
  if (values['no-respawn']) out.respawn = false;
  if (values.quiet) out.quiet = true;
  // run_win.mjs never uses a sandbox (no shell/workspace tools on this path).
  out.sandbox = 'none';
  return out;
}

const HELP = `brain/run_win.mjs — Windows-safe direct launcher (bypasses workspace-tools.js)

Usage: node brain/run_win.mjs --objective "..." [options]

  -H, --host <host>        Minecraft server host           (MC_HOST, default ${DEFAULTS.host})
  -p, --port <port>        Minecraft server port            (MC_PORT, default ${DEFAULTS.port})
      --auth <mode>        offline | microsoft              (MC_AUTH, default ${DEFAULTS.auth})
      --mc-version <ver>   protocol version or "auto"       (MC_VERSION, default ${DEFAULTS.minecraftVersion})
  -n, --name <name>        in-game username                 (AGENT_NAME, default ${DEFAULTS.name})
  -o, --objective <text>   what the agent should do         (AGENT_OBJECTIVE, required)
      --game-mode <mode>   survival | creative              (AGENT_GAME_MODE, default ${DEFAULTS.gameMode})
      --duration <min>     stop after this long             (default: run until stopped)
  -m, --model <p/id>       provider/model-id                 (AGENT_MODEL, default ${DEFAULTS.model})
      --thinking <level>   off | minimal | low | medium | high | xhigh
      --tick-rate <tps>    server tick rate if below 20
      --state-dir <dir>    sessions/logs                     (AGENT_STATE_DIR, default ${DEFAULTS.stateDir})
      --persona <name>     brain/persona.json preset         (BRAIN_PERSONA, default ${DEFAULT_PERSONA_NAME}: balanced | companion_builder | speedrunner)
  -q, --quiet               no per-tool activity lines
  -c, --config <file>      JSON config file
  -h, --help                show this help
`;

async function main(argv = process.argv.slice(2)) {
  const cwd = process.cwd();
  loadDotEnv(cwd);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: RUN_OPTIONS, allowPositionals: false, strict: true });
  } catch (e) {
    console.error(`run_win: ${e.message}`);
    return EXIT.usage;
  }
  const { values } = parsed;
  if (values.help) {
    console.log(HELP);
    return EXIT.ok;
  }

  let config;
  try {
    const file = values.config ? readConfigFile(path.resolve(cwd, values.config)) : {};
    config = resolveConfig([file, fromEnv(), flagsToConfig(values)], { cwd });
  } catch (e) {
    console.error(`run_win: ${e.message}`);
    return EXIT.usage;
  }

  const problem = await checkModel(config);
  if (problem) {
    console.error(`run_win: ${problem}`);
    return EXIT.error;
  }

  const { created } = ensurePolicySnapshotInitialized();
  if (created) console.log(`[run_win] initialized empty policy_snapshot.json at ${POLICY_PATH}`);

  // Resolved here (moved up from its previous spot right before
  // createBrainTools() below) so the hot-start deliberation pass just
  // below can also stamp the correct activePersona onto
  // policy_snapshot.json, instead of silently omitting it and letting
  // deliberate.mjs's own "keep whatever the previous snapshot already had"
  // fallback leave active_persona stale/null on a fresh snapshot — the
  // same activePersona-passthrough bug fix task 4 applies to auto_loop.mjs/
  // tools_adapter.mjs.
  // --persona (CLI) takes priority over BRAIN_PERSONA (.env/environment,
  // already loaded by loadDotEnv(cwd) above), which in turn takes priority
  // over persona.mjs's own neutral default.
  const personaName = values.persona ?? process.env.BRAIN_PERSONA ?? DEFAULT_PERSONA_NAME;
  console.log(`[run_win] persona=${personaName}`);

  // Hot-start alignment: if decisions.jsonl already has history from a
  // previous run (restart, crash, or a prior session that never reached the
  // "every 5 outcomes" threshold), run one deliberation pass up front so
  // policy_snapshot.json reflects that history before the very first live
  // brain_next_step call of THIS run — otherwise up to 4 outcomes' worth of
  // prior progress could sit unreflected in the snapshot indefinitely.
  if (existsSync(DECISIONS_LOG_PATH)) {
    try {
      const raw = readFileSync(DECISIONS_LOG_PATH, 'utf8');
      const hasAtLeastOneRecord = raw.split('\n').some(line => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        try {
          JSON.parse(trimmed);
          return true;
        } catch {
          return false;
        }
      });
      if (hasAtLeastOneRecord) {
        runDeliberation({ activePersona: personaName });
        console.log('[run_win] hot-start: ran one deliberation pass over existing decisions.jsonl history');
      }
    } catch (error) {
      console.error(`[run_win] hot-start deliberation skipped: ${String(error?.message ?? error).slice(0, 200)}`);
    }
  }

  const settings = toSettings(config);
  const options = toAgentOptions(config);
  setSettings({ ...settings });

  const root = settings.profile.pi.stateRoot;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const telemetryPath = path.join(root, 'telemetry.jsonl');
  const record = (event, fields = {}) =>
    appendFileSync(telemetryPath, JSON.stringify({ time: new Date().toISOString(), agent: settings.profile.name, event, ...fields }) + '\n');

  const atom = (file, value) => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  };

  console.log(`[run_win] connecting to ${settings.host}:${settings.port} as ${settings.profile.name}`);
  const bot = initBot(settings.profile.name);
  bot.pi_no_flight = options.allowFlight !== true;

  // Set once createActionRunner()/createMinecraftSession() exist below;
  // finish() is defined before them (it's wired to bot events immediately)
  // but only reaches into them once they're assigned, since by the time a
  // real stop reason fires (deadline, kick, SIGINT) both are already set.
  let actionRunnerRef = null;
  let sessionRunnerRef = null;
  let statusIntervalRef = null;

  let closing = false;
  const finish = async (reason, { message } = {}) => {
    if (closing) return;
    closing = true;
    record('stopping', { reason, ...(message ? { message: String(message).slice(0, 500) } : {}) });
    console.log(`[run_win] stopping (${reason})${message ? `: ${message}` : ''}`);

    if (statusIntervalRef) clearInterval(statusIntervalRef);

    // Hard ceiling so a stuck model/tool call can never keep the process
    // alive past a few seconds after a stop was requested — mirrors
    // src/agent.js's own `hardStop` escape hatch, just shorter since
    // run_win.mjs has no camera/mailbox/shell-tool cleanup to wait on.
    const hardStop = setTimeout(() => process.exit(exitCodeFor(reason)), 3000);
    hardStop.unref?.();

    try {
      if (actionRunnerRef && typeof actionRunnerRef.stop === 'function') {
        await actionRunnerRef.stop();
      }
    } catch {
      // best-effort: a stuck in-flight game action must not block shutdown
    }
    try {
      if (sessionRunnerRef && typeof sessionRunnerRef.close === 'function') {
        await Promise.race([
          sessionRunnerRef.close(),
          new Promise(resolve => setTimeout(resolve, 2000)),
        ]);
      } else if (sessionRunnerRef && typeof sessionRunnerRef.cancel === 'function') {
        sessionRunnerRef.cancel();
      }
    } catch {
      // best-effort: a stuck model session must not block shutdown either
    }
    try {
      bot.quit('Agent stopped');
    } catch {
      // bot may already be disconnected
    }

    clearTimeout(hardStop);
    process.exitCode = exitCodeFor(reason);
    process.exit(process.exitCode);
  };

  function exitCodeFor(reason) {
    return reason === 'operator_stop' || reason === 'deadline' ? EXIT.ok : EXIT.error;
  }

  process.once('SIGINT', () => void finish('operator_stop'));
  process.once('SIGTERM', () => void finish('operator_stop'));
  process.once('uncaughtException', error => {
    record('uncaught_error', { message: String(error?.message ?? error).slice(0, 500) });
    void finish('uncaught_error', { message: String(error?.message ?? error) });
  });

  let spawned = false;
  let connectionError = null;
  bot.once('kicked', reason => {
    const text = kickText(reason);
    record('kicked', { reason: text.slice(0, 300) });
    void finish(isFatalKick(text) ? 'kicked_fatal' : 'kicked', { message: text });
  });
  bot.once('end', reason => {
    if (closing) return;
    if (!spawned) {
      console.error(`[run_win] ${connectionMessage(connectionError ?? new Error(String(reason ?? 'closed')), settings.host, settings.port)}`);
      process.exitCode = EXIT.error;
      return;
    }
    void finish('disconnected', { message: String(reason ?? 'connection closed') });
  });
  bot.on('error', error => {
    connectionError = error;
    record('connection_error', { message: String(error?.message ?? error).slice(0, 300) });
  });

  try {
    await once(bot, 'spawn', { signal: AbortSignal.timeout(60000) });
  } catch (error) {
    // Real bug fix (same class as auto_loop.mjs's identical fix): a bare
    // `return EXIT.error` here only sets main()'s resolved value — it
    // never quits the bot or forces the process to exit, so a spawn
    // timeout/race (the server can accept the login right around when this
    // client-side 60s AbortSignal fires) could leave the socket open and
    // the process hanging indefinitely with no further output. Quit the
    // bot explicitly and force-exit with the right code instead of relying
    // on the event loop to drain on its own.
    const message = error?.name === 'AbortError'
      ? `timed out after 60s waiting to spawn on ${settings.host}:${settings.port}`
      : error?.code
        ? connectionMessage(error, settings.host, settings.port)
        : null;
    if (message === null) throw error;
    console.error(`[run_win] ${message}`);
    try {
      bot.quit('spawn failed');
    } catch {
      // may already be disconnected
    }
    process.exitCode = EXIT.error;
    process.exit(EXIT.error);
  }
  spawned = true;
  installSkillCompatibility(bot);
  record('spawn', { position: bot.entity.position, gameMode: bot.game.gameMode });
  console.log(`[run_win] spawned at ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)}`);

  const actionRunner = createActionRunner(bot, { settleTimeoutMs: 8000, onFatal: () => void finish('unsafe_action') });
  actionRunnerRef = actionRunner;
  const observe = createObservation({ bot, perception, world });

  // personaName already resolved above (moved up so the hot-start
  // deliberation pass could also use it).
  const brainTools = await createBrainTools({ bot, name: settings.profile.name, schema, personaName });

  const gameTools = createGameTools({
    bot,
    skills: { ...skills, ...survival },
    observe,
    actionRunner,
    perception,
    world,
    extraTools: brainTools,
  });

  const prompt = buildSystemPrompt({
    name: settings.profile.name,
    objective: settings.profile.objective,
    gameMode: config.gameMode,
    team: false,
    personality: settings.profile.personality,
    soul: settings.profile.soul,
    tickRate: options.tickRate,
    vision: options.vision,
    respawn: options.respawn,
    sandbox: false,
    sharedMachine: false,
    canFly: !bot.pi_no_flight,
  }) + BRAIN_PROMPT_SUFFIX;

  const runner = await createMinecraftSession({
    agentId: settings.profile.name,
    cwd: process.cwd(),
    sessionDir: path.join(root, 'pi-sessions'),
    systemPrompt: prompt,
    apiKey: options.apiKey,
    model: options.model,
    modelsPath: options.modelsPath,
    thinkingLevel: options.thinkingLevel,
    reconnected: false,
    tools: gameTools,
    maxModelCalls: Number.MAX_SAFE_INTEGER,
    maxToolCalls: Number.MAX_SAFE_INTEGER,
    continuous: true,
    observe: async ({ signal }) => {
      const current = await observe({ signal });
      return { text: JSON.stringify({ ...current.state }), images: [] };
    },
    telemetry: event => {
      record('tool', event);
      if (!config.quiet) console.log(activityLine(event));
      // Fallback for when the LLM calls a real game tool but forgets to
      // call brain_record_outcome afterward: auto-fills the outcome from
      // this tool-call event so the policy table doesn't silently starve
      // of outcomes. No-op when there's no unambiguous open proposal, or
      // when the LLM already recorded the outcome itself.
      try {
        recordTelemetryFallback(event);
      } catch (error) {
        record('telemetry_fallback_error', { message: String(error?.message ?? error).slice(0, 200) });
      }
    },
    onText: text => {
      if (!config.quiet) console.log(`"${text.replace(/\s+/g, ' ').slice(0, 300)}"`);
    },
    onModelError: message => console.error(`[run_win] model error, will retry: ${message.slice(0, 300)}`),
    onFatal: message => void finish('model_error', { message: `Model request failed: ${message}` }),
  });
  sessionRunnerRef = runner;

  if (Number.isFinite(config.deadlineAt && Date.parse(config.deadlineAt))) {
    const ms = Date.parse(config.deadlineAt) - Date.now();
    if (ms > 0) setTimeout(() => void finish('deadline'), Math.min(ms, 2 ** 31 - 1));
  }

  const statusInterval = setInterval(() => {
    if (closing) {
      clearInterval(statusInterval);
      return;
    }
    try {
      atom(path.join(root, 'status.json'), {
        agent: settings.profile.name,
        status: 'running',
        objective: settings.profile.objective,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // best-effort status checkpoint; never fatal
    }
  }, 3000);
  statusIntervalRef = statusInterval;

  record('ready', { tools: gameTools.map(t => t.name) });
  console.log(`[run_win] ${gameTools.length} tools ready (including brain_next_step/brain_record_outcome). Logs: ${telemetryPath}`);
  runner.start();
  return null; // keep running until stopped
}

main().then(code => {
  if (code !== null && code !== undefined) process.exitCode = code;
}).catch(err => {
  console.error('[run_win] fatal:', err);
  process.exitCode = 1;
});
