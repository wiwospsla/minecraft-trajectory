// brain/slice.mjs — read-only slicing/aggregation over decisions.jsonl.
// Never writes files (append-only writes live in stream.mjs).

import { readAll } from './stream.mjs';

/**
 * Return the most recent N decision records (oldest first).
 * @param {{lastN?: number, path?: string}} opts
 * @returns {object[]}
 */
export function window({ lastN = 50, path } = {}) {
  const all = readAll(path);
  if (lastN <= 0) return [];
  return all.slice(Math.max(0, all.length - lastN));
}

/**
 * Aggregate per-candidate stats across the whole log (or a windowed slice):
 * for each candidate id, how many times it was chosen (n), the sum of its
 * reward (sum, 1 if result.ok else 0), and the resulting mean (mu).
 * @param {{lastN?: number, path?: string}} opts
 * @returns {Record<string, {n:number, sum:number, mu:number}>}
 */
export function stats({ lastN, path } = {}) {
  const records = lastN ? window({ lastN, path }) : readAll(path);
  const agg = {};
  for (const rec of records) {
    const id = rec?.chosen;
    if (!id) continue;
    agg[id] ??= { n: 0, sum: 0, mu: 0 };
    agg[id].n += 1;
    const reward = rec?.result?.ok ? 1 : 0;
    agg[id].sum += reward;
  }
  for (const id of Object.keys(agg)) {
    agg[id].mu = agg[id].n > 0 ? agg[id].sum / agg[id].n : 0;
  }
  return agg;
}

/**
 * Total number of recorded decisions so far (used as "t" in UCB).
 */
export function totalRounds(path) {
  return readAll(path).length;
}
