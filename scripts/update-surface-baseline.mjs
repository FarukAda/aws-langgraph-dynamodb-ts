/**
 * Regenerate the surface baseline.
 *
 * The flag travels as an environment variable rather than an argument because
 * `node --test` does not forward trailing arguments to the test child — on Node
 * 22.17, `node --test file.mjs -- --update` leaves the child's `process.argv`
 * holding only the file path. It is set here, in a script, rather than inline in
 * the npm script, because `VAR=1 cmd` is shell syntax that cmd.exe does not
 * understand and CI runs a windows leg.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test', 'test/surface/surface.test.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, UPDATE_SURFACE_BASELINE: '1' },
});
process.exit(result.status ?? 1);
