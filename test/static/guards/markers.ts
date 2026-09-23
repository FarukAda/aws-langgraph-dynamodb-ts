import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { allScannableFiles, handEditedDocFiles } from './plan-references';
import { SRC_ROOT } from './source-files';

/** One marker found in the tree, by file and 1-based line. */
export interface MarkerHit {
  file: string;
  line: number;
  text: string;
}

const REPO_ROOT = resolve(SRC_ROOT, '..');

/** This guard's own two files hold every marker as test data. */
const GUARD_OWN_FILES = new Set(['test/static/guards/markers.ts', 'test/static/markers.test.ts']);

/**
 * A marker word standing alone. A marker directly after an opening double
 * quote is a quotation of another project's text, kept verbatim so a reader
 * can find it there, and is not this repository's promise.
 */
const MARKER = /(?<!")\b(TODO|FIXME|XXX|HACK)\b/g;

/** Every marker in `source`, attributed to `file`. */
export function markersIn(source: string, file: string): MarkerHit[] {
  return source
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(MARKER)].map((match) => ({ file, line: index + 1, text: match[1] })),
    );
}

/** Every marker across the scanned source, tests, scripts, examples and hand-edited docs. */
export function markers(): MarkerHit[] {
  return [...allScannableFiles(), ...handEditedDocFiles()]
    .filter((path) => !GUARD_OWN_FILES.has(path))
    .flatMap((path) => markersIn(readFileSync(resolve(REPO_ROOT, path), 'utf8'), path));
}
