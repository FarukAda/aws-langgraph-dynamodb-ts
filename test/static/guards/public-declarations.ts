import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { type UnguardedMethod, unguardedMethodsIn } from './guarded-methods';
import { SRC_ROOT, withoutEmittedExtension } from './source-files';

/**
 * One value `entry` (shaped like `src/index.ts`) makes public, before it is
 * resolved: `'named'` is a specifier of an `export { ... } from '<path>'`
 * declaration, recorded by its source name — an alias is the public name, not
 * the declared one — and `'local'` is a declaration `entry` itself exports.
 */
export interface PublicExport {
  kind: 'named' | 'local';
  /** The module path as written in `entry`; absent for `'local'`. */
  path?: string;
  name: string;
}

/**
 * One public value, resolved to the declaration behind it: a class, a
 * function (declared, or a variable holding one), or any other value, such as
 * an enum or a constant, which has no body to guard.
 */
export interface PublicDeclaration {
  file: string;
  name: string;
  kind: 'class' | 'function' | 'value';
}

/** One resolved module: the file label and source the guard reads. */
interface ResolvedModule {
  file: string;
  source: string;
}

/** True when `node` carries the modifier `kind`. */
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/** True for a statement that makes something public in any way, `export default` included. */
function isExporting(node: ts.Statement): boolean {
  return (
    ts.isExportDeclaration(node) ||
    ts.isExportAssignment(node) ||
    hasModifier(node, ts.SyntaxKind.ExportKeyword)
  );
}

/** A declared name and what it declares. */
type DeclaredName = Pick<PublicDeclaration, 'name' | 'kind'>;

/**
 * The names `node` declares when it is a declaration this derivation reads,
 * classified — or none for any other statement. An overload signature counts
 * as the function it declares.
 *
 * A variable counts as a function only when its initializer is an arrow
 * function or a function expression written in place. One holding a class
 * expression or the result of a call — a wrapped function such as
 * `wrap(async () => …)`, or a frozen object — is classified as a plain value
 * and no rule checks it: telling a callable result from a constant would need
 * the type checker, and refusing every call result would refuse ordinary
 * constants. A limit, like the type-alias one in `guarded-methods.ts`.
 */
function declaredNames(node: ts.Statement): DeclaredName[] {
  if (ts.isClassDeclaration(node) && node.name !== undefined) {
    return [{ name: node.name.text, kind: 'class' }];
  }
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    return [{ name: node.name.text, kind: 'function' }];
  }
  if (ts.isEnumDeclaration(node)) return [{ name: node.name.text, kind: 'value' }];
  if (!ts.isVariableStatement(node)) return [];
  return node.declarationList.declarations.map((declaration): DeclaredName => {
    const init = declaration.initializer;
    const holdsFunction =
      init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
    return { name: declaration.name.getText(), kind: holdsFunction ? 'function' : 'value' };
  });
}

/** True for a statement that only declares a type, which has no runtime body to guard. */
function declaresTypeOnly(node: ts.Statement): boolean {
  return ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
}

/**
 * Why `entry`'s statement `node` cannot be resolved by name, for the error the
 * derivation raises instead of skipping it.
 */
function unresolvable(node: ts.Statement, detail: string): Error {
  return new Error(
    `public-declarations: cannot resolve \`${node.getText()}\` in the entry file: ${detail}. ` +
      'Re-export each public value by its own name, from the module that declares it.',
  );
}

/** The named exports of one `export { ... } from '<path>'` declaration, type-only ones skipped. */
function namedExports(node: ts.ExportDeclaration): PublicExport[] {
  if (node.isTypeOnly) return [];
  if (node.moduleSpecifier === undefined || !ts.isStringLiteral(node.moduleSpecifier)) {
    throw unresolvable(node, 'a local export list names a binding, not its declaration');
  }
  if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) {
    throw unresolvable(node, 'a wildcard re-export names no value');
  }
  const path = node.moduleSpecifier.text;
  return node.exportClause.elements
    .filter((element) => !element.isTypeOnly)
    .map((element): PublicExport => {
      const name = (element.propertyName ?? element.name).text;
      if (name === 'default') throw unresolvable(node, 'a default export has no declared name');
      return { kind: 'named', path, name };
    });
}

/**
 * Every value `entry` makes public, by name: each value specifier of an
 * `export { ... } from '<path>'` declaration, and each class, function,
 * variable or enum `entry` declares with `export`. `export type` declarations,
 * type-only specifiers, and exported interfaces and type aliases are skipped.
 *
 * Throws: for every export form it cannot resolve to a declared name, rather
 * than skipping it — a skipped form is a public value no guard ever checks.
 * That is a local `export { X }` (of an imported binding or any other), any
 * `export default`, and an `export * from` or `export * as ns from`.
 */
export function publicExports(entry: string): PublicExport[] {
  const parsed = ts.createSourceFile('index.ts', entry, ts.ScriptTarget.Latest, true);
  const out: PublicExport[] = [];
  for (const node of parsed.statements) {
    if (!isExporting(node)) continue;
    if (ts.isExportDeclaration(node)) {
      out.push(...namedExports(node));
      continue;
    }
    if (ts.isExportAssignment(node) || hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
      throw unresolvable(node, 'a default export has no declared name');
    }
    if (declaresTypeOnly(node)) continue;
    const names = declaredNames(node);
    if (names.length === 0) throw unresolvable(node, 'it is not a declaration this guard reads');
    out.push(...names.map(({ name }) => ({ kind: 'local' as const, name })));
  }
  return out;
}

/**
 * The declaration `source` exports under `name`, or an error: the name must be
 * declared at the top level of that very module with `export`, so a module that
 * itself re-exports an imported binding fails here instead of contributing
 * nothing.
 */
function resolveDeclaration(module: ResolvedModule, name: string): PublicDeclaration {
  const parsed = ts.createSourceFile(module.file, module.source, ts.ScriptTarget.Latest, true);
  for (const node of parsed.statements) {
    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) continue;
    const found = declaredNames(node).find((declared) => declared.name === name);
    if (found !== undefined) return { file: module.file, ...found };
  }
  throw new Error(
    `public-declarations: \`${name}\` is not a class, function, variable or enum that ` +
      `${module.file} declares and exports itself`,
  );
}

/**
 * Every declaration behind `entry`'s public values, given `read` to resolve a
 * module path to its file label and source.
 *
 * Throws: as {@link publicExports}; for a module `read` cannot resolve; and
 * for a name the module it is re-exported from does not itself declare.
 */
function declarationsAcross(
  entry: string,
  read: (path: string) => ResolvedModule | undefined,
): { declaration: PublicDeclaration; module: ResolvedModule }[] {
  const index: ResolvedModule = { file: 'index.ts', source: entry };
  return publicExports(entry).map((exported) => {
    const module = exported.path === undefined ? index : read(exported.path);
    if (module === undefined) {
      throw new Error(`public-declarations: cannot read the module ${exported.path}`);
    }
    return { declaration: resolveDeclaration(module, exported.name), module };
  });
}

/** The gaps `unguardedMethodsIn` reports for one declaration: its own name, or its members. */
function gapsOf(declaration: PublicDeclaration, module: ResolvedModule): UnguardedMethod[] {
  if (declaration.kind === 'value') return [];
  return unguardedMethodsIn(module.source, module.file).filter((gap) =>
    declaration.kind === 'class'
      ? gap.name.startsWith(`${declaration.name}.`)
      : gap.name === declaration.name,
  );
}

/**
 * The synthetic-source form of {@link publicDeclarations}: `modules` maps each
 * re-exported path in `entry` to that module's source, keyed exactly as the
 * path appears in `entry`'s `from '<path>'` clauses.
 */
export function publicDeclarationsOf(
  entry: string,
  modules: Readonly<Record<string, string>>,
): PublicDeclaration[] {
  return declarationsAcross(entry, syntheticReader(modules)).map(({ declaration }) => declaration);
}

/**
 * The synthetic-source form of {@link unguardedMethods}, reading `modules` as
 * {@link publicDeclarationsOf} does.
 */
export function unguardedPublicMethods(
  entry: string,
  modules: Readonly<Record<string, string>>,
): UnguardedMethod[] {
  return declarationsAcross(entry, syntheticReader(modules)).flatMap(({ declaration, module }) =>
    gapsOf(declaration, module),
  );
}

/** A reader over synthetic sources, labelling each module by its path. */
function syntheticReader(
  modules: Readonly<Record<string, string>>,
): (path: string) => ResolvedModule | undefined {
  return (path) => {
    const source = modules[path];
    return source === undefined ? undefined : { file: path, source };
  };
}

/** A reader over the real tree: `path`, relative to `src/index.ts`, is the `.ts` file it names. */
function treeReader(path: string): ResolvedModule {
  const absolute = `${resolve(SRC_ROOT, withoutEmittedExtension(path))}.ts`;
  return {
    file: relative(SRC_ROOT, absolute).split(sep).join('/'),
    source: readFileSync(absolute, 'utf8'),
  };
}

/** The real `src/index.ts`. */
function entrySource(): string {
  return readFileSync(resolve(SRC_ROOT, 'index.ts'), 'utf8');
}

/**
 * Every declaration `src/index.ts` makes public — derived the same way a
 * consumer's `import` resolves it, never from the `export` keyword alone and
 * never kept by hand. A class or function a module declares that `src/index.ts`
 * does not name, such as the internal `S3Offloader`, is not in it.
 */
export function publicDeclarations(): PublicDeclaration[] {
  return declarationsAcross(entrySource(), treeReader).map(({ declaration }) => declaration);
}

/**
 * Every public class member and public function that must be guarded and is
 * not, across {@link publicDeclarations}.
 */
export function unguardedMethods(): UnguardedMethod[] {
  return declarationsAcross(entrySource(), treeReader).flatMap(({ declaration, module }) =>
    gapsOf(declaration, module),
  );
}
