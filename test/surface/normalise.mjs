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

/** How many cases let a non-library error escape. The ratchet reads this. */
export function countBare(lines) {
  return lines.filter((line) => line.includes('| BARE ') || line.includes('| sync BARE ')).length;
}
