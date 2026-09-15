import * as ts from 'typescript';

/**
 * The reads allowed to issue a table `Scan`, as source paths relative to `src`,
 * with the reason each is not expressible as a key condition.
 *
 * Two cross-partition listings scan only when the table carries no recency
 * index; two store reads enumerate every row because that is what they are
 * asked for, and no key structure turns "every namespace" into a key condition
 * (DESIGN D-1). A read that starts scanning outside this set has an access
 * pattern a key could have served, which is the thing D-1 forbids.
 */
export const ALLOWED_SCAN_SITES: Readonly<Record<string, string>> = {
  'checkpointer/internal/list-rows.ts': 'saver.list() across threads, without a recency index',
  'history/actions/list-sessions.ts': 'history.listSessions(), without a recency index',
  'store/actions/list-namespaces.ts': 'listNamespaces() with no concrete prefix root',
  'store/internal/candidates.ts': 'store.search([]) over every namespace',
};

/** A source file that calls `paginateScan`, by its path relative to `src`. */
export interface ScanSite {
  path: string;
  line: number;
}

/** The name a read calls to page a table `Scan`; the only way this package scans. */
const SCAN_CALL = 'paginateScan';

/**
 * The lines of `source` that call {@link SCAN_CALL}. Matched as a call
 * expression rather than as text, so an import, a mention in a comment or an
 * identifier that merely contains the name is not counted.
 */
export function findScanCalls(source: string): number[] {
  const sourceFile = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === SCAN_CALL) {
      lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

/** Every scanning site in `files`, in the order the files were given. */
export function findScanSites(files: readonly { path: string; text: string }[]): ScanSite[] {
  return files.flatMap(({ path, text }) =>
    findScanCalls(text).map((line): ScanSite => ({ path, line })),
  );
}
