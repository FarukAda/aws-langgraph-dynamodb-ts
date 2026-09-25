import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { cleanUpS3Orphans } from '../../../../src/shared/codec/s3/offloader';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import {
  answerDeleteReads,
  createStrictDocumentMock,
  observableRow,
} from '../../../shared/helpers/ddb-mock';
import { parsedPut } from '../../../shared/helpers/parsed-inputs';

jest.mock('../../../../src/shared/codec/s3/offloader', () => ({
  ...jest.requireActual('../../../../src/shared/codec/s3/offloader'),
  cleanUpS3Orphans: jest.fn(() => undefined),
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
  buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
  upload: (key: string) => key,
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

describe('store put/delete bind row-sourced S3 keys to the item', () => {
  it('cleans up the superseded object of an overwrite under the namespace/key scope', async () => {
    const { client, mock } = createStrictDocumentMock();
    /** `readExisting` sees the previous value; the read after the commit sees this put's inline one. */
    mock
      .on(GetCommand)
      .callsFake((input: { ProjectionExpression: string }) =>
        input.ProjectionExpression.startsWith('#c')
          ? { Item: { createdAt: 'c', value: previous, rev: 'r0' } }
          : { Item: { rev: 'r1', value: { location: PayloadLocation.INLINE } } },
      );
    mock.on(PutCommand).resolves({});
    await putItem(
      context(client),
      parsedPut({
        namespace: ['users', 'u1'],
        key: 'profile',
        value: { name: 'x' },
      }),
    );
    expect(cleanUpMock).toHaveBeenCalledWith(expect.anything(), {
      keys: ['p/previous.bin'],
      operation: 'store.put.overwrite',
      logger: expect.anything(),
      scope: ['users', 'u1', 'profile'],
    });
  });

  it("cleans up the deleted item's object under the namespace/key scope", async () => {
    const { client, mock } = createStrictDocumentMock();
    answerDeleteReads(mock, observableRow(previous));
    mock.on(TransactWriteCommand).resolves({});
    await putItem(
      context(client),
      parsedPut({ namespace: ['users', 'u1'], key: 'profile', value: null }),
    );
    expect(cleanUpMock).toHaveBeenCalledWith(expect.anything(), {
      keys: ['p/previous.bin'],
      operation: 'store.delete',
      logger: expect.anything(),
      scope: ['users', 'u1', 'profile'],
    });
  });
});
