import * as ts from 'typescript';

/**
 * Return the 1-based line numbers of every comment in `source` that is not a
 * JSDoc block comment. Line comments and plain block comments are disallowed by
 * the JSDoc-only rule.
 */
export function findDisallowedComments(source: string): number[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  const offenders: number[] = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const text = scanner.getTokenText();
      const isJsDoc = token === ts.SyntaxKind.MultiLineCommentTrivia && text.startsWith('/**');
      if (!isJsDoc) {
        const pos = scanner.getTokenStart();
        offenders.push(source.slice(0, pos).split('\n').length);
      }
    }
    token = scanner.scan();
  }
  return offenders;
}
