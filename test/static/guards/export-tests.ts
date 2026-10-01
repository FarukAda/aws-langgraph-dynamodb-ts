import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { listSourceFiles, SRC_ROOT } from './source-files';

/** An exported function no test imports. */
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

/** A module path as the imports below spell it: relative to `src/`, `/`-separated, extensionless. */
function modulePath(absolute: string): string {
  return relative(SRC_ROOT, absolute)
    .split(sep)
    .join('/')
    .replace(/\.(?:js|ts)$/, '');
}

/** The whole-module marker a namespace import (`import * as`) leaves. */
const WHOLE_MODULE = '*';

/**
 * What one test file imports from `src/`, as `<module>#<name>` entries — the
 * module relative to `src/` without its extension, so `../../src/a/b.js` and
 * `../../src/a/b` are one module — with `<module>#*` for a namespace import.
 *
 * Accepts: `source` — the test's text. `testFile` — its absolute path, which
 * the relative specifiers resolve against.
 */
export function importedNamesIn(source: string, testFile: string): string[] {
  const parsed = ts.createSourceFile(testFile, source, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  for (const node of parsed.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const specifier = node.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const module = modulePath(resolve(dirname(testFile), specifier));
    if (module.startsWith('..')) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) names.push(`${module}#${WHOLE_MODULE}`);
    else for (const element of bindings.elements) names.push(`${module}#${element.name.text}`);
  }
  return names;
}

/**
 * The declaring module of every function `src/index.ts` re-exports, by the
 * name it is exported under, so a test that imports the public name from the
 * package entry addresses the function it names.
 */
export function indexReexports(
  source = readFileSync(resolve(SRC_ROOT, 'index.ts'), 'utf8'),
): Map<string, string> {
  const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const declaring = new Map<string, string>();
  for (const node of parsed.statements) {
    if (!ts.isExportDeclaration(node) || node.moduleSpecifier === undefined) continue;
    if (node.isTypeOnly) continue;
    if (!ts.isStringLiteral(node.moduleSpecifier) || node.exportClause === undefined) continue;
    if (!ts.isNamedExports(node.exportClause)) continue;
    const module = modulePath(resolve(SRC_ROOT, node.moduleSpecifier.text));
    for (const element of node.exportClause.elements) {
      declaring.set(element.name.text, `${module}.ts`);
    }
  }
  return declaring;
}

/**
 * The exports of `functions` that no test imports: neither by name from the
 * declaring module (or that module whole), nor by the public name from
 * `src/index.ts` when it re-exports the function.
 *
 * An import, not a mention: a name that appears in a test's text can be a
 * comment, a string, or a different function of the same name; an import
 * specifier is a test that took hold of this one.
 */
export function unaddressedExports(
  functions: readonly UnaddressedExport[],
  imports: ReadonlySet<string>,
  reexports: ReadonlyMap<string, string> = indexReexports(),
): UnaddressedExport[] {
  return functions.filter(({ file, name }) => {
    const module = file.replace(/\.ts$/, '');
    if (imports.has(`${module}#${name}`) || imports.has(`${module}#${WHOLE_MODULE}`)) return false;
    const viaIndex = reexports.get(name) === file;
    return !(viaIndex && (imports.has(`index#${name}`) || imports.has(`index#${WHOLE_MODULE}`)));
  });
}

/** Every `<module>#<name>` any `.test.ts` under `test/` imports from `src/`. */
export function allTestImports(): Set<string> {
  const root = SRC_ROOT.replace(/src$/, 'test');
  const imports = new Set<string>();
  for (const file of listSourceFiles(root)) {
    if (!file.endsWith('.test.ts')) continue;
    for (const entry of importedNamesIn(readFileSync(file, 'utf8'), file)) imports.add(entry);
  }
  return imports;
}

/** Every exported function under `src/`. */
export function allExportedFunctions(): UnaddressedExport[] {
  return listSourceFiles().flatMap((file) =>
    exportedFunctionsIn(readFileSync(file, 'utf8'), relative(SRC_ROOT, file).split(sep).join('/')),
  );
}
