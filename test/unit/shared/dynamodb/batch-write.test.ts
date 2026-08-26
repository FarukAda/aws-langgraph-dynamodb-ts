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

  it('attempts every chunk even when an earlier one fails, and reports the aggregate', async () => {
    const { client, mock } = createStrictDocumentMock();
    let call = 0;
    mock.on(BatchWriteCommand).callsFake(() => {
      call += 1;
      if (call === 1) throw Object.assign(new Error('boom'), { name: 'ValidationException' });
      return { UnprocessedItems: {} };
    });
    // 2 chunks: 25 + 5
    const requests = Array.from({ length: 30 }, (_, i) => put(String(i)));
    await expect(batchWriteAll(client, 't', requests)).rejects.toMatchObject({
      name: 'BatchWriteAllIncompleteError',
      succeededChunks: 1,
      totalChunks: 2,
    });
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });
});
