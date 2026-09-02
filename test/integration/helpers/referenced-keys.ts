import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

/** A payload descriptor as stored on a row; only the offload fields matter here. */
interface StoredDescriptor {
  location?: string;
  s3Key?: string;
}

/** The row attributes that may hold a descriptor across the three adapters. */
const DESCRIPTOR_ATTRIBUTES = ['metadata', 'checkpoint', 'value', 'message'] as const;

/**
 * Every S3 key some row in `tableName` still references, read with a full
 * strongly-consistent scan. Together with `MemoryS3.keys()` this states the two
 * invariants a write race must keep: no referenced key is missing (a live
 * object was deleted) and the unreferenced keys are the orphans.
 */
export async function referencedS3Keys(
  client: DynamoDBDocument,
  tableName: string,
): Promise<string[]> {
  const keys = new Set<string>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.scan({
      TableName: tableName,
      ConsistentRead: true,
      ExclusiveStartKey: startKey,
    });
    for (const row of page.Items ?? []) {
      for (const attribute of DESCRIPTOR_ATTRIBUTES) {
        const descriptor = row[attribute] as StoredDescriptor | undefined;
        if (descriptor?.location === 'S3' && descriptor.s3Key) keys.add(descriptor.s3Key);
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);
  return [...keys].sort();
}
