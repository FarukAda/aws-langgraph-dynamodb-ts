import { MAX_KEY_SEGMENT_BYTES, MAX_SORT_KEY_BYTES } from '../../shared/constants';
import { ValidationError } from '../../shared/errors/errors';
import {
  validateIdentifier,
  validateInteger,
  validateNonEmptyArray,
} from '../../shared/validation/primitives';
import { NAMESPACE_SEPARATOR, sortKey } from './keys';

/** Validate search/listNamespaces paging is non-negative integers. */
export function validatePaging(offset: number, limit: number): void {
  validateInteger(offset, 'offset', { min: 0 });
  validateInteger(limit, 'limit', { min: 0 });
}

/** Validate the namespace is non-empty and each element is a valid, ≤256-byte identifier. */
export function validateNamespace(namespace: string[]): void {
  validateNonEmptyArray(namespace, 'namespace');
  for (const element of namespace) {
    validateIdentifier(element, NAMESPACE_SEPARATOR, 'namespace element', MAX_KEY_SEGMENT_BYTES);
  }
}

/** Validate an item key is a non-blank, separator- and control-char-free, ≤256-byte string. */
export function validateKey(key: string): void {
  validateIdentifier(key, NAMESPACE_SEPARATOR, 'key', MAX_KEY_SEGMENT_BYTES);
}

/**
 * Validate a namespace/key pair as the item address it becomes: each segment
 * on its own, then the sort key they compose, which DynamoDB caps at 1024
 * bytes regardless of how short the individual segments are.
 */
export function validateStoreKey(namespace: string[], key: string): void {
  validateNamespace(namespace);
  validateKey(key);
  const bytes = Buffer.byteLength(sortKey(namespace, key), 'utf8');
  if (bytes > MAX_SORT_KEY_BYTES) {
    throw new ValidationError(
      `namespace and key compose a ${bytes}-byte sort key; DynamoDB caps sort keys at ` +
        `${MAX_SORT_KEY_BYTES} bytes`,
      'sortKey',
    );
  }
}

/**
 * Validate an optional namespace depth cap. Left unchecked, a negative value
 * silently inverted truncation via `Array.prototype.slice(0, -n)`, which drops
 * the *last* n elements rather than erroring.
 */
export function validateMaxDepth(maxDepth?: number): void {
  if (maxDepth === undefined) return;
  validateInteger(maxDepth, 'maxDepth', { min: 1 });
}
