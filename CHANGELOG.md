# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`matchesStoreFilter` now detects operator objects the same way the
  official `InMemoryStore` does** — by an exact known-operator-name match
  (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`), not a `$`-prefix
  heuristic. `$in`/`$nin` are now supported. A stored value whose keys happen
  to start with `$` (e.g. a JSON Schema document with a `$schema` key) is now
  compared as a literal value instead of throwing `ValidationError`.

## [0.3.2] - 2026-08-24

### Fixed

- **Concurrent `addMessages` calls on the same chat session could exhaust
  their retry budget under real contention.** Every append transactionally
  updates the session's shared `messageCount` row alongside its message
  writes, so a burst of concurrent callers on one session can repeatedly
  collide on that row (`TransactionConflict`). The append path now retries
  such conflicts with a larger, dedicated budget instead of the default
  5-attempt one, so a burst of concurrent appends drains via backoff instead
  of erroring. Only this call site changed — other retry paths (S3, store,
  checkpointer) are unaffected.

## [0.3.1] - 2026-05-31

A hardening pass over the whole library. One runtime behaviour change
(`putWrites`, described first below) and one type-only tightening that can
surface a new compile error for existing callers (`DynamoDBFactory.createAll`,
under Fixed).

### Fixed

- **`putWrites` is now first-write-wins for regular writes.** Re-executing a
  task no longer overwrites an already-recorded write for the same
  `(thread, checkpoint, task, index)` — the first value committed is the one
  that survives, matching the reference checkpointer contract. Previously a
  re-execution silently clobbered committed data. Special negative-index
  writes (`__interrupt__` / `__resume__` / `__error__` / `__scheduled__`) still
  overwrite, as they must. A write that loses this race is not an error and
  never triggers an S3 delete: a lost conditional check cannot be told apart
  from your own retried write landing twice, so its offloaded upload is left in
  the bucket rather than risk deleting one a live row still points at.
- **S3 key collisions between different logical payloads.** Key parts are now
  base64url-encoded before being joined, so a part containing `/` (a namespace
  element or store key, both legal) can no longer produce a key some other
  payload also generates. Internal only — no API change, and objects written by
  earlier versions still read back, since each item stores its own key; only
  newly written keys take the new shape.
- **Offloaded objects were leaked or wrongly deleted in several edge cases:**
  deleting a store item now removes its S3 object; chat-history append
  compensation deletes committed rows before their S3 objects (never the other
  way round); a failing write no longer cleans up a sibling write's committed
  object.
- **Correctness fixes across the store, history, and S3 layers:** `getMessages`
  and `clearSession` no longer cap out at a fixed page count on long
  conversations; an empty per-field metadata filter no longer matches every
  item; a pluggable `VectorBackend` returning out-of-prefix hits is filtered;
  vector reconciliation keys are collision-free; `redactSecrets` no longer
  mistakes a repeated (DAG-shared) object for a cycle; S3 uploads/downloads get
  the same app-level retry budget as the DynamoDB paths, behind a client
  construction that is now race-free.
- **`DynamoDBFactory.createAll`'s per-adapter options no longer silently
  accept `clientConfig`/`createClient`.** They were always ignored at runtime
  (the shared client from the factory's own `base` options is what's actually
  used); passing either now fails to compile instead of silently doing
  nothing. If you were relying on it, move that config into the factory's
  `base` options instead.

### Added

- **`ensureS3LifecycleRule()`** on `DynamoDBSaver`, `DynamoDBStore`, and
  `DynamoDBChatMessageHistory`. When `ttl` and `s3` are both configured, call it
  once (e.g. at deploy time) to best-effort install a matching S3 lifecycle
  expiration rule. It is **opt-in**: the rule is no longer provisioned
  automatically on construction, because it needs the broader bucket-level
  `s3:PutLifecycleConfiguration` permission. Without it, objects that
  best-effort cleanup misses are never reclaimed automatically.
- **`listSessions({ maxIterations })`** — an optional override for the scan's
  iteration cap, for shared tables where non-session rows dominate the scan.

## [0.3.0] - 2026-05-30

A complete, ground-up rewrite. Earlier `0.x` releases were not reliable in
production; `0.3.0` replaces the implementation entirely and is verified
end-to-end against real AWS (DynamoDB, S3, Bedrock). The store and chat-history
layouts are built to scale without per-partition ceilings, with read-your-writes
consistency tightened across the read paths.

### Added

- **`DynamoDBSaver`** — LangGraph checkpoint + pending-writes persistence
  (`extends BaseCheckpointSaver`): `getTuple`, `list` (with `before`/`filter`/
  `limit`), `put`, `putWrites`, `deleteThread`.
- **`DynamoDBStore`** — long-term memory (`extends BaseStore`) with metadata
  filters (`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`), hierarchical namespaces, and
  optional **vector semantic search** via any LangChain `Embeddings`. Items are
  keyed `PK = namespace[0]` (scope root) / `SK = namespace[1..]#key`, so scoped
  `search` / `listNamespaces` run as native `Query`s (`begins_with` on `SK`);
  only a rootless prefix falls back to a `Scan`.
- **Pluggable `VectorBackend`** (`vectorBackend` store option) — delegate
  similarity search to an external index (OpenSearch, pgvector, …) while
  DynamoDB keeps the canonical item. The post-write index update is best-effort:
  backend `upsert`/`delete` failures are logged, not thrown, so they never fail a
  successful `put`/`delete`. The in-DB ranker is bounded by `maxSearchCandidates`
  (default 1000) and errors past the cap.
- **`DynamoDBStore.reconcileVectorIndex(namespacePrefix)`** — a maintenance tool
  that re-pushes embeddings and prunes orphaned vectors (prune requires the
  optional `VectorBackend.listKeys`), returning `{ upserted, pruned }` and
  repairing any backend drift.
- **Optional `VectorBackend.listKeys(namespacePrefix)`** plus the `VectorRef`
  type, so a backend can enumerate its stored vectors for reconciliation.
- **`DynamoDBChatMessageHistory`** — multi-session chat history, plus
  **`DynamoDBSessionChatMessageHistory`**, a single-session adapter for
  `RunnableWithMessageHistory`. Stored as one item per message
  (`SK = MSG#<ULID>`, ordered by a monotonic ULID) plus a `SESSION` metadata
  item: appends are O(1) and lock-free (batched put + one atomic `ADD`), a
  uniform whole-conversation TTL is creation-anchored via `if_not_exists`, and
  TTL-expired messages are filtered out on read.
- **`DynamoDBFactory`** — convenience constructors and `createAll`, which builds
  all three adapters on one shared client and returns a combined `destroy()`.
- **Gzip compression** (with a decompression-bomb guard), **S3 offloading** of
  payloads over DynamoDB's 400 KB limit (optional `@aws-sdk/client-s3` peer, with
  best-effort orphan cleanup and TTL-driven lifecycle rules), and **TTL expiry**.
- **Unified error model** — every error extends `DynamoDbLangGraphError` with a
  stable `ErrorCode` and a native `cause` chain; typed subclasses
  (`ValidationError`, `ConflictError`, `RetryExhaustedError`,
  `BatchWriteIncompleteError`, `AbortError`, and `CompensationFailedError`, which
  is raised when an append-saga rollback itself fails and carries both the
  trigger error as `cause` and the `rollbackError`).
- **Injectable per-instance logger** with secret redaction (`redactLogger`,
  `redactSecrets`).
- **Strongly-consistent reads** on the read-your-writes paths: checkpointer
  `getTuple` and every `store.get` use `ConsistentRead`; bulk reads stay
  eventually consistent.
- **Monotonic ULID factory** for ordered, collision-resistant sort keys.
- 100% unit-test coverage with strict assertions and static rule-guards, plus
  layered test tiers — compile-time public-API type tests (`expect-type`),
  end-to-end integration flows, and LangGraph/LangChain contract conformance
  against DynamoDB Local — and re-runnable real-AWS verification scripts under
  `examples/`.

### Changed (breaking)

- **Table schema is now `PK`/`SK` strings** with an optional Number `ttl`
  attribute. A single table can back all three adapters. Replaces the previous
  per-adapter custom key schemas; existing data is not compatible.
- **Single `tableName` option** per adapter (was `checkpointsTableName` /
  `writesTableName` / `memoryTableName`).
- **One `ttl` option** — `{ days }` or `{ seconds }` — replaces `ttlDays` /
  `ttlSeconds`.
- **S3 option renamed** `s3OffloadConfig` → `s3`.
- **Per-instance `logger` option** replaces the global `setGlobalLogger`
  singleton; default logging is now silent.
- **Checkpoint sort keys** are separated into `META#` / `PAYLOAD#` / `WRITE#`
  items, replacing single-item checkpoint storage.

### Removed

- The global logger singleton (`setGlobalLogger` / `getLogger` / `resetLogger`).
- Store filter operators `$in` / `$nin` (use the supported comparison operators).

## [0.2.0] - Unreleased

A production-hardening pass. Every item below is either a security fix or a
correctness fix; there are no new features. Several changes are silent
behavior changes, so read the **Migration** block per entry before upgrading.

### Security

- **Gzip-bomb defense**: `Compressor.decompress()` now caps output at 50 MiB by
  default (`CompressionConfig.maxDecompressedBytes`). Hostile payloads that
  expand beyond the cap throw a clear error instead of OOM-ing the process.
  - *Migration:* if legitimate checkpoints decompress above 50 MiB, raise the
    cap explicitly on the `compression` option.
- **S3 encryption by default**: `S3Offloader` now sets
  `ServerSideEncryption: AES256` on every PutObject, matching S3's own 2023
  default. Explicit is safer for compliance audits and for buckets that still
  rely on the older opt-in behaviour.
  - *Migration:* if your bucket policy enforces `aws:kms`, set
    `s3OffloadConfig.serverSideEncryption = 'aws:kms'` with `sseKmsKeyId`.
- **Filter-expression size cap**: `$in` / `$nin` arrays now capped at 50
  values, assembled `FilterExpression` capped at 3.5 KiB. Both produce
  actionable client-side errors before DynamoDB returns a cryptic
  `ValidationException`.
- **Logger secret redaction**: new `redactLogger()` / `redactSecrets()` helpers
  that strip `AccessKey`, `SecretKey`, `authorization`, `password`, `token`,
  … fields from variadic log arguments. Opt-in: `setGlobalLogger(redactLogger(getLogger()))`.
- **Cause-chain recursion cap**: `withRetry`'s retryable-error classifier
  walks `.cause` chains up to 32 levels deep to avoid a stack-overflow DoS
  from maliciously-crafted error objects.

### Changed

- **Retry backoff**: switched from additive-30% jitter to **full jitter** (AWS
  recommendation) — spreads concurrent retriers across the backoff window
  instead of letting them re-synchronize. Applied to `withRetry`, the
  `BatchGetItem`/`BatchWriteItem` UnprocessedItems loops, and S3 orphan
  cleanup.
- **Retry now classifies Node network errors** (`ECONNRESET`, `ECONNREFUSED`,
  `ETIMEDOUT`, `EPIPE`, `EAI_AGAIN`, `NetworkingError`, `TimeoutError`) plus
  nested `.cause` chains. Transient socket blips now auto-recover instead of
  surfacing as hard failures.
- **`withRetry` accepts `AbortSignal`**: pre-aborted signals reject without
  consuming an attempt; mid-backoff abort cancels the sleep immediately
  rather than waiting for the full retry schedule.
- **`semanticSearch` fails closed on embedding error** (was: fail-open,
  returned unranked results with a warning). Opt back in to the legacy
  behavior with `DynamoDBStoreOptions.fallbackToLexicalOnEmbeddingFailure:
  true`.
  - *Migration:* callers that silently relied on degraded-mode results when
    the embeddings provider was down will now see a thrown error. Set
    `fallbackToLexicalOnEmbeddingFailure: true` if that's intended, or handle
    the error upstream.
- **`list()` pagination bounded**: async generator now throws after 1000
  DynamoDB pages with no match — defends against pathological filter queries
  on million-checkpoint threads.
- **Optimistic-concurrency guard on `put()`**: the metadata `Put` inside the
  transactWrite now carries
  `attribute_not_exists(checkpoint_id) OR (#type = :t AND parent_matches)`.
  Concurrent writers racing on the same `thread_id + checkpoint_id` with
  divergent `parent_checkpoint_id` or `type` now fail fast with
  `ConditionalCheckFailedException`. Legitimate idempotent retries still
  succeed.
  - *Migration:* a migration that re-writes old checkpoints with a different
    `parent_checkpoint_id` or serializer `type` will now hit the guard.
    Validate the lineage before re-writing, or delete-then-create.
- **`getTuple()` strongly consistent end-to-end**: payload `Get` and pending-
  writes `Query` now set `ConsistentRead: true` (metadata already did). Closes
  the read-your-writes window under concurrent `putWrites` + `getTuple`.
- **`batchWriteWithRetry` throws `BatchWriteIncompleteError`** instead of
  generic `Error` on retry exhaustion. Carries `.succeededCount` and
  `.unprocessed` for reconciliation.
  - *Migration:* if you match on the old error message
    (`Failed to process all items…`), switch to
    `err instanceof BatchWriteIncompleteError`.
- **Factory `destroy()` is now idempotent and cascades**: disposes
  checkpointer (including `S3Offloader`) + store + chatHistory before tearing
  down the shared DDB client. Safe to call more than once.
- **TTL on chat-history sessions is documented**: session metadata TTL is
  sliding (refreshed on every write), but individual message TTLs are stamped
  at write time and expire independently — long-lived sessions can develop
  gaps. See `DynamoDBChatMessageHistoryOptions` remarks.
- **Optimistic-retry sub-reason inspection**: `TransactionCanceledException`
  with mixed `CancellationReasons` (e.g. `ConditionalCheckFailed` +
  `ValidationError`) no longer burns 5 retries on the permanent sub-reason —
  propagates immediately.
- **`deleteThread` iteration cap**: renamed to `MAX_DELETE_PAGES = 10 000`
  with a clearer error when exceeded, distinguishing it from the
  `MAX_LOOP_ITERATIONS = 1000` cap used by `list()` / `search()`.
- **Npm `publish --provenance`** in the release workflow; package now ships
  with Sigstore attestation.

### Added

- **PR-time CI workflow** (`.github/workflows/ci.yml`): runs typecheck, lint,
  build, test on `{ubuntu, windows, macos} × {Node 22, 24}`, plus a
  production `npm audit --audit-level=high` gate.
- **`BatchWriteIncompleteError`** — exported from `src/shared`; carries
  succeeded/unprocessed counts for reconciliation logic.
- **`redactLogger()` / `redactSecrets()`** — exported helpers for secret
  redaction in logs.
- **`fullJitter()` helper** in `shared/utils/sleep` for full-jitter backoff in
  any custom retry loop.
- **`CompressionConfig.maxDecompressedBytes`** option.
- **`DynamoDBStoreOptions.fallbackToLexicalOnEmbeddingFailure`** option —
  forwarded through the factory.
- **`RetryOptions.signal`** — `AbortSignal` support for `withRetry`.

### Fixed

- **`list()` and `getTuple()` "latest" branch worked incorrectly on real DDB**
  for any user-supplied checkpoint ID starting with a character that lex-sorts
  above `P` (every lowercase letter, most common ID patterns like `ckpt-1`).
  The old `KeyCondition: checkpoint_id < 'PAYLOAD#'` dropped those IDs
  silently; the defensive `FilterExpression: NOT begins_with(checkpoint_id,
  'PAYLOAD#')` was illegal on real DynamoDB (primary-key attributes can't
  appear in FilterExpression). Rewritten to filter on the non-key `type`
  attribute (only metadata items carry it), works for any ID character set.
  **Caught by the new LocalStack integration tier — unit tests with
  `aws-sdk-client-mock` never tripped on it.**
- **`listNamespacesOperation` sent `ExpressionAttributeNames: {}`** — DynamoDB
  rejects this with `ValidationException: ExpressionAttributeNames must not
  be empty`. Now only attaches the map when it has entries.
- **S3 orphan cleanup no longer destroys canonical data on `ConditionalCheckFailed`.**
  S3 keys are derived deterministically from `(thread_id, checkpoint_id)`, so
  a divergent-lineage put() on the same checkpoint_id uploads to keys the
  canonical write still references. The saver now skips cleanup on
  `ConditionalCheckFailedException` / `TransactionCanceledException`;
  lifecycle-rule sweep handles residual staleness. Non-conflict failures
  (network / throttle / ResourceNotFound) still trigger synchronous cleanup.
- `fetchCheckpointPayloadsBatch` validates the `PAYLOAD#` sort-key prefix
  before stripping it — prevents silent `originalId` corruption on malformed
  / migrated rows.
- Deserialization errors in `getTuple` now wrap the serde exception with
  `thread_id` / `checkpoint_id` / field context and preserve the original as
  `cause` — opaque serde errors were undiagnosable from production logs.
- Empty-string `parent_checkpoint_id` now normalizes to "no parent" in the
  `put()` ConditionExpression so retries across `''` ↔ `undefined`
  representations don't spuriously fail.
- Sleep `AbortSignal` guard against double-settle if timer and abort fire in
  the same microtask turn.
- README filter syntax corrected: `filter: { price: ... }` (not
  `'value.price'` — the library prefixes with `value.` automatically).

---

## [0.1.0] - Unreleased

### Added

- **Metadata/Payload Split**: Checkpoints are now stored as two items (metadata + payload) written atomically via `transactWrite`, reducing RCU consumption on `list()` queries
- **S3 Offloading**: Transparent S3 offloading for payloads exceeding DynamoDB's 400 KB item limit, with configurable thresholds, server-side encryption, and automatic lifecycle rules
- **Gzip Compression**: Optional compression with smart thresholds, configurable levels, and auto-detect on decompression for backward compatibility
- **`DynamoDBFactory`**: One-liner setup via `DynamoDBFactory.createAll()` with shared DynamoDB client and default table names
- **TTL in seconds**: New `ttlSeconds` option for checkpointer (overrides `ttlDays` when both set)
- **Shared client injection**: All modules accept a pre-built `DynamoDBDocument` client via `client` option, taking precedence over `clientConfig`
- **`destroy()` methods**: Resource cleanup on all modules; skips DynamoDB client cleanup when a shared client was injected
- **`deleteThread()`**: Delete all checkpoints, writes, and S3 objects for a thread
- **Configurable logger**: `setGlobalLogger()`, `getLogger()`, `resetLogger()` exported for custom logging
- **Comprehensive documentation**: Added `checkpointer.md`, `store.md`, and `history.md` component guides with table schemas, usage examples, configuration reference, and best practices
- **TypeDoc API reference**: Generated API docs under `docs/` with markdown output
- **`CODE_OF_CONDUCT.md`**: Contributor Covenant Code of Conduct

### Changed

- **Checkpointer architecture**: Migrated from single-item checkpoint storage to split metadata/payload items with `PAYLOAD#` sort key prefix
- **Batch payload fetching**: `getTuple()` uses `BatchGetItem` (batches of 100) for efficient bulk reads
- **Consistent reads**: `ConsistentRead` is now only used on `getTuple()`, not wasted on `list()`
- **Retry logic**: Enhanced retry with exponential backoff and jitter across all modules
- **Update expression builder**: Chat history uses atomic DynamoDB update expressions for session metadata
- **README.md**: Complete rewrite with architecture diagram, configuration reference tables, IAM permissions, infrastructure setup (CDK + Terraform), and project structure
- **`package.json`**: Version bumped to `0.1.0`; added `@langchain/aws`, `jsonpath-plus` dependencies; added `@aws-sdk/client-s3` as optional peer dependency

### Removed

- **`esbuild-bundle-hints.ts`**: Removed in favor of proper module resolution
- **`store/utils/result.ts`**: Removed unused result utility

---

## [0.0.11] - 2025-11-02

### Fixed

- Minor README formatting fix

---

## [0.0.10] - 2025-11-02

### Changed

- Code deduplication across test suites (shared test helpers and fixtures)

---

## [0.0.9] - 2025-11-01

### Added

- TypeDoc-generated API documentation under `docs/`
- TypeDoc configuration (`typedoc.json`)

### Fixed

- README documentation corrections

---

## [0.0.8] - 2025-11-01

### Added

- **`DynamoDBChatMessageHistory`**: New chat message history module with per-message storage pattern
  - `addMessage()` and `addMessages()` for persisting conversations
  - `getMessages()` for retrieving session messages in chronological order
  - `listSessions()` for listing user sessions with metadata
  - `clear()` for deleting session data
  - Auto-generated session titles from first message content
  - TTL support for automatic session expiration
  - Input validation with descriptive error messages
- Full test suite for all history actions and utilities
- ESLint configuration overhaul with `eslint-plugin-perfectionist`, `eslint-plugin-unused-imports`, and `eslint-config-prettier`
- `.depcheckrc` for dependency checking configuration

### Changed

- README simplified and restructured for the new module
- Store module actions updated with minor improvements

---

## [0.0.7] - 2025-10-31

### Changed

- Test suite cleanup: removed backup files, deduplicated test fixtures and mocks, standardized test patterns across checkpointer and store modules

---

## [0.0.6] - 2025-10-30

### Changed

- Replaced `jsonpath` with `jsonpath-plus` for JSONPath filtering in store operations
- Removed `esbuild-bundle-hints.ts` module

### Removed

- `esbuild` and `esbuild-plugin-polyfill-node` dev dependencies

---

## [0.0.5] - 2025-10-30

### Changed

- Refined esbuild bundle hint configuration and peer dependency declarations

---

## [0.0.4] - 2025-10-30

### Changed

- Updated esbuild bundle hints for improved tree-shaking

---

## [0.0.3] - 2025-10-30

### Added

- `esbuild-bundle-hints.ts` for optimized bundler compatibility

---

## [0.0.2] - 2025-10-30

### Changed

- Version bump and dependency updates

---

## [0.0.1] - 2025-10-30

### Added

- **`DynamoDBSaver`**: Checkpoint persistence for LangGraph workflows
  - `put()` for saving checkpoints with metadata
  - `putWrites()` for storing pending writes
  - `getTuple()` for retrieving checkpoint tuples with pending writes
  - `list()` async generator for paginated checkpoint listing with optional metadata filters
  - Thread isolation via `thread_id` with optional `checkpoint_ns` namespacing
  - Parent-child checkpoint chain support
  - TTL support for automatic checkpoint expiration
  - Input validation with configurable limits
- **`DynamoDBStore`**: Long-term memory storage for LangGraph applications
  - Hierarchical namespace organization
  - CRUD operations via `batch()` API (get, put, search, listNamespaces)
  - JSONPath-based filtering with `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte` operators
  - Optional semantic search via any LangChain `EmbeddingsInterface` provider
  - User isolation via `user_id` in configurable context
  - Pagination support with `limit` and `offset`
  - TTL support for automatic memory expiration
- Full test suites for both modules
- MIT license

---

[0.3.0]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.2.2...v0.3.0
[0.2.0]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.0.11...v0.1.0
[0.0.11]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/farukada/aws-langgraph-dynamodb-ts/releases/tag/v0.0.1
