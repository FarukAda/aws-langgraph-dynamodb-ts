import type { PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { BATCH_WRITE_MAX } from '../../shared/constants';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { sessionItemsQuery } from '../internal/query';
import type { HistoryContext } from '../internal/setup';
import type { ChatMessageItem } from '../types';

interface DeleteBuffer {
  keys: { PK: string; SK: string }[];
  descriptors: PayloadDescriptor[];
}

async function flushBuffer(context: HistoryContext, buffer: DeleteBuffer): Promise<void> {
  if (buffer.keys.length === 0) return;
  await batchWriteAll(
    context.client,
    context.tableName,
    buffer.keys.map((Key) => ({ DeleteRequest: { Key } })),
  );
  if (context.offloader) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys(buffer.descriptors),
      'history.clear',
      context.logger,
    );
  }
  buffer.keys = [];
  buffer.descriptors = [];
}

/**
 * Delete a whole session: every message item plus the metadata item, flushed
 * in bounded batches as they're listed, plus best-effort S3 cleanup. Streams
 * the partition with unbounded pagination so a session of any size is
 * deleted to completion with bounded memory — never silently truncated at
 * the in-memory page caps, and never discards already-flushed progress if a
 * later batch fails.
 */
export async function clearSession(context: HistoryContext, sessionId: string): Promise<void> {
  const buffer: DeleteBuffer = { keys: [], descriptors: [] };
  const pages = paginateQuery({
    client: context.client,
    params: sessionItemsQuery(context.tableName, sessionId, { consistent: true }),
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  });
  for await (const raw of pages) {
    const item = raw as ChatMessageItem;
    buffer.keys.push({ PK: item.PK, SK: item.SK });
    if (item.message) buffer.descriptors.push(item.message);
    if (buffer.keys.length >= BATCH_WRITE_MAX) await flushBuffer(context, buffer);
  }
  await flushBuffer(context, buffer);
}
