import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { assertCancelOptions, CANCEL_KEYS } from '../../../../src/shared/validation/collaborators';

describe('the cancellation key list (compiler-verified against the type)', () => {
  it('lists exactly what a cancellation-only options bag carries', () => {
    expect(CANCEL_KEYS).toEqual(['signal']);
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
