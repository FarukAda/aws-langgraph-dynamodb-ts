import type {
  ListNamespacesOperation,
  MatchCondition,
  Operation,
  PutOperation,
  SearchOperation,
} from '@langchain/langgraph-checkpoint';

import { validationError } from '../../shared/errors/errors';
import { assertObjectShape } from '../../shared/validation/option-shape';
import { validateStringArray } from '../../shared/validation/primitives';
import { assertMatchType } from './namespace-match';
import {
  validateMaxDepth,
  validateNamespaceLabels,
  validatePaging,
  validateStoreKey,
} from './validation';

/**
 * Validate a search's namespace prefix.
 *
 * Accepts: `namespacePrefix` — labels a namespace can hold; empty is legal and
 * spans every namespace.
 *
 * Returns: nothing; validity is the absence of a throw. A prefix no stored
 * namespace could ever match is refused rather than answered with a silent
 * empty page.
 *
 * Throws: ValidationError naming `namespacePrefix` or `namespacePrefix element`.
 */
export function assertSearchPrefix(namespacePrefix: string[]): void {
  validateNamespaceLabels(namespacePrefix, 'namespacePrefix');
}

/**
 * Validate a search operation's own arguments. Neither the filter rule nor the
 * query rule looks inside the value: an operator clause (`{ $gt: 4 }`) and a
 * non-operator one (`{ $foo: 4 }`, matched as a literal per `isOperatorObject`)
 * are both legal filter shapes.
 *
 * Accepts: `op.namespacePrefix` — as {@link assertSearchPrefix}. `op.filter` —
 * absent or an object. `op.query` — absent or a string. `op.offset` and
 * `op.limit` — absent, which takes a valid default, or non-negative integers.
 * `null` is not absent: it was checked as `0` and then read as the default,
 * so `limit: null` returned a default page instead of naming the value.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `namespacePrefix`, `namespacePrefix element`,
 * `filter`, `query`, `offset` or `limit`.
 */
export function assertSearchOperation(op: SearchOperation): void {
  assertSearchPrefix(op.namespacePrefix);
  if (op.filter !== undefined) assertObjectShape(op.filter, 'filter');
  if (op.query !== undefined && typeof op.query !== 'string') {
    throw validationError('query must be a string', 'query');
  }
  validatePaging(op.offset === undefined ? 0 : op.offset, op.limit === undefined ? 0 : op.limit);
}

/** One condition: an object of a known match type, whose path names the field after that type. */
function assertMatchCondition(condition: MatchCondition): void {
  assertObjectShape(condition, 'matchConditions');
  const { matchType, path } = condition;
  assertMatchType(matchType);
  validateNamespaceLabels(path, matchType);
}

/**
 * Validate a listing operation's own arguments.
 *
 * Accepts: `op.offset` and `op.limit` — non-negative integers, as the operation
 * type requires them. `op.maxDepth` — absent or at least 1.
 * `op.matchConditions` — absent, or an array, where empty matches every
 * namespace; each entry an object whose `matchType` is `'prefix'` or `'suffix'`
 * and whose `path` holds labels a namespace can hold, with `'*'` matching any
 * one label.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `offset`, `limit` or `maxDepth`;
 * `matchConditions` for a non-array, an entry that is not an object or an
 * unknown match type; and `prefix`, `prefix element`, `suffix` or
 * `suffix element` for a path, named after the condition's type so a listing
 * reports the same field whether it came from `listNamespaces` options or from
 * `batch()`.
 */
export function assertListOperation(op: ListNamespacesOperation): void {
  validatePaging(op.offset, op.limit);
  validateMaxDepth(op.maxDepth);
  if (op.matchConditions === undefined) return;
  if (!Array.isArray(op.matchConditions)) {
    throw validationError('matchConditions must be an array', 'matchConditions');
  }
  for (const condition of op.matchConditions) assertMatchCondition(condition);
}

/**
 * Validate a put operation's own arguments.
 *
 * Accepts: `op.namespace` and `op.key` — the item address, as
 * `validateStoreKey`. `op.value` — an object, neither an array nor any other
 * type, or `null`, which is upstream's encoding of a delete
 * (`PutOperation.value`, `@langchain/langgraph-checkpoint@1.1.5`
 * `dist/store/base.d.ts:168`, "null to delete the item"). A member JSON drops,
 * such as a function or `undefined`, is left to the serialiser, which drops it.
 * `op.index` — absent, `false`, or field paths; a path the value does not hold
 * is legal.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `namespace`, `namespace element`, `key`,
 * `sortKey`, `value` or `index`.
 */
export function assertPutOperation(op: PutOperation): void {
  validateStoreKey(op.namespace, op.key);
  if (op.value !== null) assertObjectShape(op.value, 'value');
  if (op.index !== undefined && op.index !== false) validateStringArray(op.index, 'index');
}

/**
 * Validate any operation's own arguments, routed exactly as `DynamoDBStore`
 * dispatches it.
 *
 * Accepts: `operation` — an object: a search, put, get or listing operation.
 * Anything else — `null`, a primitive, an array — is refused before routing,
 * where the `in` operator would otherwise throw a bare `TypeError` or an array
 * would be taken for a listing.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `operations` for an operation that is not an
 * object, and otherwise the field, as the per-kind checks above.
 */
export function assertOperation(operation: Operation): void {
  if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
    throw validationError('every operation in operations must be an object', 'operations');
  }
  if ('namespacePrefix' in operation) {
    assertSearchOperation(operation);
  } else if ('value' in operation) {
    assertPutOperation(operation);
  } else if ('key' in operation) {
    validateStoreKey(operation.namespace, operation.key);
  } else {
    assertListOperation(operation);
  }
}

/**
 * Validate a whole batch before any of it runs.
 *
 * `batch()` calls this before it dispatches anything, so a malformed operation
 * cannot fail a batch that has already written part of itself. That matters
 * most inside a graph: LangGraph reaches a store only through `batch()`, via
 * `AsyncBatchedStore`, which coalesces every call made in one tick into a
 * single batch and rejects them all together (`@langchain/langgraph`
 * `dist/pregel/loop.js:311`, `@langchain/langgraph-checkpoint@1.1.5`
 * `dist/store/batch.js:85-105`). Each action still runs its own check too,
 * since `search()` reaches its action without `batch()`. Checks that need the
 * store's configuration stay in the actions.
 *
 * Accepts: `operations` — an array, possibly empty, of operations
 * {@link assertOperation} accepts.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `operations` for a value that is not an array
 * or an entry that is not an object, and otherwise the offending operation's
 * field.
 */
export function assertOperations(operations: Operation[]): void {
  if (!Array.isArray(operations)) {
    throw validationError('operations must be an array', 'operations');
  }
  for (const operation of operations) assertOperation(operation);
}
