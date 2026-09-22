import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import ts from 'typescript';

import { listSourceFiles, SRC_ROOT } from './source-files';

/** An exported function no test names. */
export interface UnaddressedExport {
  file: string;
  name: string;
}

/** Every exported function declared in one source text. */
export function exportedFunctionsIn(source: string, file = 'source.ts'): UnaddressedExport[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: UnaddressedExport[] = [];
  for (const node of parsed.statements) {
    if (!ts.isFunctionDeclaration(node) || node.name === undefined) continue;
    const exported = (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (exported) found.push({ file, name: node.name.text });
  }
  return found;
}

/** The exports of `functions` whose name appears in none of `tests`. */
export function unaddressedExports(
  functions: readonly UnaddressedExport[],
  tests: string,
): UnaddressedExport[] {
  return functions.filter(({ name }) => !new RegExp(`\\b${name}\\b`).test(tests));
}

/** Every `.test.ts` under `test/`, concatenated. */
export function allTestSources(): string {
  const root = SRC_ROOT.replace(/src$/, 'test');
  return listSourceFiles(root)
    .filter((file) => file.endsWith('.test.ts'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

/** Every exported function under `src/`. */
export function allExportedFunctions(): UnaddressedExport[] {
  return listSourceFiles().flatMap((file) =>
    exportedFunctionsIn(readFileSync(file, 'utf8'), relative(SRC_ROOT, file).split(sep).join('/')),
  );
}
