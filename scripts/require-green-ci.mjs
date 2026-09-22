/**
 * Decide whether this commit's CI is green enough to publish from.
 *
 * The required checks are named rather than counted. Counting — "some check
 * runs exist and none of them failed" — passes in the one case it most needs
 * to catch: `ci.yml` producing *no* check runs on the tagged commit, which a
 * rename, invalid YAML or a later-added `paths-ignore:` would cause. CodeQL
 * and Scorecard alone would then be a complete, green set, and the release
 * would publish a commit the operating-system × Node matrix never touched.
 *
 * So the required names are listed, and every one of them must be *present*
 * and successful. A required job renamed in `ci.yml` without being renamed in
 * `required-checks.json` makes the release time out instead of publishing,
 * which is the right way round, and the static guard fails first.
 *
 * Reads `CHECK_RUNS`: the newline-delimited JSON objects `gh api --paginate
 * --jq '.check_runs[] | {id, name, status, conclusion}'` emits. Reading it from
 * the environment rather than argv keeps a check-run name containing a quote
 * from having to survive a shell. The `id` is what orders two runs of one name.
 *
 * Exit codes are the interface, because the caller loops on them:
 *   0 — every required check is present and successful. Publish.
 *   1 — a required check completed and did not succeed. Stop; waiting cannot help.
 *   2 — not there yet. Sleep and call again.
 */
import { readFileSync } from 'node:fs';

import { isMain } from './is-main.mjs';

/**
 * The check-run names a tagged commit must carry, all of them successful, read
 * from `required-checks.json` beside this script. That file is the one list:
 * test/static/release-gate.test.ts pins it against the jobs the workflows
 * define, so a job added to `ci.yml` without being required, or a required
 * name no workflow produces any more, fails the build instead of quietly
 * weakening this gate.
 *
 * Mostly `ci.yml`. The matrix legs are spelled out because a matrix job's
 * check-run name is its `name:` with the matrix values substituted, and a
 * missing leg is exactly what this gate exists to notice.
 *
 * `live-aws integration` comes from `integration-live.yml` instead, which runs
 * on the same tag push. That tier is the only one that checks this package
 * against the real services: every other tier runs against mocks or DynamoDB
 * Local. Requiring it here is what makes "the live tier runs before every
 * release" a gate rather than a good intention. A tag whose live run failed,
 * or never started because the AWS role secret is missing, waits here and then
 * refuses to publish.
 */
export const REQUIRED_CHECKS = JSON.parse(
  readFileSync(new URL('./required-checks.json', import.meta.url), 'utf8'),
);

/** Parse the newline-delimited JSON `gh api --paginate --jq` emits. */
export function parseCheckRuns(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Whether a run is the one outcome that counts. */
const hasSucceeded = (run) => run.status === 'completed' && run.conclusion === 'success';

/**
 * Whether `candidate` should replace `current` as the run that speaks for a name.
 *
 * A check run's `id` only ever grows, so the higher one is the later run. Two
 * runs that cannot be ordered — an id missing because the workflow stopped
 * asking for it — resolve towards the one that did not succeed: which of them
 * is newer is then unknowable, and guessing "the green one" is the hole this
 * function exists to close.
 */
function supersedes(candidate, current) {
  if (Number.isFinite(candidate.id) && Number.isFinite(current.id) && candidate.id !== current.id) {
    return candidate.id > current.id;
  }
  return !hasSucceeded(candidate);
}

/**
 * The one run that speaks for each name: the newest.
 *
 * A commit can carry several runs of one check. Every re-run adds one, and so
 * does a second workflow run on the same commit, such as a second tag pushed
 * at it re-running the live tier. Only the newest is evidence about the commit
 * as it is being released. "Some run
 * of this name succeeded" would let an old green run publish a tag whose own
 * run was red, or had not finished.
 */
function latestByName(checkRuns) {
  const latest = new Map();
  for (const run of checkRuns) {
    const current = latest.get(run.name);
    if (current === undefined || supersedes(run, current)) latest.set(run.name, run);
  }
  return latest;
}

/**
 * Classify a commit's check runs against the required list.
 *
 * Each required name is judged by its newest run alone (see
 * {@link latestByName}), so a re-run that went green unblocks a release, and a
 * later run that went red — or is still going — blocks one.
 *
 * Only `success` counts. Anything else that has completed is a failure —
 * `cancelled` and `timed_out` included, and `skipped` and `neutral` too.
 *
 * Those last two used to count as succeeded, on the grounds that a conditional
 * job legitimately reports them. No job on the list above is conditional, so
 * neither can arrive honestly — and the one that would matter is
 * `live-aws integration`. An `if:` added to it later, or a `secrets.` guard
 * around it, would report `skipped`, and the gate that exists to guarantee this
 * package was checked against the real service before publishing would have
 * been satisfied by it never running. A skip is also not something waiting can
 * fix, so it belongs with the failures rather than with the pending.
 */
export function evaluate(checkRuns, required = REQUIRED_CHECKS) {
  const latest = latestByName(checkRuns);
  const verdicts = required.map((name) => ({ name, run: latest.get(name) }));
  const failed = verdicts
    .filter(({ run }) => run !== undefined && run.status === 'completed' && !hasSucceeded(run))
    .map(({ run }) => run);
  const pending = verdicts
    .filter(({ run }) => run === undefined || !hasSucceeded(run))
    .map(({ name }) => name);
  return { failed, pending, satisfied: required.length - pending.length, total: required.length };
}

// The entry point. `scripts/` is outside the coverage scope, so this is not
// instrumented; the exported functions above are what the tests exercise.
if (isMain(import.meta.url)) {
  const { failed, pending, satisfied, total } = evaluate(
    parseCheckRuns(process.env.CHECK_RUNS ?? ''),
  );

  if (failed.length > 0) {
    for (const run of failed) console.error(`  ${run.name}: ${run.conclusion}`);
    console.error('::error::A required CI check did not succeed for this commit; not publishing.');
    process.exit(1);
  }

  console.log(`Required CI checks: ${satisfied}/${total} present and successful`);
  if (pending.length === 0) process.exit(0);
  for (const name of pending) console.log(`  waiting on: ${name}`);
  process.exit(2);
}
