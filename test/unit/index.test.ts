import {
  AbortError,
  BatchWriteIncompleteError,
  ConflictError,
  DynamoDbLangGraphError,
  DynamoDBChatMessageHistory,
  DynamoDBFactory,
  DynamoDBSaver,
  DynamoDBSessionChatMessageHistory,
  DynamoDBStore,
  ErrorCode,
  ResultTruncatedError,
  RetryExhaustedError,
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
      expect(new ErrorClass('x')).toBeInstanceOf(DynamoDbLangGraphError);
    }
    expect(new BatchWriteIncompleteError(1, [], 3)).toBeInstanceOf(DynamoDbLangGraphError);
    expect(new ResultTruncatedError('maxItems', 1)).toBeInstanceOf(DynamoDbLangGraphError);
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
