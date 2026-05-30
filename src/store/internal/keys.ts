/** Separator joining namespace elements (and the trailing key) in the sort key. */
export const NAMESPACE_SEPARATOR = '#';

/** Partition key for an item: the scope-root namespace element. */
export function partitionKey(namespace: string[]): string {
  return namespace[0];
}

/** Sort key: the rest of the namespace plus the key, separator-joined. */
export function sortKey(namespace: string[], key: string): string {
  return [...namespace.slice(1), key].join(NAMESPACE_SEPARATOR);
}

/**
 * `begins_with` prefix selecting a scoped subtree within `prefix[0]`'s
 * partition. Terminated with the separator so `['users','u1']` does not match a
 * sibling like `u10`. An empty rest yields '' (matches the whole partition).
 */
export function sortKeyPrefix(prefix: string[]): string {
  const rest = prefix.slice(1);
  return rest.length === 0 ? '' : `${rest.join(NAMESPACE_SEPARATOR)}${NAMESPACE_SEPARATOR}`;
}

/**
 * True when `namespace` starts with `prefix`, compared element-by-element (not
 * as a string prefix, so ["userspace"] does not match prefix ["users"]).
 */
export function namespaceMatchesPrefix(namespace: string[], prefix: string[]): boolean {
  if (prefix.length > namespace.length) return false;
  return prefix.every((element, index) => namespace[index] === element);
}
