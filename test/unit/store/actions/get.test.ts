import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ValidationError } from '../../../../src/shared/errors/errors';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { getItem } from '../../../../src/store/actions/get';
import { buildStoreItem } from '../../../../src/store/internal/item-mapper';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: StoreContext['client']): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
  };
}

describe('getItem', () => {
  it('returns null when the item is absent', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    expect(await getItem(context(client), ['users', 'u1'], 'profile')).toBeNull();
  });

  it('returns null and warns for a row that is not a store item (C2, I7)', async () => {
    // A WRITE row from the checkpointer carries a `value` PayloadDescriptor in
    // the identical shape a store item uses, so an unchecked cast used to
    // decode it successfully and hand another thread's pending write back as
    // the caller's own value.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        PK: 'STORE#users',
        SK: 'u1#profile',
        taskId: 'task-1',
        channel: 'secret-channel',
        value: { location: 'INLINE', serdeType: 'json', bytes: new Uint8Array() },
      },
    });
    const warn = jest.fn();
    const ctx = { ...context(client), logger: { ...SILENT_LOGGER, warn } };
    await expect(getItem(ctx, ['users', 'u1'], 'profile')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('throws ValidationError on an empty namespace', async () => {
    const { client } = createStrictDocumentMock();
    await expect(getItem(context(client), [], 'k1')).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when the key contains the reserved separator', async () => {
    const { client } = createStrictDocumentMock();
    await expect(getItem(context(client), ['users'], 'a#b')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('returns the decoded item with namespace, key, value, and dates', async () => {
    const { client, mock } = createStrictDocumentMock();
    const record = await buildStoreItem(
      context(client),
      ['users', 'u1'],
      'profile',
      { name: 'Faruk' },
      {
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      },
    );
    mock.on(GetCommand).resolves({ Item: record });
    const item = await getItem(context(client), ['users', 'u1'], 'profile');
    expect(item?.value).toEqual({ name: 'Faruk' });
    expect(item?.key).toBe('profile');
    expect(item?.namespace).toEqual(['users', 'u1']);
    expect(mock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({
      PK: 'STORE#users',
      SK: 'u1#profile',
    });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });
});
