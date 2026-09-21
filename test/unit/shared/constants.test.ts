import * as C from '../../../src/shared/constants';

describe('shared constants', () => {
  it('pins the DynamoDB and backoff limits', () => {
    expect(C.BATCH_WRITE_MAX).toBe(25);
    expect(C.BATCH_GET_MAX).toBe(100);
    expect(C.S3_DELETE_BATCH_MAX).toBe(1000);
    expect(C.MAX_UNPROCESSED_RETRIES).toBe(10);
    expect(C.INITIAL_BACKOFF_DELAY_MS).toBe(100);
    expect(C.MAX_BACKOFF_DELAY_MS).toBe(5000);
    expect(C.DEFAULT_RETRY_MAX_ATTEMPTS).toBe(5);
    expect(C.MAX_RETRY_ATTEMPTS).toBe(100);
  });

  it('pins TTL bounds', () => {
    expect(C.MAX_TTL_DAYS).toBe(365 * 5);
    expect(C.MAX_TTL_SECONDS).toBe(C.MAX_TTL_DAYS * 24 * 60 * 60);
    expect(C.S3_LIFECYCLE_SWEEP_MARGIN_DAYS).toBe(2);
    expect(C.S3_RELEASE_GRACE_DAYS).toBe(1);
  });

  it('pins the identifier and key byte caps', () => {
    expect(C.MAX_PARTITION_ID_BYTES).toBe(1024);
    expect(C.MAX_KEY_SEGMENT_BYTES).toBe(256);
    expect(C.MAX_SORT_KEY_BYTES).toBe(1024);
    expect(C.MAX_S3_KEY_BYTES).toBe(1024);
  });

  it('pins codec/s3 defaults', () => {
    expect(C.DEFAULT_S3_THRESHOLD_BYTES).toBe(350 * 1024);
    expect(C.DEFAULT_S3_KEY_PREFIX).toBe('langgraph-checkpoints/');
    expect(C.DEFAULT_S3_SSE).toBe('AES256');
    expect(C.DEFAULT_COMPRESSION_MIN_BYTES).toBe(1024);
    expect(C.DEFAULT_COMPRESSION_LEVEL).toBe(6);
    expect(C.DEFAULT_MAX_DECOMPRESSED_BYTES).toBe(50 * 1024 * 1024);
    expect(C.DEFAULT_MAX_S3_DOWNLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(C.DEFAULT_READ_CONCURRENCY).toBe(8);
  });

  it('pins the list() scan warning threshold to its own value, independent of the in-memory cap', () => {
    expect(C.LIST_SCAN_WARN_THRESHOLD).toBe(10000);
  });

  it('pins the ceilings bounding every previously-unbounded numeric option (H-08, M-08)', () => {
    expect(C.MAX_INDEX_SHARDS).toBe(1024);
    expect(C.MAX_READ_CONCURRENCY).toBe(128);
    expect(C.MAX_RETRY_DELAY_MS).toBe(60_000);
    expect(C.MAX_PAYLOAD_BUFFER_BYTES).toBe(512 * 1024 * 1024);
    expect(C.MAX_SCAN_ITEMS).toBe(1_000_000);
    expect(C.MAX_SEARCH_CANDIDATES).toBe(100_000);
    expect(C.MAX_PAGE_LIMIT).toBe(10_000);
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
    expect(C.MAX_PAGE_LIMIT).toBeLessThanOrEqual(C.MAX_TOTAL_ITEMS_IN_MEMORY);
    expect(C.MAX_PAGE_LIMIT).toBeLessThanOrEqual(C.LIST_SCAN_WARN_THRESHOLD);
  });
});
