import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: StoreContext['client'], extra?: Partial<StoreContext>): StoreContext {
  return { client, tableName: 'store', serde: JSON_SERDE, logger: SILENT_LOGGER, ...extra };
}
const op = (over) => ({
  namespace: ['users', 'u1'],
  key: 'profile',
  value: { name: 'Faruk' },
  ...over,
});

describe('putItem', () => {
  it('writes a new item, defaulting createdAt to now', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    await putItem(context(client), op({}));
    const item = mock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item.PK).toBe('users');
    expect(item.SK).toBe('u1#profile');
    expect(item.createdAt).toBe(item.updatedAt);
    expect(item.embedding).toBeUndefined();
  });

  it('preserves createdAt across updates', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { createdAt: '2000-01-01T00:00:00.000Z' } });
    mock.on(PutCommand).resolves({});
    await putItem(context(client), op({}));
    const item = mock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item.createdAt).toBe('2000-01-01T00:00:00.000Z');
    expect(item.updatedAt).not.toBe(item.createdAt);
  });

  it('deletes when value is null', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).resolves({});
    await putItem(context(client), op({ value: null }));
    expect(mock.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({
      PK: 'users',
      SK: 'u1#profile',
    });
  });

  it('rejects an invalid namespace element', async () => {
    const { client } = createStrictDocumentMock();
    try {
      await putItem(context(client), op({ namespace: ['a#b'] }));
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
    }
  });

  it('computes an embedding when an index is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]) };
    await putItem(context(client, { index: { dims: 2, embeddings: embeddings as never } }), op({}));
    expect(mock.commandCalls(PutCommand)[0].args[0].input.Item.embedding).toEqual([0.1, 0.2]);
  });

  it('skips embedding when index is false for the item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn() };
    await putItem(
      context(client, { index: { dims: 2, embeddings: embeddings as never } }),
      op({ index: false }),
    );
    expect(embeddings.embedQuery).not.toHaveBeenCalled();
    expect(mock.commandCalls(PutCommand)[0].args[0].input.Item.embedding).toBeUndefined();
  });

  it('uses a per-item index field override', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([1, 2]) };
    await putItem(
      context(client, { index: { dims: 2, embeddings: embeddings as never } }),
      op({ value: { name: 'Faruk', bio: 'builds things' }, index: ['bio'] }),
    );
    expect(embeddings.embedQuery).toHaveBeenCalledWith('builds things');
  });

  it('rethrows a write failure without cleanup when no offloader is set', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));
    await expect(putItem(context(client), op({}))).rejects.toThrow('down');
  });

  it('stamps ttl when configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    await putItem(context(client, { ttl: { seconds: 100 } }), op({}));
    expect(typeof mock.commandCalls(PutCommand)[0].args[0].input.Item.ttl).toBe('number');
  });

  it('cleans up offloaded objects when the write fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts) => parts.join('/'),
      upload: async (key) => key,
      deleteBatch: jest.fn().mockResolvedValue([]),
    };
    await expect(
      putItem(context(client, { offloader: offloader as never }), op({})),
    ).rejects.toThrow('boom');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['users/u1/profile']);
  });

  it('sends the embedding to a vector backend instead of storing it on the item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0.5, 0.6]) };
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: embeddings as never },
        vectorBackend: vectorBackend as never,
      }),
      op({}),
    );
    expect(mock.commandCalls(PutCommand)[0].args[0].input.Item.embedding).toBeUndefined();
    expect(vectorBackend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'profile', [0.5, 0.6]);
  });

  it('removes the backend vector when a re-put yields no embedding (index:false)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { createdAt: '2000-01-01T00:00:00.000Z' } });
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn() };
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: embeddings as never },
        vectorBackend: vectorBackend as never,
      }),
      op({ index: false }),
    );
    expect(vectorBackend.upsert).not.toHaveBeenCalled();
    expect(vectorBackend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
  });

  it('deletes from the vector backend when removing an item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).resolves({});
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(context(client, { vectorBackend: vectorBackend as never }), op({ value: null }));
    expect(vectorBackend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
  });
});
