import type { Item } from '@langchain/langgraph-checkpoint';

import { type JsonValue, matchesStoreFilter } from './filter';

/**
 * Whether `item` satisfies a search's optional metadata filter.
 *
 * Accepts: `filter` — a parsed search's filter; absent passes every item.
 * `item.value` — whatever the item's writer stored; a value that is not
 * an object satisfies no condition (see `matchesStoreFilter`).
 *
 * Returns: whether the item belongs in the result.
 *
 * Throws: nothing, so one unusual row cannot fail a search over many.
 */
export function passesFilter(item: Item, filter: Record<string, JsonValue> | undefined): boolean {
  if (!filter) return true;
  return matchesStoreFilter(item.value as Record<string, JsonValue>, filter);
}
