import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { cleanUpS3Orphans } from '../../../../src/shared/codec/s3/orphans';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

jest.mock('../../../../src/shared/codec/s3/orphans', () => ({
  cleanUpS3Orphans: jest.fn(async () => undefined),
}));

const cleanUpMock = cleanUpS3Orphans as jest.MockedFunction<typeof cleanUpS3Orphans>;

const previous = {
  location: PayloadLocation.S3,
  serdeType: 'json',
  compressed: false,
  s3Key: 'p/previous.bin',
};

const offloader = {
  shouldOffload: () => false,
  buildKey: (parts: readonly string[]) => parts.join('/'),
  upload: async (key: string) => key,
  deleteBatch: jest.fn(),
  ownsKey: () => true,
};

function context(client: StoreContext['client']): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
    offloader: offloader as never,
  };
}

afterEach(() => cleanUpMock.mockClear());

describe('store put/delete bind row-sourced S3 keys to the item (SEC-03)', () => {
  it('cleans up the superseded object of an overwrite under the namespace/key scope', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { createdAt: 'c', value: previous, rev: 'r0' } });
    mock.on(PutCommand).resolves({});
    await putItem(context(client), {
      namespace: ['users', 'u1'],
      key: 'profile',
      value: { name: 'x' },
    });
    expect(cleanUpMock).toHaveBeenCalledWith(
      expect.anything(),
      ['p/previous.bin'],
      'store.put.overwrite',
      expect.anything(),
      { scope: ['users', 'u1', 'profile'] },
    );
  });

  it("cleans up the deleted item's object under the namespace/key scope", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).resolves({ Attributes: { value: previous } });
    await putItem(context(client), { namespace: ['users', 'u1'], key: 'profile', value: null });
    expect(cleanUpMock).toHaveBeenCalledWith(
      expect.anything(),
      ['p/previous.bin'],
      'store.delete',
      expect.anything(),
      { scope: ['users', 'u1', 'profile'] },
    );
  });
});
