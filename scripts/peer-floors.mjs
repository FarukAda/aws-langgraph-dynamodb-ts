/**
 * Print the lowest version each declared peer range admits, one spec per line.
 *
 * The CI job that proves the peer ranges installs these and runs the type
 * checks and the unit tier against them. A range whose floor was never
 * published, or that the code cannot actually work against, fails there rather
 * than on the consumer who pinned it — which only holds if the floor computed
 * here is really the floor.
 *
 * It used to be `range.replace(/^[\^~]/, '')` inline in the workflow, with the
 * result word-split by the shell. That is correct for `^` and `~` and wrong,
 * silently, for everything else:
 *
 * | range              | produced      | effect                                   |
 * |--------------------|---------------|------------------------------------------|
 * | `^3.1.0`           | `3.1.0`       | correct                                  |
 * | `>=1.0.0`          | `>=1.0.0`     | installs the *newest* match — gate no-ops |
 * | `1.x`, `*`         | `1.x`, `*`    | same silent no-op                        |
 * | `^1.0.0 \|\| ^2.0.0` | three words | npm tries to install a package named `\|\|` |
 *
 * So the job could report success while proving nothing. Both current ranges
 * are `^`, so it works today; the failure mode is that it stops working
 * without saying so. This refuses what it cannot compute rather than guessing,
 * and prints one spec per line so no spec can be split on a space.
 */
import { readFileSync } from 'node:fs';

import { isMain } from './is-main.mjs';

/** `1.2.3`, with no range syntax around it. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The lowest version `range` admits.
 *
 * Accepts: a npm range string.
 *
 * Returns: that version.
 *
 * Throws: `Error` for any range whose floor is not a single stated version —
 * a union, a wildcard, an x-range, or anything unrecognised. Refusing is the
 * point: a floor this cannot compute is a floor the job cannot prove, and
 * degrading to "install whatever npm picks" is what made the check vacuous.
 */
export function floorOf(name, range) {
  const trimmed = range.trim();
  const bare = trimmed.replace(/^(\^|~|>=|=|v)/, '').trim();
  if (EXACT.test(bare) && !/\s|\|\||[x*]/i.test(trimmed)) return bare;
  throw new Error(
    `Cannot determine the floor of peer dependency "${name}" from the range "${range}". ` +
      'This job installs each peer at the lowest version its range admits; a range it cannot ' +
      'reduce to one version would install whatever npm resolves instead, and the job would ' +
      'pass having proved nothing. Use a ^, ~, >= or exact range, or teach this script the ' +
      'form you need.',
  );
}

/** Every peer as `name@floor`, in declaration order. */
export function peerFloors(manifest) {
  return Object.entries(manifest.peerDependencies ?? {}).map(
    ([name, range]) => `${name}@${floorOf(name, range)}`,
  );
}

if (isMain(import.meta.url)) {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const specs = peerFloors(manifest);
  if (specs.length === 0) {
    throw new Error('package.json declares no peerDependencies; this job has nothing to prove.');
  }
  process.stdout.write(`${specs.join('\n')}\n`);
}
