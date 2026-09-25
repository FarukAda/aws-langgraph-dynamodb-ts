import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { listSourceFiles, SRC_ROOT } from './source-files';

/** The generated API reference: one Markdown page per public name, plus the package page. */
export const API_DOCS_ROOT = resolve(SRC_ROOT, '..', 'docs', 'api');

/**
 * Internal function names that are also the name of a documented error
 * `field`, so a public page quotes them as the field, not as the function.
 */
export const FIELD_NAMES: readonly string[] = ['sortKey'];

/** Every Markdown page under `dir`, recursively. */
export function apiPages(dir: string = API_DOCS_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return apiPages(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

/** Every function `source` declares at the start of a line, exported or not. */
export function declaredFunctions(source: string): string[] {
  return [...source.matchAll(/^(?:export )?(?:async )?function\*? ([A-Za-z_$][\w$]*)/gm)].map(
    (match) => match[1],
  );
}

/** Every name a page documents: its own (`# Class: X`) and each heading under it (`### x()`). */
export function documentedNames(page: string): string[] {
  const own = [...page.matchAll(/^# \w+: ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
  const members = [...page.matchAll(/^#{2,4} ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
  return [...own, ...members];
}

/** Every code-formatted name on a page, written `` `x` `` or `` `x()` ``. */
export function quotedNames(page: string): string[] {
  return [...page.matchAll(/`([A-Za-z_$][\w$]*)(?:\(\))?`/g)].map((match) => match[1]);
}

/** The names in `internal` that `page` quotes, each once. */
export function internalNamesOn(page: string, internal: ReadonlySet<string>): string[] {
  return [...new Set(quotedNames(page).filter((name) => internal.has(name)))];
}

/**
 * The functions `src` declares that no API page documents, less
 * {@link FIELD_NAMES}: a public page that quotes one sends its reader after a
 * name the reference does not contain, and describes the implementation
 * rather than the contract (coding guidelines, rule 31).
 */
export function internalFunctions(): Set<string> {
  const documented = new Set(
    apiPages().flatMap((path) => documentedNames(readFileSync(path, 'utf8'))),
  );
  const declared = listSourceFiles().flatMap((path) =>
    declaredFunctions(readFileSync(path, 'utf8')),
  );
  return new Set(declared.filter((name) => !documented.has(name) && !FIELD_NAMES.includes(name)));
}
