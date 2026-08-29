import type { Item, SearchOperation } from '@langchain/langgraph-checkpoint';

import { type JsonValue, matchesStoreFilter } from './filter';

/** True when `item` satisfies the search operation's optional metadata filter. */
export function passesFilter(item: Item, op: SearchOperation): boolean {
  if (!op.filter) return true;
  return matchesStoreFilter(
    item.value as Record<string, JsonValue>,
    op.filter as Record<string, JsonValue>,
  );
}
