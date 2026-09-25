import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBSaver } from '../../../../src/checkpointer/saver';
import type { DocItem } from '../../../../src/shared/dynamodb/client';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import type { Logger } from '../../../../src/shared/logging/logger';
import { DynamoDBStore } from '../../../../src/store/store';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { stubEmbeddings } from '../../../shared/helpers/embeddings-stub';

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

/**
 * A logger whose every level throws — a closed transport, a formatter that
 * meets a circular object, an assertion on a field it did not expect. `Logger`
 * is an interface a consumer implements, so it is the one piece of foreign code
 * every adapter calls, and it is called from inside the `catch` blocks the
 * adapters report their own failures from.
 */
function throwingLogger(): Logger {
  const fail = (): never => {
    throw new TypeError('logger transport closed');
  };
  return { info: fail, warn: fail, error: fail, debug: fail };
}

/** A throttle: transient, so the retry layer sleeps and announces the retry. */
function throttled(): Error {
  return Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' });
}

/** A permission failure: never retried, so a write fails on its first attempt. */
function accessDenied(): Error {
  return Object.assign(new Error('denied'), { name: 'AccessDenied' });
}

const checkpoint: Checkpoint = {
  v: 4,
  id: 'ckpt-1',
  ts: '2024-01-01T00:00:00.000Z',
  channel_values: {},
  channel_versions: {},
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };

/** The rejection a call answered with, or `undefined` when it resolved. */
async function rejection(run: Promise<unknown>): Promise<Error | undefined> {
  return run.then(
    () => undefined,
    (thrown: unknown) => thrown as Error,
  );
}

/**
 * A logger is arbitrary consumer code, and the three adapters call it from the
 * `catch` blocks they report failures from. A throw out of one of those calls
 * replaces the error the caller needs with the logger's own, and — at the retry
 * hook — ends an operation that was still succeeding.
 */
describe('a caller whose logger throws', () => {
  it('still sees store.get spend its retry budget on the throttle', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(throttled());
    const store = new DynamoDBStore({
      tableName: 'store',
      client,
      logger: throwingLogger(),
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const error = await rejection(store.get(['ns'], 'k'));
    expect(error).toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED, context: { attempts: 3 } });
    expect(mock.commandCalls(GetCommand)).toHaveLength(3);
  });

  it('still sees store.put succeed for a row DynamoDB already holds', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const backend = {
      upsert: jest.fn().mockRejectedValue(accessDenied()),
      query: jest.fn(),
      delete: jest.fn(),
    };
    const store = new DynamoDBStore({
      tableName: 'store',
      client,
      logger: throwingLogger(),
      vectorBackend: backend,
      index: { dims: 2, embeddings: stubEmbeddings([1, 0]) as never, fields: ['a'] },
    });
    await expect(store.put(['ns'], 'k', { a: 'text' })).resolves.toBeUndefined();
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
    expect(backend.upsert).toHaveBeenCalledTimes(1);
  });

  it('still sees saver.put report the checkpoint its own read proved committed', async () => {
    const { client, mock } = createStrictDocumentMock();
    let sent: DocItem | undefined;
    mock
      .on(TransactWriteCommand)
      .callsFake((input: { TransactItems: { Put: { Item: DocItem } }[] }) => {
        sent = input.TransactItems[0].Put.Item;
        throw accessDenied();
      });
    mock.on(GetCommand).callsFake(() => ({ Item: sent && { metadata: sent.metadata } }));
    s3Mock.on(PutObjectCommand).resolves({});
    const saver = new DynamoDBSaver({
      tableName: 'ckpt',
      client,
      logger: throwingLogger(),
      s3: {
        bucketName: 'b',
        thresholdBytes: 1,
        createS3Client: () => new S3Client({ region: 'us-east-1' }),
      },
    });
    const stored = await saver.put(
      { configurable: { thread_id: 't1', checkpoint_ns: '' } },
      checkpoint,
      metadata,
      {},
    );
    expect(stored.configurable?.checkpoint_id).toBe('ckpt-1');
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });
});
