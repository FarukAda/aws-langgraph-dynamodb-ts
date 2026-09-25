import * as ts from 'typescript';

/**
 * Phrases that narrate what this package's code once did. A comment in `src`
 * states why the code is as it is now; the change that made it so is in
 * `CHANGELOG.md` and in the commit that made it. `no longer` is not here: it
 * as often describes the present ("an object that no longer exists").
 */
const HISTORY = /\b(?:used to|until now|previously|formerly)\b/i;

/** The 1-based lines of `source` on which a comment narrates history. Code and strings are not read. */
export function historyProse(source: string): number[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  const lines = new Set<number>();
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    const first = source.slice(0, scanner.getTokenStart()).split('\n').length;
    scanner
      .getTokenText()
      .split('\n')
      .forEach((text, offset) => {
        if (HISTORY.test(text)) lines.add(first + offset);
      });
  }
  return [...lines];
}
