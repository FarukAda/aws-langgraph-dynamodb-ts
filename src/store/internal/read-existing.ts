import type { DescriptorRef } from '../../shared/codec/descriptor-keys';
import { REVISION_ATTRIBUTE } from '../../shared/dynamodb/conditional-put';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { DocItem } from '../../shared/dynamodb/types';
import type { StoreContext } from './setup';

/** The previous row's createdAt, payload descriptor and revision. */
export interface ExistingRecordMeta {
  exists: boolean;
  createdAt?: string;
  value?: DescriptorRef;
  revision?: string;
}

/**
 * Read the fields a put needs from the row it is about to replace, in one
 * strongly-consistent projection: `createdAt` to preserve, the descriptor's
 * location and S3 key to clean up afterwards (never its inline bytes, which
 * can be hundreds of kilobytes the write would only discard), and the
 * revision the compare-and-swap pins.
 *
 * Lives apart from `actions/put.ts` so `persist.ts` can re-read on a lost swap
 * without importing its own caller.
 */
export async function readExisting(
  context: StoreContext,
  pk: string,
  sk: string,
): Promise<ExistingRecordMeta> {
  const existing = await withDynamoDBRetry(
    () =>
      context.client.get({
        TableName: context.tableName,
        Key: { PK: pk, SK: sk },
        ConsistentRead: true,
        ProjectionExpression: '#c, #r, #v.#loc, #v.#s3k',
        ExpressionAttributeNames: {
          '#c': 'createdAt',
          '#r': REVISION_ATTRIBUTE,
          '#v': 'value',
          '#loc': 'location',
          '#s3k': 's3Key',
        },
      }),
    context.retry,
  );
  return existingFrom(existing.Item as DocItem | undefined);
}

/** Project a raw row (a read result, or the row a rejection carried) onto {@link ExistingRecordMeta}. */
export function existingFrom(item: DocItem | undefined): ExistingRecordMeta {
  return {
    exists: item !== undefined,
    createdAt: item?.createdAt as string | undefined,
    value: item?.value as DescriptorRef | undefined,
    revision: item?.[REVISION_ATTRIBUTE] as string | undefined,
  };
}
