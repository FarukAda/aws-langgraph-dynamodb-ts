import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import {
  answerDeleteReads,
  createStrictDocumentMock,
  observableRow,
} from '../../../shared/helpers/ddb-mock';
import { stubEmbeddings } from '../../../shared/helpers/embeddings-stub';

function context(client: StoreContext['client'], extra?: Partial<StoreContext>): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
    ...extra,
  };
}
const op = (over: Partial<PutOperation>): PutOperation => ({
  namespace: ['users', 'u1'],
  key: 'profile',
  value: { name: 'Faruk' },
  ...over,
});

/**
 * A configured `vectorBackend` takes one vector per item and the row carries
 * none, which is the opposite of the in-DynamoDB index. These pin that split,
 * and that a backend failure never fails the DynamoDB write it follows.
 */
describe('putItem with a vector backend', () => {
  it('sends the embedding to a vector backend instead of storing it on the item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = stubEmbeddings([0.5, 0.6]);
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: embeddings as never },
        vectorBackend: vectorBackend,
      }),
      op({}),
    );
    expect(mock.commandCalls(PutCommand)[0].args[0].input.Item!.embedding).toBeUndefined();
    expect(vectorBackend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'profile', [0.5, 0.6]);
  });

  /**
   * A backend takes one vector per item, so the per-item field override must
   * still narrow what that single vector is computed from.
   */
  it('honours a per-item index field override on the backend path', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = stubEmbeddings([0.5, 0.6]);
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: embeddings as never },
        vectorBackend: vectorBackend,
      }),
      op({ value: { name: 'Faruk', bio: 'builds things' }, index: ['bio'] }),
    );
    expect(embeddings.embedDocuments).toHaveBeenCalledWith(['builds things']);
    expect(vectorBackend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'profile', [0.5, 0.6]);
  });

  it('removes the backend vector when a re-put yields no embedding (index:false)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { createdAt: '2000-01-01T00:00:00.000Z' } });
    mock.on(PutCommand).resolves({});
    const embeddings = stubEmbeddings([0.5, 0.6]);
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: embeddings as never },
        vectorBackend: vectorBackend,
      }),
      op({ index: false }),
    );
    expect(vectorBackend.upsert).not.toHaveBeenCalled();
    expect(vectorBackend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
  });

  it('deletes from the vector backend when removing an item', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerDeleteReads(mock, observableRow());
    mock.on(TransactWriteCommand).resolves({});
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(context(client, { vectorBackend: vectorBackend }), op({ value: null }));
    expect(vectorBackend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
  });

  it('does not fail a put when the vector backend upsert throws', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = stubEmbeddings([0.5, 0.6]);
    const vectorBackend = {
      upsert: jest.fn().mockRejectedValue(new Error('backend down')),
      query: jest.fn(),
      delete: jest.fn(),
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend,
      logger,
    });
    await expect(putItem(ctx, op({}))).resolves.toBeUndefined();
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('vector-index sync failed'),
      expect.objectContaining({ key: 'profile' }),
    );
  });

  it('does not fail a delete when the vector backend delete throws', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerDeleteReads(mock, observableRow());
    mock.on(TransactWriteCommand).resolves({});
    const vectorBackend = {
      upsert: jest.fn(),
      query: jest.fn(),
      delete: jest.fn().mockRejectedValue(new Error('backend down')),
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const ctx = context(client, { vectorBackend: vectorBackend, logger });
    await expect(putItem(ctx, op({ value: null }))).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
