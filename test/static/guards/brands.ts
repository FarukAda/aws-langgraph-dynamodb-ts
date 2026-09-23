import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import * as ts from 'typescript';

import { listSourceFiles, SRC_ROOT } from './source-files';

/** One module of `src`: its path relative to `src/`, and its text. */
export interface SourceModule {
  file: string;
  source: string;
}

/** A cast to a brand: which brand, on which line, inside which function declaration. */
export interface BrandCast {
  brand: string;
  line: number;
  inFunction: string | undefined;
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
}

/** The names bound by `declare const <name>: unique symbol` in `file`. */
function uniqueSymbols(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.type !== undefined &&
      ts.isTypeOperatorNode(node.type) &&
      node.type.operator === ts.SyntaxKind.UniqueKeyword
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** Whether `type` has a member whose computed key is one of `symbols`. */
function keyedBy(type: ts.Node, symbols: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertySignature(node) &&
      ts.isComputedPropertyName(node.name) &&
      ts.isIdentifier(node.name.expression) &&
      symbols.has(node.name.expression.text)
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(type);
  return found;
}

/**
 * The brands `source` declares: every type alias with a member keyed by a
 * `declare const …: unique symbol` of the same module.
 */
export function declaredBrands(source: string): string[] {
  const file = parse(source);
  const symbols = uniqueSymbols(file);
  return file.statements
    .filter(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && keyedBy(statement.type, symbols),
    )
    .map((statement) => statement.name.text);
}

/** How many `declare const …: unique symbol` declarations `source` holds. */
export function uniqueSymbolCount(source: string): number {
  return uniqueSymbols(parse(source)).size;
}

/** The name of the function declaration enclosing `node`, if any; an arrow inside one counts as inside it. */
function enclosingFunction(node: ts.Node): string | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text;
  }
  return undefined;
}

/** Every `as B` and `<B>` cast in `source` whose target type names one of `brands`. */
export function brandCasts(source: string, brands: ReadonlySet<string>): BrandCast[] {
  const file = parse(source);
  const casts: BrandCast[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      ts.isTypeReferenceNode(node.type) &&
      ts.isIdentifier(node.type.typeName) &&
      brands.has(node.type.typeName.text)
    ) {
      casts.push({
        brand: node.type.typeName.text,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        inFunction: enclosingFunction(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return casts;
}

/**
 * Every breach of the one-constructor rule across `modules`, as sorted
 * readable lines: a brand declared outside a parser module or twice; a cast to
 * a brand outside the module declaring it or outside a `parse*` function; a
 * brand built by no parser or by more than one.
 */
export function brandViolations(
  modules: readonly SourceModule[],
  parserModules: readonly string[],
): string[] {
  const owner = new Map<string, string>();
  const violations: string[] = [];
  for (const { file, source } of modules) {
    if (uniqueSymbolCount(source) > 0 && !parserModules.includes(file)) {
      violations.push(`${file}: declares a unique symbol outside a parser module`);
    }
    for (const brand of declaredBrands(source)) {
      const first = owner.get(brand);
      if (first === undefined) owner.set(brand, file);
      else violations.push(`${file}: redeclares ${brand}, already declared in ${first}`);
    }
  }
  const brands = new Set(owner.keys());
  const constructors = new Map<string, Set<string>>();
  for (const { file, source } of modules) {
    for (const cast of brandCasts(source, brands)) {
      const home = owner.get(cast.brand);
      if (home !== file) {
        violations.push(`${file}:${cast.line}: casts to ${cast.brand} outside ${home}`);
      } else if (cast.inFunction === undefined || !/^parse[A-Z]/.test(cast.inFunction)) {
        violations.push(`${file}:${cast.line}: casts to ${cast.brand} outside a parse* function`);
      } else {
        const names = constructors.get(cast.brand) ?? new Set<string>();
        names.add(cast.inFunction);
        constructors.set(cast.brand, names);
      }
    }
  }
  for (const brand of brands) {
    const names = [...(constructors.get(brand) ?? [])].sort();
    if (names.length !== 1) {
      violations.push(
        `${owner.get(brand)}: ${brand} is built by ${names.length} parsers ` +
          `(${names.join(', ') || 'none'}); it must have exactly one`,
      );
    }
  }
  return violations.sort();
}

/** Every module of `src`. */
export function sourceModules(): SourceModule[] {
  return listSourceFiles().map((path) => ({
    file: relative(SRC_ROOT, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }));
}
