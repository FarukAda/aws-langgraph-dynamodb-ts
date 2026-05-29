/** A JSON-comparable value used in metadata filters. */
export type FilterValue =
  | string
  | number
  | boolean
  | null
  | FilterValue[]
  | { [key: string]: FilterValue };

/**
 * True when every key in `filter` is present in `metadata` with a deeply equal
 * value. An empty filter matches everything.
 */
export function matchesFilter(
  metadata: Record<string, FilterValue>,
  filter: Record<string, FilterValue>,
): boolean {
  return Object.entries(filter).every(
    ([key, value]) => JSON.stringify(metadata[key]) === JSON.stringify(value),
  );
}
