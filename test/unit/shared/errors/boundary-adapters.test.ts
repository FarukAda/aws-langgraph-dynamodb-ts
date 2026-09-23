import { GetCommand, QueryCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../../../src/checkpointer/saver';
import { DynamoDBChatMessageHistory } from '../../../../src/history/chat-message-history';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { DynamoDBStore } from '../../../../src/store/store';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const checkpoint: Checkpoint = {
  v: 4,
  id: 'ckpt-1',
  ts: '',
  channel_values: {},
  channel_versions: {},
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };

/** A non-retryable SDK error, as the DynamoDB client would raise it. */
function sdkError(): Error {
  return Object.assign(new Error('The security token is invalid'), {
    name: 'UnrecognizedClientException',
    $metadata: { requestId: 'req-1', httpStatusCode: 400 },
  });
}

const wrapped = (operation: string, cause: Error) => ({
  name: 'DynamoDBLangGraphError',
  code: ErrorCode.ACCESS_DENIED,
  context: {
    operation,
    awsErrorName: 'UnrecognizedClientException',
    requestId: 'req-1',
    httpStatusCode: 400,
  },
  cause,
});

describe('public error boundary (CORE-01)', () => {
  it('DynamoDBSaver wraps a raw SDK error from put and passes a VALIDATION error through', async () => {
    const { client, mock } = createStrictDocumentMock();
    const cause = sdkError();
    mock.on(TransactWriteCommand).rejects(cause);
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde: JSON_SERDE });
    await expect(
      saver.put({ configurable: { thread_id: 't' } }, checkpoint, metadata),
    ).rejects.toMatchObject(wrapped('saver.put', cause));
    await expect(saver.put({ configurable: {} }, checkpoint, metadata)).rejects.toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.VALIDATION,
    });
  });

  it('DynamoDBSaver wraps a raw failure raised while iterating list()', async () => {
    const { client, mock } = createStrictDocumentMock();
    const cause = sdkError();
    mock.on(QueryCommand).rejects(cause);
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde: JSON_SERDE });
    await expect(
      (async () => {
        for await (const tuple of saver.list({ configurable: { thread_id: 't' } })) void tuple;
      })(),
    ).rejects.toMatchObject(wrapped('saver.list', cause));
  });

  it('DynamoDBStore wraps a raw SDK error from a get that went through batch()', async () => {
    const { client, mock } = createStrictDocumentMock();
    const cause = sdkError();
    mock.on(GetCommand).rejects(cause);
    const store = new DynamoDBStore({ tableName: 'store', client });
    await expect(store.get(['n'], 'k')).rejects.toMatchObject(wrapped('store.get', cause));
  });

  /**
   * The four single-operation methods share `batch`'s machinery and must not
   * share its brand: an operator counting failures by `context.operation` is
   * told which method the caller called, and the README's error table names
   * the four separately.
   */
  it('DynamoDBStore brands a single-operation failure with the method the caller called', async () => {
    const { client, mock } = createStrictDocumentMock();
    const cause = sdkError();
    mock.on(GetCommand).rejects(cause);
    mock.on(ScanCommand).rejects(cause);
    const store = new DynamoDBStore({ tableName: 'store', client });
    await expect(store.put(['n'], 'k', { v: 1 })).rejects.toMatchObject(
      wrapped('store.put', cause),
    );
    await expect(store.delete(['n'], 'k')).rejects.toMatchObject(wrapped('store.delete', cause));
    await expect(store.listNamespaces()).rejects.toMatchObject(
      wrapped('store.listNamespaces', cause),
    );
    await expect(store.batch([{ namespace: ['n'], key: 'k' }])).rejects.toMatchObject(
      wrapped('store.batch', cause),
    );
  });

  it('DynamoDBChatMessageHistory wraps a raw SDK error from getMessages', async () => {
    const { client, mock } = createStrictDocumentMock();
    const cause = sdkError();
    mock.on(QueryCommand).rejects(cause);
    const history = new DynamoDBChatMessageHistory({
      tableName: 'hist',
      client,
      serde: JSON_SERDE,
    });
    await expect(history.getMessages('s1')).rejects.toMatchObject(
      wrapped('history.getMessages', cause),
    );
  });
});
