import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { collectRows } from './harness.mjs';
import { canonicalLines, countBare, countUpstream, duplicateLabels } from './normalise.mjs';

const BASELINE = 'test/surface/baseline.txt';

/**
 * The count of cases that still let a non-library error escape. A ratchet, not
 * a target: every fix lowers it and nothing may raise it. A flat `=== 0` would
 * leave this tier red for the whole hardening pass and report nothing useful on
 * any intermediate commit. It becomes 0 when the pass completes.
 */
const EXPECTED_BARE = 10;

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
    `${bare} cases let a bare error escape, up from ${EXPECTED_BARE}; lower EXPECTED_BARE as fixes land, never raise it`,
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
