import * as ts from 'typescript';

/** Where the guard is looking: a parser module relaxes one rule for `unknown`. */
export interface ForbiddenTypeOptions {
  /** True for a module in `PARSER_MODULES`. */
  parserModule?: boolean;
}

/**
 * Whether `node` — an `unknown` keyword — is the whole declared type of a
 * non-rest parameter of a function declaration named `parse[A-Z]…`. That is the
 * one place a parser module may use it: the value a parser is handed is not
 * yet known to be anything, and saying so is the point of the parser.
 */
function isParserParameterType(node: ts.Node): boolean {
  const parameter = node.parent;
  if (!ts.isParameter(parameter) || parameter.type !== node) return false;
  if (parameter.dotDotDotToken !== undefined) return false;
  const owner = parameter.parent;
  return (
    ts.isFunctionDeclaration(owner) &&
    owner.name !== undefined &&
    /^parse[A-Z]/.test(owner.name.text)
  );
}

/**
 * Return the 1-based line numbers where the `any` or `unknown` type keyword
 * appears in `source`. Identifiers that merely contain the text are not
 * matched. With `parserModule`, an `unknown` that is the declared type of a
 * parameter of a `parse*` function declaration is allowed; `any` never is.
 */
export function findForbiddenTypes(source: string, options: ForbiddenTypeOptions = {}): number[] {
  const sourceFile = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const offenders: number[] = [];
  const visit = (node: ts.Node): void => {
    const forbidden =
      node.kind === ts.SyntaxKind.AnyKeyword ||
      (node.kind === ts.SyntaxKind.UnknownKeyword &&
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
