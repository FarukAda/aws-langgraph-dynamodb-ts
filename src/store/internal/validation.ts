import {
  validateIdentifier,
  validateInteger,
  validateNonEmptyArray,
} from '../../shared/validation/primitives';
import { NAMESPACE_SEPARATOR } from './keys';

/** Validate search/listNamespaces paging is non-negative integers. */
export function validatePaging(offset: number, limit: number): void {
  validateInteger(offset, 'offset', { min: 0 });
  validateInteger(limit, 'limit', { min: 0 });
}

/** Validate the namespace is non-empty and each element is a valid identifier. */
export function validateNamespace(namespace: string[]): void {
  validateNonEmptyArray(namespace, 'namespace');
  for (const element of namespace) {
    validateIdentifier(element, NAMESPACE_SEPARATOR, 'namespace element');
  }
}

/** Validate an item key is a non-empty, separator- and control-char-free string. */
export function validateKey(key: string): void {
  validateIdentifier(key, NAMESPACE_SEPARATOR, 'key');
}
