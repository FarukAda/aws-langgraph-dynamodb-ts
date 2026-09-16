import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  assertCancelOptions,
  CANCEL_KEYS,
  GET_MESSAGES_KEYS,
  LIST_SESSIONS_KEYS,
  SAVER_LIST_KEYS,
  STORE_LIST_NAMESPACES_KEYS,
  STORE_SEARCH_KEYS,
} from '../../../../src/shared/validation/method-keys';

describe('the method-bag key lists (compiler-verified against the types)', () => {
  it('lists exactly what each public method reads from its options bag', () => {
    expect(CANCEL_KEYS).toEqual(['signal']);
    expect(GET_MESSAGES_KEYS).toEqual(['limit', 'before', 'signal']);
    expect(LIST_SESSIONS_KEYS).toEqual(['limit', 'cursor', 'maxIterations', 'maxItems', 'signal']);
    expect(STORE_SEARCH_KEYS).toEqual(['filter', 'limit', 'offset', 'query', 'signal']);
    expect(STORE_LIST_NAMESPACES_KEYS).toEqual(['prefix', 'suffix', 'maxDepth', 'limit', 'offset']);
    expect(SAVER_LIST_KEYS).toEqual(['limit', 'before', 'filter']);
  });
});

describe('assertCancelOptions', () => {
  it('leaves an absent bag unchecked', () => {
    expect(() => assertCancelOptions(undefined)).not.toThrow();
  });

  it('accepts an empty bag and one carrying only signal', () => {
    expect(() => assertCancelOptions({})).not.toThrow();
    expect(() => assertCancelOptions({ signal: new AbortController().signal })).not.toThrow();
  });

  it('refuses a key this package does not read, naming it under options', () => {
    expect(() => assertCancelOptions({ bogus: true } as never)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'options.bogus' } }),
    );
  });

  it('refuses a signal that is not AbortSignal-like', () => {
    expect(() => assertCancelOptions({ signal: {} as never })).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'signal' } }),
    );
  });
});
