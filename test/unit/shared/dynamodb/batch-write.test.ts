import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

import { batchWriteAll } from '../../../../src/shared/dynamodb/batch-write';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const put = (pk: string) => ({ PutRequest: { Item: { pk } } });

describe('batchWriteAll', () => {
  it('chunks into batches of 25', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const requests = Array.from({ length: 30 }, (_, i) => put(String(i)));
    await batchWriteAll(client, 't', requests);
    const calls = mock.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0].input.RequestItems!.t).toHaveLength(25);
    expect(calls[1].args[0].input.RequestItems!.t).toHaveLength(5);
  });

  it('is a no-op for an empty request list', async () => {
    const { client, mock } = createStrictDocumentMock();
    await batchWriteAll(client, 't', []);
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('attempts every chunk even when an earlier one fails, and reports the aggregate including exact item count', async () => {
    const { client, mock } = createStrictDocumentMock();
    // Content-aware fake (not a call counter): chunk 1's items (pk 0-24) always
    // report their last 5 (pk 20-24) as unprocessed, no matter which attempt or
    // how many were actually submitted that round — simulating a persistent
    // per-item rejection for just those 5. Chunk 2's items (pk 25-29) always
    // drain immediately. A global call-counter would be wrong here: DynamoDB's
    // UnprocessedItems retry loop re-submits only the leftover each round, and
    // chunk 1's own retries interleave with chunk 2's single call in call order.
    mock
      .on(BatchWriteCommand)
      .callsFake((input: { RequestItems: { t: { PutRequest: { Item: { pk: string } } }[] } }) => {
        const items = input.RequestItems.t;
        const stillUnprocessed = items.filter(
          (r) => Number(r.PutRequest.Item.pk) >= 20 && Number(r.PutRequest.Item.pk) < 25,
        );
        return { UnprocessedItems: stillUnprocessed.length > 0 ? { t: stillUnprocessed } : {} };
      });
    const requests = Array.from({ length: 30 }, (_, i) => put(String(i)));
    // maxRetries: 1 keeps this fast (2 attempts to exhaust chunk 1, not 11) —
    // the aggregation logic under test doesn't depend on the retry budget.
    const error = await batchWriteAll(client, 't', requests, { maxRetries: 1 }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      name: 'BatchWriteAllIncompleteError',
      succeededChunks: 1,
      totalChunks: 2,
      // Chunk 1: 25 items, 5 (pk 20-24) never drain -> succeededCount 20.
      // Chunk 2: 5 items, all drain immediately -> succeededCount 5. Total 25.
      succeededCount: 25,
    });
  });
});
