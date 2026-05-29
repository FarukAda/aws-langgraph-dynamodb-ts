import { BatchGetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

import {
  drainUnprocessedKeys,
  drainUnprocessedWrites,
} from '../../../../src/shared/dynamodb/drain-unprocessed';
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

describe('drainUnprocessedKeys', () => {
  it('collects Responses across UnprocessedKeys rounds', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { t: [{ pk: 'a' }] },
        UnprocessedKeys: { t: { Keys: [{ pk: 'b' }] } },
      })
      .resolvesOnce({ Responses: { t: [{ pk: 'b' }] }, UnprocessedKeys: {} });
    const items = await drainUnprocessedKeys(client, 't', [{ pk: 'a' }, { pk: 'b' }], {
      rng: () => 0,
    });
    expect(items).toEqual([{ pk: 'a' }, { pk: 'b' }]);
  });

  it('tolerates a round that returns no Responses for the table', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(BatchGetCommand)
      .resolvesOnce({ UnprocessedKeys: { t: { Keys: [{ pk: 'b' }] } } })
      .resolvesOnce({ Responses: { t: [{ pk: 'b' }] }, UnprocessedKeys: {} });
    const items = await drainUnprocessedKeys(client, 't', [{ pk: 'b' }], { rng: () => 0 });
    expect(items).toEqual([{ pk: 'b' }]);
  });

  it('is a no-op for an empty key list', async () => {
    const { client, mock } = createStrictDocumentMock();
    const items = await drainUnprocessedKeys(client, 't', []);
    expect(items).toEqual([]);
    expect(mock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it('returns the items collected so far when the retry budget is exhausted', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchGetCommand).resolves({
      Responses: { t: [{ pk: 'a' }] },
      UnprocessedKeys: { t: { Keys: [{ pk: 'b' }] } },
    });
    const items = await drainUnprocessedKeys(client, 't', [{ pk: 'a' }, { pk: 'b' }], {
      rng: () => 0,
      maxRetries: 1,
    });
    expect(items).toEqual([{ pk: 'a' }, { pk: 'a' }]);
    expect(mock.commandCalls(BatchGetCommand)).toHaveLength(2);
  });
});
