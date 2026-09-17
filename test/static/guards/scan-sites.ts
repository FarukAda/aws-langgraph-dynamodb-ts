import * as ts from 'typescript';

/**
 * The source files allowed to issue a table `Scan`, as paths relative to `src`,
 * with the reason each may.
 *
 * **The rule.** No read this package ships may `Scan` where a key condition
 * could have served it. AWS states the cost directly: a `Scan` "always scans the
 * entire table or secondary index, then filters out values", and secondary
 * indexes exist for the access patterns a table's own key cannot serve
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-query-scan.html).
 * A library cannot decide on a caller's behalf that their access pattern is rare
 * enough for a scan, so the decision is made once, here, and enforced.
 *
 * That is not the same as "no `Scan` anywhere". Four cases, decided apart:
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
 * - A migration that visits every row by construction — `backfillRecencyIndex`
 *   gives each row written before the index its keys, and cannot know which
 *   rows those are without reading them all. It is an operator tool, not a
 *   read an adapter serves.
 *
 * The paginator the scanning reads above go through, `shared/dynamodb/scan.ts`,
 * is listed too: it is where their `Scan` requests are sent, not a read of its
 * own.
 *
 * A read that starts scanning outside this set therefore has an access pattern a
 * key could have served, which is exactly what the rule forbids.
 */
export const ALLOWED_SCAN_SITES: Readonly<Record<string, string>> = {
  'checkpointer/internal/list-rows.ts': 'saver.list() across threads, without a recency index',
  'history/actions/list-sessions.ts': 'history.listSessions(), without a recency index',
  'store/actions/list-namespaces.ts': 'listNamespaces() with no concrete prefix root',
  'store/internal/candidates.ts': 'store.search([]) over every namespace',
  'shared/dynamodb/backfill-index.ts':
    'backfillRecencyIndex(), a migration that reads every row by construction',
  'shared/dynamodb/scan.ts': 'paginateScan itself, which sends the Scan of the reads above',
};

/** A line that scans, and the source file it is in, by its path relative to `src`. */
export interface ScanSite {
  path: string;
  line: number;
}

/** The paginator a listing calls to page a table `Scan`. */
const PAGINATOR_CALL = 'paginateScan';

/** The document client's own method, which issues one `Scan` request. */
const CLIENT_SCAN_METHOD = 'scan';

/**
 * Whether `call` scans: a call of the paginator by name, or a call of a property
 * named `scan` on any object, written `object.scan(` or `object?.scan(`. The
 * object is not required to be named `client`, because a client can be held
 * under any name — `options.client`, a destructured `ddb` — and a guard keyed
 * on the name would miss the renamed one. A false match surfaces as an unlisted
 * site to decide on, which is the safe direction.
 */
function isScanCall(call: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === CLIENT_SCAN_METHOD;
  return callee.getText(sourceFile) === PAGINATOR_CALL;
}

/**
 * The lines of `source` that scan: a call of {@link PAGINATOR_CALL}, or a
 * member call such as `client.scan(` or `options.client?.scan(`. Matched as a
 * call expression rather than as text, so an import, a mention in a comment or
 * an identifier that merely contains either name is not counted.
 */
export function findScanCalls(source: string): number[] {
  const sourceFile = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isScanCall(node, sourceFile)) {
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

/** The sites in `sites` whose file {@link ALLOWED_SCAN_SITES} does not name: the ones refused. */
export function unlistedScanSites(sites: readonly ScanSite[]): ScanSite[] {
  return sites.filter((site) => !Object.hasOwn(ALLOWED_SCAN_SITES, site.path));
}
