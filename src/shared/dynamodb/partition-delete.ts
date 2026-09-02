import type { DynamoDBDocument, QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import type { PayloadDescriptor } from '../codec/codec';
import { collectS3Keys } from '../codec/descriptor-keys';
import type { S3Offloader } from '../codec/s3/offloader';
import { cleanUpS3Orphans } from '../codec/s3/orphans';
import { BATCH_WRITE_MAX } from '../constants';
import { BatchWriteAllIncompleteError } from '../errors/errors';
import type { Logger } from '../logging/logger';
import { batchWriteAll } from './batch-write';
import { paginateQuery } from './paginate';
import type { RetryOptions } from './retry';
import type { DocItem } from './types';

/** Collaborators and per-adapter policy for one partition-wide delete. */
export interface PartitionDeleteOptions {
  client: DynamoDBDocument;
  tableName: string;
  params: QueryCommandInput;
  logger: Logger;
  /** The adapter's retry options for the page reads and batch deletes. */
  retry?: RetryOptions;
  /** Aborting it stops the read between pages and rejects with the library's AbortError. */
  signal?: AbortSignal;
  offloader?: S3Offloader;
  /** Label for log lines and S3-cleanup diagnostics, e.g. `deleteThread`. */
  operation: string;
  /**
   * True when a sort key belongs to the calling adapter. A partition query
   * carries no sort-key condition, so without this a shared-table partition
   * holding a foreign row would have that row deleted too.
   */
  ownsSortKey: (sortKey: string) => boolean;
  /** The offloaded payload descriptors a row references, if any. */
  descriptorsOf: (row: DocItem) => (PayloadDescriptor | undefined)[];
  /** The partition's own leading S3 key parts; objects outside their path are never deleted. */
  scope: readonly string[];
}

/** A bounded buffer of keys to delete plus the S3 descriptors they reference. */
interface DeleteBuffer {
  keys: DocItem[];
  descriptors: PayloadDescriptor[];
}

/**
 * Running totals across every flush. A streamed delete issues many
 * independent batches; without carrying these forward, a mid-stream failure
 * reports only the failing flush's counts and understates how much was
 * actually deleted.
 */
interface DeleteProgress {
  writes: number;
  succeededChunks: number;
  totalChunks: number;
}

/** Delete the buffered keys, best-effort clean their S3 objects, then clear it. */
async function flushBuffer(
  options: PartitionDeleteOptions,
  buffer: DeleteBuffer,
  progress: DeleteProgress,
): Promise<void> {
  if (buffer.keys.length === 0) return;
  const chunks = Math.ceil(buffer.keys.length / BATCH_WRITE_MAX);
  try {
    await batchWriteAll(
      options.client,
      options.tableName,
      buffer.keys.map((Key) => ({ DeleteRequest: { Key } })),
      { retry: options.retry, signal: options.signal },
    );
  } catch (error) {
    /** batchWriteAll's only throw is a BatchWriteAllIncompleteError (see batch-write.ts). */
    const failure = error as BatchWriteAllIncompleteError;
    throw new BatchWriteAllIncompleteError(
      progress.succeededChunks + failure.succeededChunks,
      progress.totalChunks + failure.totalChunks,
      failure.failedChunks,
      progress.writes + failure.succeededCount,
    );
  }
  progress.writes += buffer.keys.length;
  progress.succeededChunks += chunks;
  progress.totalChunks += chunks;
  if (options.offloader) {
    await cleanUpS3Orphans(
      options.offloader,
      collectS3Keys(buffer.descriptors),
      options.operation,
      options.logger,
      { scope: options.scope },
    );
  }
  buffer.keys = [];
  buffer.descriptors = [];
}

/**
 * Delete every row in a partition that belongs to the calling adapter,
 * best-effort deleting any offloaded S3 objects. Streams the partition with
 * unbounded pagination and flushes in batches, so a partition of any size is
 * deleted to completion with bounded memory — never silently truncated at the
 * in-memory page caps, and never discarding already-flushed progress if a
 * later batch fails. Returns the number of rows deleted.
 */
export async function deletePartitionRows(options: PartitionDeleteOptions): Promise<number> {
  const buffer: DeleteBuffer = { keys: [], descriptors: [] };
  const progress: DeleteProgress = { writes: 0, succeededChunks: 0, totalChunks: 0 };
  let skipped = 0;
  const pages = paginateQuery({
    client: options.client,
    params: options.params,
    retry: options.retry,
    signal: options.signal,
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  });
  for await (const row of pages) {
    if (!options.ownsSortKey(row.SK as string)) {
      skipped += 1;
      options.logger.warn(`${options.operation}: left a foreign row in place`, {
        sortKey: row.SK as string,
      });
      continue;
    }
    buffer.keys.push({ PK: row.PK as string, SK: row.SK as string });
    for (const descriptor of options.descriptorsOf(row)) {
      if (descriptor) buffer.descriptors.push(descriptor);
    }
    if (buffer.keys.length >= BATCH_WRITE_MAX) await flushBuffer(options, buffer, progress);
  }
  await flushBuffer(options, buffer, progress);
  options.logger.info(`${options.operation}: deleted rows`, { deleted: progress.writes, skipped });
  return progress.writes;
}
