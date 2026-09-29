import { DynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import {
  guardPublic,
  guardPublicSync,
  toPublicError,
} from '../../../../src/shared/errors/boundary';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { validationError } from '../../../../src/shared/errors/errors';

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('the public boundary says where an error surfaced', () => {
  it('fills in the operation and the table on a library error that names neither', async () => {
    const error = await guardPublic(
      'saver.put',
      () => Promise.reject(validationError('bad', 'config')),
      'tbl',
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'config', operation: 'saver.put', tableName: 'tbl' },
    });
  });

  it('keeps an operation the error already names', () => {
    const inner = new DynamoDBLangGraphError('s3', ErrorCode.S3_OFFLOAD_FAILED, {
      operation: 'upload',
      key: 'k',
    });
    expect(toPublicError(inner, 'store.put', 'tbl').context).toEqual({
      operation: 'upload',
      key: 'k',
      tableName: 'tbl',
    });
  });

  it('stamps a wrapped AWS failure too, beside its diagnostics', () => {
    const aws = Object.assign(new Error('denied'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 400, requestId: 'r1' },
    });
    expect(toPublicError(aws, 'history.getMessages', 'tbl').context).toMatchObject({
      operation: 'history.getMessages',
      tableName: 'tbl',
      awsErrorName: 'AccessDeniedException',
      requestId: 'r1',
      httpStatusCode: 400,
    });
  });

  /**
   * A branded error from an older release, or a duplicated copy of this
   * package, need not share this release's `context` shape at all — the base
   * error module documents that possibility. Stamping must not crash on one
   * that carries no `context` object to fill in.
   */
  it('leaves an old-shaped branded error alone when it carries no context object', () => {
    const foreign = Object.assign(new Error('boom'), {
      [Symbol.for('@farukada/aws-langgraph-dynamodb-ts/error')]: true,
    });
    expect(toPublicError(foreign, 'op', 'tbl')).toBe(foreign);
    expect((foreign as { context?: unknown }).context).toBeUndefined();
  });

  /**
   * `context.operation ??= operation` throws a `TypeError` in strict mode on a
   * frozen object that does not already carry `operation` — an assignment
   * `toPublicError` must never let escape, since it runs inside a `catch`
   * whose whole job is reporting the failure already in hand.
   */
  it('never throws for a context it cannot write to, frozen included', () => {
    const frozen = new DynamoDBLangGraphError('s3', ErrorCode.S3_OFFLOAD_FAILED, { key: 'k' });
    Object.freeze(frozen.context);
    let result: unknown;
    expect(() => {
      result = toPublicError(frozen, 'store.put', 'tbl');
    }).not.toThrow();
    expect(result).toBe(frozen);
    expect(frozen.context).toEqual({ key: 'k' });
  });

  it('guards a synchronous method the same way, and returns what it returns', () => {
    expect(
      thrownBy(() =>
        guardPublicSync(
          'saver.destroy',
          () => {
            throw new Error('closed');
          },
          'tbl',
        ),
      ),
    ).toMatchObject({
      code: ErrorCode.UNEXPECTED_ERROR,
      context: { operation: 'saver.destroy', tableName: 'tbl' },
    });
    expect(guardPublicSync('x', () => 7)).toBe(7);
  });
});
