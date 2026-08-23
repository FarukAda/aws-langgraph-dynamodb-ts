import { isDeepStrictEqual } from 'node:util';

/** A JSON-comparable value used in metadata filters. */
export type FilterValue =
  string | number | boolean | null | FilterValue[] | { [key: string]: FilterValue };

/**
 * True when every key in `filter` is present in `metadata` with a deeply equal
 * value. Equality is structural and key-order-independent for nested objects,
 * order-significant for arrays, and type-strict (no `3` vs `'3'` coercion). An
 * empty filter matches everything.
 */
export function matchesFilter(
  metadata: Record<string, FilterValue>,
  filter: Record<string, FilterValue>,
): boolean {
  return Object.entries(filter).every(([key, value]) => isDeepStrictEqual(metadata[key], value));
}
