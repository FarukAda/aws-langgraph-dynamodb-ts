import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { assertBackfillOptions, backfillRecencyIndex } from '../../../src/backfill/backfill';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import {
  assertRetryBounds,
  assertRetryPolicy,
  assertTableName,
} from '../../../src/shared/validation/options';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

const TABLE = 'tbl';
const ok = () => createStrictDocumentMock().client;

/**
 * `assertBackfillOptions` is what `backfillRecencyIndex` calls, exercised
 * through the public function in `backfill-index.test.ts`. `assertTableName`
 * and `assertRetryPolicy` are its two reused-from-the-adapters building
 * blocks, exported from `shared/validation/options.ts` for exactly this reuse.
 */
describe('the validators backfillRecencyIndex is built from', () => {
  it('assertBackfillOptions accepts a well-formed bag and refuses a malformed one, both by field', () => {
    expect(() => assertBackfillOptions({ client: ok(), tableName: TABLE })).not.toThrow();
    expect(() => assertBackfillOptions({ client: ok(), tableName: '' })).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'tableName' } }),
    );
  });

  it('assertTableName rejects a name DynamoDB would refuse and accepts a legal one', () => {
    expect(() => assertTableName('ab')).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'tableName' } }),
    );
    expect(() => assertTableName(TABLE)).not.toThrow();
  });

  it('assertRetryPolicy rejects a malformed policy and accepts a valid one', () => {
    expect(() => assertRetryPolicy({ maxAttempts: 0 })).toThrow(
      expect.objectContaining({
        code: ErrorCode.VALIDATION,
        context: { field: 'retry.maxAttempts' },
      }),
    );
    expect(() => assertRetryPolicy({ maxAttempts: 3 })).not.toThrow();
  });

  /**
   * `assertRetryBounds` is the numeric-bound logic `assertRetryPolicy`
   * (above, for the adapters' narrower `RetryPolicy`) and backfill's own
   * `retry: RetryOptions` validation both call, so the two cannot drift on
   * what a legal bound is.
   */
  it('assertRetryBounds rejects an out-of-range bound and accepts an in-range one', () => {
    expect(() => assertRetryBounds({ maxAttempts: 0 })).toThrow(
      expect.objectContaining({
        code: ErrorCode.VALIDATION,
        context: { field: 'retry.maxAttempts' },
      }),
    );
    expect(() => assertRetryBounds({ maxAttempts: 3 })).not.toThrow();
  });

  it('refuses a client that wraps numbers, naming client', async () => {
    const client = DynamoDBDocument.from(new DynamoDBClient({ region: 'us-east-1' }), {
      unmarshallOptions: { wrapNumbers: true },
    });
    await expect(backfillRecencyIndex({ tableName: TABLE, client })).rejects.toMatchObject({
      code: 'VALIDATION',
      context: { field: 'client' },
    });
  });
});
