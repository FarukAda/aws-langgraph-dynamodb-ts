import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { clearSession } from '../../../../src/history/actions/clear';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(
  client: HistoryContext['client'],
  extra?: Partial<HistoryContext>,
): HistoryContext {
  return {
    client,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
    ...extra,
  };
}

const inlineMessage = {
  location: PayloadLocation.INLINE,
  serdeType: 'json',
  bytes: new Uint8Array(),
};

describe('clearSession', () => {
  it('does nothing when the session partition is empty', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await clearSession(context(client), 'sess-x');
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('batch-deletes every message item and the metadata item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 'sess-1', SK: 'MSG#01A', message: inlineMessage },
        { PK: 'sess-1', SK: 'SESSION' },
      ],
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await clearSession(context(client), 'sess-1');
    const deletes = mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems.history;
    expect(deletes.map((d) => d.DeleteRequest.Key)).toEqual([
      { PK: 'sess-1', SK: 'MSG#01A' },
      { PK: 'sess-1', SK: 'SESSION' },
    ]);
  });

  it('cleans up offloaded S3 objects for offloaded messages', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'sess-1',
          SK: 'MSG#01A',
          message: { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'sess-1/U.bin' },
        },
      ],
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    await clearSession(context(client, { offloader: offloader as never }), 'sess-1');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['sess-1/U.bin']);
  });

  it('flushes deletes incrementally rather than accumulating the whole session first', async () => {
    const { client, mock } = createStrictDocumentMock();
    // > BATCH_WRITE_MAX (25), forcing at least 2 flushes
    const pageSize = 30;
    mock.on(QueryCommand).resolvesOnce({
      Items: Array.from({ length: pageSize }, (_, i) => ({
        PK: 'sess-1',
        SK: `MSG#${i}`,
        message: inlineMessage,
      })),
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await clearSession(context(client), 'sess-1');
    expect(mock.commandCalls(BatchWriteCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('reads past the default in-memory item cap instead of throwing', async () => {
    const { client, mock } = createStrictDocumentMock();
    const pageSize = 2500;
    // 12,500 items, > the 10,000 default cap
    const pageCount = 5;
    for (let i = 0; i < pageCount; i++) {
      mock.on(QueryCommand).resolvesOnce({
        Items: Array.from({ length: pageSize }, (_, j) => ({
          PK: 'sess-1',
          SK: `MSG#${i}-${j}`,
          message: inlineMessage,
        })),
        LastEvaluatedKey: i < pageCount - 1 ? { PK: 'sess-1', SK: String(i) } : undefined,
      });
    }
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await clearSession(context(client), 'sess-1');
    expect(mock.commandCalls(BatchWriteCommand).length).toBeGreaterThan(1);
  });
});
