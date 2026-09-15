import * as ts from 'typescript';

/**
 * The reads allowed to issue a table `Scan`, as source paths relative to `src`,
 * with the reason each is not expressible as a key condition.
 *
 * **The rule.** No read this package ships may `Scan` where a key condition
 * could have served it. AWS states the cost directly: a `Scan` "always scans the
 * entire table or secondary index, then filters out values", and secondary
 * indexes exist for the access patterns a table's own key cannot serve
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-query-scan.html).
 * A library cannot decide on a caller's behalf that their access pattern is rare
 * enough for a scan, so the decision is made once, here, and enforced.
 *
 * That is not the same as "no `Scan` anywhere". Three cases, decided apart:
 *
 * - A read that names a partition — every `getTuple`, every `getMessages`, a
 *   `search` under a prefix — is a Query and never appears below.
 * - A read that crosses partitions — `saver.list()` without a `thread_id`,
 *   `history.listSessions()` — is an index query when the table carries the
 *   recency index, and a `Scan` when `indexName` is unset. The index is opt-in
 *   because whether the table has it is the operator's deployment fact, not
 *   something to probe for; the scan is the documented behaviour of an
 *   unindexed table, not a fallback during a backfill.
 * - A read that enumerates everything by construction — `store.search([])`,
 *   `listNamespaces()` with no concrete prefix root — reads every store row
 *   because that is what it was asked for. No key structure turns "every
 *   namespace" into a key condition, and the index would read the same rows.
 *   Both are bounded by `maxScanItems` and raise `RESULT_TRUNCATED` rather than
 *   truncating silently.
 *
 * A read that starts scanning outside this set therefore has an access pattern a
 * key could have served, which is exactly what the rule forbids.
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
