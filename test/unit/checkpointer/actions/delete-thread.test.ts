import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { deleteThread } from '../../../../src/checkpointer/actions/delete-thread';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (): Promise<[string, Uint8Array]> => ['json', new Uint8Array()],
  loadsTyped: async (): Promise<unknown> => ({}),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

describe('deleteThread', () => {
  it('deletes every item in the thread partition', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 't', SK: 'META##c1' },
        { PK: 't', SK: 'PAYLOAD##c1' },
        { PK: 't', SK: 'WRITE##c1#task#0' },
      ],
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await deleteThread(context(client), 't');
    const requests = mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems?.ckpt ?? [];
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.DeleteRequest?.Key?.SK)).toEqual([
      'META##c1',
      'PAYLOAD##c1',
      'WRITE##c1#task#0',
    ]);
  });

  it('is a no-op when the thread has no items', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await deleteThread(context(client), 't');
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('best-effort deletes offloaded S3 objects referenced by the items', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 't',
          SK: 'PAYLOAD##c1',
          checkpoint: { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'k-cp' },
        },
      ],
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    await deleteThread({ ...context(client), offloader: offloader as never }, 't');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k-cp']);
  });

  it('rejects an empty thread id', async () => {
    const { client } = createStrictDocumentMock();
    try {
      await deleteThread(context(client), '');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
    }
  });
});
