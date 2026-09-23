/**
 * Whether a script is the program being run, rather than a module being imported.
 *
 * Every script here is both: the tests import its functions, and CI runs it.
 * Each used to decide which with `import.meta.filename === process.argv[1]` —
 * and those two are not the same kind of path. Node resolves symbolic links in
 * the first and leaves the second as it was typed, so a script reached through
 * a linked path compared unequal, did nothing, and exited 0.
 *
 * Doing nothing is only harmless when exit 0 means nothing. For
 * `require-green-ci.mjs` it means "every required check is present and
 * successful. Publish." — the gate said yes without having looked. For
 * `peer-floors.mjs` it printed no floors, and for `changelog-section.mjs` an
 * empty release body, each with a clean exit.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Accepts: the calling module's `import.meta.url`, and the entry point —
 * `process.argv[1]` unless a test supplies one.
 *
 * Returns: `true` when both are the same file once links are resolved, which
 * is also what makes a drive letter's case irrelevant on Windows. `false` when
 * they are different files — the module was imported — and when there is no
 * entry point at all.
 *
 * Throws: whatever `realpathSync` raises for an entry point that does not
 * exist. Deliberately not caught: a script that cannot tell whether it is the
 * program must not answer "no" and exit 0 having done nothing, which is the
 * failure this function exists to end.
 */
export function isMain(moduleUrl, entry = process.argv[1]) {
  if (entry === undefined) return false;
  return realpathSync.native(entry) === realpathSync.native(fileURLToPath(moduleUrl));
}
