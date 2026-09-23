import type { MatchCondition } from '@langchain/langgraph-checkpoint';

import { validationError } from '../../shared/errors/errors';

const WILDCARD = '*';

function segmentMatches(actual: string[], path: string[]): boolean {
  return path.every((element, index) => element === WILDCARD || element === actual[index]);
}

/**
 * Refuse a match type the contract does not define.
 *
 * Accepts: `matchType` — `'prefix'` or `'suffix'`, the only two the contract
 * defines (`@langchain/langgraph-checkpoint@1.1.5` `dist/store/base.d.ts:211`).
 * Anything else is refused rather than resolved: an unrecognised type took the
 * suffix branch and answered as if the caller had asked for a suffix match.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming `matchConditions`. A string is echoed in the
 * message and anything else is described by its type, since `JSON.stringify`
 * itself throws on a bigint.
 */
export function assertMatchType(matchType: MatchCondition['matchType']): void {
  if (matchType === 'prefix' || matchType === 'suffix') return;
  const received = typeof matchType === 'string' ? JSON.stringify(matchType) : typeof matchType;
  throw validationError(
    `matchType must be "prefix" or "suffix" (received ${received})`,
    'matchConditions',
  );
}

/**
 * Whether `namespace` satisfies one match condition.
 *
 * Accepts: `condition.matchType` — as {@link assertMatchType}.
 * `condition.path` — elements, where `'*'` matches any one element; longer than
 * the namespace never matches, and empty matches every namespace.
 *
 * Returns: whether the condition holds.
 *
 * Throws: `VALIDATION` naming `matchConditions` for an unknown `matchType`.
 */
export function matchNamespace(namespace: string[], condition: MatchCondition): boolean {
  const { matchType, path } = condition;
  assertMatchType(matchType);
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
 * validated positive integer (see `validateMaxDepth` for what a negative or
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
