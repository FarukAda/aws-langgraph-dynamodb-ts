import { assertNoSeparator, validateNonEmptyString } from '../../shared/validation/primitives';
import { NAMESPACE_SEPARATOR } from './keys';

/** Validate each namespace element is a non-empty, separator-free string. */
export function validateNamespace(namespace: string[]): void {
  for (const element of namespace) {
    validateNonEmptyString(element, 'namespace element');
    assertNoSeparator(element, NAMESPACE_SEPARATOR, 'namespace element');
  }
}

/** Validate an item key is a non-empty string. */
export function validateKey(key: string): void {
  validateNonEmptyString(key, 'key');
}

/** Current time as an ISO string, derived from the (test-freezable) clock. */
export function nowIso(): string {
  return new Date(Date.now()).toISOString();
}
