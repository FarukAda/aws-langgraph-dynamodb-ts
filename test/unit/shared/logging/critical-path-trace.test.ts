import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { deleteThread } from '../../../../src/checkpointer/actions/delete-thread';
import { listCheckpoints } from '../../../../src/checkpointer/actions/list';
import { putWrites } from '../../../../src/checkpointer/actions/put-writes';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { clearSession } from '../../../../src/history/actions/clear';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import type { LogArgument, Logger } from '../../../../src/shared/logging/logger';
import { getItem } from '../../../../src/store/actions/get';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

/** A logger that records everything, so a path's whole trace can be asserted. */
function capturingLogger(): { logger: Logger; lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  const record =
    (level: string) =>
    (message: string, ..._args: LogArgument[]): void => {
      lines.push({ level, message });
    };
  return {
    logger: {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
    },
    lines,
  };
}

/** Lines at a level an operator would actually alert on — not debug. */
function notable(
  lines: { level: string; message: string }[],
): { level: string; message: string }[] {
  return lines.filter((line) => line.level !== 'debug');
}

const serde = JSON_SERDE;

/**
 * I7: replaying the Critical findings against 0.7.0 with a real logger
 * attached produced *zero* log lines — there was no log statement for these
 * operations at any level, so this was never a "you forgot to configure
 * logging" gap: enabling logging could not surface them without a code
 * change. Each path must now leave a trace an operator can alert on.
 */
describe('critical paths leave an operational trace (I7)', () => {
  it('deleteThread reports what it deleted and what it refused to touch', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 'CHKPT#t', SK: 'META##c1' },
        { PK: 'CHKPT#t', SK: 'HISTORY#SESSION' },
      ],
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const { logger, lines } = capturingLogger();
    const context: CheckpointerContext = { client, tableName: 't', serde, logger };
    await deleteThread(context, 't');
    expect(notable(lines).map((line) => line.level)).toEqual(
      expect.arrayContaining(['warn', 'info']),
    );
  });

  it('history.clear reports what it deleted and what it refused to touch', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 'HIST#s', SK: 'HISTORY#MSG#01A' },
        { PK: 'HIST#s', SK: 'META##c1' },
      ],
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const { logger, lines } = capturingLogger();
    const context: HistoryContext = {
      client,
      tableName: 't',
      serde,
      logger,
      ulid: () => 'U',
      onCorruptMessage: 'skip',
    };
    await clearSession(context, 's');
    expect(notable(lines).map((line) => line.level)).toEqual(
      expect.arrayContaining(['warn', 'info']),
    );
  });

  it('store.get reports a row it declined to decode', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { PK: 'STORE#ns', SK: 'k', taskId: 'task-1' } });
    const { logger, lines } = capturingLogger();
    const context: StoreContext = {
      client,
      tableName: 't',
      serde,
      logger,
      maxSearchCandidates: 1000,
      maxScanItems: 10000,
    };
    await expect(getItem(context, ['ns'], 'k')).resolves.toBeNull();
    expect(notable(lines)).toHaveLength(1);
    expect(notable(lines)[0].level).toBe('warn');
  });

  it('checkpointer list reports a row it declined to decode', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [{ PK: 'CHKPT#t', SK: 'META##x' }] });
    const { logger, lines } = capturingLogger();
    const context: CheckpointerContext = { client, tableName: 't', serde, logger };
    for await (const _tuple of listCheckpoints(context, {
      configurable: { thread_id: 't', checkpoint_ns: '' },
    })) {
      throw new Error('should not have yielded');
    }
    expect(notable(lines)).toHaveLength(1);
    expect(notable(lines)[0].level).toBe('warn');
  });

  it('putWrites reports a guard rejection held by an unexpected channel', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(
      Object.assign(new Error('conflict'), {
        name: 'ConditionalCheckFailedException',
        Item: { channel: { S: 'someone-else' } },
      }),
    );
    const { logger, lines } = capturingLogger();
    const context: CheckpointerContext = { client, tableName: 't', serde, logger };
    await putWrites(
      context,
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'a']],
      'task-1',
    );
    expect(notable(lines)).toHaveLength(1);
    expect(notable(lines)[0].level).toBe('warn');
  });

  it('an ordinary duplicate stays at debug, so the warnings above stay meaningful', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(
      Object.assign(new Error('conflict'), {
        name: 'ConditionalCheckFailedException',
        Item: { channel: { S: 'ch' } },
      }),
    );
    const { logger, lines } = capturingLogger();
    const context: CheckpointerContext = { client, tableName: 't', serde, logger };
    await putWrites(
      context,
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'a']],
      'task-1',
    );
    expect(notable(lines)).toHaveLength(0);
    expect(lines.filter((line) => line.level === 'debug')).toHaveLength(1);
  });
});
