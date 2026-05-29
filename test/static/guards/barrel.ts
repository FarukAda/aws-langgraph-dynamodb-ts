import { resolve } from 'node:path';

import * as ts from 'typescript';

import { SRC_ROOT } from './source-files';

const PUBLIC_ENTRY = resolve(SRC_ROOT, 'index.ts');

/** True only for the package's single allowed re-export file, `src/index.ts`. */
export function isPublicEntry(filePath: string): boolean {
  return resolve(filePath) === PUBLIC_ENTRY;
}

/**
 * True when `source` contains any `export ... from '...'` (or `export *`)
 * declaration (a barrel re-export). Local exports return false.
 */
export function findReexports(source: string): boolean {
  const sourceFile = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) found = true;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
