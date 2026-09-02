import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { getCheckpointTuple } from '../../../../src/checkpointer/actions/get-tuple';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { getMessages } from '../../../../src/history/actions/get-messages';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { getItem } from '../../../../src/store/actions/get';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const throttled = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
const retry = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 };

describe('context.retry reaches every DynamoDB call (DDB-03)', () => {
  it('checkpointer getTuple stops after the configured attempts', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).rejects(throttled);
    const context: CheckpointerContext = {
      client,
      tableName: 'ckpt',
      serde: JSON_SERDE,
      logger: SILENT_LOGGER,
      retry,
    };
    await expect(
      getCheckpointTuple(context, { configurable: { thread_id: 't' } }),
    ).rejects.toMatchObject({
      code: ErrorCode.RETRY_EXHAUSTED,
    });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it('store get stops after the configured attempts', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(throttled);
    const context: StoreContext = {
      client,
      tableName: 'store',
      serde: JSON_SERDE,
      logger: SILENT_LOGGER,
      maxSearchCandidates: 1000,
      maxScanItems: 10000,
      vectorScoreDirection: 'relevance',
      retry,
    };
    await expect(getItem(context, ['users'], 'k')).rejects.toMatchObject({
      code: ErrorCode.RETRY_EXHAUSTED,
    });
    expect(mock.commandCalls(GetCommand)).toHaveLength(2);
  });

  it('history getMessages stops after the configured attempts', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).rejects(throttled);
    const context: HistoryContext = {
      client,
      tableName: 'history',
      serde: JSON_SERDE,
      logger: SILENT_LOGGER,
      ulid: () => 'U',
      onCorruptMessage: 'skip',
      retry,
    };
    await expect(getMessages(context, 's1')).rejects.toMatchObject({
      code: ErrorCode.RETRY_EXHAUSTED,
    });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(2);
  });
});
