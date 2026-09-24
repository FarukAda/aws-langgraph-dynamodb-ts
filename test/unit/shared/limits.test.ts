import {
  DEFAULT_COMPRESSION_LEVEL,
  DEFAULT_COMPRESSION_MIN_BYTES,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
} from '../../../src/shared/codec/compression';
import { DEFAULT_S3_KEY_PREFIX, MAX_S3_KEY_BYTES } from '../../../src/shared/codec/s3/config';
import { S3_RELEASE_GRACE_DAYS } from '../../../src/shared/codec/s3/lifecycle';
import {
  DEFAULT_MAX_S3_DOWNLOAD_BYTES,
  DEFAULT_S3_SSE,
  DEFAULT_S3_THRESHOLD_BYTES,
  S3_DELETE_BATCH_MAX,
} from '../../../src/shared/codec/s3/offloader';
import { DEFAULT_READ_CONCURRENCY } from '../../../src/shared/concurrency';
import { BATCH_WRITE_MAX, MAX_UNPROCESSED_RETRIES } from '../../../src/shared/dynamodb/batch-write';
import {
  LIST_SCAN_WARN_THRESHOLD,
  MAX_TOTAL_ITEMS_IN_MEMORY,
} from '../../../src/shared/dynamodb/paginate';
import { MAX_INDEX_SHARDS } from '../../../src/shared/dynamodb/recency-index';
import {
  DEFAULT_RETRY_MAX_ATTEMPTS,
  INITIAL_BACKOFF_DELAY_MS,
  MAX_BACKOFF_DELAY_MS,
} from '../../../src/shared/dynamodb/retry';
import {
  MAX_KEY_SEGMENT_BYTES,
  MAX_PARTITION_ID_BYTES,
  MAX_SORT_KEY_BYTES,
} from '../../../src/shared/dynamodb/table-schema';
import {
  MAX_PAYLOAD_BUFFER_BYTES,
  MAX_READ_CONCURRENCY,
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
} from '../../../src/shared/validation/options';
import { MAX_PAGE_LIMIT } from '../../../src/shared/validation/primitives';
import {
  MAX_TTL_DAYS,
  MAX_TTL_SECONDS,
  S3_LIFECYCLE_SWEEP_MARGIN_DAYS,
} from '../../../src/shared/validation/ttl';
import { MAX_SCAN_ITEMS, MAX_SEARCH_CANDIDATES } from '../../../src/store/internal/setup';

describe('the limits each module owns', () => {
  it('pins the DynamoDB and backoff limits', () => {
    expect(BATCH_WRITE_MAX).toBe(25);
    expect(S3_DELETE_BATCH_MAX).toBe(1000);
    expect(MAX_UNPROCESSED_RETRIES).toBe(10);
    expect(INITIAL_BACKOFF_DELAY_MS).toBe(100);
    expect(MAX_BACKOFF_DELAY_MS).toBe(5000);
    expect(DEFAULT_RETRY_MAX_ATTEMPTS).toBe(5);
    expect(MAX_RETRY_ATTEMPTS).toBe(100);
  });

  it('pins TTL bounds', () => {
    expect(MAX_TTL_DAYS).toBe(365 * 5);
    expect(MAX_TTL_SECONDS).toBe(MAX_TTL_DAYS * 24 * 60 * 60);
    expect(S3_LIFECYCLE_SWEEP_MARGIN_DAYS).toBe(2);
    expect(S3_RELEASE_GRACE_DAYS).toBe(1);
  });

  it('pins the identifier and key byte caps', () => {
    expect(MAX_PARTITION_ID_BYTES).toBe(1024);
    expect(MAX_KEY_SEGMENT_BYTES).toBe(256);
    expect(MAX_SORT_KEY_BYTES).toBe(1024);
    expect(MAX_S3_KEY_BYTES).toBe(1024);
  });

  it('pins codec/s3 defaults', () => {
    expect(DEFAULT_S3_THRESHOLD_BYTES).toBe(350 * 1024);
    expect(DEFAULT_S3_KEY_PREFIX).toBe('langgraph-checkpoints/');
    expect(DEFAULT_S3_SSE).toBe('AES256');
    expect(DEFAULT_COMPRESSION_MIN_BYTES).toBe(1024);
    expect(DEFAULT_COMPRESSION_LEVEL).toBe(6);
    expect(DEFAULT_MAX_DECOMPRESSED_BYTES).toBe(50 * 1024 * 1024);
    expect(DEFAULT_MAX_S3_DOWNLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(DEFAULT_READ_CONCURRENCY).toBe(8);
  });

  it('pins the list() scan warning threshold to its own value, independent of the in-memory cap', () => {
    expect(LIST_SCAN_WARN_THRESHOLD).toBe(10000);
  });

  it('pins the ceilings bounding every previously-unbounded numeric option (H-08, M-08)', () => {
    expect(MAX_INDEX_SHARDS).toBe(1024);
    expect(MAX_READ_CONCURRENCY).toBe(128);
    expect(MAX_RETRY_DELAY_MS).toBe(60_000);
    expect(MAX_PAYLOAD_BUFFER_BYTES).toBe(512 * 1024 * 1024);
    expect(MAX_SCAN_ITEMS).toBe(1_000_000);
    expect(MAX_SEARCH_CANDIDATES).toBe(100_000);
    expect(MAX_PAGE_LIMIT).toBe(10_000);
  });

  /**
   * The page ceiling shares a value with the in-memory collection cap and the
   * scan warning, and holds its own literal for the reason
   * `LIST_SCAN_WARN_THRESHOLD` records: aliasing two limits has already meant
   * that retuning one silently moved the other. A page must never be allowed to
   * hold more than the most this package will collect anywhere else, so the
   * relation is pinned even though the constants are not shared.
   */
  it('keeps the page ceiling no larger than the in-memory collection cap', () => {
    expect(MAX_PAGE_LIMIT).toBeLessThanOrEqual(MAX_TOTAL_ITEMS_IN_MEMORY);
    expect(MAX_PAGE_LIMIT).toBeLessThanOrEqual(LIST_SCAN_WARN_THRESHOLD);
  });
});
