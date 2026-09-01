import {
  AbortError,
  BatchWriteAllIncompleteError,
  BatchWriteIncompleteError,
  CompensationFailedError,
  ConflictError,
  DynamoDBChatMessageHistory,
  DynamoDBFactory,
  DynamoDBLangGraphError,
  DynamoDBSaver,
  DynamoDBSessionChatMessageHistory,
  DynamoDBStore,
  ErrorCode,
  isDynamoDBLangGraphError,
  ResultTruncatedError,
  RetryExhaustedError,
  UpstreamError,
  ValidationError,
  redactLogger,
  redactSecrets,
} from '../../src/index';

describe('public entry point', () => {
  it('exports the adapter classes', () => {
    expect(DynamoDBSaver.prototype.getTuple).toBeDefined();
    expect(DynamoDBStore.prototype.batch).toBeDefined();
    expect(DynamoDBChatMessageHistory.prototype.forSession).toBeDefined();
    expect(DynamoDBSessionChatMessageHistory.prototype.getMessages).toBeDefined();
    expect(DynamoDBFactory.prototype.createAll).toBeDefined();
  });

  it('exports the full error model', () => {
    expect(ErrorCode.VALIDATION).toBe('VALIDATION');
    for (const ErrorClass of [ValidationError, ConflictError, RetryExhaustedError, AbortError]) {
      expect(new ErrorClass('x')).toBeInstanceOf(DynamoDBLangGraphError);
    }
    expect(new BatchWriteIncompleteError(1, [], 3)).toBeInstanceOf(DynamoDBLangGraphError);
    expect(new BatchWriteAllIncompleteError(1, 2, [new Error('x')], 25)).toBeInstanceOf(
      DynamoDBLangGraphError,
    );
    expect(new ResultTruncatedError('maxItems', 1)).toBeInstanceOf(DynamoDBLangGraphError);
    expect(new CompensationFailedError(new Error('a'), new Error('b'))).toBeInstanceOf(
      DynamoDBLangGraphError,
    );
    expect(new UpstreamError(new Error('sdk'), 'op')).toBeInstanceOf(DynamoDBLangGraphError);
    expect(ErrorCode.UPSTREAM).toBe('UPSTREAM');
  });

  it('names the base error with the same DynamoDB casing as every other export (CORE-15)', () => {
    expect(new DynamoDBLangGraphError('m', ErrorCode.VALIDATION).name).toBe(
      'DynamoDBLangGraphError',
    );
    expect(new ValidationError('x').name).toBe('ValidationError');
  });

  it('exports the brand guard so consumers can detect library errors across package copies', () => {
    expect(isDynamoDBLangGraphError(new ValidationError('x'))).toBe(true);
    expect(isDynamoDBLangGraphError(new Error('x'))).toBe(false);
  });

  it('exports the logging redaction helpers', () => {
    expect(redactSecrets({ token: 'secret', keep: 'ok' })).toEqual({
      token: '[REDACTED]',
      keep: 'ok',
    });
    const calls: string[] = [];
    const logger = {
      info: () => {},
      warn: (m: string) => calls.push(m),
      error: () => {},
      debug: () => {},
    };
    redactLogger(logger).warn('hello', { password: 'p' });
    expect(calls).toEqual(['hello']);
  });
});
