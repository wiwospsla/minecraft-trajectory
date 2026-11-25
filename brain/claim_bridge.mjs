// brain/claim_bridge.mjs — thin, optional glue between this MC brain and
// the sibling `agent-claim-memory` SDK (checkout: ../../agent-claim-memory
// relative to this repo's root, i.e. a sibling directory of this project).
//
// WHY THIS FILE EXISTS: `agent-claim-memory` is a separate, independently
// open-sourced zero-dependency "work-externalized memory adjudication
// layer" SDK. This brain reuses it for exactly two jobs, both strictly
// ADDITIVE and OUTSIDE environment A/B's own hard isolation boundary:
//
//   a) recordAreaPitfall / recallAreaWarnings — persist "this 16x16 chunk
//      region is bad news" conclusions (repeated failures/timeouts, or a
//      death to a strong hostile) keyed by `chunk_x_z` scope.modules, so a
//      LATER episode (even a brand new process, even a brand new LLM
//      conversation) can recall the warning before walking back into the
//      same trap. A pitfall that the bot successfully pushes through later
//      gets verifyClaim(ok:true)'d, which raises its confidence back up
//      only when it is a GOOD outcome for a *different*, already-disputed
//      claim — see recordAreaPitfall's own doc comment for the exact
//      "resolve previous pitfall" flow.
//
//   b) compileConstraintsForPrompt — a tiny, LLM-facing digest (2-3 short
//      plain-English sentences) of whatever hard constraints/pitfalls are
//      in scope right now, meant to be spliced into tools_adapter.mjs's
//      brain_next_step response so a long `pi` conversation that gets
//      compacted/summarized never silently drops a hard-won coordinate or
//      "don't go there again" lesson.
//
// GRACEFUL DEGRADATION (hard requirement): this repository must still run
// standalone if someone clones ONLY minecraft-agent-harness without the
// sibling agent-claim-memory checkout next to it. Every exported function
// here is safe to call unconditionally — on a missing/broken SDK import,
// every call silently resolves to a documented empty/no-op result instead
// of throwing. No new npm dependency is introduced; the SDK is loaded via
// a plain relative-path dynamic import that is allowed to fail.
//
// HARD BOUNDARY RESPECTED: this file is NEVER imported by decide.mjs,
// candidates.mjs, stream.mjs, slice.mjs, wiki.mjs, or log.mjs — nothing in
// environment A's locked core reaches into it. Only the optional call
// sites in auto_loop.mjs / tools_adapter.mjs (both NOT in the locked base
// file list) import this module, and they pass whatever it returns in as
// plain data (e.g. a soft score penalty number, or a hint string) exactly
// the same way they already pass in recentFailures/forceExploreFallback —
// decide.mjs/candidates.mjs still never read any claim-memory file
// themselves.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Default sibling-checkout path: D:\DeepSeekHarness\agent-claim-memory when
// this repo lives at D:\DeepSeekHarness\agent-envir\minecraft-agent-harness
// — i.e. two levels up from ROOT, then into agent-claim-memory/src. This is
// configurable (see createClaimBridge's opts.sdkPath) purely so tests can
// point it at a deliberately-missing path to exercise the degraded path.
const DEFAULT_SDK_SPECIFIER = '../../../agent-claim-memory/src/memory_sdk.mjs';

const DEFAULT_NAMESPACE = 'mc-survival';
const DEFAULT_DATA_DIR = path.join(ROOT, 'claim-memory-data');

// A chunk is a 16x16 (x,z) region, matching vanilla Minecraft's own chunk
// grid — see chunkKeyFor()'s doc comment. Repeated bad outcomes in the same
// chunk are what get consolidated into one pitfall claim rather than one
// claim per failed step, so recallAreaWarnings() returns a short, genuinely
// actionable list instead of a noisy one.
const PITFALL_FAIL_THRESHOLD = 2;

/**
 * Build the `chunk_x_z` scope.modules key for a world position, using
 * floor(coord / 16) exactly like Minecraft's own chunk coordinates. Returns
 * null when x/z are not finite numbers (e.g. no position available yet),
 * so callers can skip chunk-scoped bookkeeping gracefully instead of
 * stamping a bogus 'chunk_NaN_NaN' key.
 *
 * @param {number} x
 * @param {number} z
 * @returns {string|null}
 */
export function chunkKeyFor(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);
  return `chunk_${cx}_${cz}`;
}

/**
 * The fully-degraded (SDK unavailable) bridge: every method resolves to a
 * safe empty/no-op value, synchronously-shaped as a Promise so callers
 * never need an `if (bridge.available)` branch before calling through —
 * `await bridge.recallAreaWarnings(...)` is always safe.
 */
function createNoopBridge(reason) {
  return {
    available: false,
    reason,
    async recordAreaPitfall() {
      return { recorded: false, reason };
    },
    async recallAreaWarnings() {
      return { warnings: [], pitfallClaims: [] };
    },
    async resolvePitfall() {
      return { resolved: false, reason };
    },
    async compileConstraintsForPrompt() {
      return { lines: [], text: '' };
    },
  };
}

/**
 * Create the claim-memory bridge. Never throws: a missing/broken SDK
 * import, or a store that fails to initialize (e.g. an unwritable
 * dataDir), both fall back to createNoopBridge() so the caller's own
 * startup sequence (auto_loop.mjs/tools_adapter.mjs) is never put at risk
 * by this being a purely optional enhancement layer.
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir]    defaults to <repo-root>/claim-memory-data
 * @param {string} [opts.namespace]  defaults to 'mc-survival'
 * @param {string} [opts.sdkSpecifier]  override import specifier (tests use
 *   this to point at a deliberately-nonexistent path, proving graceful
 *   degradation without touching the real sibling checkout).
 * @returns {Promise<object>} the bridge (either a live one or createNoopBridge())
 */
export async function createClaimBridge({
  dataDir = DEFAULT_DATA_DIR,
  namespace = DEFAULT_NAMESPACE,
  sdkSpecifier = DEFAULT_SDK_SPECIFIER,
} = {}) {
  let createClaimMemory;
  try {
    const mod = await import(sdkSpecifier);
    createClaimMemory = mod.createClaimMemory;
    if (typeof createClaimMemory !== 'function') {
      return createNoopBridge('agent-claim-memory SDK module loaded but did not export createClaimMemory');
    }
  } catch (error) {
    // The documented degrade path: sibling checkout missing, or any other
    // import-time failure (syntax error in a future SDK version, etc.) —
    // this repo must keep working standalone either way.
    return createNoopBridge(`agent-claim-memory not available: ${String(error?.message ?? error).slice(0, 200)}`);
  }

  let memory;
  try {
    memory = createClaimMemory({ dataDir, namespace });
  } catch (error) {
    return createNoopBridge(`createClaimMemory failed: ${String(error?.message ?? error).slice(0, 200)}`);
  }

  /**
   * Persist (or reinforce) a pitfall conclusion for one chunk scope.
   *
   * Call this when a candidate tied to a specific chunk has failed/timed
   * out at least PITFALL_FAIL_THRESHOLD times in a row in that chunk, OR
   * immediately on a death to a strong hostile — both are judged by the
   * CALLER (auto_loop.mjs tracks its own in-memory per-chunk fail counts,
   * exactly like decide.mjs's existing recentFailures pattern); this
   * function itself does zero history inspection, it only ever writes.
   *
   * Idempotent in spirit: proposeClaim's own checkAndSupersede logic in
   * the SDK does not auto-merge same-scope 'pitfall' claims (pitfalls are
   * explicitly excluded from REPLACEABLE_KINDS, i.e. they are meant to
   * coexist/accumulate as independent evidence rather than overwrite one
   * another) — repeated calls for the same chunk simply add corroborating
   * claims, which recallAreaWarnings() below naturally dedupes for display
   * by chunk key.
   *
   * @param {object} input
   * @param {string} input.chunkKey   e.g. 'chunk_1_0' (see chunkKeyFor())
   * @param {string} input.reason     short human-readable cause, e.g.
   *   'repeated_timeout:gather:oak_log' or 'death:zombie'
   * @param {string} [input.ref]      source.ref evidence pointer (e.g. a
   *   decision_id or death event id) — mandatory provenance per the SDK's
   *   own "no ungrounded claim" rule, defaults to a timestamp if omitted.
   * @returns {Promise<{recorded: boolean, block_id?: string}>}
   */
  async function recordAreaPitfall({ chunkKey, reason, ref } = {}) {
    if (!chunkKey) return { recorded: false, reason: 'missing chunkKey' };
    try {
      const claim = await memory.propose({
        kind: 'pitfall',
        claim: `Area ${chunkKey} is risky: ${String(reason ?? 'repeated failure').slice(0, 200)}`,
        scope: { modules: [chunkKey], tags: ['mc-area-pitfall'] },
        source: { kind: 'tool', ref: ref ? String(ref).slice(0, 200) : `auto:${Date.now()}` },
        authority: 'tool_verified',
        confidence: 0.7,
        utility: 0.7,
      });
      return { recorded: true, block_id: claim?.block_id ?? null };
    } catch (error) {
      return { recorded: false, reason: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /**
   * Recall any active/disputed pitfall warnings scoped to one chunk. Other
   * chunks are NEVER returned — recall.mjs's own scope-match gate
   * (activeModules containing exactly this chunkKey) guarantees that, so a
   * bot standing in chunk_5_5 is never warned about chunk_1_0's history.
   *
   * @param {string} chunkKey
   * @param {object} [opts]
   * @param {number} [opts.topK=3]
   * @returns {Promise<{warnings: string[], pitfallClaims: object[]}>}
   *   `warnings`: at most topK short plain-English strings, newest/highest
   *   scored first — safe to splice straight into an LLM-facing hint or a
   *   soft score penalty lookup.
   */
  async function recallAreaWarnings(chunkKey, { topK = 3 } = {}) {
    if (!chunkKey) return { warnings: [], pitfallClaims: [] };
    try {
      const { results } = await memory.recall({ activeModules: [chunkKey], taskText: chunkKey }, { topK });
      const pitfallClaims = results.map(r => r.claim).filter(c => c.kind === 'pitfall');
      const warnings = pitfallClaims.map(c => `[避雷] ${c.claim}`);
      return { warnings, pitfallClaims };
    } catch (error) {
      return { warnings: [], pitfallClaims: [], error: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /**
   * Mark a previously-recorded pitfall as resolved once the chain that
   * used to break there succeeds (ok: true) — lowers false-positive drag
   * on future recall by letting the SDK's own verifyClaim machinery raise
   * confidence back toward neutral (two consecutive ok:true verifications
   * would be needed to fully clear a 'disputed' status, consistent with
   * the SDK's own 2-consecutive-failure dispute rule being symmetric in
   * spirit here) rather than this bridge silently deleting the claim
   * outright — the history of "this USED to be a problem" stays auditable
   * in the ledger even after it stops being one.
   *
   * @param {string} blockId
   * @param {object} [opts]
   * @param {string} [opts.ref]
   * @returns {Promise<{resolved: boolean}>}
   */
  async function resolvePitfall(blockId, { ref } = {}) {
    if (!blockId) return { resolved: false, reason: 'missing blockId' };
    try {
      await memory.verify(blockId, { ok: true, evidenceRef: ref ? String(ref).slice(0, 200) : undefined, note: 'chain succeeded; pitfall pressure released' });
      return { resolved: true };
    } catch (error) {
      return { resolved: false, reason: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /**
   * LLM-facing anti-compaction digest: at most 2-3 terse sentences
   * covering (a) the current chunk's pitfall warnings and (b) any
   * compiled hard-constraint injection the SDK itself would otherwise
   * produce via compileInjection() for this scope — meant to be appended
   * to brain_next_step's response so a long `pi` conversation that gets
   * compacted/summarized never silently drops a hard-won coordinate or a
   * known trap.
   *
   * @param {object} ctx
   * @param {string} [ctx.chunkKey]
   * @returns {Promise<{lines: string[], text: string}>}
   */
  async function compileConstraintsForPrompt({ chunkKey } = {}) {
    const lines = [];
    try {
      if (chunkKey) {
        const { warnings } = await recallAreaWarnings(chunkKey, { topK: 2 });
        lines.push(...warnings);
      }
      // injector.mjs's real return shape: { compiled_constraints: string[],
      // pitfall_warnings: {text,...}[], context_claims, disputed_warnings,
      // debugTrace }. compiled_constraints (channel 1, hard constraints) is
      // what this digest additionally pulls in, deduped against the
      // pitfall warnings already gathered above via recallAreaWarnings().
      const injection = await memory.compileInjection({ activeModules: chunkKey ? [chunkKey] : [], taskText: chunkKey ?? '' }, { topK: 2 });
      const extra = Array.isArray(injection?.compiled_constraints) ? injection.compiled_constraints : [];
      for (const l of extra) {
        if (lines.length >= 3) break;
        if (typeof l === 'string' && l && !lines.includes(l)) lines.push(`[约束] ${l}`);
      }
    } catch {
      // Best-effort only: a broken compileInjection() must never block
      // brain_next_step's main response.
    }
    const capped = lines.slice(0, 3);
    return { lines: capped, text: capped.join(' ') };
  }

  return {
    available: true,
    namespace,
    dataDir,
    recordAreaPitfall,
    recallAreaWarnings,
    resolvePitfall,
    compileConstraintsForPrompt,
  };
}

// Module-level singleton (lazy, memoized) for the two production call
// sites (auto_loop.mjs / tools_adapter.mjs) so neither has to thread a
// bridge instance through every function call by hand, and so the SDK's
// own in-process store (which keeps namespace state cached in memory, see
// store.mjs) is shared rather than re-initialized from disk on every
// single decision round. Tests that need a fresh/degraded instance call
// createClaimBridge() directly instead of this singleton.
let singleton = null;
export async function getDefaultClaimBridge() {
  if (!singleton) singleton = createClaimBridge();
  return singleton;
}

export const PITFALL_FAIL_THRESHOLD_EXPORT = PITFALL_FAIL_THRESHOLD;
