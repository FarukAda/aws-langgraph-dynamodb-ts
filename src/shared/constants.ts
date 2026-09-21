/** Maximum TTL expressed in days (5 years). */
export const MAX_TTL_DAYS = 365 * 5;

/** Maximum TTL expressed in seconds: the same five years as {@link MAX_TTL_DAYS}. */
export const MAX_TTL_SECONDS = MAX_TTL_DAYS * 24 * 60 * 60;

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

/**
 * Largest serialized payload stored inline when no S3 offloader is configured:
 * DynamoDB's 400 KB item cap less 8 KB of headroom for the item's keys,
 * attribute names and descriptor fields. Exceeding it fails before the write
 * with a typed error instead of a raw `ValidationException` after it.
 */
export const MAX_INLINE_PAYLOAD_BYTES = 400 * 1024 - 8 * 1024;

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

/**
 * Default cap on an offloaded object buffered from S3 (50 MiB), checked against
 * `ContentLength` before the body is read and enforced while streaming when
 * the length is unknown. Together with {@link DEFAULT_MAX_DECOMPRESSED_BYTES}
 * it bounds the memory any single payload can claim.
 */
export const DEFAULT_MAX_S3_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Largest `s3.maxDownloadBytes`/`compression.maxDecompressedBytes` an adapter
 * accepts (512 MiB): both hold one buffer fully resident while it is read or
 * inflated, and `BaseAdapterOptions.readConcurrency`'s doc multiplies the two
 * together into the package's memory ceiling, so an unbounded value here is an
 * unbounded process, not just an unbounded object.
 */
export const MAX_PAYLOAD_BUFFER_BYTES = 512 * 1024 * 1024;

/** Default maximum attempts for transient-error retries. */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 5;

/** Largest `retry.maxAttempts` an adapter accepts; beyond it a retry loop is a hang, not a policy. */
export const MAX_RETRY_ATTEMPTS = 100;

/**
 * Largest `retry.baseDelayMs`/`retry.maxDelayMs` an adapter accepts (one
 * minute): combined with {@link MAX_RETRY_ATTEMPTS}, an unbounded per-attempt
 * delay turns a bounded attempt count back into an effectively unbounded wait.
 */
export const MAX_RETRY_DELAY_MS = 60_000;

/**
 * How long DynamoDB treats a repeated client request token as the same request
 * rather than a new one, so re-sending a tokened write is deduplicated instead
 * of applied twice (10 minutes). Recorded as its own constant so the margin
 * {@link MAX_WRITE_LIFETIME_MS} keeps under it is legible.
 */
export const TOKEN_IDEMPOTENCY_WINDOW_MS = 600_000;

/**
 * Longest one token-carrying write may keep retrying (5 minutes): half of
 * {@link TOKEN_IDEMPOTENCY_WINDOW_MS}. The other half absorbs the attempt
 * still in flight when the budget ends, clock skew between this client's own
 * clock and DynamoDB's timer, and SDK-internal queueing, so a write that
 * retries to the end still finishes well inside the window its token is
 * honoured for. Its own literal rather than a division of the window: aliasing
 * two caps has already meant that retuning one silently moved the other (see
 * {@link LIST_SCAN_WARN_THRESHOLD}).
 */
export const MAX_WRITE_LIFETIME_MS = 300_000;

/**
 * How long one request attempt may take on a client this library builds
 * (10 seconds) before the SDK's request handler destroys it and rejects with a
 * retryable `TimeoutError`. {@link MAX_WRITE_LIFETIME_MS} bounds how many
 * attempts *start*; it is checked between them, so it can refuse to begin
 * another wait and can never shorten the attempt already in flight. Without a
 * handler timeout — every one of them defaults to 0 — a hung socket holds that
 * attempt open forever and the write lifetime bounds nothing.
 *
 * Measured, not picked. Across the fan-out widths this package documents, the
 * worst interval the handler itself saw — socket acquisition including the
 * wait behind the agent's fifty sockets, connect, request write and
 * time-to-first-response-header — was 0.92 s, at a thousand concurrent writes
 * of 20 KB values, and ten seconds is roughly eleven times that. The asymmetry
 * settles the close call: too large leaves one attempt hanging for at most ten
 * seconds, which the write lifetime's own headroom absorbs, while too small
 * turns a healthy wide fan-out into a retry storm.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long a socket may sit idle (5 seconds) on a client this library builds
 * before the request handler destroys the request. Which error that surfaces
 * as depends on when it fires: before response headers the handler's own
 * rejection reaches the caller as a `TimeoutError`, while after them the call
 * has already resolved and the destroy arrives through the response stream
 * instead, as an `ECONNRESET` abort. Both are classified retryable, so either
 * way a stalled transfer becomes a retry of this library's own. An idle timer
 * rather than a deadline: activity in either direction resets it, so it bounds
 * a transfer that has stalled and never one that is merely slow, and its clock
 * starts at socket assignment rather than at request creation. What each
 * client needs it *for* differs, so that belongs at each client's own call
 * site rather than here.
 *
 * Not a tuning knob. The handler installs the socket listener immediately only
 * below 6 000 ms; at or above that it defers registration by 3 000 ms and
 * returns the deferral's timer id, which the handler's clear-on-resolve
 * cancels when response headers arrive — so at 6 000 or more the field
 * silently stops doing anything for every response that answers inside three
 * seconds, which is the normal case. That is a fact about the request handler
 * and about neither client. A unit assertion holds this value under that
 * threshold so raising it fails loudly instead of disabling the only bound a
 * stalled transfer has.
 */
export const DEFAULT_SOCKET_TIMEOUT_MS = 5_000;

/**
 * The most shards a recency index may have. The indexed read builds every
 * shard's partition key and issues at least one query per shard, so an
 * unbounded value turns a config typo into an unbounded stream of requests and
 * an out-of-memory crash. How many of those queries run at once is
 * `readConcurrency`.
 */
export const MAX_INDEX_SHARDS = 1024;

/**
 * Max attempts for the message-append transaction. It shares one session's
 * metadata row across every concurrent `addMessages` caller on that session,
 * so a burst of concurrent appends can collide repeatedly; combined with the
 * existing 100ms base / 5000ms cap backoff, this keeps worst-case retrying
 * within AWS's documented guidance to bound conflict retries to "around one
 * minute" (see DynamoDB's "Error retries and exponential backoff" guide).
 * This bound is exact for clients this library constructs, which disable the
 * AWS SDK's own internal retries (`maxAttempts: 1`, see
 * `resolveDynamoDBClient`). An injected client that keeps SDK retries stacks
 * them inside each attempt; construction warns about that.
 */
export const MESSAGE_APPEND_RETRY_MAX_ATTEMPTS = 18;

/**
 * Offloaded payloads decoded at once by one read (`getTuple` pending writes,
 * `search` candidates, `getMessages`). Each offloaded row costs one S3 GET, so
 * a serial loop scaled latency linearly with the row count; eight in flight
 * keeps the win without bursting a bucket. Also the recency-index shards one
 * listing queries at once when the adapter names no `readConcurrency`.
 */
export const DEFAULT_READ_CONCURRENCY = 8;

/**
 * Conditional row deletes a partition-wide delete keeps in flight. Pinning a
 * row on the write that produced it costs one request per row where a batch
 * carried twenty-five, so issuing them one at a time would have paid a round
 * trip per row; eight at once gives most of that back while keeping a
 * partition of any size from opening a socket per row. A fixed value rather
 * than a caller option: this is a maintenance path, and it has no other knob.
 *
 * Its own literal at the same value as {@link DEFAULT_READ_CONCURRENCY}, not an
 * alias of it — aliasing two limits has already meant that retuning one
 * silently moved the other (see {@link LIST_SCAN_WARN_THRESHOLD}).
 */
export const DELETE_CONCURRENCY = 8;

/**
 * Largest `readConcurrency` an adapter accepts: it is a multiplier on the
 * memory-ceiling formula (see the option's own doc) and on requests fired at
 * once, so an unbounded value turns a typo into an out-of-memory crash or a
 * request storm against the table/bucket.
 */
export const MAX_READ_CONCURRENCY = 128;

/** Default cap on candidates the in-DB semantic ranker will score. */
export const DEFAULT_MAX_SEARCH_CANDIDATES = 1000;

/**
 * Largest `maxSearchCandidates` an adapter accepts: this many decoded
 * candidates are held and re-ranked in memory by one `search()` call, so an
 * unbounded value lets a typo or hostile config hold an unbounded working set.
 */
export const MAX_SEARCH_CANDIDATES = 100_000;

/**
 * Largest `maxScanItems` an adapter accepts: this many raw rows are collected
 * into memory across one paginated scan/query before it errors, so — like
 * {@link MAX_SEARCH_CANDIDATES} — an unbounded value lets a typo or hostile
 * config hold an unbounded working set.
 */
export const MAX_SCAN_ITEMS = 1_000_000;

/**
 * Raw rows a single `listCheckpoints` call may pull before it warns. The read
 * itself is deliberately unbounded — capping it counted raw rows rather than
 * filter-matched ones, which turned a caller asking for a handful of rare
 * matches over a large thread into a hard error instead of the true answer.
 * The warning restores the operational signal without restoring the wrong
 * error.
 *
 * Its own literal, deliberately: this is the point at which a scan is worth
 * telling an operator about, which is independent of
 * {@link MAX_TOTAL_ITEMS_IN_MEMORY}'s hard collection cap. Aliasing the two
 * meant retuning the memory cap silently moved the warning as well, and it
 * left the pair reported as a duplicate export.
 */
export const LIST_SCAN_WARN_THRESHOLD = 10000;

/**
 * Largest `limit` any read accepts, on every method that takes one.
 *
 * Chosen from what a page costs, which is linear in `limit` and amortised
 * nowhere: every row of a page is held decoded and resident until the whole
 * page is handed back, and an offloaded row is an S3 GET and a decompression
 * of its own, `readConcurrency` at a time. A page of N rows is therefore N
 * objects held at once and, in the worst case, N round trips before the caller
 * sees the first of them.
 *
 * Ten thousand is where this package already says a read has stopped being one
 * and become an export: {@link MAX_TOTAL_ITEMS_IN_MEMORY} refuses to collect
 * more than that across a whole paginated query, and
 * {@link LIST_SCAN_WARN_THRESHOLD} tells an operator about a listing that
 * walks that far. A single page allowed past either would hold more than every
 * other path in the package may. Its own literal at the same value rather than
 * an alias of them, for the reason {@link LIST_SCAN_WARN_THRESHOLD} records.
 *
 * What it does *not* do is promise a memory figure: rows are the caller's own
 * data, so ten thousand session summaries are a few megabytes while a hundred
 * items at {@link MAX_INLINE_PAYLOAD_BYTES} are forty. It bounds a typo — the
 * `1e12` that used to resolve — not a working set.
 *
 * What a caller loses at the ceiling is one large page, never the rows: every
 * bounded read has a way to continue — `listSessions` a cursor, `search` an
 * `offset`, `getMessages` a `before`, and `saver.list` streams and never
 * accumulates — so an answer larger than this is paid for as pages.
 */
export const MAX_PAGE_LIMIT = 10_000;

/**
 * Byte caps on caller-supplied identifiers, measured as UTF-8. DynamoDB caps a
 * partition key at 2048 bytes and a sort key at 1024; S3 caps an object key at
 * 1024. These leave room for the adapter prefixes and separators that compose
 * the stored keys, so a value that passes validation fails as a typed error
 * here rather than as a raw AWS ValidationException on the write.
 *
 * Partition-key identifiers: `thread_id` and `sessionId`.
 */
export const MAX_PARTITION_ID_BYTES = 1024;

/**
 * Sort-key segments: `checkpoint_ns`, `checkpoint_id`, `taskId`, a pending-write
 * channel, a store namespace element and a store `key`.
 */
export const MAX_KEY_SEGMENT_BYTES = 256;

/** DynamoDB cap on a whole sort key; composed keys are checked against it too. */
export const MAX_SORT_KEY_BYTES = 1024;

/** S3 cap on an object key, applied to the produced offload key. */
export const MAX_S3_KEY_BYTES = 1024;

/**
 * Extra days an S3 lifecycle rule adds over the TTL it backs. DynamoDB's TTL
 * sweep can lag up to ~48 h past the `ttl` timestamp; the offloaded object
 * must outlive its row, never the other way round.
 */
export const S3_LIFECYCLE_SWEEP_MARGIN_DAYS = 2;

/**
 * Days a released payload's noncurrent version survives behind its delete
 * marker before S3 reclaims it. One day is the smallest the lifecycle API
 * accepts and it rounds up to the next UTC midnight, so the window is 24-48 h:
 * long enough to restore a payload released in error, short enough that a
 * versioned bucket does not pay for every release it has ever made. It is a
 * floor and never a cap — a longer retention the bucket already carries is
 * kept, because this package has no business shortening someone else's
 * recovery window. Inert on an unversioned bucket, which has no noncurrent
 * versions to expire.
 */
export const S3_RELEASE_GRACE_DAYS = 1;

/**
 * Characters of a row-sourced string one log line carries, past which it is
 * cut and marked with its real length.
 *
 * The values these lines quote are a row's sort key and an offloaded object's
 * S3 key, so the service already caps each at 1024 bytes — the cost is not one
 * long line but many. `list: skipped a row that is not a checkpoint meta item`
 * and `left a foreign row in place` fire once per row, and those passes walk a
 * whole partition, up to {@link MAX_TOTAL_ITEMS_IN_MEMORY} rows: one call on a
 * shared table could write megabytes of log.
 *
 * 256 is {@link MAX_KEY_SEGMENT_BYTES}, this package's own budget for one
 * identifier inside a key, so any key composed from identifiers it validated
 * is quoted whole in the common case and only a foreign or hand-written row —
 * exactly the case these lines report — is cut. Nothing is lost by cutting:
 * the line's job is to say which row to go and look at, and the row holds the
 * rest.
 */
export const MAX_LOGGED_VALUE_CHARS = 256;
