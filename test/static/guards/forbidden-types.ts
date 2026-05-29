import * as ts from 'typescript';

/**
 * Return the 1-based line numbers where the `any` or `unknown` type keyword
 * appears in `source`. Identifiers that merely contain the text are not matched.
 */
export function findForbiddenTypes(source: string): number[] {
  const sourceFile = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const offenders: number[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      offenders.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offenders;
}
