import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { clearSession } from '../../../../src/history/actions/clear';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { conditionalTable } from '../../../shared/helpers/conditional-delete';
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
    onCorruptMessage: 'skip',
    ...extra,
  };
}

const inlineMessage = {
  location: PayloadLocation.INLINE,
  serdeType: 'json',
  bytes: new Uint8Array(),
};

describe('clearSession', () => {
  it('leaves a row that is not a chat-history row in place, and warns (C1, I7)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 'HIST#sess-1', SK: 'HISTORY#MSG#01A', message: inlineMessage },
        { PK: 'HIST#sess-1', SK: 'META##ckpt-1' },
      ],
    });
    mock.on(DeleteCommand).resolves({});
    const warn = jest.fn();
    await clearSession(context(client, { logger: { ...SILENT_LOGGER, warn } }), 'sess-1');
    const deleted = mock.commandCalls(DeleteCommand).map((call) => call.args[0].input.Key?.SK);
    expect(deleted).toEqual(['HISTORY#MSG#01A']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid session id instead of reaching DynamoDB (M12)', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(clearSession(context(client), '')).rejects.toThrow(/sessionId/);
    await expect(clearSession(context(client), 'a#b')).rejects.toThrow(/reserved "#" separator/);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('does nothing when the session partition is empty', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await clearSession(context(client), 'sess-x');
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it('reads the session partition strongly-consistently', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await clearSession(context(client), 'sess-1');
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  it('deletes every message item and the metadata item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 'sess-1', SK: 'HISTORY#MSG#01A', message: inlineMessage },
        { PK: 'sess-1', SK: 'HISTORY#SESSION' },
      ],
    });
    mock.on(DeleteCommand).resolves({});
    await clearSession(context(client), 'sess-1');
    expect(mock.commandCalls(DeleteCommand).map((call) => call.args[0].input.Key)).toEqual([
      { PK: 'sess-1', SK: 'HISTORY#MSG#01A' },
      { PK: 'sess-1', SK: 'HISTORY#SESSION' },
    ]);
  });

  /**
   * An append landing during the call moves the session row's own write id, so
   * that row is refused and left alive while the messages the read saw are
   * still deleted. A history partition has no multi-row unit, so the refusal
   * suppresses nothing: `messageCount` then over-counts until
   * `reconcileMessageCount` repairs it, which is the right outcome for a
   * session that is still in use.
   */
  it('leaves a session row an append rewrote, and deletes the messages it saw', async () => {
    const { client, mock } = createStrictDocumentMock();
    const observed = [
      { PK: 'HIST#sess-1', SK: 'HISTORY#MSG#01A', message: inlineMessage },
      { PK: 'HIST#sess-1', SK: 'HISTORY#SESSION', writeId: 'w1' },
    ];
    const table = conditionalTable([observed[0], { ...observed[1], writeId: 'w2' }]);
    mock.on(QueryCommand).resolves({ Items: observed });
    mock.on(DeleteCommand).callsFake(table.handler);
    const info = jest.fn();
    await clearSession(context(client, { logger: { ...SILENT_LOGGER, info } }), 'sess-1');
    expect([...table.rows.keys()]).toEqual(['HIST#sess-1|HISTORY#SESSION']);
    expect(info).toHaveBeenCalledWith(expect.anything(), { deleted: 1, skipped: 1 });
  });

  it('cleans up offloaded S3 objects for offloaded messages', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'sess-1',
          SK: 'HISTORY#MSG#01A',
          message: { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'sess-1/U.bin' },
        },
      ],
    });
    mock.on(DeleteCommand).resolves({});
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]), ownsKey: () => true };
    await clearSession(context(client, { offloader: offloader as never }), 'sess-1');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['sess-1/U.bin']);
  });

  it('flushes deletes incrementally rather than accumulating the whole session first', async () => {
    const { client, mock } = createStrictDocumentMock();
    let queryCallCount = 0;
    let deletesBeforeSecondQuery = -1;

    mock.on(QueryCommand).callsFake(async () => {
      queryCallCount += 1;
      if (queryCallCount === 1) {
        // Page 1: 25 items (BATCH_WRITE_MAX) with LastEvaluatedKey to trigger pagination
        return {
          Items: Array.from({ length: 25 }, (_, i) => ({
            PK: 'sess-1',
            SK: `HISTORY#MSG#${i}`,
            message: inlineMessage,
          })),
          LastEvaluatedKey: { PK: 'sess-1', SK: 'HISTORY#MSG#25' },
        };
      }
      // Page 2: 5 items; capture the delete count at this point
      // (proves the buffer was flushed mid-stream after page 1, not just at the end)
      deletesBeforeSecondQuery = mock.commandCalls(DeleteCommand).length;
      return {
        Items: Array.from({ length: 5 }, (_, i) => ({
          PK: 'sess-1',
          SK: `HISTORY#MSG#${25 + i}`,
          message: inlineMessage,
        })),
      };
    });

    mock.on(DeleteCommand).resolves({});
    await clearSession(context(client), 'sess-1');

    // Assert that deletes were already issued before page 2 was queried, proving the
    // buffer was flushed after collecting 25 items (page 1), not accumulated until the end
    expect(deletesBeforeSecondQuery).toBeGreaterThanOrEqual(1);
  });

  it('reads past the default in-memory item cap instead of throwing', async () => {
    const { client, mock } = createStrictDocumentMock();
    const pageSize = 2500;
    // 12,500 items, > the 10,000 default cap
    const pageCount = 5;
    let page = 0;
    mock.on(QueryCommand).callsFake(() => {
      page += 1;
      return {
        Items: Array.from({ length: pageSize }, (_, j) => ({
          PK: 'sess-1',
          SK: `HISTORY#MSG#${page}-${j}`,
          message: inlineMessage,
        })),
        LastEvaluatedKey: page < pageCount ? { PK: 'sess-1', SK: String(page) } : undefined,
      };
    });
    mock.on(DeleteCommand).resolves({});
    await clearSession(context(client), 'sess-1');
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(pageSize * pageCount);
  });
});
