/**
 * Assert the tarball `npm pack` would publish contains exactly the shipped
 * files: an ES-module tree and a CommonJS tree under dist/, the CommonJS scope
 * marker, the licence, the README and the manifest. Anything else (maps,
 * tests, configs, scratch files, a flat dist/ from the single-build layout) is
 * a packaging regression. Also verify that all shipped .js files have
 * corresponding source files.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [{ files }] = JSON.parse(execSync('npm pack --dry-run --json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
const paths = files.map((file) => file.path).sort();
const BUILD_TREE = /^dist\/(esm|cjs)\//;
const allowed = (path) => BUILD_TREE.test(path) || ['LICENSE', 'README.md', 'package.json'].includes(path);
const unexpected = paths.filter((path) => !allowed(path) || path.endsWith('.map'));
const required = [
  'dist/esm/index.js',
  'dist/esm/index.d.ts',
  'dist/cjs/index.js',
  'dist/cjs/index.d.ts',
  'dist/cjs/package.json',
  'LICENSE',
  'README.md',
  'package.json',
];
const missing = required.filter((path) => !paths.includes(path));
const staleModules = paths.filter((path) => BUILD_TREE.test(path) && path.endsWith('.js'))
  .filter((path) => !existsSync(path.replace(/\.js$/, '.ts').replace(BUILD_TREE, 'src/')));
if (unexpected.length > 0 || missing.length > 0 || staleModules.length > 0) {
  if (unexpected.length > 0 || missing.length > 0) {
    console.error(`pack listing: unexpected ${JSON.stringify(unexpected)} missing ${JSON.stringify(missing)}`);
  }
  if (staleModules.length > 0) {
    console.error(`pack listing: stale modules ${JSON.stringify(staleModules)}`);
  }
  process.exit(1);
}
console.log(`pack listing ok: ${paths.length} files under dist/esm and dist/cjs, plus LICENSE, README.md and package.json`);
