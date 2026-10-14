/**
 * Regenerate the surface baseline.
 *
 * The flag travels as an environment variable rather than an argument because
 * `node --test` does not forward trailing arguments to the test child — on Node
 * 22.17, `node --test file.mjs -- --update` leaves the child's `process.argv`
 * holding only the file path. It is set here, in a script, rather than inline in
 * the npm script, because `VAR=1 cmd` is shell syntax that cmd.exe does not
 * understand and CI runs a windows leg.
 *
 * The test runs exactly as `npm run test:surface` runs it — under the same
 * timeout wrapper, with the runner told to exit once the tests are done — so
 * regenerating the baseline cannot stall where the check would not: without
 * `--test-force-exit`, a Node 24 or 26 process whose tests have all passed can
 * spin at 100 % CPU in its own teardown instead of exiting (see
 * `run-with-timeout.mjs`), and this script used to run the bare `node --test`.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    'scripts/run-with-timeout.mjs',
    '150',
    '--',
    process.execPath,
    '--test',
    '--test-force-exit',
    '--test-timeout=120000',
    'test/surface/surface.test.mjs',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, UPDATE_SURFACE_BASELINE: '1' },
  },
);
process.exit(result.status ?? 1);