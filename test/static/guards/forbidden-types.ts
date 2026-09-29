import * as ts from 'typescript';

/** Where the guard is looking: a parser module relaxes one rule for `unknown`. */
export interface ForbiddenTypeOptions {
  /** True for a module in `PARSER_MODULES`. */
  parserModule?: boolean;
}

/**
 * The function declaration `node` — an `unknown` keyword — is the whole
 * declared type of a plain, named, non-rest parameter with no default of, or
 * `undefined` when it is anything else. A default (`value: unknown = x`) or a
 * destructured name (`{ a }: unknown`) is refused, as ESLint's selectors refuse
 * it: there the parameter is no longer a bare identifier.
 */
function plainParameterOwner(node: ts.Node): ts.FunctionDeclaration | undefined {
  const parameter = node.parent;
  if (!ts.isParameter(parameter) || parameter.type !== node) return undefined;
  if (parameter.dotDotDotToken !== undefined) return undefined;
  if (parameter.initializer !== undefined || !ts.isIdentifier(parameter.name)) return undefined;
  return ts.isFunctionDeclaration(parameter.parent) ? parameter.parent : undefined;
}

/**
 * Whether `node` is the type of a plain parameter (see
 * {@link plainParameterOwner}) of a function declaration named `parse[A-Z]…`.
 * That is the place a parser module may use it: the value a parser is handed is
 * not yet known to be anything, and saying so is the point of the parser.
 */
function isParserParameterType(node: ts.Node): boolean {
  const owner = plainParameterOwner(node);
  return owner?.name !== undefined && /^parse[A-Z]/.test(owner.name.text);
}

/**
 * Whether `node` is the type of a plain parameter (see
 * {@link plainParameterOwner}) of a function declaration whose return type is a
 * type predicate (`value is X`, `asserts value is X`). A guard exists to find
 * out what its argument is, so its parameter is the other place a value is
 * honestly not yet known to be anything; typing it narrower pushes a cast onto
 * every caller. Allowed in any module, as ESLint's selector allows it.
 */
function isTypeGuardParameterType(node: ts.Node): boolean {
  const owner = plainParameterOwner(node);
  return owner?.type !== undefined && ts.isTypePredicateNode(owner.type);
}

/**
 * Return the 1-based line numbers where the `any` or `unknown` type keyword
 * appears in `source`. Identifiers that merely contain the text are not
 * matched. An `unknown` that is the declared type of a plain parameter of a
 * type-predicate function declaration (see {@link isTypeGuardParameterType})
 * is allowed anywhere, and with `parserModule` so is one of a `parse*`
 * function declaration (see {@link isParserParameterType}); `any` never is.
 */
export function findForbiddenTypes(source: string, options: ForbiddenTypeOptions = {}): number[] {
  const sourceFile = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const offenders: number[] = [];
  const visit = (node: ts.Node): void => {
    const forbidden =
      node.kind === ts.SyntaxKind.AnyKeyword ||
      (node.kind === ts.SyntaxKind.UnknownKeyword &&
        !isTypeGuardParameterType(node) &&
        !(options.parserModule === true && isParserParameterType(node)));
    if (forbidden) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      offenders.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offenders;
}
