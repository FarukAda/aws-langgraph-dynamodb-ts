import * as api from '../../src/index';
import {
  DynamoDBChatMessageHistory,
  DynamoDBFactory,
  DynamoDBLangGraphError,
  DynamoDBSaver,
  DynamoDBSessionChatMessageHistory,
  DynamoDBStore,
  ErrorCode,
  isDynamoDBLangGraphError,
  backfillRecencyIndex,
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

  /**
   * The operator tool has to be reachable from the package entry point, not
   * only from its own module: an operator runs it before turning the index on.
   */
  it('exports the recency-index backfill tool', async () => {
    expect(typeof backfillRecencyIndex).toBe('function');
    const client = { scan: jest.fn(), update: jest.fn() } as never;
    await expect(
      backfillRecencyIndex({ client, tableName: 'tbl', pageSize: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'pageSize' } });
  });

  it('exports the full error model', () => {
    expect(ErrorCode.VALIDATION).toBe('VALIDATION');
    expect(new DynamoDBLangGraphError('x', ErrorCode.VALIDATION)).toBeInstanceOf(
      DynamoDBLangGraphError,
    );
  });

  /**
   * One class, distinguished by its code: a second exported error class would
   * invite `instanceof`, which fails across two copies of the package and
   * across realms.
   */
  it('exports exactly one error class', () => {
    expect(Object.keys(api).filter((name) => /^[A-Z][A-Za-z]*Error$/.test(name))).toEqual([
      'DynamoDBLangGraphError',
    ]);
  });

  it('names the error with the same DynamoDB casing as every other export', () => {
    expect(new DynamoDBLangGraphError('m', ErrorCode.VALIDATION).name).toBe(
      'DynamoDBLangGraphError',
    );
  });

  it('exports the brand guard so consumers can detect library errors across package copies', () => {
    expect(isDynamoDBLangGraphError(new DynamoDBLangGraphError('x', ErrorCode.VALIDATION))).toBe(
      true,
    );
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
