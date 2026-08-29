import { isDeepStrictEqual } from 'node:util';

/** A JSON value stored in an item or supplied in a filter. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Three-way order for a like-typed pair, or `undefined` when the pair is
 * *unordered*. `NaN` compares `false` against everything including itself, so a
 * bare `===`/`>` ternary silently reports it as "less than" — which let a
 * stored `NaN` satisfy `$lt`/`$lte` against any number, contradicting
 * {@link compareOrdered}'s own contract.
 */
function orderOf<T extends number | string>(actual: T, expected: T): number | undefined {
  if (actual < expected) return -1;
  if (actual > expected) return 1;
  return actual === expected ? 0 : undefined;
}

/** Apply `test` to a resolved order; an unordered pair never matches. */
function testOrder(order: number | undefined, test: (order: number) => boolean): boolean {
  return order !== undefined && test(order);
}

/**
 * Ordered comparison over like-typed values only: numbers compare numerically,
 * strings lexicographically, and a mismatched or unordered pair never matches.
 *
 * Deliberately stricter than both what this used to do and what upstream does.
 * Native `>` coerces, so a stored `'10'` satisfied `{ $gt: 5 }` — inclusion
 * decided by JS coercion rather than by the stored type. Upstream instead
 * reduces both sides with `Number()`, which makes two ISO-8601 date strings
 * `NaN` and every comparison between them false. Comparing like types
 * directly is well-defined in both cases.
 */
function compareOrdered(
  actual: ActualValue,
  expected: JsonValue,
  test: (order: number) => boolean,
): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return testOrder(orderOf(actual, expected), test);
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    return testOrder(orderOf(actual, expected), test);
  }
  return false;
}

/** A stored field's value, or `undefined` when the item has no such own property. */
type ActualValue = JsonValue | undefined;

const COMPARATORS: Record<string, (actual: ActualValue, expected: JsonValue) => boolean> = {
  $eq: (actual, expected) => isDeepStrictEqual(actual, expected),
  $ne: (actual, expected) => !isDeepStrictEqual(actual, expected),
  $gt: (actual, expected) => compareOrdered(actual, expected, (order) => order > 0),
  $gte: (actual, expected) => compareOrdered(actual, expected, (order) => order >= 0),
  $lt: (actual, expected) => compareOrdered(actual, expected, (order) => order < 0),
  $lte: (actual, expected) => compareOrdered(actual, expected, (order) => order <= 0),
  $in: (actual, expected) =>
    Array.isArray(expected)
      ? expected.some((candidate) => isDeepStrictEqual(actual, candidate))
      : false,
  $nin: (actual, expected) =>
    Array.isArray(expected)
      ? !expected.some((candidate) => isDeepStrictEqual(actual, candidate))
      : true,
};

/**
 * True only when every key is one of the exact known operator names — matches
 * the official `@langchain/langgraph-checkpoint` InMemoryStore's own detection
 * exactly, so a stored value that merely has `$`-prefixed keys (e.g. a JSON
 * Schema document) is compared as a literal value instead of misread as a
 * filter operator.
 */
function isOperatorObject(condition: JsonValue): condition is { [key: string]: JsonValue } {
  return (
    typeof condition === 'object' &&
    condition !== null &&
    !Array.isArray(condition) &&
    Object.keys(condition).length > 0 &&
    Object.keys(condition).every((key) => Object.prototype.hasOwnProperty.call(COMPARATORS, key))
  );
}

function matchesCondition(actual: ActualValue, condition: JsonValue): boolean {
  if (!isOperatorObject(condition)) return isDeepStrictEqual(actual, condition);
  return Object.entries(condition).every(([operator, expected]) =>
    COMPARATORS[operator](actual, expected),
  );
}

/**
 * True when `value` satisfies every field condition in `filter`. A plain value
 * is exact-match ($eq); an operator object ({ $gt: 4 }) applies comparisons.
 */
export function matchesStoreFilter(
  value: Record<string, JsonValue>,
  filter: Record<string, JsonValue>,
): boolean {
  return Object.entries(filter).every(([field, condition]) =>
    /** Own properties only: `value['toString']` would otherwise resolve up the
     *  prototype chain and be compared as if it were stored data. */
    matchesCondition(Object.hasOwn(value, field) ? value[field] : undefined, condition),
  );
}
