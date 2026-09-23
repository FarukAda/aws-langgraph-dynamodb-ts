import {
  MAX_LOGGED_VALUE_CHARS,
  MAX_RELAYED_MESSAGE_CHARS,
} from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { wrapForeignError } from '../../../../src/shared/errors/wrap-error';
import { truncateForLog, truncateRelayedText } from '../../../../src/shared/logging/truncate';

describe('wrapForeignError', () => {
  const throttled = Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 400, requestId: 'req-1' },
  });

  it('gives an AWS failure its classified code and lifts its diagnostics', () => {
    const error = wrapForeignError(throttled, 'store.get');
    expect(error).toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.THROTTLED,
      context: {
        operation: 'store.get',
        awsErrorName: 'ThrottlingException',
        requestId: 'req-1',
        httpStatusCode: 400,
      },
      message: 'store.get: ThrottlingException: Rate exceeded',
    });
    expect(error.cause).toBe(throttled);
  });

  it('calls a collaborator failure unexpected and names no AWS field', () => {
    const error = wrapForeignError(new TypeError('vector backend broke'), 'store.search');
    expect(error.code).toBe(ErrorCode.UNEXPECTED_ERROR);
    expect(error.context).toEqual({ operation: 'store.search' });
  });

  it('redacts a credential the cause quoted, and survives a thrown non-Error', () => {
    const leaky = Object.assign(new Error('Credential=AKIAIOSFODNN7EXAMPLE/20260101'), {
      name: 'SignatureDoesNotMatch',
    });
    expect(wrapForeignError(leaky, 'op').message).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(wrapForeignError('boom' as never, 'op')).toMatchObject({
      code: ErrorCode.UNEXPECTED_ERROR,
    });
    expect(wrapForeignError(null as never, 'op').cause).toBeDefined();
  });
});

/**
 * `classifyAwsError` reads only an error's own fields, while the retry layer
 * walks the whole `cause` chain (`isRetryableError` in
 * `shared/dynamodb/retry.ts`). Without a matching walk here, an AWS
 * or network failure that reaches the boundary one level down — wrapped by a
 * caller's own error, or sitting under an SDK error's own transport `cause` —
 * classified as `UNEXPECTED_ERROR`, even though the same failure would have
 * told the retry layer to retry.
 */
describe('wrapForeignError classifies a foreign or network failure found down the cause chain', () => {
  it('classifies a wrapped ECONNRESET', () => {
    const network = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const outer = new Error('request failed', { cause: network });

    const error = wrapForeignError(outer, 'store.put');

    expect(error.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(error.cause).toBe(outer);
  });

  it('classifies a wrapped ThrottlingException, lifting its diagnostics', () => {
    const sdkError = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400, requestId: 'req-2' },
    });
    const outer = new Error('operation failed', { cause: sdkError });

    const error = wrapForeignError(outer, 'store.put');

    expect(error.code).toBe(ErrorCode.THROTTLED);
    expect(error.context).toEqual({
      operation: 'store.put',
      awsErrorName: 'ThrottlingException',
      requestId: 'req-2',
      httpStatusCode: 400,
    });
    expect(error.cause).toBe(outer);
  });

  it('stays UNEXPECTED_ERROR when no node in the chain is AWS- or network-shaped', () => {
    const innermost = new Error('disk full');
    const middle = new Error('flush failed', { cause: innermost });
    const outer = new Error('write failed', { cause: middle });

    const error = wrapForeignError(outer, 'store.put');

    expect(error.code).toBe(ErrorCode.UNEXPECTED_ERROR);
    expect(error.context).toEqual({ operation: 'store.put' });
  });

  it('stops the walk at a null cause rather than reading a name off it', () => {
    const outer = new Error('outer', { cause: null });

    const error = wrapForeignError(outer, 'store.put');

    expect(error.code).toBe(ErrorCode.UNEXPECTED_ERROR);
  });

  it('stops the walk at a cause that is not error-shaped rather than reading its own cause', () => {
    const outer = new Error('outer', { cause: 'not an object' });

    const error = wrapForeignError(outer, 'store.put');

    expect(error.code).toBe(ErrorCode.UNEXPECTED_ERROR);
  });

  it('stops at a cycle in the cause chain rather than looping', () => {
    const a: Error = new Error('a');
    const b: Error = new Error('b');
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });

    const error = wrapForeignError(a, 'store.put');

    expect(error.code).toBe(ErrorCode.UNEXPECTED_ERROR);
  });
});

describe('wrapForeignError bounds what it quotes', () => {
  /**
   * The name takes the identifier cap because it is one; the text takes the
   * relay cap because it is prose. `cause` and `context.awsErrorName` keep the
   * name whole, because the structured fields are what a caller branches on
   * and the message never was.
   */
  it('cuts an oversized name at the log cap and its text at the relay cap', () => {
    const name = 'N'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const text = 'm'.repeat(MAX_RELAYED_MESSAGE_CHARS * 4);
    const below = Object.assign(new Error(text), {
      name,
      $metadata: { httpStatusCode: 400, requestId: 'req-1' },
    });
    const error = wrapForeignError(below, 'store.get');
    expect(error.message).toBe(`store.get: ${truncateForLog(name)}: ${truncateRelayedText(text)}`);
    expect(error.message).not.toContain(name);
    expect(error.cause).toBe(below);
    expect((error.cause as Error).name).toBe(name);
    expect(error.context.awsErrorName).toBe(name);
  });
});
