import { isDeepStrictEqual } from 'node:util';

/** A JSON value stored in an item or supplied in a filter. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const COMPARATORS: Record<string, (actual: JsonValue, expected: JsonValue) => boolean> = {
  $eq: (actual, expected) => isDeepStrictEqual(actual, expected),
  $ne: (actual, expected) => !isDeepStrictEqual(actual, expected),
  $gt: (actual, expected) => (actual as number) > (expected as number),
  $gte: (actual, expected) => (actual as number) >= (expected as number),
  $lt: (actual, expected) => (actual as number) < (expected as number),
  $lte: (actual, expected) => (actual as number) <= (expected as number),
  $in: (actual, expected) => (Array.isArray(expected) ? expected.includes(actual) : false),
  $nin: (actual, expected) => (Array.isArray(expected) ? !expected.includes(actual) : true),
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
    Object.keys(condition).every((key) => key in COMPARATORS)
  );
}

function matchesCondition(actual: JsonValue, condition: JsonValue): boolean {
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
    matchesCondition(value[field], condition),
  );
}
