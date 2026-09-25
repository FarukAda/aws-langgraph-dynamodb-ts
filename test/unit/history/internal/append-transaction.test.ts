import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { writeMessageChunk } from '../../../../src/history/internal/append';
import type { ChatMessageItem } from '../../../../src/history/internal/rows';
import type { HistoryTransactItem } from '../../../../src/history/internal/session';
import {
  type HistoryContext,
  MESSAGE_APPEND_RETRY_MAX_ATTEMPTS,
} from '../../../../src/history/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createUlidFactory } from '../../../../src/shared/ulid';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function transactionConflict(): Error {
  return Object.assign(new Error('canceled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'TransactionConflict' }],
  });
}

/** A cancellation caused solely by the SESSION update's ttl ConditionExpression (index 0). */
function ttlConditionFailure(): Error {
  return Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
  });
}

function messageItem(sk: string): ChatMessageItem {
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

function context(client: unknown, extra?: Partial<HistoryContext>) {
  return {
    client,
    tableName: 'history',
    logger: SILENT_LOGGER,
    /** One factory per context, so ids drawn through it strictly increase. */
    ulid: createUlidFactory(),
    ...extra,
  } as never;
}

/** The id the session update of one transaction carries for the SESSION row. */
function sessionWriteId(call: { input: { TransactItems?: HistoryTransactItem[] } }): unknown {
  return call.input.TransactItems?.[0].Update?.ExpressionAttributeValues?.[':wid'];
}

/**
 * The row an update item leaves behind, applying the two clause forms this
 * builder emits. What an expression carries and what the row ends up holding
 * are different things: a once-only clause carries a fresh value on every
 * append and still leaves the row holding its first, which is the whole
 * difference between a pin that works and one that always passes.
 */
function applySets(row: Record<string, unknown>, item?: HistoryTransactItem) {
  const update = item?.Update;
  const names = update?.ExpressionAttributeNames ?? {};
  const values = update?.ExpressionAttributeValues ?? {};
  const next = { ...row };
  /** Clauses are comma-separated, but so are `if_not_exists` arguments. */
  const clauses = (update?.UpdateExpression ?? '').split(' SET ')[1].split(/, (?=#)/);
  for (const clause of clauses) {
    const [target, source] = clause.split(' = ');
    const once = source.startsWith('if_not_exists(');
    const attribute = names[target];
    if (once && next[attribute] !== undefined) continue;
    next[attribute] = values[once ? source.slice(source.indexOf(', ') + 2, -1) : source];
  }
  return next;
}

describe('writeMessageChunk', () => {
  it('writes the metadata update and every message put in one transaction', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await writeMessageChunk(context(client), [messageItem('MSG#1'), messageItem('MSG#2')], {
      sessionId: 's1',
      count: 2,
      now: 'u',
    });
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(3);
    expect(items[0].Update?.UpdateExpression).toContain('ADD #count :n');
    expect(items[1].Put?.Item?.SK).toBe('MSG#1');
    expect(items[2].Put?.Item?.SK).toBe('MSG#2');
  });

  /**
   * Two appends to one session have to leave two different ids on the SESSION
   * row. "An id is present" and "the id is on the row" hold just as well for an
   * id stamped once when the session was created, and so does "each append
   * carries a fresh id" — an update that carries a value the row refuses still
   * carries it. Only the row's own state after the second append says it moved.
   */
  it('leaves a different write id on the session row after each append', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const ctx = context(client);
    /**
     * Distinct `now` values, because `createdAt` below is the contrast that
     * proves the simulation freezes an `if_not_exists` clause at all. Give
     * both appends the same timestamp and that assertion holds whether or not
     * the helper freezes anything, and a one-line slip in it would go unseen.
     */
    await writeMessageChunk(ctx, [messageItem('MSG#1')], { sessionId: 's1', count: 1, now: 'u1' });
    await writeMessageChunk(ctx, [messageItem('MSG#2')], { sessionId: 's1', count: 1, now: 'u2' });
    const calls = mock.commandCalls(TransactWriteCommand);
    expect(sessionWriteId(calls[0].args[0])).not.toBe(sessionWriteId(calls[1].args[0]));

    const created = applySets({}, calls[0].args[0].input.TransactItems?.[0]);
    const appended = applySets(created, calls[1].args[0].input.TransactItems?.[0]);
    expect(created.writeId).toEqual(expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/));
    expect(appended.writeId).not.toBe(created.writeId);
    /** The once-only neighbours are the contrast: they stay on the first value. */
    expect(appended.createdAt).toBe(created.createdAt);
  });

  /**
   * The session update travels in the same transaction as the chunk's rows,
   * which is what makes a moved id mean "a row was added" in both directions.
   * Asserting the transaction's shape rather than one value is what would catch
   * a path writing message rows without the update beside them.
   */
  it('carries the session update beside every message put, on a first and a retried attempt', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejectsOnce(ttlConditionFailure()).resolves({});
    await writeMessageChunk(context(client), [messageItem('MSG#1'), messageItem('MSG#2')], {
      sessionId: 's1',
      count: 2,
      now: 'u',
      ttlTimestamp: 5000,
      forceTtlRefresh: true,
    });
    const calls = mock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const items = call.args[0].input.TransactItems ?? [];
      expect(items[0].Update?.Key).toEqual({ PK: 'HIST#s1', SK: 'HISTORY#SESSION' });
      expect(items[0].Update?.ExpressionAttributeNames?.['#wid']).toBe('writeId');
      expect(items.slice(1).map((item) => item.Put?.Item?.SK)).toEqual(['MSG#1', 'MSG#2']);
    }
    /** The cancelled attempt committed nothing, so the retry carries its id. */
    expect(sessionWriteId(calls[1].args[0])).toBe(sessionWriteId(calls[0].args[0]));
  });

  it('retries a transaction-conflict cancellation', async () => {
    const { client, mock } = createStrictDocumentMock();
    const conflict = Object.assign(new Error('canceled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'TransactionConflict' }],
    });
    mock.on(TransactWriteCommand).rejectsOnce(conflict).resolves({});
    await writeMessageChunk(
      context(client),
      [messageItem('MSG#1')],
      { sessionId: 's1', count: 1, now: 'u' },
      { rng: () => 0 },
    );
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });

  it('does not retry a cancellation with a permanent reason', async () => {
    const { client, mock } = createStrictDocumentMock();
    const permanent = Object.assign(new Error('canceled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ValidationError' }],
    });
    mock.on(TransactWriteCommand).rejects(permanent);
    await expect(
      writeMessageChunk(
        context(client),
        [messageItem('MSG#1')],
        { sessionId: 's1', count: 1, now: 'u' },
        { rng: () => 0 },
      ),
    ).rejects.toThrow();
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('does not retry a bare cancellation that carries no reasons', async () => {
    const { client, mock } = createStrictDocumentMock();
    const bare = Object.assign(new Error('canceled'), {
      name: 'TransactionCanceledException',
    });
    mock.on(TransactWriteCommand).rejects(bare);
    await expect(
      writeMessageChunk(
        context(client),
        [messageItem('MSG#1')],
        { sessionId: 's1', count: 1, now: 'u' },
        { rng: () => 0 },
      ),
    ).rejects.toThrow();
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('reuses one ClientRequestToken across retries so a re-sent commit is idempotent', async () => {
    const { client, mock } = createStrictDocumentMock();
    const conflict = Object.assign(new Error('canceled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'TransactionConflict' }],
    });
    mock.on(TransactWriteCommand).rejectsOnce(conflict).resolves({});
    await writeMessageChunk(
      context(client),
      [messageItem('MSG#1')],
      { sessionId: 's1', count: 1, now: 'u' },
      { rng: () => 0 },
    );
    const calls = mock.commandCalls(TransactWriteCommand);
    const firstToken = calls[0].args[0].input.ClientRequestToken;
    expect(typeof firstToken).toBe('string');
    expect(calls[1].args[0].input.ClientRequestToken).toBe(firstToken);
  });

  it('uses a distinct ClientRequestToken for separate chunks', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const ctx = context(client);
    await writeMessageChunk(ctx, [messageItem('MSG#1')], { sessionId: 's1', count: 1, now: 'u' });
    await writeMessageChunk(ctx, [messageItem('MSG#2')], { sessionId: 's1', count: 1, now: 'u' });
    const calls = mock.commandCalls(TransactWriteCommand);
    expect(calls[0].args[0].input.ClientRequestToken).not.toBe(
      calls[1].args[0].input.ClientRequestToken,
    );
  });

  it('retries a sustained transaction conflict past the default 5-attempt budget', async () => {
    const { client, mock } = createStrictDocumentMock();
    const survivedAttempts = MESSAGE_APPEND_RETRY_MAX_ATTEMPTS - 1;
    let call = mock.on(TransactWriteCommand);
    for (let i = 0; i < survivedAttempts; i++) {
      call = call.rejectsOnce(transactionConflict());
    }
    call.resolves({});
    await writeMessageChunk(
      context(client),
      [messageItem('MSG#1')],
      { sessionId: 's1', count: 1, now: 'u' },
      { rng: () => 0 },
    );
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(survivedAttempts + 1);
  });

  it(`gives up after ${MESSAGE_APPEND_RETRY_MAX_ATTEMPTS} attempts under sustained conflict`, async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(transactionConflict());
    await expect(
      writeMessageChunk(
        context(client),
        [messageItem('MSG#1')],
        { sessionId: 's1', count: 1, now: 'u' },
        { rng: () => 0 },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(MESSAGE_APPEND_RETRY_MAX_ATTEMPTS);
  });

  it('retries once without forcing ttl when only the ttl condition lost the race, and succeeds', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejectsOnce(ttlConditionFailure()).resolves({});
    await expect(
      writeMessageChunk(context(client), [messageItem('MSG#1')], {
        sessionId: 's1',
        count: 1,
        now: 'u',
        ttlTimestamp: 5000,
        forceTtlRefresh: true,
      }),
    ).resolves.toBeUndefined();
    const calls = mock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0].input.TransactItems?.[0]?.Update?.ConditionExpression).toBeDefined();
    expect(calls[1].args[0].input.TransactItems?.[0]?.Update?.ConditionExpression).toBeUndefined();
  });

  it('uses a fresh ClientRequestToken on the retried attempt', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejectsOnce(ttlConditionFailure()).resolves({});
    await writeMessageChunk(context(client), [messageItem('MSG#1')], {
      sessionId: 's1',
      count: 1,
      now: 'u',
      ttlTimestamp: 5000,
      forceTtlRefresh: true,
    });
    const calls = mock.commandCalls(TransactWriteCommand);
    expect(calls[0].args[0].input.ClientRequestToken).not.toBe(
      calls[1].args[0].input.ClientRequestToken,
    );
  });

  it('does not retry, and rethrows, when a non-ttl item caused the cancellation', async () => {
    const { client, mock } = createStrictDocumentMock();
    const messageConflict = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    });
    mock.on(TransactWriteCommand).rejects(messageConflict);
    await expect(
      writeMessageChunk(context(client), [messageItem('MSG#1')], {
        sessionId: 's1',
        count: 1,
        now: 'u',
        ttlTimestamp: 5000,
        forceTtlRefresh: true,
      }),
    ).rejects.toBe(messageConflict);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('does not retry, and rethrows, when the ttl item and another item both failed', async () => {
    const { client, mock } = createStrictDocumentMock();
    const dualConflict = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'ConditionalCheckFailed' }],
    });
    mock.on(TransactWriteCommand).rejects(dualConflict);
    await expect(
      writeMessageChunk(context(client), [messageItem('MSG#1')], {
        sessionId: 's1',
        count: 1,
        now: 'u',
        ttlTimestamp: 5000,
        forceTtlRefresh: true,
      }),
    ).rejects.toBe(dualConflict);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('does not retry when forceTtlRefresh was not set', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(ttlConditionFailure());
    await expect(
      writeMessageChunk(context(client), [messageItem('MSG#1')], {
        sessionId: 's1',
        count: 1,
        now: 'u',
      }),
    ).rejects.toBeDefined();
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });
});

describe('append retry floor under a caller retry policy', () => {
  it('never drops below its own floor when the adapter policy asks for fewer attempts', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(transactionConflict());
    await expect(
      writeMessageChunk(
        context(client, { retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }),
        [messageItem('MSG#1')],
        { sessionId: 's1', delta: 1, now: 0 } as never,
        { rng: () => 0 },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(MESSAGE_APPEND_RETRY_MAX_ATTEMPTS);
  });
});
