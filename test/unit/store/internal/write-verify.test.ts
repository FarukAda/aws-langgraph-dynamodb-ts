import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { writeLandedAt } from '../../../../src/store/internal/write-verify';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: StoreContext['client']): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
  };
}

describe('writeLandedAt', () => {
  it('returns true when the row already holds the expected S3 key', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        value: {
          location: PayloadLocation.S3,
          serdeType: 'json',
          compressed: false,
          s3Key: 'k.bin',
        },
      },
    });
    await expect(writeLandedAt(context(client), { PK: 'p', SK: 's' }, 'k.bin')).resolves.toBe(true);
  });

  it('returns false when the row holds a different S3 key', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        value: {
          location: PayloadLocation.S3,
          serdeType: 'json',
          compressed: false,
          s3Key: 'other.bin',
        },
      },
    });
    await expect(writeLandedAt(context(client), { PK: 'p', SK: 's' }, 'k.bin')).resolves.toBe(
      false,
    );
  });

  it('returns false when the row does not exist', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    await expect(writeLandedAt(context(client), { PK: 'p', SK: 's' }, 'k.bin')).resolves.toBe(
      false,
    );
  });

  it('returns false (fails safe) when the confirmation read itself fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));
    await expect(writeLandedAt(context(client), { PK: 'p', SK: 's' }, 'k.bin')).resolves.toBe(
      false,
    );
  });
});
