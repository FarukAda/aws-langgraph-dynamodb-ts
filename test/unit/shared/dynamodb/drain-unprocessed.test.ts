import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

import { drainUnprocessedWrites } from '../../../../src/shared/dynamodb/drain-unprocessed';
import { BatchWriteIncompleteError } from '../../../../src/shared/errors/errors';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const put = (pk: string) => ({ PutRequest: { Item: { pk } } });

describe('drainUnprocessedWrites', () => {
  it('re-submits UnprocessedItems until empty', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { t: [put('a')] } })
      .resolvesOnce({ UnprocessedItems: {} });
    await expect(
      drainUnprocessedWrites(client, 't', [put('a')], { rng: () => 0 }),
    ).resolves.toBeUndefined();
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });

  it('is a no-op for an empty request list', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(drainUnprocessedWrites(client, 't', [])).resolves.toBeUndefined();
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('throws BatchWriteIncompleteError after the retry budget', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: { t: [put('a')] } });
    await expect(
      drainUnprocessedWrites(client, 't', [put('a')], { rng: () => 0, maxRetries: 1 }),
    ).rejects.toBeInstanceOf(BatchWriteIncompleteError);
  });
});
