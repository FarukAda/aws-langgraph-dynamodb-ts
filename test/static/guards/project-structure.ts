import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SRC_ROOT } from './source-files';

const REPO_ROOT = resolve(SRC_ROOT, '..');

/** The tree under the README's `## Project structure` heading, one line per element. */
function structureTree(readme: string): string[] {
  const lines = readme.split(/\r?\n/);
  const heading = lines.indexOf('## Project structure');
  const open = lines.indexOf('```text', heading);
  if (heading === -1 || open === -1) {
    throw new Error('README.md has no "## Project structure" tree; teach this guard where it went');
  }
  return lines.slice(open + 1, lines.indexOf('```', open + 1));
}

/**
 * The names the README's project-structure tree lists directly under `root` —
 * `scripts`, `.github/workflows` — without the trailing `/` a directory is
 * written with. Only the first level is read: the tree shortens everything
 * below it on purpose.
 */
export function listedEntries(
  root: string,
  readme: string = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8'),
): string[] {
  const tree = structureTree(readme);
  const start = tree.findIndex((line) => line === `${root}/` || line.startsWith(`${root}/ `));
  if (start === -1) throw new Error(`the project-structure tree has no "${root}/" block`);
  const entries: string[] = [];
  for (const line of tree.slice(start + 1)) {
    if (line.trim() === '') break;
    // A first-level branch starts at column 0; a nested one sits behind `│` or spaces.
    const branch = /^[├└]── (\S+)/.exec(line);
    if (branch) entries.push(branch[1].replace(/\/$/, ''));
  }
  return entries;
}

/** The names on disk directly under `root`, relative to the repository root. */
export function actualEntries(root: string): string[] {
  return readdirSync(resolve(REPO_ROOT, root));
}
