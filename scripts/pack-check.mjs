/**
 * Assert the tarball `npm pack` would publish contains exactly the shipped
 * files: the build output, the licence, the README and the manifest. Anything
 * else (maps, tests, configs, scratch files) is a packaging regression.
 */
import { execSync } from 'node:child_process';

const [{ files }] = JSON.parse(execSync('npm pack --dry-run --json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
const paths = files.map((file) => file.path).sort();
const allowed = (path) => path.startsWith('dist/') || ['LICENSE', 'README.md', 'package.json'].includes(path);
const unexpected = paths.filter((path) => !allowed(path) || path.endsWith('.map'));
const required = ['dist/index.js', 'dist/index.d.ts', 'LICENSE', 'README.md', 'package.json'];
const missing = required.filter((path) => !paths.includes(path));
if (unexpected.length > 0 || missing.length > 0) {
  console.error(`pack listing: unexpected ${JSON.stringify(unexpected)} missing ${JSON.stringify(missing)}`);
  process.exit(1);
}
console.log(`pack listing ok: ${paths.length} files, all under dist/ plus LICENSE, README.md and package.json`);
