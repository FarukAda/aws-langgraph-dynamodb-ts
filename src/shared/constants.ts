/** Maximum TTL expressed in days (5 years). */
export const MAX_TTL_DAYS = 365 * 5;

/** Maximum TTL expressed in seconds (100 years). */
export const MAX_TTL_SECONDS = 100 * 365 * 24 * 60 * 60;

/** Hard cap on query-pagination loop iterations (runaway-loop guard). */
export const MAX_LOOP_ITERATIONS = 1000;

/** Hard cap on items collected into memory across a paginated query. */
export const MAX_TOTAL_ITEMS_IN_MEMORY = 10000;

/** DynamoDB BatchWriteItem maximum requests per call. */
export const BATCH_WRITE_MAX = 25;

/** DynamoDB BatchGetItem maximum keys per call. */
export const BATCH_GET_MAX = 100;

/** Maximum retries draining UnprocessedItems / UnprocessedKeys. */
export const MAX_UNPROCESSED_RETRIES = 10;

/** Starting delay for UnprocessedItems / UnprocessedKeys backoff loops. */
export const INITIAL_BACKOFF_DELAY_MS = 100;

/** Maximum backoff delay for retry loops. */
export const MAX_BACKOFF_DELAY_MS = 5000;

/** S3 DeleteObjects maximum keys per request. */
export const S3_DELETE_BATCH_MAX = 1000;

/** Default payload size that triggers S3 offload (350 KB; 50 KB under the DDB 400 KB cap). */
export const DEFAULT_S3_THRESHOLD_BYTES = 350 * 1024;

/** Default S3 key prefix for offloaded payloads. */
export const DEFAULT_S3_KEY_PREFIX = 'langgraph-checkpoints/';

/** Default S3 server-side encryption algorithm. */
export const DEFAULT_S3_SSE = 'AES256';

/** Default minimum payload size before gzip compression is attempted. */
export const DEFAULT_COMPRESSION_MIN_BYTES = 1024;

/** Default gzip compression level (balanced speed/ratio). */
export const DEFAULT_COMPRESSION_LEVEL = 6;

/** Default gzip-bomb guard: maximum decompressed output (50 MiB). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;

/** Default maximum attempts for transient-error retries. */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 5;

/**
 * Max attempts for the message-append transaction. It shares one session's
 * metadata row across every concurrent `addMessages` caller on that session,
 * so a burst of concurrent appends can collide repeatedly; combined with the
 * existing 100ms base / 5000ms cap backoff, this keeps worst-case retrying
 * within AWS's documented guidance to bound conflict retries to "around one
 * minute" (see DynamoDB's "Error retries and exponential backoff" guide).
 */
export const MESSAGE_APPEND_RETRY_MAX_ATTEMPTS = 18;

/** Default cap on candidates the in-DB semantic ranker will score. */
export const DEFAULT_MAX_SEARCH_CANDIDATES = 1000;
