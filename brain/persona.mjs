// brain/persona.mjs — pure, read-only loader for brain/persona.json's
// "game personality" preference presets (task 2).
//
// This file touches NOTHING except persona.json: no bot, no network, no
// decisions.jsonl/policy_snapshot.json. It is safe to import from either
// environment A (decide.mjs/candidates.mjs, via auto_loop.mjs/
// tools_adapter.mjs/run_win.mjs passing a resolved persona object down) or
// a test, with no risk of smuggling the stream.mjs/slice.mjs boundary
// through here — persona.mjs never imports either.
//
// Each preset is five independent knobs, all plain multipliers/bonuses
// applied by decide.mjs's scoring (see its own doc comments for exactly
// where each one is read):
//   wiki_drive        multiplies the Wiki-direction bonus (wikiBonus) a
//                      candidate gets for hitting the next route split.
//   explore_appetite   multiplies the score of exploration (move:explore_*)
//                      candidates.
//   gather_hoard       multiplies the score of "reserve gather" candidates
//                      (candidates.mjs's isReserveGather: true pool) and
//                      ordinary gather candidates in general.
//   safety_caution     multiplies the score of isSafety candidates
//                      (flee/eat) — also usable by callers as an
//                      eat/flee-threshold nudge, though decide.mjs itself
//                      only ever applies it as a score multiplier.
//   momentum_bonus     flat additive bonus applied when this round's
//                      candidate shares its action-family key prefix with
//                      the PREVIOUS round's chosen key (lastChosenKey,
//                      passed in by the caller as pure in-memory context —
//                      never read from decisions.jsonl here or in
//                      decide.mjs).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location: brain/persona.json, sibling of this file. */
export const PERSONA_PATH = join(__dirname, 'persona.json');

export const DEFAULT_PERSONA_NAME = 'balanced';

/** Safe, fully-neutral fallback preset used whenever persona.json is
 * missing, corrupt, or the requested name does not exist in it — decide.mjs
 * must never crash or behave unpredictably just because this optional
 * config file had a problem. */
function neutralPersona(name = DEFAULT_PERSONA_NAME) {
  return {
    name,
    label: name,
    description: '',
    wiki_drive: 1,
    explore_appetite: 1,
    gather_hoard: 1,
    safety_caution: 1,
    momentum_bonus: 0,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Validate/repair one persona preset record so decide.mjs's math always
 * receives finite multipliers, even from a hand-edited/corrupt file.
 */
function sanitizePreset(name, raw) {
  const neutral = neutralPersona(name);
  if (!isPlainObject(raw)) return neutral;
  return {
    name,
    label: typeof raw.label === 'string' && raw.label ? raw.label : name,
    description: typeof raw.description === 'string' ? raw.description : '',
    wiki_drive: num(raw.wiki_drive, neutral.wiki_drive),
    explore_appetite: num(raw.explore_appetite, neutral.explore_appetite),
    gather_hoard: num(raw.gather_hoard, neutral.gather_hoard),
    safety_caution: num(raw.safety_caution, neutral.safety_caution),
    momentum_bonus: num(raw.momentum_bonus, neutral.momentum_bonus),
  };
}

/**
 * Load every preset in persona.json, sanitized. Missing/corrupt file falls
 * back to a single synthetic `balanced` neutral preset — never throws.
 * @param {string} [filePath]
 * @returns {{defaultName: string, presets: Record<string, object>}}
 */
export function loadPersonaConfig(filePath = PERSONA_PATH) {
  if (!existsSync(filePath)) {
    return { defaultName: DEFAULT_PERSONA_NAME, presets: { [DEFAULT_PERSONA_NAME]: neutralPersona() } };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { defaultName: DEFAULT_PERSONA_NAME, presets: { [DEFAULT_PERSONA_NAME]: neutralPersona() } };
  }
  const defaultName = typeof parsed?.default === 'string' && parsed.default ? parsed.default : DEFAULT_PERSONA_NAME;
  const rawPresets = isPlainObject(parsed?.presets) ? parsed.presets : {};
  const presets = {};
  for (const [name, preset] of Object.entries(rawPresets)) {
    presets[name] = sanitizePreset(name, preset);
  }
  if (!Object.keys(presets).length) presets[DEFAULT_PERSONA_NAME] = neutralPersona();
  return { defaultName, presets };
}

/**
 * Resolve one named persona preset, falling back through:
 *   1. the exact requested name, if it exists in persona.json;
 *   2. persona.json's own declared `default` preset, if that exists;
 *   3. a fully-neutral synthetic preset (every knob = 1, momentum_bonus = 0).
 * Never throws, never returns undefined — every caller (decide.mjs via
 * auto_loop.mjs/run_win.mjs/tools_adapter.mjs) always gets a usable object
 * with all five knobs present and finite.
 *
 * @param {string} [name]       preset name, e.g. 'speedrunner'
 * @param {string} [filePath]   persona.json path override (tests)
 * @returns {{name:string, label:string, description:string, wiki_drive:number, explore_appetite:number, gather_hoard:number, safety_caution:number, momentum_bonus:number}}
 */
export function resolvePersona(name, filePath = PERSONA_PATH) {
  const { defaultName, presets } = loadPersonaConfig(filePath);
  if (typeof name === 'string' && presets[name]) return presets[name];
  if (presets[defaultName]) return presets[defaultName];
  return neutralPersona(typeof name === 'string' && name ? name : DEFAULT_PERSONA_NAME);
}

/**
 * List every preset name currently defined in persona.json (for CLI
 * help/validation messages) — never throws on a missing/corrupt file.
 * @param {string} [filePath]
 * @returns {string[]}
 */
export function listPersonaNames(filePath = PERSONA_PATH) {
  return Object.keys(loadPersonaConfig(filePath).presets);
}
