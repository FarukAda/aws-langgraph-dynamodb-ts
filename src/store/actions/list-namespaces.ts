import type { ListNamespacesOperation } from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock';
import { isExpiredRow, withoutExpired } from '../../shared/dynamodb/expiry';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { paginateScan } from '../../shared/dynamodb/scan';
import { narrowStoreRecord } from '../internal/item-mapper';
import { NAMESPACE_SEPARATOR } from '../internal/keys';
import { matchNamespace, prefixRoot, truncateDepth } from '../internal/namespace-match';
import { projectKeys, scopedQuery, storeScan } from '../internal/query';
import type { StoreContext } from '../internal/setup';
import { validateMaxDepth, validatePaging } from '../internal/validation';

function namespaceSource(context: StoreContext, op: ListNamespacesOperation, now: number) {
  const root = prefixRoot(op.matchConditions);
  if (root.length > 0) {
    return paginateQuery({
      retry: context.retry,
      client: context.client,
      params: withoutExpired(projectKeys(scopedQuery(context.tableName, root)), now),
      maxItems: context.maxScanItems,
    });
  }
  return paginateScan({
    retry: context.retry,
    client: context.client,
    params: withoutExpired(projectKeys(storeScan(context.tableName)), now),
    maxItems: context.maxScanItems,
  });
}

/**
 * Order two namespaces as the reference store does, with its ties settled.
 *
 * The collation is `localeCompare` on the joined namespace, which is what
 * `InMemoryStore` sorts by (`@langchain/langgraph-checkpoint@1.1.5`
 * `dist/store/memory.js:119`). Collation calls some *distinct* strings equal —
 * `'café'` written precomposed and decomposed is one such pair — and the
 * reference then leaves their order to insertion order. Here that would be the
 * order DynamoDB happened to return the rows in, so the same listing could
 * place a page boundary between them differently on two calls and a page could
 * skip one namespace while repeating another. The tie-break settles exactly
 * those pairs and never reorders a pair the collation itself orders.
 */
function compareNamespaces(a: string[], b: string[]): number {
  const left = a.join(NAMESPACE_SEPARATOR);
  const right = b.join(NAMESPACE_SEPARATOR);
  const collated = left.localeCompare(right);
  /** `Number(left > right)` keeps the comparator total: 0 for a pair that really is equal. */
  return collated !== 0 ? collated : left < right ? -1 : Number(left > right);
}

/**
 * The distinct namespaces satisfying every match condition.
 *
 * Accepts: `op.matchConditions` — every one must hold; absent or empty matches
 * every namespace. A concrete prefix root scopes the read to one partition's
 * Query, and anything else — a suffix condition, a leading `*`, no conditions —
 * spans the table and is the Scan this adapter reserves for it (DESIGN D-1).
 * `op.maxDepth` — at least 1; namespaces are truncated to it and then
 * deduplicated, so `['a','b']` and `['a','c']` list once as `['a']`.
 * `op.offset` and `op.limit` — required non-negative integers, as the operation
 * type declares them.
 *
 * Returns: the namespaces, sorted, then `limit` of them from `offset`.
 *
 * Throws: ValidationError naming `offset`, `limit`, `maxDepth` or
 * `matchConditions`; {@link ResultTruncatedError} when `maxScanItems` is reached
 * while rows remain, so a partial listing is never returned as a complete one.
 *
 * Guarantees: every live row is read — the answer is about which namespaces
 * exist, and paging over it must not depend on which rows were read first. That
 * is also why the sort is total (see {@link compareNamespaces}).
 */
export async function listNamespaces(
  context: StoreContext,
  op: ListNamespacesOperation,
): Promise<string[][]> {
  validatePaging(op.offset, op.limit);
  validateMaxDepth(op.maxDepth);
  const now = nowSeconds();
  const seen = new Set<string>();
  const namespaces: string[][] = [];
  for await (const raw of namespaceSource(context, op, now)) {
    const record = narrowStoreRecord(raw);
    if (!record || isExpiredRow(record, now)) continue;
    const namespace = record.namespace;
    if (
      op.matchConditions &&
      !op.matchConditions.every((condition) => matchNamespace(namespace, condition))
    ) {
      continue;
    }
    const truncated = truncateDepth(namespace, op.maxDepth);
    const dedupeKey = truncated.join(NAMESPACE_SEPARATOR);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    namespaces.push(truncated);
  }
  namespaces.sort(compareNamespaces);
  return namespaces.slice(op.offset, op.offset + op.limit);
}
