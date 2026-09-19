import { randomUUID } from 'node:crypto';

import { MESSAGE_APPEND_RETRY_MAX_ATTEMPTS } from '../../shared/constants';
import { getCancellationReasons } from '../../shared/dynamodb/cancellation';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { ChatMessageItem } from '../types';
import {
  buildSessionUpdateItem,
  type HistoryTransactItem,
  type SessionUpdateFields,
} from './session-update';
import type { HistoryContext } from './setup';

/** Per-call retry seams (injected in tests to keep backoff instant). */
export interface ChunkRetryOptions {
  rng?: () => number;
  signal?: AbortSignal;
}

/** True when a TransactWriteItems cancellation was caused solely by the SESSION update's ttl condition (always TransactItems index 0 — see buildInput below), not by any message item. */
function isTtlConditionLoss(error: Error): boolean {
  const reasons = getCancellationReasons(error);
  return (
    reasons?.[0]?.Code === 'ConditionalCheckFailed' &&
    reasons.slice(1).every((reason) => reason.Code === 'None')
  );
}

function buildInput(
  context: HistoryContext,
  items: ChatMessageItem[],
  fields: SessionUpdateFields,
): { TransactItems: HistoryTransactItem[]; ClientRequestToken: string } {
  return {
    TransactItems: [
      buildSessionUpdateItem(context.tableName, fields),
      ...items.map((item) => ({ Put: { TableName: context.tableName, Item: item } })),
    ],
    ClientRequestToken: randomUUID(),
  };
}

async function attempt(
  context: HistoryContext,
  items: ChatMessageItem[],
  fields: SessionUpdateFields,
  retry: ChunkRetryOptions,
): Promise<void> {
  const input = buildInput(context, items, fields);
  await withDynamoDBRetry(() => context.client.transactWrite(input), {
    ...context.retry,
    /** The contention floor: a caller policy may raise the budget, never lower it. */
    maxAttempts: Math.max(MESSAGE_APPEND_RETRY_MAX_ATTEMPTS, context.retry?.maxAttempts ?? 0),
    rng: retry.rng,
    signal: retry.signal,
  });
}

/**
 * Atomically write a chunk of message items together with the session-metadata
 * count update in one {@link https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html | TransactWriteItems}
 * call, so `messageCount` can never disagree with the messages that landed. A
 * single `ClientRequestToken` is used per attempt so a re-sent commit (e.g.
 * after a lost response) is idempotent and never double-applies the count
 * `ADD`. When `fields.forceTtlRefresh` is set, the session update carries a
 * monotonic ConditionExpression (see session-update.ts); if — and only if —
 * that specific condition loses a race against a concurrent caller who just
 * healed the same anchor, this retries the identical chunk once with
 * `forceTtlRefresh: false` (safe: `if_not_exists` then converges to whatever
 * already won) rather than losing the message writes to a benign ttl race. A
 * cancellation caused by any other item (a genuine message-row conflict) is
 * not retried here — it propagates for the normal transient-conflict retry
 * budget inside `withDynamoDBRetry` to handle, or to the caller otherwise.
 *
 * Accepts: `items` — one chunk, already within the transaction's limits.
 * `fields` — the session-metadata update accompanying it; its `indexShards` and
 * its `writeId` are taken from the adapter's context, never from the caller.
 * `retry.signal` — aborts between attempts.
 *
 * Returns: nothing. The chunk and the count are committed together or not at
 * all.
 *
 * Throws: whatever the transaction throws — including a
 * `TransactionCanceledException` for a genuine conflict, after the retry budget
 * is spent. The caller compensates; this function never partially succeeds.
 *
 * Guarantees: `messageCount` can never disagree with the messages that landed,
 * because they land in one transaction. At most one extra attempt is spent on
 * the benign ttl race, and it carries its own request token, so a retry can
 * never double-apply the count. The SESSION row's `writeId` moves if and only
 * if a message row was added: the update travels in the same transaction as
 * the rows, and nothing else writes it.
 */
export async function writeMessageChunk(
  context: HistoryContext,
  items: ChatMessageItem[],
  fields: Omit<SessionUpdateFields, 'writeId'>,
  retry: ChunkRetryOptions = {},
): Promise<void> {
  /**
   * The index shard comes from the adapter's context, not from the caller's
   * fields, and the write id is drawn here — once per chunk, beside it. Drawn
   * here rather than inside the builder, every attempt of this chunk carries
   * one id, and no caller can supply or reuse one.
   */
  const withIndex = { ...fields, indexShards: context.indexShards, writeId: context.ulid() };
  try {
    await attempt(context, items, withIndex, retry);
  } catch (error) {
    if (fields.forceTtlRefresh && isTtlConditionLoss(error as Error)) {
      await attempt(context, items, { ...withIndex, forceTtlRefresh: false }, retry);
      return;
    }
    throw error;
  }
}
