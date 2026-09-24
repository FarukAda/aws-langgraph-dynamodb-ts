import type {
  BaseStore,
  ListNamespacesOperation,
  MatchCondition,
  Operation,
  PutOperation,
  SearchOperation,
} from '@langchain/langgraph-checkpoint';

import {
  KEY_SEPARATOR,
  MAX_KEY_SEGMENT_BYTES,
  MAX_SORT_KEY_BYTES,
} from '../../shared/dynamodb/table-schema';
import { validationError } from '../../shared/errors/errors';
import { assertObjectShape, assertShape } from '../../shared/validation/option-shape';
import {
  type PageLimit,
  parseIdentifier,
  parseInteger,
  parseLimit,
  parseString,
  parseStringArray,
} from '../../shared/validation/primitives';
import type { ListNamespacesOptions } from '../types';
import type { JsonValue } from './filter';
import { sortKey } from './rows';
import { STORE_LIST_NAMESPACES_KEYS } from './setup';

declare const namespaceBrand: unique symbol;
declare const namespacePrefixBrand: unique symbol;
declare const storeAddressBrand: unique symbol;

/**
 * A namespace checked as the partition and sort-key segments it becomes:
 * non-empty, every label a well-formed identifier. Built only by
 * {@link parseNamespace}, as a copy no caller holds. Mutable in type only so it
 * still satisfies the public `VectorBackend` signatures; nothing writes to it.
 */
export type Namespace = string[] & { readonly [namespaceBrand]: true };

/** A namespace prefix: like a {@link Namespace}, but possibly empty. Built only by {@link parseNamespacePrefix}. */
export type NamespacePrefix = string[] & { readonly [namespacePrefixBrand]: true };

/**
 * An item's address — namespace and key — checked together, because the
 * DynamoDB sort-key cap is a property of the pair. Built only by
 * {@link parseStoreAddress}.
 */
export type StoreAddress = { readonly namespace: Namespace; readonly key: string } & {
  readonly [storeAddressBrand]: true;
};

/**
 * The root label upstream `BaseStore.put` refuses
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/store/base.js:23`).
 */
const RESERVED_ROOT = 'langgraph';

/** The page `search` reads when the caller names none. */
const DEFAULT_SEARCH_LIMIT: PageLimit = parseLimit(10, 0);

/** The page `listNamespaces` reads when the caller names none. */
const DEFAULT_LIST_LIMIT = 100;

/**
 * Every label of `value`, each a well-formed identifier, as a copy. Iterated
 * with `for…of`, so a hole in a sparse array is checked as the `undefined` it
 * reads as rather than skipped.
 *
 * These are this backend's own rules, and only those: `#` is this backend's
 * separator, so a `.` costs nothing here, and a listing's `'*'` wildcard
 * satisfies every one of these rules, so it needs no exemption. Upstream
 * `BaseStore.put` refuses a `.` in a label and a `"langgraph"` root too, but
 * only in that one method — see {@link checkUpstreamPutNamespace}.
 */
function parseLabels(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw validationError(`${field} must be an array of labels`, field);
  }
  const labels: string[] = [];
  for (const label of value) {
    labels.push(parseIdentifier(label, KEY_SEPARATOR, `${field} element`, MAX_KEY_SEGMENT_BYTES));
  }
  return labels;
}

/**
 * Parse a namespace prefix.
 *
 * Accepts: `value` — anything; an array of labels a namespace can hold,
 * possibly empty, which spans every namespace. `field` — the argument the
 * caller set (`namespacePrefix`, or `prefix`/`suffix` for a match condition's
 * path), named on a refusal.
 *
 * Returns: a copy of the labels, as a {@link NamespacePrefix}. A prefix no
 * stored namespace could ever match is refused rather than answered with a
 * silent empty page.
 *
 * Throws: `VALIDATION` naming `field` for a non-array, or `<field> element` for
 * a malformed label.
 */
export function parseNamespacePrefix(value: unknown, field: string): NamespacePrefix {
  return parseLabels(value, field) as NamespacePrefix;
}

/**
 * Parse a namespace.
 *
 * Accepts: `value` — anything; a non-empty array of labels. `field` — defaults
 * to `namespace`; `reconcileVectorIndex` passes `namespacePrefix`, whose prefix
 * must not be empty.
 *
 * Returns: a copy of the labels, as a {@link Namespace}.
 *
 * Throws: `VALIDATION` naming `field` for a non-array or an empty one, or
 * `<field> element` for a malformed label.
 */
export function parseNamespace(value: unknown, field = 'namespace'): Namespace {
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError(`${field} must be a non-empty array`, field);
  }
  return parseLabels(value, field) as Namespace;
}

/**
 * Parse an item's address: the namespace and key together, because the
 * DynamoDB sort-key cap is a property of the pair. A deep namespace of legal
 * segments can still compose an illegal sort key, which is why the
 * composition is checked and not just the parts.
 *
 * Accepts: `namespace` — as {@link parseNamespace}. `key` — a well-formed
 * identifier.
 *
 * Returns: the address, as a {@link StoreAddress}.
 *
 * Throws: `VALIDATION` naming `namespace` (or `namespace element`), then `key`,
 * then `sortKey` when the two compose a sort key over DynamoDB's cap.
 */
export function parseStoreAddress(namespace: unknown, key: unknown): StoreAddress {
  const parsedNamespace = parseNamespace(namespace);
  const parsedKey = parseIdentifier(key, KEY_SEPARATOR, 'key', MAX_KEY_SEGMENT_BYTES);
  const bytes = Buffer.byteLength(sortKey(parsedNamespace, parsedKey), 'utf8');
  if (bytes > MAX_SORT_KEY_BYTES) {
    throw validationError(
      `namespace and key compose a ${bytes}-byte sort key; DynamoDB caps sort keys at ` +
        `${MAX_SORT_KEY_BYTES} bytes`,
      'sortKey',
    );
  }
  return { namespace: parsedNamespace, key: parsedKey } as StoreAddress;
}

/** Read one item. */
export interface ParsedGet {
  readonly kind: 'get';
  readonly address: StoreAddress;
}

/** Store one item. */
export interface ParsedPut {
  readonly kind: 'put';
  readonly address: StoreAddress;
  readonly value: Record<string, JsonValue>;
  /** `false` indexes nothing, a list the fields named, `undefined` the configured fields. */
  readonly index: false | string[] | undefined;
}

/** Delete one item: a put whose value is `null`. */
export interface ParsedDelete {
  readonly kind: 'delete';
  readonly address: StoreAddress;
}

/** Search under a prefix, its page and its defaults resolved. */
export interface ParsedSearch {
  readonly kind: 'search';
  readonly namespacePrefix: NamespacePrefix;
  readonly filter: Record<string, JsonValue> | undefined;
  readonly query: string | undefined;
  readonly offset: number;
  readonly limit: PageLimit;
}

/** One match condition of a namespace listing. */
export interface ParsedMatchCondition {
  readonly matchType: 'prefix' | 'suffix';
  readonly path: NamespacePrefix;
}

/** List namespaces. */
export interface ParsedList {
  readonly kind: 'list';
  readonly matchConditions: ParsedMatchCondition[] | undefined;
  readonly maxDepth: number | undefined;
  readonly offset: number;
  readonly limit: PageLimit;
}

/**
 * One store operation, parsed. The kind is decided here, once, from the shape
 * upstream's `Operation` union gives it — every other step switches on `kind`
 * instead of asking the shape again.
 */
export type ParsedOperation = ParsedGet | ParsedPut | ParsedDelete | ParsedSearch | ParsedList;

/** A put's `index`: absent and `false` as given, a field list as a copy. */
function parseIndex(index: PutOperation['index']): false | string[] | undefined {
  if (index === undefined || index === false) return index;
  return parseStringArray(index, 'index');
}

/**
 * Parse a search's options against a prefix already parsed.
 *
 * Accepts: `namespacePrefix` — parsed by {@link parseNamespacePrefix}, which
 * `store.search` does first so a malformed prefix is named before a malformed
 * option. `op.filter` — an object when given. `op.query` — a string when given.
 * `op.offset` — an integer of at least 0, `0` when absent; it carries no
 * ceiling of its own, since it selects where a page starts rather than how
 * much one holds, and what it can make a read walk is already bounded by
 * `maxScanItems`. `op.limit` — 0 to the page ceiling, 10 when absent; `null` is
 * not absent, so `limit: null` is refused rather than read as the default.
 * `0` asks for no items and is answered as such, not refused — a page, not a
 * conversation window, which is the one place this package refuses zero.
 *
 * Returns: the search, its defaults applied.
 *
 * Throws: `VALIDATION` naming `filter`, `query`, `offset` or `limit`, in that
 * order.
 */
export function parseSearch(
  namespacePrefix: NamespacePrefix,
  op: Pick<SearchOperation, 'filter' | 'limit' | 'offset' | 'query'>,
): ParsedSearch {
  if (op.filter !== undefined) assertObjectShape(op.filter, 'filter');
  const query = op.query === undefined ? undefined : parseString(op.query, 'query');
  const offset = parseInteger(op.offset === undefined ? 0 : op.offset, 'offset', { min: 0 });
  const limit = op.limit === undefined ? DEFAULT_SEARCH_LIMIT : parseLimit(op.limit, 0);
  return {
    kind: 'search',
    namespacePrefix,
    filter: op.filter as Record<string, JsonValue> | undefined,
    query,
    offset,
    limit,
  };
}

/**
 * One match condition: an object, a known match type, a well-formed path.
 * `matchType` is refused rather than resolved when it is neither `'prefix'`
 * nor `'suffix'`: `matchNamespace`'s own branch on `matchType` (see
 * `actions/list-namespaces.ts`) otherwise takes an unrecognised type as a
 * suffix match and answers as if the caller had asked for one. The refusal echoes a string
 * `matchType` in the message and describes anything else by its type, since
 * `JSON.stringify` itself throws on a bigint.
 */
function parseMatchCondition(condition: MatchCondition): ParsedMatchCondition {
  assertObjectShape(condition, 'matchConditions');
  const { matchType, path } = condition;
  if (matchType !== 'prefix' && matchType !== 'suffix') {
    const received = typeof matchType === 'string' ? JSON.stringify(matchType) : typeof matchType;
    throw validationError(
      `matchType must be "prefix" or "suffix" (received ${received})`,
      'matchConditions',
    );
  }
  return { matchType, path: parseNamespacePrefix(path, matchType) };
}

/** The match conditions of a listing, absent when none are given. */
function parseMatchConditions(
  conditions: MatchCondition[] | undefined,
): ParsedMatchCondition[] | undefined {
  if (conditions === undefined) return undefined;
  if (!Array.isArray(conditions)) {
    throw validationError('matchConditions must be an array', 'matchConditions');
  }
  const parsed: ParsedMatchCondition[] = [];
  for (const condition of conditions) parsed.push(parseMatchCondition(condition));
  return parsed;
}

/**
 * Parse a namespace-listing operation.
 *
 * Accepts: `op.offset` — an integer of at least 0. `op.limit` — 0 to the page
 * ceiling. `op.maxDepth` — an integer of at least 1 when given: left
 * unchecked, a negative value inverts truncation via `Array.prototype.slice(0,
 * -n)`, which drops the *last* n elements rather than erroring, and 0
 * truncates every namespace to the same empty one. `op.matchConditions` — an
 * array of `{ matchType: 'prefix' | 'suffix', path }` when given; `*` is a
 * legal label in a path.
 *
 * Returns: the listing.
 *
 * Throws: `VALIDATION` naming `offset`, `limit`, `maxDepth`, `matchConditions`
 * or `<matchType> element`, in that order.
 */
export function parseListOperation(op: ListNamespacesOperation): ParsedList {
  const offset = parseInteger(op.offset, 'offset', { min: 0 });
  const limit = parseLimit(op.limit, 0);
  const maxDepth =
    op.maxDepth === undefined ? undefined : parseInteger(op.maxDepth, 'maxDepth', { min: 1 });
  return {
    kind: 'list',
    matchConditions: parseMatchConditions(op.matchConditions),
    maxDepth,
    offset,
    limit,
  };
}

/**
 * Parse the options of `listNamespaces`.
 *
 * Accepts: `options` — only `prefix`, `suffix`, `maxDepth`, `limit` and
 * `offset`; `limit` defaults to 100 and `offset` to 0.
 *
 * Returns: the listing the options describe.
 *
 * Throws: `VALIDATION` naming `options.<key>` for a key this package does not
 * read, then as {@link parseListOperation}.
 */
export function parseListNamespacesOptions(options: ListNamespacesOptions): ParsedList {
  assertShape(options, STORE_LIST_NAMESPACES_KEYS, 'options');
  const { prefix, suffix, maxDepth, limit = DEFAULT_LIST_LIMIT, offset = 0 } = options;
  const matchConditions: MatchCondition[] = [];
  if (prefix !== undefined) matchConditions.push({ matchType: 'prefix', path: prefix });
  if (suffix !== undefined) matchConditions.push({ matchType: 'suffix', path: suffix });
  return parseListOperation({
    matchConditions: matchConditions.length > 0 ? matchConditions : undefined,
    maxDepth,
    limit,
    offset,
  });
}

/**
 * Refuse what upstream `BaseStore.put` refuses and this store's own key rules
 * allow: no `.` in a label, and no `"langgraph"` root
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/store/base.js:16-24`). These
 * two rules belong to that one method only: the reference `InMemoryStore.batch`
 * checks neither, and LangGraph's runtime reaches a store only through
 * `batch()`, so a namespace such as `['memories', 'jane.doe@example.com']`
 * written there must stay readable, searchable and deletable here. Only
 * `put()` applies it, as upstream does; `batch()` does not.
 */
function checkUpstreamPutNamespace(namespace: Namespace): void {
  if (namespace.some((label) => label.includes('.'))) {
    throw validationError(
      'namespace element must not contain "."; put() refuses it, as upstream BaseStore.put does',
      'namespace element',
    );
  }
  if (namespace[0] === RESERVED_ROOT) {
    throw validationError(
      `namespace must not start with "${RESERVED_ROOT}", the root label LangGraph reserves`,
      'namespace',
    );
  }
}

/**
 * Parse the arguments of `put()`.
 *
 * Accepts: `namespace`, `key` — as {@link parseStoreAddress}, plus the
 * namespace rules upstream `put()` adds. `value` — an object; `null` is refused,
 * because `delete()` is how an item is removed. `index` — `false`, a list of
 * field paths, or absent.
 *
 * Returns: the put.
 *
 * Throws: `VALIDATION` naming `namespace`, `namespace element`, `key`,
 * `sortKey`, `value` or `index`, in that order.
 */
export function parsePutArguments(
  namespace: string[],
  key: string,
  value: Parameters<BaseStore['put']>[2],
  index: PutOperation['index'],
): ParsedPut {
  const address = parseStoreAddress(namespace, key);
  checkUpstreamPutNamespace(address.namespace);
  if (value === null) {
    throw validationError('value must be an object; delete() removes an item', 'value');
  }
  assertObjectShape(value, 'value');
  return {
    kind: 'put',
    address,
    value: value as Record<string, JsonValue>,
    index: parseIndex(index),
  };
}

/**
 * A batch put, or the delete a `null` value asks for. The index is parsed
 * either way, as it always was for a put with a `null` value.
 */
function parsePutOperation(op: PutOperation): ParsedPut | ParsedDelete {
  const address = parseStoreAddress(op.namespace, op.key);
  if (op.value !== null) assertObjectShape(op.value, 'value');
  const index = parseIndex(op.index);
  if (op.value === null) return { kind: 'delete', address };
  return { kind: 'put', address, value: op.value as Record<string, JsonValue>, index };
}

/**
 * Parse one operation of a batch, deciding its kind from its shape — the only
 * place that asks.
 *
 * Accepts: `operation` — an object; a `namespacePrefix` makes it a search, a
 * `value` a put (a delete when `null`), a `key` a get, anything else a listing.
 *
 * Returns: the parsed operation.
 *
 * Throws: `VALIDATION` naming `operations` for a non-object, else as the
 * parser of its kind.
 */
export function parseOperation(operation: Operation): ParsedOperation {
  if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
    throw validationError('every operation in operations must be an object', 'operations');
  }
  if ('namespacePrefix' in operation) {
    return parseSearch(
      parseNamespacePrefix(operation.namespacePrefix, 'namespacePrefix'),
      operation,
    );
  }
  if ('value' in operation) return parsePutOperation(operation);
  if ('key' in operation) {
    return { kind: 'get', address: parseStoreAddress(operation.namespace, operation.key) };
  }
  return parseListOperation(operation);
}

/**
 * Parse every operation of a batch before any of them runs, so a malformed
 * last operation cannot leave the first ones applied. That matters most
 * inside a graph: LangGraph reaches a store only through `batch()`, via
 * `AsyncBatchedStore`, which coalesces every call made in one tick into a
 * single batch and rejects them all together (`@langchain/langgraph`
 * `dist/pregel/loop.js:311`, `@langchain/langgraph-checkpoint@1.1.5`
 * `dist/store/batch.js:85-105`).
 *
 * Accepts: `operations` — an array of operations.
 *
 * Returns: the parsed operations, in order.
 *
 * Throws: `VALIDATION` naming `operations` for a non-array, else as
 * {@link parseOperation} for the first malformed one.
 */
export function parseOperations(operations: Operation[]): ParsedOperation[] {
  if (!Array.isArray(operations)) {
    throw validationError('operations must be an array', 'operations');
  }
  const parsed: ParsedOperation[] = [];
  for (const operation of operations) parsed.push(parseOperation(operation));
  return parsed;
}
