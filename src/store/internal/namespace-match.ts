import type { MatchCondition } from '@langchain/langgraph-checkpoint';

const WILDCARD = '*';

function segmentMatches(actual: string[], path: (string | '*')[]): boolean {
  return path.every((element, index) => element === WILDCARD || element === actual[index]);
}

/** True when `namespace` satisfies a prefix/suffix match condition (with `*`). */
export function matchNamespace(namespace: string[], condition: MatchCondition): boolean {
  const { matchType, path } = condition;
  if (path.length > namespace.length) return false;
  const slice =
    matchType === 'prefix'
      ? namespace.slice(0, path.length)
      : namespace.slice(namespace.length - path.length);
  return segmentMatches(slice, path);
}

/** Cap a namespace to at most `maxDepth` elements (no-op when undefined). */
export function truncateDepth(namespace: string[], maxDepth?: number): string[] {
  return maxDepth === undefined ? namespace : namespace.slice(0, maxDepth);
}
