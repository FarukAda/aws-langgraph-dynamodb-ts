import { validateBackfillOptions } from '../../../../src/shared/dynamodb/backfill-validation';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  validateRetryBounds,
  validateRetryPolicy,
  validateTableName,
} from '../../../../src/shared/validation/options';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const TABLE = 'tbl';
const ok = () => createStrictDocumentMock().client;

/**
 * `validateBackfillOptions` is what `backfillRecencyIndex` calls, exercised
 * through the public function in `backfill-index.test.ts`. `validateTableName`
 * and `validateRetryPolicy` are its two reused-from-the-adapters building
 * blocks, exported from `shared/validation/options.ts` for exactly this reuse.
 */
describe('the validators backfillRecencyIndex is built from', () => {
  it('validateBackfillOptions accepts a well-formed bag and refuses a malformed one, both by field', () => {
    expect(() => validateBackfillOptions({ client: ok(), tableName: TABLE })).not.toThrow();
    expect(() => validateBackfillOptions({ client: ok(), tableName: '' })).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'tableName' } }),
    );
  });

  it('validateTableName rejects a name DynamoDB would refuse and accepts a legal one', () => {
    expect(() => validateTableName('ab')).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'tableName' } }),
    );
    expect(() => validateTableName(TABLE)).not.toThrow();
  });

  it('validateRetryPolicy rejects a malformed policy and accepts a valid one', () => {
    expect(() => validateRetryPolicy({ maxAttempts: 0 })).toThrow(
      expect.objectContaining({
        code: ErrorCode.VALIDATION,
        context: { field: 'retry.maxAttempts' },
      }),
    );
    expect(() => validateRetryPolicy({ maxAttempts: 3 })).not.toThrow();
  });

  /**
   * `validateRetryBounds` is the numeric-bound logic `validateRetryPolicy`
   * (above, for the adapters' narrower `RetryPolicy`) and backfill's own
   * `retry: RetryOptions` validation both call, so the two cannot drift on
   * what a legal bound is.
   */
  it('validateRetryBounds rejects an out-of-range bound and accepts an in-range one', () => {
    expect(() => validateRetryBounds({ maxAttempts: 0 })).toThrow(
      expect.objectContaining({
        code: ErrorCode.VALIDATION,
        context: { field: 'retry.maxAttempts' },
      }),
    );
    expect(() => validateRetryBounds({ maxAttempts: 3 })).not.toThrow();
  });
});
