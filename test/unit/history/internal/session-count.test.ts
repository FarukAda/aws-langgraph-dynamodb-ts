import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import {
  revertSessionCount,
  revertSessionCreation,
} from '../../../../src/history/internal/session-count';
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

/**
 * C4: a rolled-back append used to leave the SESSION row behind carrying the
 * `title` derived from the first human message — up to 80 characters of
 * content the caller was told had not persisted, with no API to clear it.
 * `title`/`createdAt`/`sessionId` are written via `if_not_exists`, so nothing
 * ever set them again.
 */
describe('revertSessionCreation', () => {
  const now = '2026-08-29T00:00:00.000Z';

  it('is a no-op when the total is 0', async () => {
    const { client, mock } = createStrictDocumentMock();
    await revertSessionCreation(context(client), 's1', 0, now);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('deletes the session row this call created, title and all', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await revertSessionCreation(context(client), 's1', 2, now);
    const calls = mock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    const item = calls[0].args[0].input.TransactItems![0];
    expect(item.Delete).toMatchObject({
      Key: { PK: 'HIST#s1', SK: 'HISTORY#SESSION' },
      ConditionExpression: '#count = :total AND #c = :now',
      ExpressionAttributeValues: { ':total': 2, ':now': now },
    });
  });

  it('falls back to decrementing when the session was not created by this call', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejectsOnce(
        Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      )
      .resolves({});
    await revertSessionCreation(context(client), 's1', 2, now);
    const calls = mock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.TransactItems![0].Update?.UpdateExpression).toBe(
      'ADD #count :neg',
    );
  });

  it('rethrows a failure that is not a condition rejection', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    await expect(revertSessionCreation(context(client), 's1', 2, now)).rejects.toThrow('boom');
  });

  it('strips the title it contributed when the row cannot be deleted (C4)', async () => {
    // A concurrent append added messages to the brand-new session, so deleting
    // the row would destroy that caller's data. The count is decremented
    // instead — and the title, still holding text from the rolled-back
    // message, is removed on its own.
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejectsOnce(
        Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      )
      .resolves({});
    mock.on(UpdateCommand).resolves({});
    await revertSessionCreation(context(client), 's1', 2, now, 'tiny message 0');
    const update = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.UpdateExpression).toBe('REMOVE #title');
    expect(update.ExpressionAttributeValues).toEqual({ ':now': now, ':title': 'tiny message 0' });
  });

  it('has no title to strip when the append contributed none', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejectsOnce(
        Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      )
      .resolves({});
    await revertSessionCreation(context(client), 's1', 2, now);
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
