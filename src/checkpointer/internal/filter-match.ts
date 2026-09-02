import { isDeepStrictEqual } from 'node:util';

/** A JSON-comparable value used in metadata filters. */
export type FilterValue =
  string | number | boolean | null | FilterValue[] | { [key: string]: FilterValue };

/**
 * True when every key in `filter` is present in `metadata` with a deeply equal
 * value. Equality is structural and key-order-independent for nested objects,
 * order-significant for arrays, and type-strict (no `3` vs `'3'` coercion). An
 * empty filter matches everything. Only own properties count: a filter on
 * `constructor` or `toString` compares against nothing, not against the
 * prototype's function, the same rule the store's filter applies.
 */
export function matchesFilter(
  metadata: Record<string, FilterValue>,
  filter: Record<string, FilterValue>,
): boolean {
  return Object.entries(filter).every(([key, value]) =>
    isDeepStrictEqual(Object.hasOwn(metadata, key) ? metadata[key] : undefined, value),
  );
}
