import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { readRawSession } from '../internal/item-mapper';
import { SESSION_SORT_KEY, sessionPartition } from '../internal/keys';
import type { HistoryContext } from '../internal/setup';

/** Delete a session and best-effort remove any offloaded S3 object. */
export async function clearSession(context: HistoryContext, sessionId: string): Promise<void> {
  const existing = await readRawSession(context, sessionId);
  if (!existing) return;
  await withDynamoDBRetry(() =>
    context.client.delete({
      TableName: context.tableName,
      Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
    }),
  );
  if (context.offloader) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys([existing.messages]),
      'history.clear',
      context.logger,
    );
  }
}
