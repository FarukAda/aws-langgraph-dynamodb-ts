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
    expect(C.MAX_TTL_SECONDS).toBe(100 * 365 * 24 * 60 * 60);
  });

  it('pins codec/s3 defaults', () => {
    expect(C.DEFAULT_S3_THRESHOLD_BYTES).toBe(350 * 1024);
    expect(C.DEFAULT_S3_KEY_PREFIX).toBe('langgraph-checkpoints/');
    expect(C.DEFAULT_S3_SSE).toBe('AES256');
    expect(C.DEFAULT_COMPRESSION_MIN_BYTES).toBe(1024);
    expect(C.DEFAULT_COMPRESSION_LEVEL).toBe(6);
    expect(C.DEFAULT_MAX_DECOMPRESSED_BYTES).toBe(50 * 1024 * 1024);
  });

  it('pins the list() scan warning threshold to the shared in-memory item cap', () => {
    expect(C.LIST_SCAN_WARN_THRESHOLD).toBe(10000);
  });
});
