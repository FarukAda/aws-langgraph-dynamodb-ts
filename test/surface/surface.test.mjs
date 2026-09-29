import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { setTimeout } from 'node:timers';

import { collectRows, retainedStubCount } from './harness.mjs';
import { canonicalLines, countBare, countMisnamed, countUpstream, duplicateLabels } from './normalise.mjs';

const BASELINE = 'test/surface/baseline.txt';

/**
 * The count of cases that still let a non-library error escape. It is 0: every
 * public entry point now answers a caller's mistake with a branded error, so
 * this is the flat assertion the tier was always meant to carry rather than a
 * count still on its way down. It spent the hardening pass as a ratchet, since
 * a flat `=== 0` would have left this tier red throughout and reported nothing
 * useful on any intermediate commit; the `<=` is what it kept from that, and at
 * 0 it says exactly what `=== 0` says. Nothing may raise it.
 *
 * What 0 covers is only what the case list asks. It now asks the one question
 * that separates a refusal this package composes from one the runtime raises:
 * a `toJSON` that throws a value which is not an `Error` — legal JavaScript,
 * and the shortest path from caller code into the `catch` blocks every refusal
 * is composed in. The corpus held that case with an `Error`, which passed and
 * proved nothing about it.
 */
const EXPECTED_BARE = 0;

/**
 * The count of cases ending in a code that reports a failure outside this
 * library — `RETRY_EXHAUSTED`, `THROTTLED`, `SERVICE_UNAVAILABLE`,
 * `CONTENTION`, `ACCESS_DENIED`, `NOT_FOUND`, `AWS_REJECTED`,
 * `AWS_REQUEST_FAILED` or `UNEXPECTED_ERROR` — under the same rule. It sees
 * what the bare count cannot: wrapping a method so a caller's mistake escapes
 * wrapped as a failure from below removes a bare row and adds one here, and
 * that is a rebranding, not a fix. The fake client's own rejection is reported as
 * REACHED-WRITE instead, so a row counted here failed somewhere other than the
 * AWS call the harness fakes.
 */
const EXPECTED_UPSTREAM = 0;

test('the public surface matches the committed baseline', async () => {
  assert.ok(
    existsSync('dist/cjs/index.js'),
    'dist/cjs/index.js is missing — run `npm run build` first; this tier fuzzes built output, not src/',
  );
  const lines = canonicalLines(await collectRows());
  /**
   * An environment flag, not an argv flag: `node --test` does not forward
   * trailing arguments to the test child — verified on Node 22.17, where
   * `node --test file.mjs -- --update` leaves the child's `process.argv`
   * holding only the file path. Environment variables do reach the child.
   */
  if (process.env.UPDATE_SURFACE_BASELINE === '1') {
    writeFileSync(BASELINE, `${lines.join('\n')}\n`);
    return;
  }
  const expected = readFileSync(BASELINE, 'utf8').trimEnd().split('\n');
  assert.deepEqual(lines, expected, 'the public surface changed; review the diff, then re-run with --update');
});

test('no two cases share a label', async () => {
  const duplicates = duplicateLabels(await collectRows());
  assert.deepEqual(
    duplicates,
    [],
    `${duplicates.length} labels each name more than one case, so the baseline cannot say which case an outcome belongs to`,
  );
});

test('no case regresses into letting a bare error escape', async () => {
  const lines = canonicalLines(await collectRows());
  const bare = countBare(lines);
  assert.ok(
    bare <= EXPECTED_BARE,
    `${bare} cases let a bare error escape, up from ${EXPECTED_BARE}; every public entry point must answer a caller's mistake with a branded error, and nothing may raise this count`,
  );
});

test('no case regresses into ending in an upstream failure', async () => {
  const lines = canonicalLines(await collectRows());
  const upstream = countUpstream(lines);
  assert.ok(
    upstream <= EXPECTED_UPSTREAM,
    `${upstream} cases end in an upstream failure, up from ${EXPECTED_UPSTREAM}; lower EXPECTED_UPSTREAM as fixes land, never raise it`,
  );
});

test('every branded error carries the one class name', async () => {
  const lines = canonicalLines(await collectRows());
  const misnamed = countMisnamed(lines);
  assert.equal(
    misnamed,
    0,
    `${misnamed} cases raised a branded error under a name other than DynamoDBLangGraphError; there is one error class`,
  );
});

/**
 * A stub sinon keeps holds the client it replaced and every row it serves.
 * When the harness stubbed through sinon's global sandbox, nothing released
 * them: each call kept about 40 MB, and the ~290 MB five calls left at process
 * exit crashed Node 24 and 26 while they freed it
 * (`Check failed: node->IsInUse()`), or hung them there.
 */
test('a run of the harness leaves no stub behind', async () => {
  await collectRows();
  const retained = retainedStubCount();
  assert.equal(
    retained,
    0,
    `${retained} sinon stubs outlived the harness run that made them; stub through the per-run sandbox so it releases them`,
  );
});

/**
 * `PipeWrap` is the one resource kind excluded: `node --test` runs this file in
 * its own child process and talks to the parent over a pipe, so two `PipeWrap`
 * handles (its stdio/IPC channel) are open for the file's whole life, before
 * `collectRows()` ever runs and after this test ends — they belong to the
 * runner, not to anything the harness or the library under test left behind.
 * Nothing else survived a run once this file's own `docMock`/`rowMock` stopped
 * building a bare `DynamoDBClient` per call: that call started an AWS SDK
 * credentials/region read from `~/.aws/*` that was still in flight when a test
 * ended, and it is what left the stray `FSReqPromise`s behind.
 */
const RUNNER_OWN_RESOURCES = new Set(['PipeWrap']);

/**
 * Polls instead of a single fixed wait: one library entry point this tier
 * fuzzes (`DynamoDBFactory` built with no client or `clientConfig` at all) is
 * deliberately left to build a real client from the environment, which starts
 * its own short-lived credentials read. That read finishes well within this
 * deadline on its own; nothing here waits on it directly, since a future
 * regression must still be caught even if it never finishes.
 */
async function activeResourcesOnceSettled(deadlineMs = 2000, pollMs = 10) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const info = process.getActiveResourcesInfo();
    const leftover = info.filter((kind) => !RUNNER_OWN_RESOURCES.has(kind));
    if (leftover.length === 0 || Date.now() > deadline) return { info, leftover };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

test('a run of the harness leaves no active resource behind but the test runner\'s own', async () => {
  await collectRows();
  const { info, leftover } = await activeResourcesOnceSettled();
  assert.deepEqual(
    leftover,
    [],
    `active resources remained once the run settled: ${JSON.stringify(info)}; a client, timer or socket the harness or the library built is still open`,
  );
});
