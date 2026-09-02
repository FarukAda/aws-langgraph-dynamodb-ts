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
 * List distinct namespaces (truncated to `maxDepth`) that satisfy every match
 * condition, sorted, with offset/limit applied. A concrete prefix root scopes
 * the read to a native Query; otherwise it falls back to a filtered Scan.
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
  namespaces.sort((a, b) => a.join(NAMESPACE_SEPARATOR).localeCompare(b.join(NAMESPACE_SEPARATOR)));
  return namespaces.slice(op.offset, op.offset + op.limit);
}
