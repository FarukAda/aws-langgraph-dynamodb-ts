/** Separator joining namespace elements into a partition key. */
export const NAMESPACE_SEPARATOR = '#';

/** Join a hierarchical namespace into its DynamoDB partition key. */
export function namespaceToPartition(namespace: string[]): string {
  return namespace.join(NAMESPACE_SEPARATOR);
}

/**
 * True when `namespace` starts with `prefix`, compared element-by-element (not
 * as a string prefix, so ["userspace"] does not match prefix ["users"]).
 */
export function namespaceMatchesPrefix(namespace: string[], prefix: string[]): boolean {
  if (prefix.length > namespace.length) return false;
  return prefix.every((element, index) => namespace[index] === element);
}
