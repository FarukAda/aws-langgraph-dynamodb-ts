import type { MatchCondition } from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock';
import { paginateQuery, paginateScan } from '../../shared/dynamodb/paginate';
import { isExpiredRow, KEY_SEPARATOR, withoutExpired } from '../../shared/dynamodb/table-schema';
import type { ParsedList } from '../internal/parse';
import { parseStoreRow, projectKeys, scopedQuery, storeScan } from '../internal/rows';
import type { StoreContext } from '../internal/setup';

const WILDCARD = '*';

function segmentMatches(actual: string[], path: string[]): boolean {
  return path.every((element, index) => element === WILDCARD || element === actual[index]);
}

/**
 * Whether `namespace` satisfies one match condition. `condition.matchType` is
 * `'prefix'` or `'suffix'`, already refused otherwise by the parser that built
 * `condition` (`parseMatchCondition` in `parse.ts`).
 *
 * Accepts: `condition.path` — elements, where `'*'` matches any one element;
 * longer than the namespace never matches, and empty matches every namespace.
 *
 * Returns: whether the condition holds.
 *
 * Throws: nothing.
 */
export function matchNamespace(namespace: string[], condition: MatchCondition): boolean {
  const { matchType, path } = condition;
  if (path.length > namespace.length) return false;
  const slice =
    matchType === 'prefix'
      ? namespace.slice(0, path.length)
      : namespace.slice(namespace.length - path.length);
  return segmentMatches(slice, path);
}

/**
 * Cap a namespace to at most `maxDepth` elements.
 *
 * Accepts: `maxDepth` — absent returns the namespace unchanged; otherwise a
 * parsed positive integer (see `parseListOperation` for what a negative or
 * zero value did here).
 *
 * Returns: the namespace, truncated from the end; shorter than `maxDepth` is
 * returned whole.
 *
 * Throws: nothing.
 */
export function truncateDepth(namespace: string[], maxDepth?: number): string[] {
  return maxDepth === undefined ? namespace : namespace.slice(0, maxDepth);
}

/**
 * Leading concrete (non-wildcard) elements of the first prefix condition.
 *
 * Accepts: `conditions` — absent, empty, suffix-only, or a prefix condition
 * starting with `'*'` all yield nothing to scope by.
 *
 * Returns: the concrete leading elements, which name a partition and a sort-key
 * prefix the listing can be read from. An empty result means the listing cannot
 * be scoped to one partition and falls back to a Scan.
 *
 * Throws: nothing.
 *
 * Guarantees: the root is only ever a *superset* of what the conditions select
 * — every condition is still applied to each namespace read — so scoping can
 * never drop a namespace that belongs in the answer.
 */
export function prefixRoot(conditions?: MatchCondition[]): string[] {
  const prefixCondition = conditions?.find((condition) => condition.matchType === 'prefix');
  if (!prefixCondition) return [];
  const root: string[] = [];
  for (const element of prefixCondition.path) {
    if (element === WILDCARD) break;
    root.push(element);
  }
  return root;
}

function namespaceSource(context: StoreContext, op: ParsedList, now: number) {
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
 * The collation namespaces are sorted by, pinned to one locale.
 *
 * `InMemoryStore` sorts with bare `localeCompare`
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/store/memory.js:119`), which
 * means "in the host's default locale" — and locales disagree: `'ä'` sorts
 * before `'z'` in German and after it in Swedish. A listing paged by `offset`
 * is a position a caller holds between two calls, so an order that changes
 * with the host answering the call cuts the same listing in two places and the
 * caller misses one namespace and sees another twice. Matching the reference
 * there is not possible anyway, because the reference's own order varies with
 * its host; what is possible is matching it on every host that agrees with
 * this locale, and being deterministic on the rest.
 *
 * `en` is the locale to pin because ICU applies no tailoring to it — its order
 * is the untailored root order — and because it is the one locale a Node built
 * with small ICU still carries, so this cannot degrade to a different order on
 * a minimal runtime.
 */
const NAMESPACE_COLLATOR = new Intl.Collator('en');

/**
 * Order two namespaces by the reference store's collation, pinned, with its
 * ties settled.
 *
 * The collation is {@link NAMESPACE_COLLATOR} on the joined namespace — the
 * comparison `InMemoryStore` makes, held to one locale. Collation calls some
 * *distinct* strings equal — `'café'` written precomposed and decomposed is
 * one such pair — and the reference then leaves their order to insertion
 * order. Here that would be the order DynamoDB happened to return the rows in,
 * so the same listing could place a page boundary between them differently on
 * two calls and a page could skip one namespace while repeating another. The
 * tie-break settles exactly those pairs and never reorders a pair the
 * collation itself orders.
 */
function compareNamespaces(a: string[], b: string[]): number {
  const left = a.join(KEY_SEPARATOR);
  const right = b.join(KEY_SEPARATOR);
  const collated = NAMESPACE_COLLATOR.compare(left, right);
  // `Number(left > right)` keeps the comparator total: 0 for a pair that really is equal.
  return collated !== 0 ? collated : left < right ? -1 : Number(left > right);
}

/**
 * The distinct namespaces satisfying every match condition.
 *
 * Accepts: `op` — parsed; every match condition must hold, absent or empty
 * matches every namespace. A concrete prefix root scopes the read to one
 * partition's Query, and anything else — a suffix condition, a leading `*`, no
 * conditions — spans the table and is one of the four reads allowed to Scan
 * (`test/static/guards/scan-sites.ts`).
 * `op.maxDepth` — namespaces are truncated to it and then
 * deduplicated, so `['a','b']` and `['a','c']` list once as `['a']`.
 * `op.offset` and `op.limit` — a `limit` of 0 returns an empty listing without reading.
 *
 * Returns: the namespaces, sorted, then `limit` of them from `offset`.
 *
 * Throws: `RESULT_TRUNCATED` when `maxScanItems` is reached while rows
 * remain, so a partial listing is never returned as a complete one;
 * `FORMAT_UNSUPPORTED` for a store item a newer release wrote.
 *
 * Guarantees: every live row is read — the answer is about which namespaces
 * exist, and paging over it must not depend on which rows were read first. That
 * is also why the sort is total (see {@link compareNamespaces}), and why a
 * `limit` of 0 is answered ahead of the read rather than by slicing one.
 */
export async function listNamespaces(context: StoreContext, op: ParsedList): Promise<string[][]> {
  // A zero page is answered before the read. This listing is the one that can
  // never stop early — every live row must be seen before the namespaces can
  // be sorted and sliced — so scanning the whole table to slice nothing out of
  // it is the entire cost for none of the answer.
  if (op.limit === 0) return [];
  const now = nowSeconds();
  const seen = new Set<string>();
  const namespaces: string[][] = [];
  for await (const raw of namespaceSource(context, op, now)) {
    const record = parseStoreRow(raw);
    if (!record || isExpiredRow(record, now)) continue;
    const namespace = record.namespace;
    if (
      op.matchConditions &&
      !op.matchConditions.every((condition) => matchNamespace(namespace, condition))
    ) {
      continue;
    }
    const truncated = truncateDepth(namespace, op.maxDepth);
    const dedupeKey = truncated.join(KEY_SEPARATOR);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    namespaces.push(truncated);
  }
  namespaces.sort(compareNamespaces);
  return namespaces.slice(op.offset, op.offset + op.limit);
}
