// brain/wiki.mjs — "look at the whole picture": given the route map (splits)
// and the current observed state, work out how far along the route we are.

/**
 * @param {{inv:string,count:number}|{dimension:string}} cond
 * @param {{inventory: Record<string, number>, dimension: string}} state
 */
function conditionSatisfied(cond, state) {
  if (cond.dimension !== undefined) {
    return state.dimension === cond.dimension;
  }
  if (cond.inv !== undefined) {
    const have = state.inventory?.[cond.inv] ?? 0;
    return have >= (cond.count ?? 1);
  }
  // Unknown condition shape: fail closed (not satisfied) rather than throw.
  return false;
}

function splitSatisfied(split, state) {
  if (!split || !Array.isArray(split.conditions) || split.conditions.length === 0) return false;
  return split.conditions.every(c => conditionSatisfied(c, state));
}

/**
 * Evaluate progress along the route map.
 * @param {Array} splits ordered route map (see splits.json)
 * @param {{inventory: Record<string, number>, dimension: string}} state
 * @returns {{cur_idx:number, next:object|null, satisfied:number[]}}
 *   cur_idx = index of the last split that is satisfied (-1 = none yet)
 *   next    = splits[cur_idx+1] or null if route is complete
 *   satisfied = indices of all splits currently satisfied (for diagnostics)
 */
export function evaluate(splits, state) {
  const safeState = {
    inventory: state?.inventory ?? {},
    dimension: state?.dimension ?? null,
  };

  const satisfied = [];
  let cur_idx = -1;
  for (let i = 0; i < splits.length; i++) {
    if (splitSatisfied(splits[i], safeState)) {
      satisfied.push(i);
      // "Last satisfied" assumes a mostly-linear route: keep advancing cur_idx
      // as long as splits are satisfied in order. A later split satisfied out
      // of order (e.g. player already has a diamond but no table) still counts,
      // since the route is a checklist, not a strict gate.
      cur_idx = i;
    }
  }

  const next = cur_idx + 1 < splits.length ? splits[cur_idx + 1] : null;
  return { cur_idx, next, satisfied };
}
