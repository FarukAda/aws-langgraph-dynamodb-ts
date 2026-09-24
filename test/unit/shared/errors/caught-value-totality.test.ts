import { isPermanentPayloadLoss, isMissingObjectError } from '../../../../src/shared/codec/codec';
import { isAbortError } from '../../../../src/shared/dynamodb/abort';
import { getCancellationReasons } from '../../../../src/shared/dynamodb/cancellation';
import { isTransientS3Error, isRetryableError } from '../../../../src/shared/dynamodb/retry';
import { isDynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { toPublicError } from '../../../../src/shared/errors/boundary';
import { toError } from '../../../../src/shared/errors/to-error';
import { redactErrorText, redactedMessage } from '../../../../src/shared/logging/secret-patterns';
import { isRetryExhausted } from '../../../../src/store/internal/item-write';

/**
 * Everything a `throw` can produce. `throw 'boom'` is legal JavaScript and a
 * `toJSON` written by a caller is the shortest path to one reaching this
 * package, so a function whose contract says it takes "any error" takes these
 * too — and each of them is the value a `catch` block hands it.
 */
const THROWN: readonly unknown[] = [
  undefined,
  null,
  'boom',
  42,
  true,
  Symbol('s'),
  10n,
  {},
  [],
  () => 1,
  Object.create(null) as object,
];

/** Run `probe` over every thrown value, returning the ones that made it throw. */
function survivors(probe: (value: Error) => void): unknown[] {
  return THROWN.filter((value) => {
    try {
      probe(value as Error);
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * A static guard funnels every `catch` block in this package into
 * `redactedMessage`, and the surface tier asserts that no public entry point
 * lets an unbranded error escape. Both promises rest on the same premise: that
 * a function documenting `Throws: nothing` keeps that promise for the values a
 * `catch` actually binds, not only for the `Error` its signature names.
 */
describe('the functions a catch block hands a caught value', () => {
  const total: Record<string, (value: Error) => void> = {
    toError: (value) => void toError(value),
    toPublicError: (value) => void toPublicError(value, 'op'),
    isDynamoDBLangGraphError: (value) => void isDynamoDBLangGraphError(value),
    redactedMessage: (value) => void redactedMessage(value),
    redactErrorText: (value) => void redactErrorText(value, []),
    isPermanentPayloadLoss: (value) => void isPermanentPayloadLoss(value),
    isMissingObjectError: (value) => void isMissingObjectError(value),
    isTransientS3Error: (value) => void isTransientS3Error(value),
    isAbortError: (value) => void isAbortError(value),
    isRetryableError: (value) => void isRetryableError(value, ['x']),
    isRetryExhausted: (value) => void isRetryExhausted(value),
    getCancellationReasons: (value) => void getCancellationReasons(value),
  };

  it.each(Object.keys(total))('%s answers every value a throw can produce', (name) => {
    expect(survivors(total[name])).toEqual([]);
  });

  /** Total is not enough: each must answer what it would have answered for an Error carrying nothing. */
  it('answers a value that carries no fields the way it answers a bare error', () => {
    expect(redactedMessage('boom' as unknown as Error)).toBe('boom');
    expect(redactedMessage(null as unknown as Error)).toBe('null was thrown');
    expect(redactErrorText(42 as unknown as Error, []).message).toBe('42');
    expect(isPermanentPayloadLoss(null as unknown as Error)).toBe(false);
    expect(isMissingObjectError(undefined as unknown as Error)).toBe(false);
    expect(isTransientS3Error(null as unknown as Error)).toBe(false);
    expect(isAbortError(null as unknown as Error)).toBe(false);
    expect(isRetryableError(null as unknown as Error, ['x'])).toBe(false);
    expect(isRetryExhausted(null as unknown as Error)).toBe(false);
    expect(getCancellationReasons(null as unknown as Error)).toBeUndefined();
  });

  /**
   * A secret in a non-`Error`'s own text is still redacted: the value is
   * described first and the description is what the patterns run over, so
   * widening the input did not open a hole beside the one it closed.
   */
  it('still redacts a credential carried by a value that is not an error', () => {
    expect(redactedMessage('password=hunter2' as unknown as Error)).toBe('password=[REDACTED]');
    expect(redactedMessage({ password: 'hunter2' } as unknown as Error)).toContain('[REDACTED]');
  });
});
