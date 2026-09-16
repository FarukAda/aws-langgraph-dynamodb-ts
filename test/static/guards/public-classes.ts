import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { type UnguardedMethod, unguardedMethodsIn } from './guarded-methods';
import { SRC_ROOT } from './source-files';

/**
 * How `entry` makes one class part of the public API: `'named'` (or an
 * aliased re-export, resolved to the class's own name) names it directly;
 * `'all'` is every class a `export *` forwards; `'default'` is the module's
 * default export, named or anonymous; `'local'` is a class `entry` declares
 * and exports itself.
 */
export interface ReExportedClass {
  kind: 'named' | 'all' | 'default' | 'local';
  /** The module path as written in `entry`; absent for `'local'`. */
  path?: string;
  /** The class's own declared name; set for `'named'` and `'local'`. */
  name?: string;
}

/** True for a class declaration carrying `export`. */
function isExportedClass(node: ts.ClassDeclaration): boolean {
  return (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** True for a class declaration also carrying `default`. */
function isDefaultExport(node: ts.ClassDeclaration): boolean {
  return (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

/**
 * The classes `entry` (shaped like `src/index.ts`) makes part of the public
 * API: every named or aliased specifier of a value `export { ... } from
 * '<path>'` declaration — an alias is recorded by its source name, since
 * that is the class's own declared name, not the public one — every class a
 * `export * from '<path>'` forwards, the module's default export named by
 * `export { default }` or `export { default as X } from '<path>'`, and a
 * class `entry` declares and exports directly, with no `from`. `export type`
 * declarations and individually type-only specifiers are skipped.
 */
export function reExportedClasses(entry: string): ReExportedClass[] {
  const parsed = ts.createSourceFile('index.ts', entry, ts.ScriptTarget.Latest, true);
  const out: ReExportedClass[] = [];
  for (const node of parsed.statements) {
    if (ts.isClassDeclaration(node) && isExportedClass(node) && node.name !== undefined) {
      out.push({ kind: 'local', name: node.name.text });
      continue;
    }
    if (!ts.isExportDeclaration(node) || node.isTypeOnly) continue;
    if (node.moduleSpecifier === undefined || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const path = node.moduleSpecifier.text;
    if (node.exportClause === undefined) {
      out.push({ kind: 'all', path });
      continue;
    }
    if (!ts.isNamedExports(node.exportClause)) continue;
    for (const element of node.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const sourceName = (element.propertyName ?? element.name).text;
      out.push(
        sourceName === 'default'
          ? { kind: 'default', path }
          : { kind: 'named', path, name: sourceName },
      );
    }
  }
  return out;
}

/**
 * Every class `source` exports, labelled the way `unguardedMethodsIn` labels
 * its gaps, and which one (if any) is the default export.
 */
function exportedClassNames(
  source: string,
  file: string,
): { names: ReadonlySet<string>; defaultName?: string } {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  let defaultName: string | undefined;
  for (const node of parsed.statements) {
    if (!ts.isClassDeclaration(node) || !isExportedClass(node)) continue;
    const label = node.name?.text ?? 'default';
    names.add(label);
    if (isDefaultExport(node)) defaultName = label;
  }
  return { names, defaultName };
}

/** One resolved module: the file label and source `unguardedMethodsIn` should see. */
interface ResolvedModule {
  file: string;
  source: string;
}

/**
 * The unguarded members of every class `entry` makes public, given `read` to
 * resolve a module path to its file label and source. A path `read` cannot
 * resolve is skipped. A class a resolved module declares that `entry` does
 * not name — directly, through a wildcard, or as its default export — stays
 * out of scope even though its module was read; this is what keeps internal
 * plumbing such as `S3Offloader` out of scope.
 */
function unguardedAcross(
  entry: string,
  read: (path: string) => ResolvedModule | undefined,
): UnguardedMethod[] {
  const gaps: UnguardedMethod[] = [];
  const local = unguardedMethodsIn(entry, 'index.ts');
  for (const locator of reExportedClasses(entry)) {
    if (locator.kind === 'local') {
      gaps.push(...local.filter((gap) => gap.name.split('.')[0] === locator.name));
      continue;
    }
    const module = locator.path === undefined ? undefined : read(locator.path);
    if (module === undefined) continue;
    const moduleGaps = unguardedMethodsIn(module.source, module.file);
    if (locator.kind === 'named') {
      gaps.push(...moduleGaps.filter((gap) => gap.name.split('.')[0] === locator.name));
      continue;
    }
    const { names, defaultName } = exportedClassNames(module.source, module.file);
    const allowed =
      locator.kind === 'all' ? names : new Set(defaultName === undefined ? [] : [defaultName]);
    gaps.push(...moduleGaps.filter((gap) => allowed.has(gap.name.split('.')[0])));
  }
  return gaps;
}

/**
 * The synthetic-source form of {@link unguardedMethods}: `modules` maps each
 * re-exported path in `entry` to that module's source, keyed exactly as the
 * path appears in `entry`'s `from '<path>'` clauses.
 */
export function unguardedPublicMethods(
  entry: string,
  modules: Readonly<Record<string, string>>,
): UnguardedMethod[] {
  return unguardedAcross(entry, (path) => {
    const source = modules[path];
    return source === undefined ? undefined : { file: path, source };
  });
}

/** `path`, relative to `src/index.ts`, resolved to the `.ts` file it names. */
function resolveSrcModule(path: string): string {
  return `${resolve(SRC_ROOT, path)}.ts`;
}

/**
 * Every public member that must be guarded and is not, across the classes
 * `src/index.ts` makes part of the public API — the whole public API,
 * derived the same way a consumer's `import` resolves it, never from the
 * `export` keyword alone.
 */
export function unguardedMethods(): UnguardedMethod[] {
  const entry = readFileSync(resolve(SRC_ROOT, 'index.ts'), 'utf8');
  return unguardedAcross(entry, (path) => {
    const absolute = resolveSrcModule(path);
    return {
      file: relative(SRC_ROOT, absolute).split(sep).join('/'),
      source: readFileSync(absolute, 'utf8'),
    };
  });
}
