import { MAX_KEY_SEGMENT_BYTES, MAX_SORT_KEY_BYTES } from '../../shared/constants';
import { validationError } from '../../shared/errors/errors';
import {
  validateIdentifier,
  validateInteger,
  validateLimit,
  validateNonEmptyArray,
} from '../../shared/validation/primitives';
import { NAMESPACE_SEPARATOR, sortKey } from './keys';

/**
 * Validate the paging a `search` or `listNamespaces` asks for.
 *
 * Accepts: `offset` — a non-negative integer. `limit` — the package-wide page
 * rule at its zero floor: a non-negative integer no larger than the page
 * ceiling. `limit: 0` asks for no items and is answered as such, not refused,
 * and the answer is an empty array the caller holds and can see is empty — a
 * page, not a conversation window, which is the one place this package refuses
 * zero. `offset` carries no ceiling of its own: it selects where a page starts
 * rather than how much one holds, and what it can make a read walk is already
 * bounded by `maxScanItems`.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `offset` or `limit`.
 */
export function validatePaging(offset: number, limit: number): void {
  validateInteger(offset, 'offset', { min: 0 });
  /** Zero is a legitimate page here, and `searchItems`/`listNamespaces` answer it without a read. */
  validateLimit(limit, 0);
}

/**
 * Validate the labels of a namespace, or of a path matched against namespaces,
 * as the key segments they become.
 *
 * These are this backend's rules, and only those. Upstream `BaseStore.put` also
 * refuses a `.` in a label and a `"langgraph"` root, but only in that one
 * method: the reference `InMemoryStore.batch`, and LangGraph's runtime, which
 * reaches a store only through `batch()`, accept both. So does this store
 * everywhere but `put()` itself (see `call-arguments.ts`); `#` is this
 * backend's separator, so a `.` costs nothing here.
 *
 * Accepts: `labels` — an array, possibly empty; each label a non-blank
 * identifier of at most {@link MAX_KEY_SEGMENT_BYTES} with no `#`, no control
 * character and no unpaired surrogate. A listing's `'*'` wildcard satisfies
 * every one of these rules, so it needs no exemption. `field` — the argument
 * the errors name.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field` for a value that is not an array, and
 * `<field> element` for a label that is not a usable key segment.
 */
export function validateNamespaceLabels(labels: string[], field: string): void {
  if (!Array.isArray(labels)) {
    throw validationError(`${field} must be an array of labels`, field);
  }
  for (const label of labels) {
    validateIdentifier(label, NAMESPACE_SEPARATOR, `${field} element`, MAX_KEY_SEGMENT_BYTES);
  }
}

/**
 * Validate a namespace as the partition and sort key it becomes.
 *
 * Accepts: `namespace` — at least one element, since the first becomes the
 * partition key; every element a label {@link validateNamespaceLabels} accepts.
 * `field` — the argument the errors name, `namespace` unless the caller calls
 * it something else.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field` for an empty or non-array value, and
 * `<field> element` for an element that is not a usable key segment.
 */
export function validateNamespace(namespace: string[], field = 'namespace'): void {
  validateNonEmptyArray(namespace, field);
  validateNamespaceLabels(namespace, field);
}

/**
 * Validate an item key as the trailing sort-key segment it becomes.
 *
 * Accepts: `key` — a non-blank identifier of at most
 * {@link MAX_KEY_SEGMENT_BYTES}, free of the namespace separator and of control
 * characters.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `key`.
 */
export function validateKey(key: string): void {
  validateIdentifier(key, NAMESPACE_SEPARATOR, 'key', MAX_KEY_SEGMENT_BYTES);
}

/**
 * Validate a namespace/key pair as the item address it becomes: each segment
 * on its own, then the sort key they compose, which DynamoDB caps at 1024
 * bytes regardless of how short the individual segments are.
 *
 * Accepts: `namespace` and `key` — each valid on its own *and* short enough
 * together. A deep namespace of legal segments can still compose an illegal
 * sort key, which is why the composition is checked and not just the parts.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `namespace`, `namespace element`, `key`, or
 * `sortKey` for the composition.
 */
export function validateStoreKey(namespace: string[], key: string): void {
  validateNamespace(namespace);
  validateKey(key);
  const bytes = Buffer.byteLength(sortKey(namespace, key), 'utf8');
  if (bytes > MAX_SORT_KEY_BYTES) {
    throw validationError(
      `namespace and key compose a ${bytes}-byte sort key; DynamoDB caps sort keys at ` +
        `${MAX_SORT_KEY_BYTES} bytes`,
      'sortKey',
    );
  }
}

/**
 * Validate an optional namespace depth cap.
 *
 * Accepts: `maxDepth` — absent means no truncation; otherwise an integer of at
 * least 1. Left unchecked, a negative value silently inverted truncation via
 * `Array.prototype.slice(0, -n)`, which drops the *last* n elements rather than
 * erroring, and 0 truncated every namespace to the same empty one.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `maxDepth`.
 */
export function validateMaxDepth(maxDepth?: number): void {
  if (maxDepth === undefined) return;
  validateInteger(maxDepth, 'maxDepth', { min: 1 });
}
