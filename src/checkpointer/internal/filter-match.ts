import { isDeepStrictEqual } from 'node:util';

/** A JSON-comparable value used in metadata filters. */
export type FilterValue =
  string | number | boolean | null | FilterValue[] | { [key: string]: FilterValue };

/** The value `metadata` holds at `key`, or undefined when it holds no such own property. */
function ownValue(metadata: Record<string, FilterValue>, key: string): FilterValue | undefined {
  if (metadata === null || typeof metadata !== 'object') return undefined;
  return Object.hasOwn(metadata, key) ? metadata[key] : undefined;
}

/**
 * Whether `metadata` satisfies every clause of `filter`.
 *
 * Accepts: `metadata` — a checkpoint's decoded metadata. Declared as a record,
 * but a row can hold anything its writer stored, including `null` and a scalar;
 * such a value has no own properties and so matches no clause.
 * `filter` — the caller's equality clauses; `{}` matches everything.
 *
 * Returns: true when every key of `filter` is an **own** property of `metadata`
 * with a deeply equal value. Equality is structural and key-order-independent
 * for nested objects, order-significant for arrays, and type-strict — `3` does
 * not match `'3'`.
 *
 * Throws: nothing. A filtered `list()` walks every row, so a single row whose
 * metadata is not an object must not fail the listing.
 *
 * Guarantees: only own properties count, so a filter on `constructor` or
 * `toString` compares against nothing rather than against the prototype's
 * function — the same rule the store's filter applies.
 */
export function matchesFilter(
  metadata: Record<string, FilterValue>,
  filter: Record<string, FilterValue>,
): boolean {
  return Object.entries(filter).every(([key, value]) =>
    isDeepStrictEqual(ownValue(metadata, key), value),
  );
}
