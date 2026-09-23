import * as ts from 'typescript';

/** Whether `node` carries the `export` modifier. */
function isExported(node: ts.FunctionDeclaration): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Every function declaration in `source` that breaks the naming convention:
 * no function is named `validate*`; an exported `parse*` declares a return type
 * that is not `void`; an exported `assert*` declares `void`, `Promise<void>` or
 * an `asserts` predicate. Private helpers of other names are not constrained.
 */
export function namingViolations(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      const name = node.name.text;
      const at = `${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}: ${name}`;
      const returns = node.type?.getText(sourceFile);
      const returnsNothing = returns === 'void' || returns === 'Promise<void>';
      if (/^validate[A-Z]/.test(name)) {
        violations.push(
          `${at} — validate* is retired: a parse* returns the checked value, an assert* returns nothing`,
        );
      } else if (
        isExported(node) &&
        /^parse[A-Z]/.test(name) &&
        (returns === undefined || returnsNothing)
      ) {
        violations.push(
          `${at} — a parse* function returns the value it checked, as a more precise type`,
        );
      } else if (
        isExported(node) &&
        /^assert[A-Z]/.test(name) &&
        !(returnsNothing || returns?.startsWith('asserts ') === true)
      ) {
        violations.push(
          `${at} — an assert* function returns nothing; one that returns the value is a parse*`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}
