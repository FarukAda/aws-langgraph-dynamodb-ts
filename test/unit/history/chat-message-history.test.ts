import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  DynamoDBDocument,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { HumanMessage } from '@langchain/core/messages';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBChatMessageHistory } from '../../../src/history/chat-message-history';
import { DynamoDBSessionChatMessageHistory } from '../../../src/history/session-adapter';
import { JSON_SERDE } from '../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { createStrictDocumentMock, fakeMiddlewareStack } from '../../shared/helpers/ddb-mock';

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

function history(client: DynamoDBDocument) {
  return new DynamoDBChatMessageHistory({ tableName: 'history', client, serde: JSON_SERDE });
}

describe('DynamoDBChatMessageHistory', () => {
  it('addMessage then getMessages round-trips through DynamoDB', async () => {
    const { client, mock } = createStrictDocumentMock();
    let written: unknown[] = [];
    mock
      .on(TransactWriteCommand)
      .callsFake((input: { TransactItems: { Put: { Item: unknown } }[] }) => {
        written = input.TransactItems.slice(1).map((t) => t.Put.Item);
        return {};
      });
    mock.on(QueryCommand).callsFake(() => ({ Items: written }));
    const h = history(client);
    await h.addMessage('sess-1', new HumanMessage('hello'));
    const messages = await h.getMessages('sess-1');
    expect(messages.map((m) => m.content)).toEqual(['hello']);
  });

  it('clear deletes every item in the session partition', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'sess-1',
          SK: 'HISTORY#MSG#01A',
          message: { location: 'INLINE', serdeType: 'json', bytes: new Uint8Array() },
        },
        { PK: 'sess-1', SK: 'HISTORY#SESSION' },
      ],
    });
    mock.on(DeleteCommand).resolves({});
    await history(client).clear('sess-1');
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(2);
  });

  it('listSessions scans for sessions', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [
        {
          PK: 'HIST#s',
          SK: 'HISTORY#SESSION',
          sessionId: 's',
          messageCount: 1,
          createdAt: 'c',
          updatedAt: 'u',
        },
      ],
    });
    const { sessions: sessions } = await history(client).listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['s']);
  });

  it('reconcileMessageCount recomputes and writes back the stored count', async () => {
    const { client, mock } = createStrictDocumentMock();
    /** The repair pins its write to the count the row held, so it reads that first. */
    mock.on(GetCommand).resolves({ Item: { messageCount: 0 } });
    const counted = { PK: 'HIST#sess-1', sessionId: 'sess-1', message: { location: 'INLINE' } };
    mock.on(QueryCommand).resolves({ Items: [{ ...counted, v: 1 }, counted] });
    mock.on(UpdateCommand).resolves({});
    await expect(history(client).reconcileMessageCount('sess-1')).resolves.toBe(2);
  });

  it('forSession returns a single-session adapter bound to the session', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const adapter = history(client).forSession('sess-9');
    expect(adapter).toBeInstanceOf(DynamoDBSessionChatMessageHistory);
    await adapter.addMessage(new HumanMessage('hi'));
    const item =
      mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![1].Put!.Item!;
    expect(item.PK).toBe('HIST#sess-9');
  });

  it('does not destroy an injected client but destroys an owned one', () => {
    const injected = createStrictDocumentMock();
    expect(() => history(injected.client).destroy()).not.toThrow();

    const destroy = jest.fn();
    const fake = { destroy, config: {}, middlewareStack: fakeMiddlewareStack(), send: jest.fn() };
    const owned = new DynamoDBChatMessageHistory({
      tableName: 'history',
      clientConfig: { region: 'us-east-1' },
      createClient: () => fake as never,
    });
    owned.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('ensureS3LifecycleRule provisions the rule when both s3 and ttl are configured', async () => {
    const { client } = createStrictDocumentMock();
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const h = new DynamoDBChatMessageHistory({
      tableName: 'history',
      client,
      serde: JSON_SERDE,
      logger,
      s3: { bucketName: 'b', createS3Client: () => new S3Client({ region: 'us-east-1' }) },
      ttl: { days: 30 },
    });
    /** The injected client has maxAttempts > 1, triggering a warning asynchronously during setup. */
    await new Promise((resolve) => setImmediate(resolve));
    logger.warn.mockClear();
    await h.ensureS3LifecycleRule();
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    /** A warn here would mean the versioning stub above was not the one consumed. */
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ensureS3LifecycleRule no-ops when ttl is not configured', async () => {
    const { client } = createStrictDocumentMock();
    const h = new DynamoDBChatMessageHistory({
      tableName: 'history',
      client,
      serde: JSON_SERDE,
      s3: { bucketName: 'b', createS3Client: () => new S3Client({ region: 'us-east-1' }) },
    });
    await expect(h.ensureS3LifecycleRule()).resolves.toBeUndefined();
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('ensureS3LifecycleRule no-ops when s3 is not configured', async () => {
    const { client } = createStrictDocumentMock();
    const h = new DynamoDBChatMessageHistory({
      tableName: 'history',
      client,
      serde: JSON_SERDE,
      ttl: { days: 30 },
    });
    await expect(h.ensureS3LifecycleRule()).resolves.toBeUndefined();
  });
});

describe('cancellation via { signal }', () => {
  it('rejects every long-running method before any DynamoDB call', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    controller.abort();
    const h = history(client);
    const options = { signal: controller.signal };
    const expectAborted = (promise: Promise<unknown>) =>
      expect(promise).rejects.toMatchObject({
        code: ErrorCode.ABORTED,
        name: 'DynamoDBLangGraphError',
      });
    await expectAborted(h.getMessages('s1', options));
    await expectAborted(h.addMessages('s1', [new HumanMessage('hi')], options));
    await expectAborted(h.addMessage('s1', new HumanMessage('hi'), options));
    await expectAborted(h.clear('s1', options));
    await expectAborted(h.listSessions(options));
    await expectAborted(h.reconcileMessageCount('s1', options));
    expect(mock.calls()).toHaveLength(0);
  });

  /**
   * The wait between retries calls `removeEventListener` from inside its
   * timer. A signal lacking it passed the old shape check, so one throttled
   * read threw from that timer, an uncaught exception, and the call never
   * settled.
   */
  it('refuses a signal without removeEventListener before any request, naming signal', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.rejects(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    const h = new DynamoDBChatMessageHistory({
      tableName: 'history',
      client,
      retry: { maxAttempts: 2 },
    });
    const signal = { aborted: false, addEventListener: () => {} } as never;
    await expect(h.getMessages('s1', { signal })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'signal' },
    });
    expect(mock.calls()).toHaveLength(0);
  });
});

describe('options shape', () => {
  const bogus = { bogus: true } as never;
  const rejectsUnknownKey = (promise: Promise<unknown>) =>
    expect(promise).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'options.bogus' },
    });

  it('getMessages refuses a key this package does not read', async () => {
    const { client } = createStrictDocumentMock();
    await rejectsUnknownKey(history(client).getMessages('s1', bogus));
  });

  /**
   * `before: null` passes the `!== undefined` guard and then used to reach
   * `null.getTime`, a bare `TypeError` the boundary branded `UNEXPECTED_ERROR`
   * instead of naming the caller's mistake.
   */
  it('getMessages refuses before: null rather than crashing on it', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      history(client).getMessages('s1', { before: null } as never),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'before' } });
  });

  it('listSessions refuses a key this package does not read', async () => {
    const { client } = createStrictDocumentMock();
    await rejectsUnknownKey(history(client).listSessions(bogus));
  });

  it('listSessions refuses a non-integer maxItems or maxIterations', async () => {
    const { client } = createStrictDocumentMock();
    await expect(history(client).listSessions({ maxItems: 1.5 })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'maxItems' },
    });
    await expect(history(client).listSessions({ maxIterations: 1.5 })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'maxIterations' },
    });
  });

  it('addMessages refuses a key this package does not read', async () => {
    const { client } = createStrictDocumentMock();
    await rejectsUnknownKey(history(client).addMessages('s1', [new HumanMessage('hi')], bogus));
  });

  it('addMessage refuses a key this package does not read', async () => {
    const { client } = createStrictDocumentMock();
    await rejectsUnknownKey(history(client).addMessage('s1', new HumanMessage('hi'), bogus));
  });

  it('clear refuses a key this package does not read', async () => {
    const { client } = createStrictDocumentMock();
    await rejectsUnknownKey(history(client).clear('s1', bogus));
  });

  it('reconcileMessageCount refuses a key this package does not read', async () => {
    const { client } = createStrictDocumentMock();
    await rejectsUnknownKey(history(client).reconcileMessageCount('s1', bogus));
  });
});

/**
 * `addMessages` validated each message once `messages` was known to be an
 * array, but never that it was one: a non-array reached `.length` directly
 * and raised a bare `TypeError`, branded `UNEXPECTED_ERROR` instead of naming
 * the caller's mistake.
 */
describe('addMessages messages validation', () => {
  it('refuses a messages that is not an array, naming it', async () => {
    const { client } = createStrictDocumentMock();
    for (const messages of ['x', null, undefined, {}]) {
      await expect(history(client).addMessages('s1', messages as never)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 'messages' },
      });
    }
  });

  /**
   * A hole in a sparse `messages` array used to survive both parse passes
   * (`map` keeps a hole, `forEach` skips one) and fail later with a raw
   * `TypeError`, reported as `UNEXPECTED_ERROR`.
   */
  it('refuses a hole in a sparse messages array, naming messages, before any write', async () => {
    const { client, mock } = createStrictDocumentMock();
    const sparse: HumanMessage[] = new Array<HumanMessage>(2);
    sparse[1] = new HumanMessage('hi');
    await expect(history(client).addMessages('s1', sparse)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'messages' },
      message: expect.stringContaining('messages[0]'),
    });
    expect(mock.calls()).toHaveLength(0);
  });

  it('accepts messages: [], a no-op that writes nothing', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(history(client).addMessages('s1', [])).resolves.toBeUndefined();
    expect(mock.calls()).toHaveLength(0);
  });

  it('accepts a valid message list and writes it', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await expect(
      history(client).addMessages('s1', [new HumanMessage('hi')]),
    ).resolves.toBeUndefined();
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });
});

/**
 * `listSessions` refused a `cursor` given without a configured `indexName`,
 * but with one set a non-string `cursor` reached the cursor decoder's
 * `Buffer.from` directly and raised a bare `TypeError`, branded
 * `UNEXPECTED_ERROR` instead of naming the caller's mistake.
 */
describe('listSessions cursor validation on the indexed path', () => {
  function indexedHistory(client: DynamoDBDocument) {
    return new DynamoDBChatMessageHistory({
      tableName: 'history',
      client,
      serde: JSON_SERDE,
      indexName: 'gsi1',
    });
  }

  it('refuses a cursor that is present and not a string, naming it', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      indexedHistory(client).listSessions({ cursor: 123 as never }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'cursor' } });
  });

  it('accepts a valid string cursor and pages from it', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const cursor = Buffer.from('2026-01-01T00:00:00.000Z#s1', 'utf8').toString('base64url');
    await expect(indexedHistory(client).listSessions({ cursor })).resolves.toEqual({
      sessions: [],
    });
  });
});

describe('forSession checks its arguments when it is called', () => {
  const refusal = (field: string) =>
    expect.objectContaining({
      code: ErrorCode.VALIDATION,
      context: expect.objectContaining({ field }),
    });

  /** A synchronous throw, not a rejection: `forSession` returns an adapter, not a promise. */
  it('throws VALIDATION synchronously for a malformed sessionId', () => {
    const h = history(createStrictDocumentMock().client);
    expect(() => h.forSession('a#b')).toThrow(refusal('sessionId'));
    expect(() => h.forSession('')).toThrow(refusal('sessionId'));
    expect(() => h.forSession(42 as never)).toThrow(refusal('sessionId'));
  });

  it('throws VALIDATION synchronously for a malformed window', () => {
    const h = history(createStrictDocumentMock().client);
    expect(() => h.forSession('s1', 'x' as never)).toThrow(refusal('window'));
    expect(() => h.forSession('s1', { limt: 5 } as never)).toThrow(refusal('window.limt'));
    /** Zero too: this window feeds a model, and an empty one reads as a session that never was. */
    expect(() => h.forSession('s1', { limit: 0 })).toThrow(refusal('limit'));
    expect(() => h.forSession('s1', { limit: -1 })).toThrow(refusal('limit'));
  });

  /**
   * `forSession` runs on every request under `RunnableWithMessageHistory`, so
   * a malformed session id it refuses must say where — like every other
   * public method — rather than being the one silent public entry point.
   */
  it('names history.forSession and this table on the error it raises', () => {
    const h = history(createStrictDocumentMock().client);
    expect(() => h.forSession('a#b')).toThrow(
      expect.objectContaining({
        code: ErrorCode.VALIDATION,
        context: expect.objectContaining({
          field: 'sessionId',
          operation: 'history.forSession',
          tableName: 'history',
        }),
      }),
    );
  });
});

describe('bounded reads', () => {
  it('getMessages passes the window through and forSession binds a limit to the adapter', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const h = history(client);
    await h.getMessages('s1', { limit: 3 });
    expect(mock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      Limit: 3,
      ScanIndexForward: false,
    });
    await h.forSession('s1', { limit: 1 }).getMessages();
    expect(mock.commandCalls(QueryCommand)[1].args[0].input.Limit).toBe(1);
    await h.forSession('s1').getMessages();
    expect(mock.commandCalls(QueryCommand)[2].args[0].input.Limit).toBeUndefined();
  });
});
