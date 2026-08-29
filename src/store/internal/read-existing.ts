import type { PayloadDescriptor } from '../../shared/codec/codec';
import { REVISION_ATTRIBUTE } from '../../shared/dynamodb/conditional-put';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { StoreContext } from './setup';

/** The previous row's createdAt, payload descriptor and revision. */
export interface ExistingRecordMeta {
  exists: boolean;
  createdAt?: string;
  value?: PayloadDescriptor;
  revision?: string;
}

/**
 * Read the fields a put needs from the row it is about to replace, in one
 * strongly-consistent projection: `createdAt` to preserve, `value` to clean up
 * afterwards, and the revision the compare-and-swap pins.
 *
 * Lives apart from `actions/put.ts` so `persist.ts` can re-read on a lost swap
 * without importing its own caller.
 */
export async function readExisting(
  context: StoreContext,
  pk: string,
  sk: string,
): Promise<ExistingRecordMeta> {
  const existing = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: pk, SK: sk },
      ConsistentRead: true,
      ProjectionExpression: '#c, #v, #r',
      ExpressionAttributeNames: { '#c': 'createdAt', '#v': 'value', '#r': REVISION_ATTRIBUTE },
    }),
  );
  return {
    exists: existing.Item !== undefined,
    createdAt: existing.Item?.createdAt as string | undefined,
    value: existing.Item?.value as PayloadDescriptor | undefined,
    revision: existing.Item?.[REVISION_ATTRIBUTE] as string | undefined,
  };
}
