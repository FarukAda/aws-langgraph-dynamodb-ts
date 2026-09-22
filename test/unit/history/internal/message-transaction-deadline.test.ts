import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { writeMessageChunk } from '../../../../src/history/internal/message-transaction';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import type { ChatMessageItem } from '../../../../src/history/types';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import {
  MAX_WRITE_LIFETIME_MS,
  MESSAGE_APPEND_RETRY_MAX_ATTEMPTS,
} from '../../../../src/shared/constants';
import * as retryModule from '../../../../src/shared/dynamodb/retry';
import type { RetryAttemptInfo, RetryOptions } from '../../../../src/shared/dynamodb/retry';
import { RetryExhaustedError } from '../../../../src/shared/errors/errors';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createUlidFactory } from '../../../../src/shared/ulid';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

const ITEM = {
  PK: 's1',
  SK: 'MSG#1',
  sessionId: 's1',
  message: {
    location: PayloadLocation.INLINE,
    serdeType: 'json',
    compressed: false,
    bytes: new Uint8Array(),
  },
} as ChatMessageItem;

const FIELDS = { sessionId: 's1', count: 1, now: 'u' };
const TTL_FIELDS = { ...FIELDS, ttlTimestamp: 5000, forceTtlRefresh: true };

/** A cancellation carrying one reason code per transaction item, in item order. */
function cancellation(...codes: string[]): Error {
  return Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

function context(client: unknown, retry?: RetryOptions): HistoryContext {
  const ulid = createUlidFactory();
  return { client, tableName: 'history', logger: SILENT_LOGGER, ulid, retry } as never;
}

/**
 * A clock the backoff schedule itself moves.
 *
 * The suite freezes the wall clock and keeps real timers, so a budget whose
 * sleeps add up to minutes can neither be waited out nor observed: under a
 * clock that never moves, no accumulation of sleeps ever reaches a deadline.
 * `onRetry` runs once before each backoff sleep and is handed that sleep's
 * attempt number, so it can put back exactly the time the un-jittered schedule
 * would have spent there — `min(baseDelayMs * 2 ** (k - 1), maxDelayMs)` —
 * while `rng: () => 0` keeps the sleep the test really performs
 * instantaneous. What `withRetry` then measures against the deadline is the
 * elapsed time of the documented schedule, not a stand-in for it.
 *
 * **One half of the check is nulled, deliberately, and the counts below are
 * one higher because of it.** `crossesDeadline` is predictive — it compares
 * `now + delayMs` and refuses the sleep that *would* cross — but `rng: () => 0`
 * makes `delayMs` zero, so what is really evaluated here is `now >= deadline`:
 * worst-case elapsed with no lookahead, a combination production never
 * produces. Every attempt count in this file is therefore one past what the
 * un-jittered schedule would reach. The predictive half is pinned where it
 * belongs, by `retry.test.ts`'s "cuts the budget before a sleep that would
 * cross the deadline"; what this file pins is that the deadline is minted per
 * attempt, at the right value, off the adapter's own object.
 */
function installScheduleClock(baseDelayMs: number, maxDelayMs: number): RetryOptions {
  const clock = { now: FROZEN_NOW_MS };
  jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
  return {
    baseDelayMs,
    maxDelayMs,
    onRetry: ({ attempt }: RetryAttemptInfo) => {
      clock.now += Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
    },
  };
}

describe('the append transaction stays inside the window its token is honoured for', () => {
  it('bounds the budget by the write lifetime without lowering the contention floor', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const retry = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 };
    const ctx = context(client, retry);
    const spy = jest.spyOn(retryModule, 'withDynamoDBRetry');

    await writeMessageChunk(ctx, [ITEM], FIELDS);

    expect(spy.mock.calls[0][1]).toMatchObject({
      deadlineAt: FROZEN_NOW_MS + MAX_WRITE_LIFETIME_MS,
      /** A floor, not a target: a deadline cuts a budget short, it never counts it down. */
      maxAttempts: MESSAGE_APPEND_RETRY_MAX_ATTEMPTS,
    });
    /** The adapter's own options object, reused by every later call it makes. */
    expect(retry).not.toHaveProperty('deadlineAt');
    expect(ctx.retry).toBe(retry);
  });

  /**
   * 18 attempts at a 60 s cap nominally back off for 522 300 ms, which is the
   * configuration this deadline exists for: the budget ends well short of its
   * eighteenth attempt, and the send that would have landed the chunk under a
   * token DynamoDB may no longer honour is never made. The exact attempt the
   * count stops at is the helper's, not production's - see its note about the
   * nulled lookahead - so the assertion is on "stopped early and rejected",
   * not on a number the real schedule would reach.
   */
  it('exhausts at the deadline rather than re-landing past it', async () => {
    const { client, mock } = createStrictDocumentMock();
    let stub = mock.on(TransactWriteCommand);
    for (let i = 0; i < 15; i++) stub = stub.rejectsOnce(cancellation('TransactionConflict'));
    stub.resolves({});
    const ctx = context(client, installScheduleClock(100, 60_000));

    await expect(writeMessageChunk(ctx, [ITEM], FIELDS, { rng: () => 0 })).rejects.toBeInstanceOf(
      RetryExhaustedError,
    );
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(15);
  });

  /**
   * The ttl race sends the chunk twice, each send drawing its own request
   * token, so each send needs its own deadline — minted beside that token,
   * inside the attempt, not once per call.
   *
   * Minted once per call, the retry inherits whatever the first send left. Here
   * the first send spends 240 s of its 300 s before the ttl condition loses its
   * race; the retry would then have 60 s, enough for two attempts, and would
   * exhaust on the second. With a budget of its own it gets the same six
   * attempts any first send gets, and the sixth lands.
   */
  it('gives the ttl-race retry a budget of its own, not the remains of the first', async () => {
    const { client, mock } = createStrictDocumentMock();
    let stub = mock.on(TransactWriteCommand);
    for (let i = 0; i < 4; i++) stub = stub.rejectsOnce(cancellation('TransactionConflict'));
    stub = stub.rejectsOnce(cancellation('ConditionalCheckFailed', 'None'));
    for (let i = 0; i < 5; i++) stub = stub.rejectsOnce(cancellation('TransactionConflict'));
    stub.resolves({});
    const ctx = context(client, installScheduleClock(60_000, 60_000));
    const spy = jest.spyOn(retryModule, 'withDynamoDBRetry');

    await expect(
      writeMessageChunk(ctx, [ITEM], TTL_FIELDS, { rng: () => 0 }),
    ).resolves.toBeUndefined();
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(11);
    /**
     * Two sends, two deadlines, the second minted 240 s after the first —
     * exactly the time the first send spent. One deadline for both, or none at
     * all, is a different list.
     */
    expect(spy.mock.calls.map((call) => call[1]?.deadlineAt)).toEqual([
      FROZEN_NOW_MS + MAX_WRITE_LIFETIME_MS,
      FROZEN_NOW_MS + 240_000 + MAX_WRITE_LIFETIME_MS,
    ]);
  });
});
