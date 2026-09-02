import * as C from '../../../src/shared/constants';

describe('shared constants', () => {
  it('pins the DynamoDB and backoff limits', () => {
    expect(C.BATCH_WRITE_MAX).toBe(25);
    expect(C.BATCH_GET_MAX).toBe(100);
    expect(C.S3_DELETE_BATCH_MAX).toBe(1000);
    expect(C.MAX_UNPROCESSED_RETRIES).toBe(10);
    expect(C.INITIAL_BACKOFF_DELAY_MS).toBe(100);
    expect(C.MAX_BACKOFF_DELAY_MS).toBe(5000);
  });

  it('pins TTL bounds', () => {
    expect(C.MAX_TTL_DAYS).toBe(365 * 5);
    expect(C.MAX_TTL_SECONDS).toBe(C.MAX_TTL_DAYS * 24 * 60 * 60);
    expect(C.S3_LIFECYCLE_SWEEP_MARGIN_DAYS).toBe(2);
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
  });

  it('pins the list() scan warning threshold to its own value, independent of the in-memory cap', () => {
    expect(C.LIST_SCAN_WARN_THRESHOLD).toBe(10000);
  });
});
