// brain/stream.mjs — the only place that writes decisions.jsonl.
// Append-only: one JSON object per line. Never rewrites existing lines.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const LOG_PATH = join(__dirname, '..', 'decisions.jsonl');

/**
 * Append one decision record as a single JSON line.
 * @param {object} record
 */
export function append(record, path = LOG_PATH) {
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Read all complete (parseable) JSON lines from the log.
 * A trailing partial line (e.g. from a crash mid-write) is skipped, which is
 * what lets a restarted process resume cleanly without choking on garbage.
 * @returns {object[]}
 */
export function readAll(path = LOG_PATH) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Incomplete/corrupt trailing line — skip it (this is "lastIncomplete" territory).
      continue;
    }
  }
  return out;
}

/**
 * Return the last successfully-parsed record, or null if the log is empty.
 * Used on startup to resume (hot-start) without re-reading the whole file twice.
 */
export function lastIncomplete(path = LOG_PATH) {
  const all = readAll(path);
  return all.length ? all[all.length - 1] : null;
}
