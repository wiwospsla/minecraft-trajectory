// brain/log.mjs — thin semantic wrapper over stream.append for deviation
// diagnostics. Deviations share the same JSONL file as decisions (one
// append-only stream, grep-able), tagged with `kind: "deviation"`.

import { append } from './stream.mjs';

/**
 * @param {"direction"|"progress"} kind
 * @param {object} details free-form diagnostic payload
 */
export function logDeviation(kind, details) {
  append({
    kind: 'deviation',
    deviation: kind,
    time: Date.now(),
    ...details,
  });
}
