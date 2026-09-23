import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SRC_ROOT } from './source-files';

const REPO_ROOT = resolve(SRC_ROOT, '..');
const EVIDENCE = resolve(REPO_ROOT, 'docs', 'evidence');
const LIVE_TESTS = resolve(REPO_ROOT, 'test', 'aws');

/** One claim an evidence file settles. */
export interface EvidenceClaim {
  id: string;
  file: string;
}

/** The text of every evidence file except the index. */
export function evidenceTexts(): { file: string; text: string }[] {
  return readdirSync(EVIDENCE)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ file: name, text: readFileSync(join(EVIDENCE, name), 'utf8') }));
}

/** Every `## E-<n>: …` heading across the evidence files. */
export function evidenceClaims(): EvidenceClaim[] {
  return evidenceTexts()
    .filter(({ file }) => file !== 'README.md')
    .flatMap(({ file, text }) =>
      [...text.matchAll(/^## (E-\d+):/gm)].map((match) => ({ id: match[1], file })),
    );
}

/** The claim ids the README's claims table links. */
export function indexedClaimIds(): string[] {
  const readme = readFileSync(join(EVIDENCE, 'README.md'), 'utf8');
  return [...readme.matchAll(/^\| (E-\d+) \|/gm)].map((match) => match[1]);
}

/** Every `.ts` file under `dir`, recursively. */
function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTs(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Every claim id a live test names itself after: `it('E-3: …'`. */
export function liveTestClaimIds(): string[] {
  return listTs(LIVE_TESTS).flatMap((path) =>
    [...readFileSync(path, 'utf8').matchAll(/\b(?:it|test)\(\s*['"`](E-\d+):/g)].map(
      (match) => match[1],
    ),
  );
}
