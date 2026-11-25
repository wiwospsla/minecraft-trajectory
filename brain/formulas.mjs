// brain/formulas.mjs — pure functions, no state, no I/O.
// UCB1-style scoring used to rank candidate actions from their history.

/**
 * Arithmetic mean with safe handling of n=0.
 * @param {number} n  sample count
 * @param {number} sum sum of observed rewards
 * @returns {number} mean, or 0 when n<=0
 */
export function mean(n, sum) {
  if (!Number.isFinite(n) || !Number.isFinite(sum) || n <= 0) return 0;
  const m = sum / n;
  return Number.isFinite(m) ? m : 0;
}

/**
 * UCB1 score: mu + sqrt(2*ln(t)/n).
 * Unvisited candidates (n=0) get a high prior score so they get tried first.
 * @param {number} n  times this candidate has been chosen
 * @param {number} sum sum of rewards for this candidate
 * @param {number} t  total rounds played so far (across all candidates)
 * @param {number} prior score returned when n=0 (default: +Infinity-ish large constant)
 * @returns {number}
 */
export function ucb(n, sum, t, prior = 10) {
  if (!Number.isFinite(n) || n <= 0) return prior;
  const mu = mean(n, sum);
  const tt = Number.isFinite(t) && t > 0 ? t : 1;
  const bonus = Math.sqrt((2 * Math.log(tt)) / n);
  const score = mu + (Number.isFinite(bonus) ? bonus : 0);
  return Number.isFinite(score) ? score : mu;
}

/**
 * Clamp a number into [min, max], returning `fallback` if not finite.
 */
export function clampFinite(x, min, max, fallback = min) {
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}
