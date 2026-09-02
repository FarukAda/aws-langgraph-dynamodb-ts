import type { ChannelVersions, Checkpoint } from '@langchain/langgraph-checkpoint';

import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { metaSortKey, partitionKey } from './keys';
import type { CheckpointerContext } from './setup';

/**
 * The channels a put stores values for. With `newVersions` the reference
 * savers store only the channels that changed in this step and rebuild the
 * rest from earlier checkpoints on read; here the rest are carried into the
 * new row directly — every channel the parent stored that this put still
 * holds a value for — so a read never walks ancestors. A value the put holds
 * for a channel that neither changed nor was stored before has no version of
 * record and is not stored. Without `newVersions` (a caller predating the
 * argument) every value given is stored, and so it is when `parentStored` is
 * `undefined`: the parent row predates the attribute and held everything.
 */
export function selectStoredChannels(
  checkpoint: Checkpoint,
  newVersions: ChannelVersions | undefined,
  parentStored: readonly string[] | undefined,
): string[] {
  const present = Object.keys(checkpoint.channel_values);
  if (newVersions === undefined) return present;
  const keep = new Set([...Object.keys(newVersions), ...(parentStored ?? present)]);
  return present.filter((channel) => keep.has(channel));
}

/** The checkpoint as it is stored: `channel_values` narrowed to `channels`, everything else untouched. */
export function withStoredChannels(
  checkpoint: Checkpoint,
  channels: readonly string[],
): Checkpoint {
  const channelValues: Checkpoint['channel_values'] = {};
  for (const channel of channels) channelValues[channel] = checkpoint.channel_values[channel];
  return { ...checkpoint, channel_values: channelValues };
}

/** True when `newVersions` already names every value the checkpoint carries, so nothing needs carrying over. */
export function coversEveryChannel(checkpoint: Checkpoint, newVersions: ChannelVersions): boolean {
  return Object.keys(checkpoint.channel_values).every((channel) =>
    Object.hasOwn(newVersions, channel),
  );
}

/**
 * The parent's stored-channel list, read from its META row with a consistent
 * projection of that one attribute. `undefined` when the parent is gone
 * (deleted or expired) or predates the attribute: both mean "carry every
 * value the put holds", the behaviour those rows were written under.
 */
export async function readParentStoredChannels(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  parentCheckpointId: string,
  signal?: AbortSignal,
): Promise<readonly string[] | undefined> {
  const result = await withDynamoDBRetry(
    () =>
      context.client.get({
        TableName: context.tableName,
        Key: { PK: partitionKey(threadId), SK: metaSortKey(checkpointNs, parentCheckpointId) },
        ConsistentRead: true,
        ProjectionExpression: '#sc',
        ExpressionAttributeNames: { '#sc': 'storedChannels' },
      }),
    retryFor(context, signal),
  );
  const stored = result.Item?.storedChannels;
  return Array.isArray(stored) ? (stored as string[]) : undefined;
}

/**
 * Resolve the channels a put stores, spending the parent read only when it
 * can change the answer: never without `newVersions` or a parent, and not
 * when `newVersions` already covers every value the put carries.
 */
export async function storedChannelsFor(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpoint: Checkpoint,
  newVersions: ChannelVersions | undefined,
  parentCheckpointId: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  if (newVersions === undefined) return selectStoredChannels(checkpoint, undefined, []);
  if (parentCheckpointId === undefined || coversEveryChannel(checkpoint, newVersions)) {
    return selectStoredChannels(checkpoint, newVersions, []);
  }
  const parentStored = await readParentStoredChannels(
    context,
    threadId,
    checkpointNs,
    parentCheckpointId,
    signal,
  );
  return selectStoredChannels(checkpoint, newVersions, parentStored);
}
