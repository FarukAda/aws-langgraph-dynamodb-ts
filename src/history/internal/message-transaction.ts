import { randomUUID } from 'node:crypto';

import { MESSAGE_APPEND_RETRY_MAX_ATTEMPTS } from '../../shared/constants';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { ChatMessageItem } from '../types';
import { buildSessionUpdateItem, type SessionUpdateFields } from './session-update';
import type { HistoryContext } from './setup';

/** Per-call retry seams (injected in tests to keep backoff instant). */
export interface ChunkRetryOptions {
  rng?: () => number;
  signal?: AbortSignal;
}

/**
 * Atomically write a chunk of message items together with the session-metadata
 * count update in one {@link https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html | TransactWriteItems}
 * call, so `messageCount` can never disagree with the messages that landed. A
 * single `ClientRequestToken` is reused across retries so a re-sent commit (e.g.
 * after a lost response) is idempotent and never double-applies the count `ADD`.
 * The transaction always touches the session's shared metadata row, so
 * concurrent appends to the same session contend on it; retries use
 * {@link MESSAGE_APPEND_RETRY_MAX_ATTEMPTS} rather than the default budget so a
 * burst of concurrent callers can drain via backoff instead of erroring.
 */
export async function writeMessageChunk(
  context: HistoryContext,
  items: ChatMessageItem[],
  fields: SessionUpdateFields,
  retry: ChunkRetryOptions = {},
): Promise<void> {
  const input = {
    TransactItems: [
      buildSessionUpdateItem(context.tableName, fields),
      ...items.map((item) => ({ Put: { TableName: context.tableName, Item: item } })),
    ],
    ClientRequestToken: randomUUID(),
  };
  await withDynamoDBRetry(() => context.client.transactWrite(input), {
    maxAttempts: MESSAGE_APPEND_RETRY_MAX_ATTEMPTS,
    rng: retry.rng,
    signal: retry.signal,
  });
}
