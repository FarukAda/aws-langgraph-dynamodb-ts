import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { parseSessionId } from '../../../../src/history/internal/parse';
import {
  revertSessionCount,
  revertSessionCreation,
} from '../../../../src/history/internal/session';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { MAX_WRITE_LIFETIME_MS } from '../../../../src/shared/constants';
import * as retryModule from '../../../../src/shared/dynamodb/retry';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

function context(client: HistoryContext['client']): HistoryContext {
  return { client, tableName: 'history', logger: SILENT_LOGGER } as never;
}

const SESSION_ID = parseSessionId('s1');

describe('revertSessionCount', () => {
  it('is a no-op when delta is 0', async () => {
    const { client, mock } = createStrictDocumentMock();
    await revertSessionCount(context(client), SESSION_ID, 0, 'u');
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('only decrements the incarnation this call appended to (HIST-03)', async () => {
    // A session clear()-ed and re-created by another caller between this
    // call's commit and its rollback carries a later createdAt; decrementing
    // it would corrupt the new incarnation's count, and its rows were never
    // this call's to revert.
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await revertSessionCount(context(client), SESSION_ID, 2, '2026-09-01T12:00:00.000Z');
    const update =
      mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems?.[0]?.Update;
    expect(update?.ConditionExpression).toBe('attribute_exists(PK) AND #c <= :now');
    expect(update?.ExpressionAttributeNames).toEqual({
      '#count': 'messageCount',
      '#c': 'createdAt',
    });
    expect(update?.ExpressionAttributeValues).toEqual({
      ':neg': -2,
      ':now': '2026-09-01T12:00:00.000Z',
    });
  });

  it('swallows a ConditionalCheckFailed cancellation (row already gone) instead of throwing', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    await expect(revertSessionCount(context(client), SESSION_ID, 2, 'u')).resolves.toBeUndefined();
  });

  it('rethrows any other failure', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    await expect(revertSessionCount(context(client), SESSION_ID, 2, 'u')).rejects.toThrow('boom');
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
    await expect(revertSessionCount(context(client), SESSION_ID, 2, 'u')).rejects.toThrow(
      'cancelled',
    );
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
    await revertSessionCreation(context(client), SESSION_ID, { total: 0, createdAt: now });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('deletes the session row this call created, title and all', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await revertSessionCreation(context(client), SESSION_ID, { total: 2, createdAt: now });
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
    await revertSessionCreation(context(client), SESSION_ID, { total: 2, createdAt: now });
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
    await expect(
      revertSessionCreation(context(client), SESSION_ID, { total: 2, createdAt: now }),
    ).rejects.toThrow('boom');
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
    await revertSessionCreation(context(client), SESSION_ID, {
      total: 2,
      createdAt: now,
      title: 'tiny message 0',
    });
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
    await revertSessionCreation(context(client), SESSION_ID, { total: 2, createdAt: now });
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

/**
 * `ADD #count :neg` is the one write in this package that is not naturally
 * idempotent: applied twice it subtracts twice, and nothing reads the row back
 * to notice. The request token it already carries is what stops a re-send from
 * double-applying it; the deadline is what keeps the retrying inside the ten
 * minutes that token is honoured for.
 */
describe('a tokened revert stays inside the window its token is honoured for', () => {
  const adapterPolicy = () => ({ maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1 });

  it('bounds the decrement, on a copy of the adapter policy rather than on it', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const retry = adapterPolicy();
    const ctx = { ...context(client), retry } as HistoryContext;
    const spy = jest.spyOn(retryModule, 'withDynamoDBRetry');

    await revertSessionCount(ctx, SESSION_ID, 2, 'u');

    expect(spy.mock.calls[0][1]).toEqual({
      ...retry,
      deadlineAt: FROZEN_NOW_MS + MAX_WRITE_LIFETIME_MS,
    });
    /** Stamped onto the adapter's own object, this call's clock would bound every later one. */
    expect(retry).not.toHaveProperty('deadlineAt');
    expect(ctx.retry).toBe(retry);
  });

  it('bounds the row delete the same way', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const retry = adapterPolicy();
    const ctx = { ...context(client), retry } as HistoryContext;
    const spy = jest.spyOn(retryModule, 'withDynamoDBRetry');

    await revertSessionCreation(ctx, SESSION_ID, {
      total: 2,
      createdAt: '2026-08-29T00:00:00.000Z',
    });

    expect(spy.mock.calls[0][1]).toEqual({
      ...retry,
      deadlineAt: FROZEN_NOW_MS + MAX_WRITE_LIFETIME_MS,
    });
    expect(retry).not.toHaveProperty('deadlineAt');
  });

  /**
   * A policy whose every sleep is a minute long would spend seventeen of them
   * on a sustained conflict — nearly three times the window the token survives.
   * The clock advances by each sleep the schedule starts (`onRetry` fires once
   * before each, and `rng: () => 0` keeps the sleep itself instantaneous), so
   * the budget ends a handful of attempts in rather than at its eighteenth,
   * while the token still deduplicates the sends already made. The exact count
   * belongs to the helper rather than to production, which checks the sleep it
   * is about to take and so stops one attempt earlier.
   */
  it('cuts short a budget that would outlive the token', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'TransactionConflict' }],
      }),
    );
    const clock = { now: FROZEN_NOW_MS };
    jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const retry = {
      maxAttempts: 18,
      baseDelayMs: 60_000,
      maxDelayMs: 60_000,
      rng: () => 0,
      onRetry: () => {
        clock.now += 60_000;
      },
    };

    await expect(
      revertSessionCount({ ...context(client), retry }, SESSION_ID, 2, 'u'),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(6);
  });
});
