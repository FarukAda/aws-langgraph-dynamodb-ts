import {
  BatchWriteCommand,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import { appendChunks } from '../../../../src/history/internal/append-saga';
import type { ChatMessageItem } from '../../../../src/history/types';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { CompensationFailedError, RetryExhaustedError } from '../../../../src/shared/errors/errors';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function inlineItem(sk: string): ChatMessageItem {
  return {
    PK: 's1',
    SK: sk,
    sessionId: 's1',
    message: {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new Uint8Array(),
    },
  };
}

function s3Item(sk: string, s3Key: string): ChatMessageItem {
  return {
    PK: 's1',
    SK: sk,
    sessionId: 's1',
    message: { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key },
  };
}

function context(client: unknown, offloader?: unknown, logger: unknown = SILENT_LOGGER) {
  return { client, tableName: 'history', logger, offloader } as never;
}

describe('appendChunks', () => {
  it('commits every chunk in order and never rolls back on success', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await appendChunks(context(client), 's1', [[inlineItem('MSG#1')], [inlineItem('MSG#2')]], {
      now: 'u',
    });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(2);
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('rolls back committed chunks and reverts the count when a later chunk fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    // TransactWriteCommand call order: chunk 1 append succeeds, chunk 2 append
    // fails, then revertSessionCount's compensating transactWrite.
    mock
      .on(TransactWriteCommand)
      .resolvesOnce({})
      .rejectsOnce(Object.assign(new Error('boom'), { name: 'ValidationException' }))
      .resolves({});
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    await expect(
      appendChunks(
        context(client, undefined, logger),
        's1',
        [[inlineItem('MSG#1'), inlineItem('MSG#2')], [inlineItem('MSG#3')]],
        { now: 'u' },
      ),
    ).rejects.toThrow('boom');

    const deletes =
      mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems?.history ?? [];
    expect(deletes.map((r) => r.DeleteRequest?.Key?.SK)).toEqual(['MSG#1', 'MSG#2']);
    // This call created the session, so the rollback removes the whole row
    // rather than only decrementing it — otherwise `title`/`createdAt`, both
    // written via if_not_exists, would survive as a ghost session (C4).
    const revertCall = mock.commandCalls(TransactWriteCommand)[2].args[0].input;
    const revertDelete = revertCall.TransactItems?.[0]?.Delete;
    expect(revertDelete?.ConditionExpression).toBe('#count = :total AND #c = :now');
    expect(revertDelete?.ExpressionAttributeValues?.[':total']).toBe(2);
    expect(revertDelete?.ExpressionAttributeValues?.[':now']).toBe('u');
    expect(revertCall.ClientRequestToken).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('compensating'), {
      sessionId: 's1',
      committedChunks: 1,
    });
  });

  it('raises CompensationFailedError when the rollback itself fails', async () => {
    expect(CompensationFailedError).toBeDefined();
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .resolvesOnce({})
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    mock
      .on(BatchWriteCommand)
      .rejects(Object.assign(new Error('rollback-down'), { name: 'ValidationException' }));
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    await expect(
      appendChunks(
        context(client, undefined, logger),
        's1',
        [[inlineItem('MSG#1')], [inlineItem('MSG#2')]],
        { now: 'u' },
      ),
    ).rejects.toMatchObject({ name: 'CompensationFailedError', code: 'COMPENSATION_FAILED' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('rollback failed'),
      expect.objectContaining({ sessionId: 's1' }),
    );
  });

  it('reverts the count by the number of rows actually deleted when the rollback delete itself partially fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    const committedMessages = Array.from({ length: 30 }, (_, i) => inlineItem(`MSG#${i}`));
    // TransactWriteCommand call order: the 30-message chunk commits, the
    // triggering chunk fails, then revertSessionCount's compensating
    // transactWrite.
    mock
      .on(TransactWriteCommand)
      .resolvesOnce({})
      .rejectsOnce(Object.assign(new Error('boom'), { name: 'ValidationException' }))
      .resolves({});
    let batchCall = 0;
    mock.on(BatchWriteCommand).callsFake(() => {
      batchCall += 1;
      // The delete-side batchWriteAll splits 30 keys into chunks of 25 + 5.
      // The first chunk succeeds; the second fails outright (ValidationException
      // isn't retryable) before any of its 5 keys are confirmed drained.
      if (batchCall === 1) return { UnprocessedItems: {} };
      throw Object.assign(new Error('delete-down'), { name: 'ValidationException' });
    });
    await expect(
      appendChunks(context(client), 's1', [committedMessages, [inlineItem('MSG#trigger')]], {
        now: 'u',
      }),
    ).rejects.toMatchObject({ name: 'CompensationFailedError' });
    const revertCall = mock.commandCalls(TransactWriteCommand)[2].args[0].input;
    const revertUpdate = revertCall.TransactItems?.[0]?.Update;
    // 25 of the 30 committed rows were actually deleted; the revert must
    // subtract exactly 25 — not the full 30 (today's bug: skipped entirely,
    // leaving messageCount silently overstated by 30 with zero compensating
    // write) and not 0.
    expect(revertUpdate?.ExpressionAttributeValues?.[':neg']).toBe(-25);
    // ...and only against the incarnation this call appended to (HIST-03).
    expect(revertUpdate?.ConditionExpression).toBe('attribute_exists(PK) AND #c <= :now');
    expect(revertUpdate?.ExpressionAttributeValues?.[':now']).toBe('u');
  });

  it('cleans offloaded S3 objects for the whole batch when a chunk fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('x'), { name: 'ValidationException' }));
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    await expect(
      appendChunks(
        context(client, offloader),
        's1',
        [[s3Item('MSG#1', 'k1'), s3Item('MSG#2', 'k2')]],
        {
          now: 'u',
        },
      ),
    ).rejects.toThrow('x');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k1', 'k2']);
  });

  it('deletes the committed chunk DynamoDB row before its S3 object during compensation', async () => {
    const order: string[] = [];
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .resolvesOnce({})
      .rejectsOnce(Object.assign(new Error('boom'), { name: 'ValidationException' }))
      .resolves({});
    mock.on(BatchWriteCommand).callsFake(() => {
      order.push('ddb-delete');
      return Promise.resolve({ UnprocessedItems: {} });
    });
    const offloader = {
      deleteBatch: jest.fn(async (keys: string[]) => {
        if (keys.includes('k1')) order.push('s3-delete-k1');
        return [];
      }),
    };
    await expect(
      appendChunks(
        context(client, offloader),
        's1',
        [[s3Item('MSG#1', 'k1')], [s3Item('MSG#2', 'k2')]],
        { now: 'u' },
      ),
    ).rejects.toThrow('boom');
    expect(order).toEqual(['ddb-delete', 's3-delete-k1']);
  });

  it('does not delete a committed chunk S3 object when rollback itself fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .resolvesOnce({})
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    mock
      .on(BatchWriteCommand)
      .rejects(Object.assign(new Error('rollback-down'), { name: 'ValidationException' }));
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    await expect(
      appendChunks(
        context(client, offloader),
        's1',
        [[s3Item('MSG#1', 'k1')], [s3Item('MSG#2', 'k2')]],
        { now: 'u' },
      ),
    ).rejects.toMatchObject({ name: 'CompensationFailedError' });
    // The committed chunk's key (k1) must NOT be among the cleaned keys, since
    // its DynamoDB row's fate is unknown after a failed rollback. Only the
    // never-committed chunk's key (k2) is safe to have cleaned.
    expect(offloader.deleteBatch).not.toHaveBeenCalledWith(expect.arrayContaining(['k1']));
  });

  it('reverts the session count via an idempotent TransactWriteItems call, not a bare UpdateItem', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .resolvesOnce({})
      .rejectsOnce(Object.assign(new Error('boom'), { name: 'ValidationException' }))
      .resolves({});
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await expect(
      appendChunks(context(client), 's1', [[inlineItem('MSG#1')], [inlineItem('MSG#2')]], {
        now: 'u',
      }),
    ).rejects.toThrow('boom');
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(3);
  });

  it('does not resurrect a concurrently-deleted SESSION row when reverting the count', async () => {
    const { client, mock } = createStrictDocumentMock();
    const sessionGone = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    mock
      .on(TransactWriteCommand)
      // chunk 1 append succeeds
      .resolvesOnce({})
      // chunk 2 fails
      .rejectsOnce(Object.assign(new Error('boom'), { name: 'ValidationException' }))
      // both the compensating delete and its count-revert fallback find the
      // row already gone
      .rejects(sessionGone);
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    // The original trigger, not a new error, must still be what surfaces —
    // the swallowed condition failure must not become CompensationFailedError.
    // Asserting the precise name+message (not just a `toThrow('boom')`
    // substring check) matters here: CompensationFailedError's own message
    // embeds the trigger's message as a substring ("compensation failed
    // after an append error: boom (rollback: cancelled)"), so a loose
    // substring match would pass even without the fix.
    await expect(
      appendChunks(
        context(client),
        's1',
        [[inlineItem('MSG#1'), inlineItem('MSG#2')], [inlineItem('MSG#3')]],
        { now: 'u' },
      ),
    ).rejects.toMatchObject({ name: 'ValidationException', message: 'boom' });
    // 4 transactions: two chunk appends, the compensating delete, and its
    // count-revert fallback — both of the latter swallowed, neither retried.
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(4);
  });

  it('does not revert a force-refreshed ttl anchor on rollback (documented tradeoff, see README)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .resolvesOnce({})
      .rejectsOnce(Object.assign(new Error('boom'), { name: 'ValidationException' }))
      // The session pre-existed this append — exactly the case the README
      // documents — so the compensating delete's condition fails and the
      // count-revert fallback runs instead.
      .rejectsOnce(
        Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      )
      .resolves({});
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await expect(
      appendChunks(context(client), 's1', [[inlineItem('MSG#1')], [inlineItem('MSG#2')]], {
        now: 'u',
        forceTtlRefresh: true,
        ttlTimestamp: 9999,
      }),
    ).rejects.toThrow('boom');
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(4);
    const revertUpdate =
      mock.commandCalls(TransactWriteCommand)[3].args[0].input.TransactItems?.[0]?.Update;
    expect(revertUpdate?.UpdateExpression).toBe('ADD #count :neg');
    expect(revertUpdate?.UpdateExpression).not.toContain('ttl');
    expect(revertUpdate?.ExpressionAttributeNames?.['#ttl']).toBeUndefined();
  });
});

describe('appendChunks: ambiguous chunk failure (HIST-09)', () => {
  // The transaction is retried up to MESSAGE_APPEND_RETRY_MAX_ATTEMPTS times
  // with real backoff and appendChunks exposes no rng seam, so the exhausted
  // outcome is injected directly: withRetry rethrows a RetryExhaustedError
  // unchanged, which is exactly what the saga sees after a lost-response
  // transaction whose re-issues all timed out. The cause deliberately carries
  // no retryable signal (the classifier walks the cause chain), or the mock
  // itself would be retried through the whole 18-attempt backoff.
  function exhausted(): Error {
    return new RetryExhaustedError(
      'Operation failed after 18 attempts: timeout',
      18,
      Object.assign(new Error('timeout'), { name: 'SimulatedTransportFailure' }),
    );
  }

  it('treats a chunk whose transaction landed but lost its response as committed', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(exhausted());
    mock.on(GetCommand).resolves({ Item: { SK: 'MSG#1' } });
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    await expect(
      appendChunks(context(client, offloader), 's1', [[s3Item('MSG#1', 'k1')]], { now: 'u' }),
    ).resolves.toBeUndefined();
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
    const read = mock.commandCalls(GetCommand)[0].args[0].input;
    expect(read.Key).toEqual({ PK: 's1', SK: 'MSG#1' });
    expect(read.ConsistentRead).toBe(true);
  });

  it('compensates normally when the re-read proves the chunk did not commit', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(exhausted());
    mock.on(GetCommand).resolves({});
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    await expect(
      appendChunks(context(client, offloader), 's1', [[s3Item('MSG#1', 'k1')]], { now: 'u' }),
    ).rejects.toMatchObject({ name: 'RetryExhaustedError' });
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k1']);
  });

  it("leaks the uncertain chunk's objects when the re-read itself fails", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(exhausted());
    mock
      .on(GetCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    await expect(
      appendChunks(context(client, offloader), 's1', [[s3Item('MSG#1', 'k1')]], { now: 'u' }),
    ).rejects.toMatchObject({ name: 'RetryExhaustedError' });
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('still cleans the never-attempted suffix when an earlier chunk is uncertain', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(exhausted());
    mock
      .on(GetCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    await expect(
      appendChunks(
        context(client, offloader),
        's1',
        [[s3Item('MSG#1', 'k1')], [s3Item('MSG#2', 'k2')]],
        { now: 'u' },
      ),
    ).rejects.toMatchObject({ name: 'RetryExhaustedError' });
    // k1 may be referenced by a live row; k2's chunk was never attempted.
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k2']);
  });

  it('does not re-read on a definite failure', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('bad'), { name: 'ValidationException' }));
    await expect(
      appendChunks(context(client), 's1', [[inlineItem('MSG#1')]], { now: 'u' }),
    ).rejects.toThrow('bad');
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });
});
