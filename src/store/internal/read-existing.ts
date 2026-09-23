import type { DescriptorRef } from '../../shared/codec/descriptor-keys';
import type { DocItem } from '../../shared/dynamodb/client';
import { REVISION_ATTRIBUTE } from '../../shared/dynamodb/conditional-put';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
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
 *
 * Accepts: the row's key. The row need not exist.
 *
 * Returns: what the row holds, with `exists: false` and every field undefined
 * when there is none. A row written before revisions existed reports no
 * `revision`, which is why the swap tests `rev` for presence rather than
 * comparing two undefineds.
 *
 * Throws: whatever the read throws after retries.
 *
 * Guarantees: strongly consistent — a put must supersede the row that is really
 * there, not one a replica still shows.
 */
export async function readExisting(
  context: StoreContext,
  pk: string,
  sk: string,
): Promise<ExistingRecordMeta> {
  const existing = await withDynamoDBRetry(
    (request) =>
      context.client.get(
        {
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
        },
        request,
      ),
    context.retry,
  );
  return existingFrom(existing.Item as DocItem | undefined);
}

/**
 * Project a raw row onto {@link ExistingRecordMeta}.
 *
 * Accepts: `item` — a read result, or the row a conditional-check rejection
 * carried with it; `undefined` means there is no row.
 *
 * Returns: the fields a put needs from the row it supersedes. Fields the
 * projection did not ask for, or that the row does not carry, are undefined.
 *
 * Throws: nothing.
 */
export function existingFrom(item: DocItem | undefined): ExistingRecordMeta {
  return {
    exists: item !== undefined,
    createdAt: item?.createdAt as string | undefined,
    value: item?.value as DescriptorRef | undefined,
    revision: item?.[REVISION_ATTRIBUTE] as string | undefined,
  };
}
