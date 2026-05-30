import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { DEFAULT_RETRYABLE_ERRORS } from '../../shared/dynamodb/retry-classifier';
import type { ChatMessageItem } from '../types';
import { buildSessionUpdateItem, type SessionUpdateFields } from './session-update';
import type { HistoryContext } from './setup';

/**
 * Retryable signals for the append transaction. `TransactionCanceledException`
 * is safe to retry here because the transaction carries no condition expression,
 * so a cancellation can only be transient (row contention, throttling), never a
 * permanent conditional-check failure.
 */
const APPEND_TRANSACTION_RETRYABLE: readonly string[] = [
  ...DEFAULT_RETRYABLE_ERRORS,
  'TransactionCanceledException',
];

/** Per-call retry seams (injected in tests to keep backoff instant). */
export interface ChunkRetryOptions {
  rng?: () => number;
  signal?: AbortSignal;
}

/**
 * Atomically write a chunk of message items together with the session-metadata
 * count update in one {@link https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html | TransactWriteItems}
 * call, so `messageCount` can never disagree with the messages that landed.
 */
export async function writeMessageChunk(
  context: HistoryContext,
  items: ChatMessageItem[],
  fields: SessionUpdateFields,
  retry: ChunkRetryOptions = {},
): Promise<void> {
  const transactItems = [
    buildSessionUpdateItem(context.tableName, fields),
    ...items.map((item) => ({ Put: { TableName: context.tableName, Item: item } })),
  ];
  await withDynamoDBRetry(() => context.client.transactWrite({ TransactItems: transactItems }), {
    retryableErrors: APPEND_TRANSACTION_RETRYABLE,
    rng: retry.rng,
    signal: retry.signal,
  });
}
