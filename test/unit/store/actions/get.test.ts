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
  };
}

describe('getItem', () => {
  it('returns null when the item is absent', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    expect(await getItem(context(client), ['users', 'u1'], 'profile')).toBeNull();
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
      PK: 'users',
      SK: 'u1#profile',
    });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });
});
