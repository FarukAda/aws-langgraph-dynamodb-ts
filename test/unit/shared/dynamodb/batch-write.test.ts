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
});
