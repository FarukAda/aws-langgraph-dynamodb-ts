import type { ListNamespacesOperation } from '@langchain/langgraph-checkpoint';

import { paginateQuery } from '../../shared/dynamodb/paginate';
import { paginateScan } from '../../shared/dynamodb/scan';
import { NAMESPACE_SEPARATOR } from '../internal/keys';
import { matchNamespace, prefixRoot, truncateDepth } from '../internal/namespace-match';
import { scopedQuery, storeScan } from '../internal/query';
import type { StoreContext } from '../internal/setup';

interface NamespaceRecord {
  namespace: string[];
}

function namespaceSource(context: StoreContext, op: ListNamespacesOperation) {
  const root = prefixRoot(op.matchConditions);
  if (root.length > 0) {
    return paginateQuery({ client: context.client, params: scopedQuery(context.tableName, root) });
  }
  return paginateScan({ client: context.client, params: storeScan(context.tableName) });
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
  const seen = new Set<string>();
  const namespaces: string[][] = [];
  for await (const raw of namespaceSource(context, op)) {
    const namespace = (raw as NamespaceRecord).namespace;
    if (!namespace) continue;
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
