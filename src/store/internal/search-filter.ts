import type { Item, SearchOperation } from '@langchain/langgraph-checkpoint';

import { type JsonValue, matchesStoreFilter } from './filter';

/**
 * Whether `item` satisfies the search operation's optional metadata filter.
 *
 * Accepts: `op.filter` — absent or `{}` constrains nothing and every item
 * passes. `item.value` — whatever the item's writer stored; a value that is not
 * an object satisfies no condition (see `matchesStoreFilter`).
 *
 * Returns: whether the item belongs in the result.
 *
 * Throws: nothing, so one unusual row cannot fail a search over many.
 */
export function passesFilter(item: Item, op: SearchOperation): boolean {
  if (!op.filter) return true;
  return matchesStoreFilter(
    item.value as Record<string, JsonValue>,
    op.filter as Record<string, JsonValue>,
  );
}
