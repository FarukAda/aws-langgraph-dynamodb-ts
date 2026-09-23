import type { MatchCondition } from '@langchain/langgraph-checkpoint';

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
