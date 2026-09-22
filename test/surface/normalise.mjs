/**
 * One canonical line per case, sorted. Sorting is what makes the baseline a
 * useful review surface: adding a case inserts one line instead of reshuffling
 * every line below it, so a diff shows only what actually changed.
 */
export function canonicalLines(rows) {
  return rows
    .map(([entry, label, result]) => `${entry} | ${label} | ${result}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Every label that names more than one case, with each case's outcome. The label
 * is the row text before the outcome, `entry | label`: two rows sharing it cannot
 * be told apart in the baseline, so a changed outcome on one reads as a change to
 * the other, and a defect on one hides behind a correct refusal on the other.
 */
export function duplicateLabels(rows) {
  const outcomes = new Map();
  for (const [entry, label, result] of rows) {
    const key = `${entry} | ${label}`;
    outcomes.set(key, [...(outcomes.get(key) ?? []), result]);
  }
  return [...outcomes]
    .filter(([, results]) => results.length > 1)
    .map(([key, results]) => `${key} -> ${results.join(' / ')}`)
    .sort();
}

/** How many cases let a non-library error escape. The ratchet reads this. */
export function countBare(lines) {
  return lines.filter((line) => line.includes('| BARE ') || line.includes('| sync BARE ')).length;
}

/** The outcomes that report a failure outside this library. */
const UPSTREAM_OUTCOMES = ['UpstreamError/UPSTREAM', 'RetryExhaustedError/RETRY_EXHAUSTED'];

/** How many cases end in an upstream failure. The second ratchet reads this. */
export function countUpstream(lines) {
  return lines.filter((line) =>
    UPSTREAM_OUTCOMES.some((kind) => line.includes(`| throws ${kind}`) || line.includes(`| sync throws ${kind}`)),
  ).length;
}
