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
 * True when every key is one of the exact known operator names, which matches
 * the reference store's own detection (`@langchain/langgraph-checkpoint@1.1.5`
 * `dist/store/utils.js:61`): a stored value that merely has `$`-prefixed keys —
 * a JSON Schema document, say — is compared as a literal instead of misread as
 * a filter.
 *
 * An empty condition qualifies, and therefore imposes no constraint: `every`
 * over no operators is true, exactly as it is upstream, so `{ field: {} }`
 * matches every item — including one that does not hold the field at all, for
 * which there is likewise no operator to fail. Requiring at least one key
 * inverted that answer and made the same filter match nothing.
 *
 * Arrays are excluded where the reference does not. Upstream an empty array
 * reaches `Object.keys([]).every(...)` and is likewise vacuously true, so `[]`
 * as a condition matches everything there; treating a stored array as a literal
 * to compare is the answer a caller means, and the difference is recorded
 * rather than copied.
 */
function isOperatorObject(condition: JsonValue): condition is { [key: string]: JsonValue } {
  return (
    typeof condition === 'object' &&
    condition !== null &&
    !Array.isArray(condition) &&
    Object.keys(condition).every((key) => Object.prototype.hasOwnProperty.call(COMPARATORS, key))
  );
}

function matchesCondition(actual: ActualValue, condition: JsonValue): boolean {
  if (!isOperatorObject(condition)) return isDeepStrictEqual(actual, condition);
  return Object.entries(condition).every(([operator, expected]) =>
    COMPARATORS[operator](actual, expected),
  );
}

/** The value `item` holds at `field`, or undefined when it holds no such own property. */
function ownField(item: Record<string, JsonValue>, field: string): ActualValue {
  if (item === null || typeof item !== 'object') return undefined;
  return Object.hasOwn(item, field) ? item[field] : undefined;
}

/**
 * Whether `value` satisfies every field condition in `filter`.
 *
 * Accepts: `value` — a stored item's decoded value. Declared as a record, but a
 * row holds whatever its writer stored, including `null` and a scalar; such a
 * value has no own properties and so satisfies no condition. `filter` — a plain
 * value per field is exact match, an operator object (`{ $gt: 4 }`) applies
 * comparisons, and `{}` constrains nothing.
 *
 * Returns: whether every condition holds.
 *
 * Throws: nothing. `search` walks every candidate row, so one row whose value
 * is not an object must not fail the search.
 *
 * Guarantees: own properties only — `value['toString']` would otherwise resolve
 * up the prototype chain and be compared as if it were stored data.
 */
export function matchesStoreFilter(
  value: Record<string, JsonValue>,
  filter: Record<string, JsonValue>,
): boolean {
  return Object.entries(filter).every(([field, condition]) =>
    matchesCondition(ownField(value, field), condition),
  );
}
