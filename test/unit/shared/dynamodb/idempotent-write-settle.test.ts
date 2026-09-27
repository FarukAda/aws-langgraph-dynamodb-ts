import { mayStillLand, settledVerdict } from '../../../../src/shared/dynamodb/idempotent-write';
import { abortError, retryExhaustedError } from '../../../../src/shared/errors/errors';

const timeout = (): Error => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
const answered = (): Error =>
  Object.assign(new Error('throttled'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 400 },
  });

describe('mayStillLand', () => {
  it('is true for a cancel, whatever was in flight', () => {
    expect(mayStillLand(abortError('Operation aborted'))).toBe(true);
  });

  it('judges a spent budget by its last attempt', () => {
    expect(mayStillLand(retryExhaustedError('spent', 5, timeout()))).toBe(true);
    expect(mayStillLand(retryExhaustedError('spent', 5, answered()))).toBe(false);
  });

  it('judges any other failure by itself', () => {
    expect(mayStillLand(timeout())).toBe(true);
    expect(mayStillLand(answered())).toBe(false);
  });
});

describe('settledVerdict', () => {
  it('turns a not-landed read into unverified only while the write may still land', () => {
    expect(settledVerdict('not-landed', timeout())).toBe('unverified');
    expect(settledVerdict('not-landed', answered())).toBe('not-landed');
  });

  it('leaves landed and unverified alone', () => {
    expect(settledVerdict('landed', timeout())).toBe('landed');
    expect(settledVerdict('unverified', answered())).toBe('unverified');
  });
});
