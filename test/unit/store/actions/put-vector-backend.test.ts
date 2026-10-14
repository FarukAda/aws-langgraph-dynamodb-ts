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
import { parsedPut } from '../../../shared/helpers/parsed-inputs';

function context(client: StoreContext['client'], extra?: Partial<StoreContext>): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    maxIterations: 1000,
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

/** A read's single projected attribute, as `readRow` names it. */
const projected = (input: {
  ExpressionAttributeNames?: Record<string, string>;
}): string | undefined => input.ExpressionAttributeNames?.['#a0'];

/**
 * Answer a put's two reads: the pre-read with `existing`, and the confirmation
 * that follows the write with the row as `standing` says — this put's own
 * revision (`'own'`, the normal case), another write's (`'other'`), or no
 * row at all (`'gone'`). The put's revision is read off the row it wrote.
 */
function answerPutReads(
  mock: ReturnType<typeof createStrictDocumentMock>['mock'],
  existing: object,
  standing: 'own' | 'other' | 'gone',
): void {
  let written: { rev?: string } | undefined;
  mock.on(PutCommand).callsFake((input) => {
    written = input.Item as { rev?: string };
    return {};
  });
  mock.on(GetCommand).callsFake((input) => {
    if (projected(input) !== 'rev') return existing;
    if (standing === 'gone') return {};
    return { Item: { rev: standing === 'own' ? written?.rev : 'someone-else' } };
  });
}

/**
 * A configured `vectorBackend` takes one vector per item and the row carries
 * none, which is the opposite of the in-DynamoDB index. These pin that split,
 * and that a backend failure never fails the DynamoDB write it follows.
 */
describe('putItem with a vector backend', () => {
  it('sends the embedding to a vector backend instead of storing it on the item', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerPutReads(mock, {}, 'own');
    const embeddings = stubEmbeddings([0.5, 0.6]);
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: embeddings as never },
        vectorBackend: vectorBackend,
      }),
      parsedPut(op({})),
    );
    expect(mock.commandCalls(PutCommand)[0].args[0].input.Item!.embeddings).toBeUndefined();
    expect(vectorBackend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'profile', [0.5, 0.6]);
  });

  /**
   * A backend takes one vector per item, so the per-item field override must
   * still narrow what that single vector is computed from.
   */
  it('honours a per-item index field override on the backend path', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerPutReads(mock, {}, 'own');
    const embeddings = stubEmbeddings([0.5, 0.6]);
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: embeddings as never },
        vectorBackend: vectorBackend,
      }),
      parsedPut(op({ value: { name: 'Faruk', bio: 'builds things' }, index: ['bio'] })),
    );
    expect(embeddings.embedDocuments).toHaveBeenCalledWith(['builds things']);
    expect(vectorBackend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'profile', [0.5, 0.6]);
  });

  it('removes the backend vector when a re-put yields no embedding (index:false)', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerPutReads(mock, { Item: { createdAt: '2000-01-01T00:00:00.000Z' } }, 'own');
    const embeddings = stubEmbeddings([0.5, 0.6]);
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: embeddings as never },
        vectorBackend: vectorBackend,
      }),
      parsedPut(op({ index: false })),
    );
    expect(vectorBackend.upsert).not.toHaveBeenCalled();
    expect(vectorBackend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
  });

  it('deletes from the vector backend when removing an item', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerDeleteReads(mock, observableRow());
    mock.on(TransactWriteCommand).resolves({});
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, { vectorBackend: vectorBackend }),
      parsedPut(op({ value: null })),
    );
    expect(vectorBackend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
  });

  it('does not fail a put when the vector backend upsert throws', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerPutReads(mock, {}, 'own');
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
    await expect(putItem(ctx, parsedPut(op({})))).resolves.toBeUndefined();
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('vector-index sync failed'),
      expect.objectContaining({ key: 'profile' }),
    );
  });

  /**
   * Two puts of one key can commit in one order and reach the backend in the
   * other: the backend would then hold the loser's vector — or none, after a
   * loser that indexed nothing — for an item whose row is the winner's. The
   * backend is written only while a fresh read finds the row at this put's own
   * revision; the twin of the delete path's confirmation.
   */
  it('leaves the backend alone when another write has superseded this put before its sync', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerPutReads(mock, {}, 'other');
    const embeddings = stubEmbeddings([0.5, 0.6]);
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: embeddings as never },
        vectorBackend,
        logger,
      }),
      parsedPut(op({})),
    );
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
    expect(vectorBackend.upsert).not.toHaveBeenCalled();
    expect(vectorBackend.delete).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'store.put: left the vector index to the write that superseded this put',
      { namespace: ['users', 'u1'], key: 'profile' },
    );
  });

  it('leaves the backend alone when the row is gone by the time the put would sync', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerPutReads(mock, {}, 'gone');
    const embeddings = stubEmbeddings([0.5, 0.6]);
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, { index: { dims: 2, embeddings: embeddings as never }, vectorBackend }),
      parsedPut(op({ index: false })),
    );
    expect(vectorBackend.delete).not.toHaveBeenCalled();
  });

  it('reads the row again before the sync, strongly consistently, and never without a backend', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerPutReads(mock, {}, 'own');
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: stubEmbeddings([1, 2]) as never },
        vectorBackend,
      }),
      parsedPut(op({})),
    );
    const confirmation = mock
      .commandCalls(GetCommand)
      .map((call) => call.args[0].input)
      .find((input) => projected(input) === 'rev');
    expect(confirmation?.ConsistentRead).toBe(true);

    const { client: plain, mock: plainMock } = createStrictDocumentMock();
    answerPutReads(plainMock, {}, 'own');
    await putItem(context(plain), parsedPut(op({})));
    expect(plainMock.commandCalls(GetCommand)).toHaveLength(1);
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
    await expect(putItem(ctx, parsedPut(op({ value: null })))).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
