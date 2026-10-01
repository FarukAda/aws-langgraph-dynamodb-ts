import { mayStillLand, settledVerdict } from '../../../../src/shared/dynamodb/idempotent-write';
import {
  abortError,
  markMayStillLand,
  retryExhaustedError,
} from '../../../../src/shared/errors/errors';

const timeout = (): Error => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
const answered = (): Error =>
  Object.assign(new Error('throttled'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 400 },
  });
const transactionInProgress = (): Error =>
  Object.assign(new Error('in progress'), { name: 'TransactionInProgressException' });
const serverError = (): Error =>
  Object.assign(new Error('internal'), { name: 'Unknown', $metadata: { httpStatusCode: 500 } });

describe('mayStillLand', () => {
  it('is true for a cancel, whatever was in flight', () => {
    expect(mayStillLand(abortError('Operation aborted'))).toBe(true);
  });

  it("trusts the record kept across the whole retry budget, not only the last attempt's own cause", () => {
    // An earlier attempt may have left DynamoDB free to apply the write even
    // though the last attempt — `cause` — was answered definitely; the record
    // withRetry kept across every attempt is what settles it, not a
    // re-derivation from `cause` alone.
    expect(mayStillLand(retryExhaustedError('spent', 5, answered(), true))).toBe(true);
  });

  it("falls back to the last attempt's own cause when the record itself does not say true", () => {
    // A RETRY_EXHAUSTED error built outside withRetry — as this package's own
    // append-saga tests build one to model a lost-response commit — carries
    // an explicit record of `false` rather than no record at all. Either way,
    // a cause that may still be in flight must still count, or such an error
    // would read as answered.
    expect(mayStillLand(retryExhaustedError('spent', 5, timeout(), false))).toBe(true);
    expect(mayStillLand(retryExhaustedError('spent', 5, answered(), false))).toBe(false);
  });

  it('defaults the same way for a RETRY_EXHAUSTED error built without a record at all', () => {
    expect(mayStillLand(retryExhaustedError('spent', 5, timeout()))).toBe(true);
    expect(mayStillLand(retryExhaustedError('spent', 5, answered()))).toBe(false);
  });

  /**
   * The budget's record outranks the failure's own shape for a refusal as
   * much as for a spent budget: a refusal thrown after an unanswered attempt
   * carries the same record, and the write it ended may still land.
   */
  it('trusts the record on a refusal that ended the budget after an unanswered attempt', () => {
    const refused = Object.assign(new Error('expired'), {
      name: 'ExpiredTokenException',
      $metadata: { httpStatusCode: 400 },
    });
    expect(mayStillLand(refused)).toBe(false);
    expect(mayStillLand(markMayStillLand(refused))).toBe(true);
  });

  /** "Throws nothing, for any value": a frozen error cannot take the mark, and is handed back as it was. */
  it('leaves a frozen error unmarked rather than throwing', () => {
    const frozen = Object.freeze(answered());
    expect(markMayStillLand(frozen)).toBe(frozen);
    expect(mayStillLand(frozen)).toBe(false);
  });

  it('judges any other failure by itself, including one DynamoDB answered ambiguously', () => {
    expect(mayStillLand(timeout())).toBe(true);
    expect(mayStillLand(answered())).toBe(false);
    expect(mayStillLand(transactionInProgress())).toBe(true);
    expect(mayStillLand(serverError())).toBe(true);
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
