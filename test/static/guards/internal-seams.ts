import * as ts from 'typescript';

/** Option properties that are test seams: they must carry `@internal` so `stripInternal` drops them. */
export const INTERNAL_SEAMS: readonly string[] = ['createClient', 'createS3Client'];

/** 1-based lines where a seam property is declared without an `@internal` JSDoc tag. */
export function findUnmarkedSeams(source: string): number[] {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const offenders: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertySignature(node) &&
      ts.isIdentifier(node.name) &&
      INTERNAL_SEAMS.includes(node.name.text) &&
      !ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'internal')
    ) {
      offenders.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
}
