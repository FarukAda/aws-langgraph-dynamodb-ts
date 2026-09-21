import type { RunnableConfig } from '@langchain/core/runnables';

import { nowSeconds } from '../../shared/clock';
import { isExpiredRow } from '../../shared/dynamodb/expiry';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import type { DocItem } from '../../shared/dynamodb/types';
import { DynamoDBLangGraphError } from '../../shared/errors/base-error';
import { ErrorCode } from '../../shared/errors/error-code';
import { metaSortKey, partitionKey } from './keys';
import type { CheckpointerContext } from './setup';

/** Where an ancestor walk stopped, and whether that stop is a hole in the thread. */
export interface WalkStop {
  threadId: string;
  checkpointId: string;
  /** True when the row is still stored but past its `ttl`, rather than never written. */
  expired: boolean;
}

/**
 * Read the META row an ancestor walk could not follow, **ignoring expiry**, to
 * tell "this checkpoint was never written" apart from "it expired out from
 * under its own descendants".
 *
 * Every other read in this package treats an expired row as absent, which is
 * the right rule for a reader asking for state. Here the distinction is the
 * whole point: one is an ordinary root, the other is data loss.
 *
 * Accepts: `config` — the parent pointer a walk stopped at.
 *
 * Returns: whether that checkpoint exists and whether it has expired, or
 * `undefined` when the config names no thread or no checkpoint — such a pointer
 * addresses nothing that could have expired, so the walk has simply run out of
 * chain.
 *
 * Throws: whatever the read throws after retries.
 *
 * Guarantees: the read ignores the ttl, deliberately. Every other read in this
 * package treats an expired row as absent, which is the right rule for a reader
 * asking for state; here the distinction is the whole point, because one answer
 * is an ordinary root and the other is data loss.
 */
export async function probeAncestor(
  context: CheckpointerContext,
  config: RunnableConfig,
): Promise<WalkStop | undefined> {
  const ids = config.configurable;
  const threadId: string | undefined = ids?.thread_id;
  const checkpointId: string | undefined = ids?.checkpoint_id;
  if (typeof threadId !== 'string' || typeof checkpointId !== 'string') return undefined;
  const checkpointNs: string = ids?.checkpoint_ns ?? '';
  const result = await withDynamoDBRetry(
    (request) =>
      context.client.get(
        {
          TableName: context.tableName,
          Key: { PK: partitionKey(threadId), SK: metaSortKey(checkpointNs, checkpointId) },
          ConsistentRead: true,
        },
        request,
      ),
    retryFor(context),
  );
  const row = result.Item as DocItem | undefined;
  return {
    threadId,
    checkpointId,
    expired: row !== undefined && isExpiredRow(row as { ttl?: number }, nowSeconds()),
  };
}

/**
 * The error a read raises when a delta channel's history has a hole in it.
 *
 * Accepts: `stop` — the expired ancestor the walk reached. `channels` — the
 * delta channels that still needed it, named in the message so the operator
 * knows what was lost.
 *
 * Returns: the error, coded `ANCESTOR_EXPIRED` and carrying the thread and
 * checkpoint.
 *
 * Throws: nothing — it builds the error, the caller throws it.
 *
 * Guarantees: returning the partial history instead would hand the caller a
 * channel rebuilt from its initial value plus whatever writes survived — a
 * shorter message list, say, with nothing to say that anything is missing. The
 * reference contract has no way to express "incomplete", so refusing the read
 * is the only honest answer.
 */
export function ancestorExpired(stop: WalkStop, channels: string[]): DynamoDBLangGraphError {
  return new DynamoDBLangGraphError(
    `checkpoint "${stop.checkpointId}" of thread "${stop.threadId}" has expired, but later ` +
      `checkpoints still need it to reconstruct ${channels.map((c) => `"${c}"`).join(', ')}. ` +
      'A delta channel writes a full snapshot only every `snapshotFrequency` updates and leaves ' +
      'itself out of the checkpoints in between, so its value is rebuilt from an earlier ' +
      'ancestor — which a per-checkpoint ttl expires while its descendants live on. Lower ' +
      '`snapshotFrequency` (1 makes every checkpoint self-contained), or do not configure a ttl ' +
      'on threads that use delta channels.',
    ErrorCode.ANCESTOR_EXPIRED,
    { threadId: stop.threadId, checkpointId: stop.checkpointId },
  );
}
