import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { collectRows } from './harness.mjs';
import { canonicalLines, countBare } from './normalise.mjs';

const BASELINE = 'test/surface/baseline.txt';

/**
 * The count of cases that still let a non-library error escape. A ratchet, not
 * a target: every fix lowers it and nothing may raise it. A flat `=== 0` would
 * leave this tier red for the whole hardening pass and report nothing useful on
 * any intermediate commit. It becomes 0 when the pass completes.
 */
const EXPECTED_BARE = 34;

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

test('no case regresses into letting a bare error escape', async () => {
  const lines = canonicalLines(await collectRows());
  const bare = countBare(lines);
  assert.ok(
    bare <= EXPECTED_BARE,
    `${bare} cases let a bare error escape, up from ${EXPECTED_BARE}; lower EXPECTED_BARE as fixes land, never raise it`,
  );
});
