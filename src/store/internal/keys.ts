/** Separator joining namespace elements (and the trailing key) in the sort key. */
export const NAMESPACE_SEPARATOR = '#';

/**
 * Adapter tag prefixed to every store partition key — see the equivalent in
 * checkpointer/internal/keys.ts for why the three adapters' partitions must
 * not overlap on a shared table.
 */
const ADAPTER_PARTITION_PREFIX = `STORE${NAMESPACE_SEPARATOR}`;

/**
 * Partition key for an item: the adapter tag plus the scope-root element.
 *
 * Accepts: `namespace` — normally a validated one, whose first element is the
 * scope root every item under it shares.
 *
 * Returns: the partition key. The function is deliberately **total**: it maps
 * any array to a string rather than refusing a malformed one, because
 * `narrowStoreRecord` calls it on rows read from a shared table to test whether
 * a row's own attributes agree with the key it was found at. A corrupt or
 * foreign row must be skipped there, not turned into a failed search.
 *
 * Throws: nothing.
 */
export function partitionKey(namespace: string[]): string {
  return `${ADAPTER_PARTITION_PREFIX}${namespace[0]}`;
}

/**
 * Sort key: the rest of the namespace plus the key, separator-joined.
 *
 * Accepts: `namespace` and `key` — normally validated, so no element can itself
 * contain the separator and the join is unambiguous. A one-element namespace
 * lives entirely in the partition key, so the sort key is just `key`.
 *
 * Returns: the sort key. Total, for the same reason as {@link partitionKey}.
 *
 * Throws: nothing.
 */
export function sortKey(namespace: string[], key: string): string {
  return [...namespace.slice(1), key].join(NAMESPACE_SEPARATOR);
}

/**
 * `begins_with` prefix selecting a scoped subtree within `prefix[0]`'s
 * partition.
 *
 * Accepts: `prefix` — its first element selects the partition and is not part
 * of the sort key, so a one-element prefix has no rest to match on.
 *
 * Returns: the prefix, separator-terminated so `['users','u1']` does not also
 * match a sibling like `u10`; `''` when there is no rest, which matches the
 * whole partition.
 *
 * Throws: nothing.
 */
export function sortKeyPrefix(prefix: string[]): string {
  const rest = prefix.slice(1);
  return rest.length === 0 ? '' : `${rest.join(NAMESPACE_SEPARATOR)}${NAMESPACE_SEPARATOR}`;
}

/**
 * Whether `namespace` starts with `prefix`, element by element.
 *
 * Accepts: any two namespaces; an empty prefix matches everything, and a prefix
 * longer than the namespace matches nothing.
 *
 * Returns: whether every prefix element equals the namespace element at the
 * same position — not a string comparison, so `['userspace']` does not match the
 * prefix `['users']`.
 *
 * Throws: nothing.
 */
export function namespaceMatchesPrefix(namespace: string[], prefix: string[]): boolean {
  if (prefix.length > namespace.length) return false;
  return prefix.every((element, index) => namespace[index] === element);
}
