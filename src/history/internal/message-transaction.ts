import { randomUUID } from 'node:crypto';

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
    rng: retry.rng,
    signal: retry.signal,
  });
}
