// brain/policy_table.mjs — the ONLY read/write boundary for policy_snapshot.json.
//
// This is the physical isolation point between environment B (periodic
// deliberation, which computes and atomically writes the snapshot) and
// environment A (immediate decision, which may ONLY read it back). Nothing
// in this file ever touches decisions.jsonl: it has no import of stream.mjs
// or slice.mjs, by design, so that boundary cannot be smuggled through here.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location: project root policy_snapshot.json (sibling of brain/). */
export const POLICY_PATH = join(__dirname, '..', 'policy_snapshot.json');

/** Default location: brain/wiki_priors.json (sibling of this file). */
export const WIKI_PRIORS_PATH = join(__dirname, 'wiki_priors.json');

/**
 * A brand-new, empty-but-valid policy table. Used whenever no snapshot file
 * exists yet, or the file on disk cannot be parsed as the expected shape —
 * environment A must never crash or block on a missing/corrupt snapshot.
 * @returns {object}
 */
export function defaultPolicyTable() {
  return {
    version: 1,
    updatedAt: null,
    cur_idx: -1,
    next_split_id: null,
    total_rounds: 0,
    entries: {},
    stitched_macros: [],
    active_persona: null,
    macro_flow_summary: [],
    // episode_history (task 4, "局间四定义复盘"): append-only (capped at 20,
    // oldest dropped) list of per-episode summaries written by
    // deliberate.mjs's runDeliberation({ mode: 'inter_episode' }) — see that
    // function's own doc comment. Purely descriptive/read-only for
    // status_report.mjs's "跨局成长轨迹" section; decide.mjs/candidates.mjs
    // never read this array.
    episode_history: [],
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate/repair a candidate entry record so downstream math (formulas.ucb,
 * etc.) always receives finite numbers and sane defaults, even if the file
 * on disk was hand-edited or partially written.
 */
function sanitizeEntry(raw) {
  const e = isPlainObject(raw) ? raw : {};
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  const entry = {
    weight: num(e.weight, 1),
    prior_confidence: num(e.prior_confidence, 0),
    proficiency_count: num(e.proficiency_count, 0),
    has_precedent: Boolean(e.has_precedent),
    sum_reward: num(e.sum_reward, 0),
  };
  // Eligibility trace (TD-lambda style, stage 4): both fields are OPTIONAL
  // and purely additive for backward compatibility — an entry written by
  // an older deliberate.mjs (or hand-seeded without them) simply omits
  // both, which decide.mjs's decay math treats as "no decay applied" (see
  // decide.mjs's policyEntryFor/scoreCandidate). Only included on the
  // sanitized entry when the raw value was actually a finite number, so a
  // missing/corrupt field never gets silently defaulted to a fake 0 that
  // would then look like "deliberately decayed to nothing".
  if (Number.isFinite(e.eligibility)) entry.eligibility = e.eligibility;
  if (Number.isFinite(e.last_updated_round)) entry.last_updated_round = e.last_updated_round;
  return entry;
}

/**
 * Validate/repair one stitched-macro template. Mirrors the candidate shape
 * candidates.mjs/decide.mjs expect ({id,key,tool,args,requires,ensures}),
 * so a corrupt/hand-edited entry can never crash enumerateCandidates().
 */
function sanitizeStitchedMacroStep(raw) {
  if (!isPlainObject(raw)) return null;
  const key = typeof raw.key === 'string' && raw.key ? raw.key : null;
  if (!key) return null;
  return {
    key,
    tool: typeof raw.tool === 'string' ? raw.tool : null,
    args: isPlainObject(raw.args) ? raw.args : {},
    requires: Array.isArray(raw.requires) ? raw.requires : [],
    ensures: Array.isArray(raw.ensures) ? raw.ensures : [],
  };
}

function sanitizeStitchedMacro(raw) {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  if (!id) return null;
  const macro = {
    id,
    key: typeof raw.key === 'string' && raw.key ? raw.key : id,
    tool: typeof raw.tool === 'string' ? raw.tool : null,
    args: isPlainObject(raw.args) ? raw.args : {},
    requires: Array.isArray(raw.requires) ? raw.requires : [],
    ensures: Array.isArray(raw.ensures) ? raw.ensures : [],
  };
  // Optional multi-step chain metadata (stage 4): the macro still EXECUTES
  // as its own tool/args above (the first step) — `steps` is read-only
  // provenance of the full verified 2-3 step chain it was lifted from, for
  // candidates.mjs/decide.mjs to inspect but never required to use. Omitted
  // entirely (not defaulted to []) when the raw entry has none, so a
  // single-step macro written before this upgrade stays indistinguishable
  // from one written after it.
  if (Array.isArray(raw.steps)) {
    const steps = raw.steps.map(sanitizeStitchedMacroStep).filter(Boolean);
    if (steps.length) macro.steps = steps;
  }
  // Player-chapter span metadata (this upgrade): which Wiki milestone
  // range this macro was actually observed carrying the bot across, plus
  // a human-readable phase_label and a 'direct'/'noisy'/'spliced'
  // smoothness provenance tag. All four are read-only descriptive
  // metadata for status_report.mjs — never consumed by decide.mjs's
  // scoring math — so a missing one (snapshot written before this
  // upgrade) is simply omitted rather than defaulted to a misleading 0.
  if (Number.isFinite(raw.span_from_idx)) macro.span_from_idx = raw.span_from_idx;
  if (Number.isFinite(raw.span_to_idx)) macro.span_to_idx = raw.span_to_idx;
  if (typeof raw.phase_label === 'string' && raw.phase_label) macro.phase_label = raw.phase_label;
  if (typeof raw.smoothness === 'string' && raw.smoothness) macro.smoothness = raw.smoothness;
  // Long-chain flow-shape feedback (this upgrade): completion_rate (0..1,
  // real-execution-derived) and macro_commitment (the [0.2,1.2]
  // confidence/trust multiplier decide.mjs applies to its OWN step-2/3
  // confidence term — see decide.mjs's doc comment on this exact field;
  // NEVER applied to `weight`). Both are optional/nullable: a macro never
  // actually attempted as a multi-step chain yet, or one lifted before
  // this upgrade, simply omits them, which decide.mjs already treats as
  // "no commitment evidence yet" (neutral 1.0).
  if (Number.isFinite(raw.completion_rate)) macro.completion_rate = raw.completion_rate;
  if (Number.isFinite(raw.macro_commitment)) macro.macro_commitment = raw.macro_commitment;
  if (Number.isFinite(raw.common_break_step)) macro.common_break_step = raw.common_break_step;
  // Provenance tag (this upgrade, task 1): 'wiki_prior' marks a cold-start
  // macro seeded from brain/wiki_priors.json (see loadWikiPriorMacros()
  // below) as opposed to one actually extracted from real decisions.jsonl
  // history by deliberate.mjs's extractStitchedMacros()/
  // extractMultiStepMacros() (which never set this field, so a
  // native-extracted macro's `source` stays omitted/undefined — purely
  // additive/backward-compatible). Read-only/descriptive: decide.mjs's
  // scoring never branches on it directly; a wiki_prior macro's initially
  // modest macro_commitment (see wiki_priors.json) is the ONLY lever that
  // lets real execution evidence naturally overtake it, never this label.
  if (typeof raw.source === 'string' && raw.source) macro.source = raw.source;
  return macro;
}

function sanitizeStitchedMacros(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeStitchedMacro).filter(Boolean);
}

/**
 * Validate/repair one macro_flow_summary entry (this upgrade's "high-
 * dimensional long-chain flow shape" diagnostic row — see deliberate.mjs's
 * computeMacroFlowSummary()). Purely informational/read-only: nothing in
 * decide.mjs/candidates.mjs reads this top-level array directly (they read
 * the SAME completion_rate/macro_commitment values already folded onto
 * each entry in stitched_macros instead) — this exists so
 * status_report.mjs has one flat list to render the "长链章法体检" section
 * from without having to re-derive it from stitched_macros itself.
 */
function sanitizeMacroFlowEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  if (!id) return null;
  return {
    id,
    span_from_idx: Number.isFinite(raw.span_from_idx) ? raw.span_from_idx : null,
    span_to_idx: Number.isFinite(raw.span_to_idx) ? raw.span_to_idx : null,
    phase_label: typeof raw.phase_label === 'string' ? raw.phase_label : null,
    steps: Number.isFinite(raw.steps) ? raw.steps : null,
    attempts: Number.isFinite(raw.attempts) ? raw.attempts : 0,
    completion_rate: Number.isFinite(raw.completion_rate) ? raw.completion_rate : null,
    common_break_step: Number.isFinite(raw.common_break_step) ? raw.common_break_step : null,
    macro_commitment: Number.isFinite(raw.macro_commitment) ? raw.macro_commitment : 1,
  };
}

function sanitizeMacroFlowSummary(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeMacroFlowEntry).filter(Boolean);
}

const EPISODE_HISTORY_MAX = 20;

/**
 * Validate/repair one episode_history entry (task 4's "局间四定义复盘" —
 * see deliberate.mjs's buildEpisodeSummary()). Purely descriptive, read
 * only by status_report.mjs's "跨局成长轨迹" section — decide.mjs/
 * candidates.mjs never read this array, exactly like macro_flow_summary
 * above.
 */
function sanitizeEpisodeEntry(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    episodeId: typeof raw.episodeId === 'string' || Number.isFinite(raw.episodeId) ? raw.episodeId : null,
    endedAt: typeof raw.endedAt === 'string' ? raw.endedAt : null,
    totalSteps: Number.isFinite(raw.totalSteps) ? raw.totalSteps : 0,
    finalCurIdx: Number.isFinite(raw.finalCurIdx) ? raw.finalCurIdx : -1,
    avgStepDurationMs: Number.isFinite(raw.avgStepDurationMs) ? raw.avgStepDurationMs : null,
    failureRate: Number.isFinite(raw.failureRate) ? raw.failureRate : null,
    deathOrStuckReason: typeof raw.deathOrStuckReason === 'string' ? raw.deathOrStuckReason : null,
    activePersona: typeof raw.activePersona === 'string' && raw.activePersona ? raw.activePersona : null,
  };
}

/**
 * Validate/repair the whole episode_history array, keeping only the most
 * recent EPISODE_HISTORY_MAX (20) entries — same "cap, drop oldest" policy
 * stitched_macros already uses elsewhere in this codebase. Input order is
 * assumed oldest-first (the order deliberate.mjs appends in); the cap keeps
 * the NEWEST entries, i.e. slices off the front, not the back.
 */
function sanitizeEpisodeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const cleaned = raw.map(sanitizeEpisodeEntry).filter(Boolean);
  return cleaned.length > EPISODE_HISTORY_MAX ? cleaned.slice(cleaned.length - EPISODE_HISTORY_MAX) : cleaned;
}

/**
 * Validate/repair a whole snapshot object read from disk (or constructed in
 * memory) into the canonical shape. Never throws: unknown/missing/malformed
 * fields fall back to safe defaults field-by-field.
 * @param {object} raw
 * @returns {object}
 */
function sanitizeSnapshot(raw) {
  const base = defaultPolicyTable();
  if (!isPlainObject(raw)) return base;

  const entries = {};
  if (isPlainObject(raw.entries)) {
    for (const [key, value] of Object.entries(raw.entries)) {
      entries[key] = sanitizeEntry(value);
    }
  }

  return {
    version: Number.isFinite(raw.version) ? raw.version : base.version,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    cur_idx: Number.isFinite(raw.cur_idx) ? raw.cur_idx : base.cur_idx,
    next_split_id: typeof raw.next_split_id === 'string' || raw.next_split_id === null ? raw.next_split_id : base.next_split_id,
    total_rounds: Number.isFinite(raw.total_rounds) ? raw.total_rounds : base.total_rounds,
    entries,
    stitched_macros: sanitizeStitchedMacros(raw.stitched_macros),
    // active_persona (task 2a): the persona NAME that produced/last
    // touched this snapshot — purely informational provenance for
    // status_report.mjs to display ("which experience profile is this
    // snapshot's?"); decide.mjs/candidates.mjs never read this field, so
    // adding it changes no scoring behavior. Optional/nullable: a snapshot
    // written before this upgrade (or hand-edited without it) simply has
    // `null` here, which status_report.mjs already knows how to print as
    // "unknown".
    active_persona: typeof raw.active_persona === 'string' && raw.active_persona ? raw.active_persona : base.active_persona,
    // macro_flow_summary (this upgrade): see sanitizeMacroFlowEntry()'s
    // doc comment — purely descriptive, read by status_report.mjs only.
    macro_flow_summary: sanitizeMacroFlowSummary(raw.macro_flow_summary),
    // episode_history (task 4): see sanitizeEpisodeEntry()'s doc comment.
    episode_history: sanitizeEpisodeHistory(raw.episode_history),
  };
}

/**
 * Read the policy snapshot from disk. Missing file or unparsable JSON both
 * fall back to `defaultPolicyTable()` rather than throwing — environment A
 * must be able to call this on every decision without ever crashing on a
 * bad/missing file (e.g. first run, or a write caught mid-crash before the
 * atomic rename happened).
 * @param {string} filePath
 * @returns {object}
 */
export function readPolicyTable(filePath = POLICY_PATH) {
  if (!existsSync(filePath)) return defaultPolicyTable();
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return defaultPolicyTable();
  }
  try {
    const parsed = JSON.parse(text);
    return sanitizeSnapshot(parsed);
  } catch {
    return defaultPolicyTable();
  }
}

/**
 * Atomically write the policy snapshot: write to `${filePath}.tmp` first,
 * then `renameSync` over the real path. On POSIX and on Windows (NTFS),
 * `rename` onto an existing destination is atomic, so a reader (environment
 * A) can never observe a half-written file — it sees either the old
 * complete snapshot or the new complete snapshot, never a torn one.
 * @param {object} snapshot
 * @param {string} filePath
 */
export function writePolicyTableAtomic(snapshot, filePath = POLICY_PATH) {
  const clean = sanitizeSnapshot({ ...snapshot, updatedAt: snapshot?.updatedAt ?? new Date().toISOString() });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(clean, null, 2), 'utf8');
  renameSync(tmpPath, filePath);
  return clean;
}

// --- Wiki-prior cold-start seeding (task 1) -------------------------------
//
// brain/wiki_priors.json carries a small set of hand-curated, Wiki-sourced
// long chains (wood tools / stone tools / iron tools) so a brand-new bot
// with zero decisions.jsonl history still has SOME reasonable long-chain
// direction to try, instead of starting from a completely empty
// stitched_macros pool. This is read ONLY here (policy_table.mjs) and by
// deliberate.mjs's cold-start branch in runDeliberation() — never by
// candidates.mjs/decide.mjs directly, preserving the same one-way
// "environment B decides what goes into the snapshot, environment A only
// ever reads the snapshot" boundary this whole file exists to enforce.

/**
 * Load and sanitize every macro in brain/wiki_priors.json. Missing/corrupt
 * file (or a hand-edited one with a malformed `macros` array) safely
 * returns [] rather than throwing — this is a purely optional cold-start
 * convenience, never a hard dependency of runDeliberation().
 * @param {string} [filePath]
 * @returns {object[]} sanitized macros, shaped exactly like stitched_macros entries
 */
export function loadWikiPriorMacros(filePath = WIKI_PRIORS_PATH) {
  if (!existsSync(filePath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
  const rawMacros = Array.isArray(parsed?.macros) ? parsed.macros : [];
  return rawMacros.map(sanitizeStitchedMacro).filter(Boolean);
}

/**
 * Cold-start-only merge: when the CURRENT stitched_macros pool has nothing
 * native yet for a given macro `key` (never attempted, so no real
 * decisions.jsonl-derived macro could have earned that key), seed in the
 * matching wiki_prior macro(s) so environment A has a long-chain direction
 * to try from round 1. Once a NATIVE macro (no `source: 'wiki_prior'` tag —
 * i.e. one deliberate.mjs's extractStitchedMacros()/extractMultiStepMacros()
 * actually lifted from real execution history) exists for that same key,
 * this function stops injecting the prior for it at all: the native macro
 * (with its own real completion_rate/macro_commitment, which can rise above
 * the prior's modest 0.6 start) is left to compete and win purely through
 * decide.mjs's existing macro_commitment multiplier — never through any
 * special-case override here. This is what lets "本土提炼出的更优长链可
 * 自然胜出覆盖先验" (task 1): nothing is force-ranked; the prior simply
 * stops being OFFERED once something real has taken its key's place, and
 * decide.mjs's ordinary scoring (commitment-weighted UCB) does the rest for
 * whichever ones still coexist (e.g. a native single-step macro with the
 * SAME key as a multi-step prior chain) without this file taking sides.
 *
 * Pure merge, no I/O of its own beyond the already-loaded `priorMacros` and
 * `currentMacros` arrays — safe to call from runDeliberation() (and from a
 * test) with an explicit `priorMacros` override.
 *
 * @param {object[]} currentMacros  this pass's already-extracted native
 *   stitched_macros (single-step + multi-step + spliced), newest-first
 * @param {object[]} [priorMacros]  defaults to loadWikiPriorMacros()
 * @returns {object[]} currentMacros with any still-missing-key priors
 *   appended at the end (native macros always take priority ordering)
 */
export function mergeWikiPriorsColdStart(currentMacros, priorMacros = loadWikiPriorMacros()) {
  const current = Array.isArray(currentMacros) ? currentMacros : [];
  const priors = Array.isArray(priorMacros) ? priorMacros : [];
  if (!priors.length) return current;

  const nativeKeys = new Set(current.filter(m => m.source !== 'wiki_prior').map(m => m.key));
  const toInject = priors.filter(p => !nativeKeys.has(p.key));
  if (!toInject.length) return current;

  return [...current, ...toInject];
}
