/**
 * The release gate's classification, exercised off a runner.
 *
 * This is the check that stands between `git push --tags` and a live `latest`,
 * and the failure it exists to catch is silent: a `ci.yml` that produced no
 * check runs at all on the tagged commit — after a rename, a YAML error, or a
 * `paths-ignore:` added later — leaves CodeQL and Scorecard as a complete,
 * green set. A gate that counted rather than named would pass that set and
 * publish a commit the operating-system × Node matrix never touched.
 *
 * `scripts/` is outside jest's coverage collection, so nothing here moves the
 * coverage gate; it runs under `node --test` because `require-green-ci.mjs` is
 * an ESM `.mjs` module. These run because a release gate that has never been
 * exercised is not a gate.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { evaluate, parseCheckRuns, REQUIRED_CHECKS } from '../../scripts/require-green-ci.mjs';

const required = REQUIRED_CHECKS;

const succeeded = (name) => ({ name, status: 'completed', conclusion: 'success' });
const allGreen = () => required.map(succeeded);
const allGreenExcept = (name, run) => [
  ...required.filter((candidate) => candidate !== name).map(succeeded),
  run,
];
const names = (runs) => runs.map((run) => run.name);

describe('the required list', () => {
  it('is scripts/required-checks.json, the one list the release and its guard both read', () => {
    // Which names belong on it is pinned against the workflows by
    // test/static/release-gate.test.ts; this pins that the script reads that
    // file rather than carrying a second copy that could drift from it.
    const onDisk = JSON.parse(readFileSync('scripts/required-checks.json', 'utf8'));
    assert.deepEqual(required, onDisk);
  });

  it('requires the live-AWS tier, so a tag whose live run failed does not publish', () => {
    assert.ok(required.includes('live-aws integration'));
  });

  it('names each check once', () => {
    assert.equal(new Set(required).size, required.length);
  });
});

describe('evaluate', () => {
  it('is satisfied when every required check succeeded', () => {
    const verdict = evaluate(allGreen());
    assert.deepEqual(verdict.pending, []);
    assert.deepEqual(verdict.failed, []);
    assert.equal(verdict.satisfied, required.length);
    assert.equal(verdict.total, required.length);
  });

  it('is NOT satisfied when only checks outside the list ran', () => {
    // The case the gate exists for: ci.yml produced nothing, and the green
    // checks present belong to other workflows entirely.
    const verdict = evaluate([succeeded('CodeQL'), succeeded('Scorecard analysis')]);
    assert.equal(verdict.satisfied, 0);
    assert.deepEqual(verdict.pending, required);
    assert.deepEqual(verdict.failed, []);
  });

  it('reports a required check that completed without succeeding', () => {
    const name = 'npm audit (high+)';
    const verdict = evaluate(
      allGreenExcept(name, { name, status: 'completed', conclusion: 'failure' }),
    );
    assert.deepEqual(names(verdict.failed), [name]);
  });

  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale']) {
    it(`treats a required check concluding ${conclusion} as failed, not pending`, () => {
      const name = 'test (node 24 on macos-latest)';
      const verdict = evaluate(allGreenExcept(name, { name, status: 'completed', conclusion }));
      assert.deepEqual(names(verdict.failed), [name]);
    });
  }

  for (const conclusion of ['skipped', 'neutral']) {
    it(`treats a required check concluding ${conclusion} as failed too: only success counts`, () => {
      const name = 'test (node 22 on windows-latest)';
      const verdict = evaluate(allGreenExcept(name, { name, status: 'completed', conclusion }));
      assert.deepEqual(names(verdict.failed), [name]);
    });
  }

  it('refuses to publish when the live-AWS tier was skipped rather than run', () => {
    // The reason `skipped` is not a success. An `if:` added to that job, or a
    // guard around the AWS role secret, makes it report `skipped`, and the
    // gate that exists to guarantee a live check before publishing would have
    // been satisfied by the tier never running.
    const name = 'live-aws integration';
    const verdict = evaluate(
      allGreenExcept(name, { name, status: 'completed', conclusion: 'skipped' }),
    );
    assert.deepEqual(names(verdict.failed), [name]);
    assert.deepEqual(verdict.pending, [name]);
  });

  it('leaves a still-running required check pending rather than failed', () => {
    const name = 'test (node 24 on ubuntu-latest)';
    const verdict = evaluate(
      allGreenExcept(name, { name, status: 'in_progress', conclusion: null }),
    );
    assert.deepEqual(verdict.pending, [name]);
    assert.deepEqual(verdict.failed, []);
  });

  it('accepts a re-run: a failed attempt and a later success under one name', () => {
    // GitHub keeps both check runs after a re-run, so the failed attempt is
    // still in the response. Requiring "no failed run of this name" would make
    // a re-run unable to unblock a release, which is the point of re-running.
    // The later run is the one with the higher id.
    const name = 'test (node 22 on windows-latest)';
    const verdict = evaluate([
      ...allGreenExcept(name, { id: 101, name, status: 'completed', conclusion: 'failure' }),
      { id: 102, name, status: 'completed', conclusion: 'success' },
    ]);
    assert.deepEqual(verdict.failed, []);
    assert.deepEqual(verdict.pending, []);
  });

  it('refuses when a newer run of a required check failed after an older one succeeded', () => {
    // A re-run of the live tier on the tagged commit that went red after the
    // first run went green: "some run of this name succeeded" would publish
    // that, which is the tier gating nothing.
    const name = 'live-aws integration';
    const verdict = evaluate([
      ...allGreenExcept(name, { id: 101, name, status: 'completed', conclusion: 'success' }),
      { id: 102, name, status: 'completed', conclusion: 'failure' },
    ]);
    assert.deepEqual(names(verdict.failed), [name]);
    assert.deepEqual(verdict.pending, [name]);
  });

  it('waits on a newer run still in progress, whatever an older run concluded', () => {
    const name = 'live-aws integration';
    const verdict = evaluate([
      ...allGreenExcept(name, { id: 101, name, status: 'completed', conclusion: 'success' }),
      { id: 102, name, status: 'in_progress', conclusion: null },
    ]);
    assert.deepEqual(verdict.pending, [name]);
    assert.deepEqual(verdict.failed, []);
  });

  it('orders runs by id, not by their position in the response', () => {
    const name = 'npm audit (high+)';
    const verdict = evaluate([
      { id: 102, name, status: 'completed', conclusion: 'failure' },
      ...allGreenExcept(name, { id: 101, name, status: 'completed', conclusion: 'success' }),
    ]);
    assert.deepEqual(names(verdict.failed), [name]);
  });

  it('fails closed when two runs of one name cannot be ordered', () => {
    // No ids means the workflow stopped asking for them. Which run is the
    // newer one is then unknowable, and guessing "the green one" is the hole.
    const name = 'peer dependency floors';
    const verdict = evaluate([
      ...allGreenExcept(name, { name, status: 'completed', conclusion: 'success' }),
      { name, status: 'completed', conclusion: 'failure' },
    ]);
    assert.deepEqual(names(verdict.failed), [name]);
  });

  it('ignores a failing check that is not on the list', () => {
    const verdict = evaluate([
      ...allGreen(),
      { name: 'some-external-bot', status: 'completed', conclusion: 'failure' },
    ]);
    assert.deepEqual(verdict.failed, []);
    assert.deepEqual(verdict.pending, []);
  });

  it('holds everything pending when the commit has no check runs at all', () => {
    assert.deepEqual(evaluate([]).pending, required);
  });
});

describe('parseCheckRuns', () => {
  it('reads the newline-delimited JSON gh api --paginate --jq emits', () => {
    const text =
      '{"name":"a","status":"completed","conclusion":"success"}\n' +
      '{"name":"b","status":"queued","conclusion":null}\n';
    assert.deepEqual(parseCheckRuns(text), [
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'queued', conclusion: null },
    ]);
  });

  it('tolerates the blank lines a paginated response leaves between pages', () => {
    assert.equal(
      parseCheckRuns('\n{"name":"a","status":"queued","conclusion":null}\n\n\n').length,
      1,
    );
  });

  it('reads an empty response as no check runs', () => {
    assert.deepEqual(parseCheckRuns(''), []);
    assert.deepEqual(parseCheckRuns('   \n  '), []);
  });

  it('a check-run name containing a quote survives the round trip', () => {
    // Names reach the script through the environment rather than argv for
    // exactly this reason.
    const name = 'test ("node 24" on macos-latest)';
    const [run] = parseCheckRuns(JSON.stringify({ name, status: 'queued', conclusion: null }));
    assert.equal(run.name, name);
  });
});
