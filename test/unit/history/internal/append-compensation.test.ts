import { BatchWriteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { compensate } from '../../../../src/history/internal/append';
import { parseSessionId } from '../../../../src/history/internal/parse';
import type { MessageRow } from '../../../../src/history/internal/rows';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { type Logger, SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

/** A caller's logger that fails at every level: consumer code this package cannot vet. */
function throwingLogger(): Logger {
  const fail = (): never => {
    throw new TypeError('logger transport closed');
  };
  return { info: fail, warn: fail, error: fail, debug: fail };
}

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

const item = (ulid: string, key = 'k'): MessageRow =>
  ({
    PK: 'HIST#s1',
    SK: `HISTORY#MSG#${ulid}`,
    sessionId: 's1',
    message: {
      location: 'S3',
      s3Key: `history/s1/${ulid}/${key}.bin`,
      serdeType: 'json',
      schemaVersion: 1,
      compressed: false,
    },
  }) as MessageRow;

function offloaderSpy() {
  const deleted: string[] = [];
  return {
    deleted,
    offloader: {
      deleteBatch: (keys: string[]) => {
        deleted.push(...keys);
        return [];
      },
      ownsKey: () => true,
      assertOwnedKey: () => undefined,
    },
  };
}

const SESSION_ID = parseSessionId('s1');

describe('compensate', () => {
  const trigger = new Error('chunk failed');

  /** Never-committed chunks had no row, so their objects are safe to clean at once. */
  it('cleans the never-committed suffix and rethrows the trigger', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const spy = offloaderSpy();
    const chunks = [[item('a')], [item('b')]];
    await expect(
      compensate(
        context(client, { offloader: spy.offloader as never }),
        { sessionId: SESSION_ID, chunks, fields: { now: 'now', title: undefined } },
        { committed: [], trigger, uncertain: false },
      ),
    ).rejects.toBe(trigger);
    expect(spy.deleted).toEqual(['history/s1/a/k.bin', 'history/s1/b/k.bin']);
  });

  /**
   * Its rows may be live, so its objects are leaked rather than deleted; and
   * since the chunk's own outcome could not be established, the session
   * cannot be called restored, so the rollback's own success reports
   * `COMPENSATION_FAILED` rather than the trigger unchanged (record 25).
   */
  it('leaves an unverified chunk s objects alone, cleans the rest, and reports COMPENSATION_FAILED', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const spy = offloaderSpy();
    const chunks = [[item('a')], [item('b')], [item('c')]];
    await expect(
      compensate(
        context(client, { offloader: spy.offloader as never }),
        { sessionId: SESSION_ID, chunks, fields: { now: 'now', title: undefined } },
        { committed: [], trigger, uncertain: true },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.COMPENSATION_FAILED, cause: trigger });
    expect(spy.deleted).toEqual(['history/s1/b/k.bin', 'history/s1/c/k.bin']);
  });

  it('deletes a committed chunk s rows before its objects', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({});
    mock.on(TransactWriteCommand).resolves({});
    const spy = offloaderSpy();
    const chunks = [[item('a')], [item('b')]];
    const committed = [{ keys: [{ PK: 'HIST#s1', SK: 'HISTORY#MSG#a' }], count: 1 }];
    await expect(
      compensate(
        context(client, { offloader: spy.offloader as never }),
        { sessionId: SESSION_ID, chunks, fields: { now: 'now', title: undefined } },
        { committed, trigger, uncertain: false },
      ),
    ).rejects.toBe(trigger);
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(1);
    expect(spy.deleted).toContain('history/s1/a/k.bin');
  });

  /** The rollback failed, so those rows may survive: their objects must stay. */
  it('raises COMPENSATION_FAILED and keeps the committed objects when the rollback fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).rejects(new Error('throttled'));
    mock.on(TransactWriteCommand).resolves({});
    const spy = offloaderSpy();
    const chunks = [[item('a')], [item('b')]];
    const committed = [{ keys: [{ PK: 'HIST#s1', SK: 'HISTORY#MSG#a' }], count: 1 }];
    await expect(
      compensate(
        context(client, { offloader: spy.offloader as never }),
        { sessionId: SESSION_ID, chunks, fields: { now: 'now', title: undefined } },
        { committed, trigger, uncertain: false },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.COMPENSATION_FAILED });
    expect(spy.deleted).not.toContain('history/s1/a/k.bin');
  });

  /**
   * The announcement is the first statement of the rollback, and `Logger` is
   * consumer code, so a throw there skipped the S3 cleanup, the row deletes,
   * the count revert and the rethrow in one go: every committed message stayed
   * in the table with `messageCount` still counting it, and the caller was
   * handed the logger's own `TypeError` instead of the failure that started it.
   */
  it('rolls back and rethrows the trigger even when the announcing log throws', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({});
    mock.on(TransactWriteCommand).resolves({});
    const spy = offloaderSpy();
    const committed = [{ keys: [{ PK: 'HIST#s1', SK: 'HISTORY#MSG#a' }], count: 1 }];
    await expect(
      compensate(
        context(client, { offloader: spy.offloader as never, logger: throwingLogger() }),
        {
          sessionId: SESSION_ID,
          chunks: [[item('a')], [item('b')]],
          fields: { now: 'now', title: undefined },
        },
        { committed, trigger, uncertain: false },
      ),
    ).rejects.toBe(trigger);
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(1);
    expect(spy.deleted).toContain('history/s1/a/k.bin');
  });

  /** The second line reports the drift; a throw there replaced the error whose job is to name it. */
  it('still raises COMPENSATION_FAILED when the rollback s own log throws', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).rejects(new Error('throttled'));
    mock.on(TransactWriteCommand).resolves({});
    const committed = [{ keys: [{ PK: 'HIST#s1', SK: 'HISTORY#MSG#a' }], count: 1 }];
    await expect(
      compensate(
        context(client, { logger: throwingLogger() }),
        { sessionId: SESSION_ID, chunks: [[item('a')]], fields: { now: 'now', title: undefined } },
        { committed, trigger, uncertain: false },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.COMPENSATION_FAILED });
  });

  it('does nothing with S3 when no offloader is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await expect(
      compensate(
        context(client),
        { sessionId: SESSION_ID, chunks: [[item('a')]], fields: { now: 'now', title: undefined } },
        { committed: [], trigger, uncertain: false },
      ),
    ).rejects.toBe(trigger);
  });
});
