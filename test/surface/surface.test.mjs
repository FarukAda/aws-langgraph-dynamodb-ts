import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { collectRows } from './harness.mjs';
import { canonicalLines, countBare, countUpstream, duplicateLabels } from './normalise.mjs';

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
 * The count of cases ending in `UpstreamError/UPSTREAM` or
 * `RetryExhaustedError/RETRY_EXHAUSTED`, under the same rule. It sees what the
 * bare count cannot: wrapping a method so a caller's mistake escapes as an
 * `UpstreamError` removes a bare row and adds one here, and that is a
 * rebranding, not a fix. The fake client's own rejection is reported as
 * REACHED-WRITE instead, so a row counted here failed somewhere other than the
 * AWS call the harness fakes.
 */
const EXPECTED_UPSTREAM = 0;

test('the public surface matches the committed baseline', async () => {
  assert.ok(
    existsSync('dist/index.js'),
    'dist/index.js is missing — run `npm run build` first; this tier fuzzes built output, not src/',
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
