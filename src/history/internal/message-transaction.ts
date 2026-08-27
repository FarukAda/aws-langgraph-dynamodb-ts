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
    maxAttempts: MESSAGE_APPEND_RETRY_MAX_ATTEMPTS,
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
 */
export async function writeMessageChunk(
  context: HistoryContext,
  items: ChatMessageItem[],
  fields: SessionUpdateFields,
  retry: ChunkRetryOptions = {},
): Promise<void> {
  try {
    await attempt(context, items, fields, retry);
  } catch (error) {
    if (fields.forceTtlRefresh && isTtlConditionLoss(error as Error)) {
      await attempt(context, items, { ...fields, forceTtlRefresh: false }, retry);
      return;
    }
    throw error;
  }
}
