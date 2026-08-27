import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { revertSessionCount } from '../../../../src/history/internal/session-count';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: HistoryContext['client']): HistoryContext {
  return { client, tableName: 'history', logger: SILENT_LOGGER } as never;
}

describe('revertSessionCount', () => {
  it('is a no-op when delta is 0', async () => {
    const { client, mock } = createStrictDocumentMock();
    await revertSessionCount(context(client), 's1', 0);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('swallows a ConditionalCheckFailed cancellation (row already gone) instead of throwing', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    await expect(revertSessionCount(context(client), 's1', 2)).resolves.toBeUndefined();
  });

  it('rethrows any other failure', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    await expect(revertSessionCount(context(client), 's1', 2)).rejects.toThrow('boom');
  });

  it('rethrows a TransactionCanceledException whose cancellation reason is not ConditionalCheckFailed', async () => {
    // Distinguishes "matches the specific ConditionalCheckFailed reason code"
    // from a broader guard that swallows on the exception name alone (or on
    // any CancellationReasons-bearing cancellation) — a real cancellation for
    // an unrelated reason must still surface, not be treated as a no-op.
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ItemCollectionSizeLimitExceeded' }],
      }),
    );
    await expect(revertSessionCount(context(client), 's1', 2)).rejects.toThrow('cancelled');
  });
});
