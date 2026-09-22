import type {
  BaseStore,
  ListNamespacesOperation,
  MatchCondition,
} from '@langchain/langgraph-checkpoint';

import { ValidationError } from '../../shared/errors/errors';
import { STORE_LIST_NAMESPACES_KEYS } from '../../shared/validation/method-keys';
import { assertShape } from '../../shared/validation/option-shape';
import type { ListNamespacesOptions } from '../types';
import { validateStoreKey } from './validation';

/**
 * The root label upstream `BaseStore.put` refuses
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/store/base.js:23`).
 */
const RESERVED_ROOT = 'langgraph';

/**
 * Upstream `BaseStore.put`'s two namespace rules beyond this backend's own
 * (`dist/store/base.js:16-24`): no `.` in a label, and no `"langgraph"` root.
 * They belong to that one method only. The reference `InMemoryStore.batch`
 * checks neither, and LangGraph's runtime reaches a store only through
 * `batch()`, so a namespace such as `['memories', 'jane.doe@example.com']`
 * written there must stay readable, searchable and deletable here.
 */
function assertUpstreamPutNamespace(namespace: string[]): void {
  if (namespace.some((label) => label.includes('.'))) {
    throw new ValidationError(
      'namespace element must not contain "."; put() refuses it, as upstream BaseStore.put does',
      'namespace element',
    );
  }
  if (namespace[0] === RESERVED_ROOT) {
    throw new ValidationError(
      `namespace must not start with "${RESERVED_ROOT}", the root label LangGraph reserves`,
      'namespace',
    );
  }
}

/**
 * Validate what `DynamoDBStore.put` refuses beyond the operation it builds.
 *
 * Every rule about the operation itself, such as the value's shape or the
 * index, runs where `batch()` reaches it too. What is left here is about the
 * method: upstream's `put` refuses a `.` in a label and a `"langgraph"` root,
 * which no other route does; and `put` is typed to take an object, while a put
 * operation carrying `null` *is* a delete, so `put(ns, key, null)` would
 * silently remove the item.
 *
 * Accepts: `namespace` and `key` — the item address this backend can store,
 * checked first; the action checks it again. Then `namespace` — no label
 * holding `.`, and a root other than `"langgraph"`. `value` — anything but
 * `null`.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `namespace`, `namespace element`, `key`,
 * `sortKey` or `value`.
 */
export function assertPutArguments(
  namespace: string[],
  key: string,
  value: Parameters<BaseStore['put']>[2],
): void {
  validateStoreKey(namespace, key);
  assertUpstreamPutNamespace(namespace);
  if (value === null) {
    throw new ValidationError('value must be an object; delete() removes an item', 'value');
  }
}

/**
 * Build the operation `listNamespaces` runs, as upstream `BaseStore` builds it
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/store/base.js:178-195`).
 *
 * Accepts: `options` — an object reading only `prefix`, `suffix`, `maxDepth`,
 * `limit` and `offset`. `prefix` and `suffix` become match conditions whenever
 * they are given at all, so a `null` or an empty string reaches the listing
 * action and is refused there, where upstream's truthiness test would drop it.
 * For every value that action accepts, the operation is upstream's.
 * `maxDepth`, `limit` and `offset` are passed on as given, with upstream's
 * defaults of 100 and 0. The action validates all of them, and the paths.
 *
 * Returns: the operation, with `matchConditions` absent when neither path is
 * given.
 *
 * Throws: ValidationError naming `options` or `options.<key>`.
 */
export function listNamespacesOperation(options: ListNamespacesOptions): ListNamespacesOperation {
  assertShape(options, STORE_LIST_NAMESPACES_KEYS, 'options');
  const { prefix, suffix, maxDepth, limit = 100, offset = 0 } = options;
  const matchConditions: MatchCondition[] = [];
  if (prefix !== undefined) matchConditions.push({ matchType: 'prefix', path: prefix });
  if (suffix !== undefined) matchConditions.push({ matchType: 'suffix', path: suffix });
  return {
    matchConditions: matchConditions.length ? matchConditions : undefined,
    maxDepth,
    limit,
    offset,
  };
}
