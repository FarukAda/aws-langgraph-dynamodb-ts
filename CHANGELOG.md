# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`maxIterations` on `DynamoDBStore`**: the DynamoDB pages one `search`, `listNamespaces` or `reconcileVectorIndex` reads before `RESULT_TRUNCATED` (default 1000; `Infinity` for none). Those scans were capped at 1000 pages with no way to raise it, which a rootless scan over a large table of mostly non-store rows reached long before `maxScanItems`.
- **`scripts/find-orphaned-payloads.mjs`, a sweep for offloaded objects no live row names** — the orphans a failed or unverified write, a failed best-effort delete or an exhausted compare-and-swap leave, which nothing reclaims on a deployment without a `ttl`. It reports by default and deletes only with `--delete`, never touching an object younger than `--min-age-hours` (1 hour floor, 24 default) and never one whose row is only past its `ttl` but not yet removed by DynamoDB — a checkpoint's PAYLOAD and pending-WRITE rows are served without checking their own `ttl`, so such an object may still be read. `--delete` requires an explicit `--prefix`, since the default spans every adapter and is safe only when one table backs all of them, and refuses to run when there is something to delete but not one checked object found evidence of the right table — a live row, or an expired row that still names that exact object — in `--table`. A row that instead names a different object is not evidence: it never rescues a `--table` that only collides with an unrelated row at a backlinked key, which store keys' deterministic naming makes ordinary rather than contrived. Repository-only, like the stranded-row sweep.

### Changed (breaking)

- **`history.addMessages` reports a chunk whose outcome it cannot establish as `COMPENSATION_FAILED`.** An append whose failing chunk could not be read back — a single-message append included, since it is one chunk too — used to roll back what had committed and rethrow the chunk's own error — the error that means "the session is back to where it was, retrying is safe" — while that chunk's messages might be in the table. It now fails with `COMPENSATION_FAILED`, carrying the read's failure (or the write's own failure, when some attempt of it may still be applied — it got no answer, or DynamoDB answered that it was still in progress (`TransactionInProgressException`) or failed with a server error (5xx)) as `details.rollbackError`, and logs `history.addMessages could not tell whether a failed chunk committed; messageCount may have drifted` at `error`, naming that same failure in a `reason` field. A caller retrying on ordinary errors no longer risks duplicating messages; run `reconcileMessageCount` instead.
- **An adapter now refuses to write what a reader configured like it could not read.** An offloaded payload larger than `s3.maxDownloadBytes` is refused at the write with `VALIDATION` naming `payload`, before it is uploaded; a configuration whose `s3.maxDownloadBytes` is below its `s3.thresholdBytes` is refused at construction, naming `s3.maxDownloadBytes`; and a payload larger than `compression.maxDecompressedBytes` is stored uncompressed rather than compressed past the cap. Each used to be accepted and fail only at the first read.
- **`history.getMessages` fails the read on `COMPRESSION_LIMIT` under `onCorruptMessage: 'skip'` too.** A payload larger than this reader decompresses is intact — a reader with a larger `maxDecompressedBytes` reads it — so it is no longer dropped as a corrupt message behind a silent default logger (decision record 26). Upgrading: a row an earlier release compressed past a custom `compression.maxDecompressedBytes` now fails the read under `'skip'` too, where it used to be silently dropped; raise the cap to read it.
- **An injected `client` built with `unmarshallOptions.wrapNumbers` or `marshallOptions.convertEmptyValues: true` is refused at construction**, naming `client`, by every adapter and by `backfillRecencyIndex`. Such a client silently broke this package: wrapped numbers read every row as format version 0, so a newer release's rows were no longer refused, dropped every session from `listSessions`, and refreshed a session's TTL anchor on every append; an empty string stored as NULL erased the root checkpoint namespace, losing its checkpoints from every read.
- **The store no longer writes recency-index keys, and refuses `indexName` and `indexShards`.** No store read uses the recency index — a rootless `search` and `listNamespaces` stay table scans — yet every store row carried `gsi1pk`/`gsi1sk`, so a table with the index wrote every store item twice, and the store accepted both options without reading them. Construction now refuses them as unknown keys (`options.indexName`, `options.indexShards`); drop them from store options. A store row written by `1.0.0-rc.2` keeps its keys until its next put. `backfillRecencyIndex` no longer gives store rows keys (decision record 27). On a table that already carries the GSI, such a row's leftover `gsi1pk`/`gsi1sk` hold an `ALL`-projected copy of it in the index, billed as index storage, until the row's next put, its delete, or its TTL expiry; a one-off `UpdateItem` (`REMOVE gsi1pk, gsi1sk`) over the store's `STORE#` rows reclaims it sooner.

### Changed

- **`checkpoint_ns` may be 512 bytes, up from 256.** LangGraph names a nested subgraph's namespace after its parent's plus the node name and a 36-character task id, so 256 bytes refused graphs at their fifth or sixth level of nesting with ordinary node names. Composed sort keys and S3 keys are still checked against their own caps. A row with a namespace over 256 bytes cannot be read by `1.0.0-rc.2`.
- **Every error a public method raises names where it surfaced.** The public boundary independently fills in whichever of `context.operation` (the innermost guarded method reached — `saver.getTuple`, `history.forSession`, and so on) and `context.tableName` an error does not already carry, so a count by operation, which the monitoring advice recommends, finds every error a method call raised. `RETRY_EXHAUSTED` and `S3_OFFLOAD_FAILED` also carry the `awsErrorName`, `httpStatusCode` and `requestId` of the AWS failure beneath them — kept correct once a spent retry budget wraps that failure, by reading them off the classifiable failure under the wrapper rather than off the wrapper itself. A constructor's own `VALIDATION` — a bad option to `new DynamoDBSaver(...)` or the like, or to `DynamoDBFactory`'s `create*`/`createAll` — carries `context.field`, not `context.operation`: it fails before any method call, and so before any boundary, runs.
- **`getTuple` on an adapter without a `ttl` reads one META row per page instead of fifty.** No row at the head can have expired there, so the larger page only billed for rows it discarded — about seven strongly consistent read units per graph step where one does. With a `ttl` the page stays at fifty, to step over rows that aged out.

### Removed

- **`SessionBackend`**, the deprecated alias of `MultiSessionHistory`. It existed only in `1.0.0-rc.1` and `1.0.0-rc.2` — `0.9.0` never exported it — so it is removed before `1.0.0` rather than carried as a deprecated name through the first stable major. Use `MultiSessionHistory`.

### Fixed

- **A write DynamoDB may still apply no longer releases the S3 objects it uploaded while its row can still commit.** `saver.put`, `saver.putWrites` and `store.put` read a failed write's row back before releasing what the write had uploaded, and took a row found absent as proof that the write had not landed. That proof fails whenever DynamoDB may still apply a request this client no longer controls: a cancel, a request timeout or a dropped connection that cut an attempt short before it was answered; DynamoDB answering that this same write's own earlier attempt, under the same request token, was still being processed (`TransactionInProgressException`); or a server error, which AWS documents as leaving a write's outcome undecided rather than refused. Any attempt of a retried write's whole budget counts, not only its last, since an earlier one can still be in flight while a later one is answered outright. Such a failure now keeps its uploads for the lifecycle rule; a write whose signal had fired before it was sent is not sent at all, and its uploads are released at once.
- **A cancelled `history.addMessages` no longer releases the S3 objects of a chunk that may have committed.** A cancel that fired while a chunk's transaction was in flight released that chunk's offloaded messages without reading the chunk back, so a transaction DynamoDB still applied left message rows naming deleted objects: every later `getMessages` of the session failed under `onCorruptMessage: 'throw'`, and silently dropped the message with an `error` log under the default `'skip'`. The chunk is now read back first: one that landed is rolled back with the rest, and one still unsettled keeps its objects. No chunk is sent once the signal has fired.
- **A store put whose row would pass DynamoDB's 400 KB item limit is refused before anything is written, and its upload is released.** The store keeps one inline vector per text its `index.fields` extract — a wildcard path such as `sections[*].text` yields one per element — and nothing measured the whole row, so such a put embedded, uploaded, and then failed with `AWS_REJECTED`. The row is now measured by DynamoDB's own item-size rules and refused with `VALIDATION`, naming `index` when the vectors are what pushed it over. The README and guide no longer say "one vector per configured field".
- **`store.get` recovers from a concurrent overwrite on a role without `s3:ListBucket`.** S3 answers a download of a released object with 403 `AccessDenied` rather than 404 when the caller cannot list the bucket, and the documented IAM policy granted no `ListBucket`, so the re-read that resolves the race never ran and the read failed. A refused download now triggers the same re-read; one that finds the same row still rethrows, since that is a real permission failure.
- **A session id near its 1024-byte cap no longer makes its session row unwritable once the recency index exists.** The index sort key is `<updatedAt>#<id>`, and DynamoDB rejects every write to an item whose index key passes 1024 bytes; such an id is now carried as its SHA-256 digest. A session `1.0.0-rc.2` or earlier wrote with such an id, on a table with no index yet, keeps its over-length `gsi1sk` after the upgrade: DynamoDB's own GSI backfill excludes it from a newly built index, `backfillRecencyIndex` leaves it alone too since it already carries `gsi1pk`, it is missing from an indexed `listSessions()`, and `reconcileMessageCount` on it is refused — until its next `history.addMessages` call rewrites the key under the new digest form.
- **`destroy()` is idempotent and raises a `DynamoDBLangGraphError`.** Each call released every client again, and a client that failed to close escaped as its own raw error, although every other failure is a `DynamoDBLangGraphError`. The first failure is now raised as `UNEXPECTED_ERROR` (or its AWS code) with the client's error as `cause`, a second call does nothing, and the `destroy` `createAll` returns runs once too.
- **S3 upload and download retries are logged at `debug`**, as `retrying after a transient error` with `operation: 'upload' | 'download'`, like every DynamoDB retry. The README said every retry was logged; the S3 transfers' were not. The README now also says which retries are not logged line by line (`UnprocessedItems` re-submission and a best-effort delete's retries).
- **`ensureS3LifecycleRule()` now reads its own write back before deciding whether to write again, within one call's own polling.** It reads the bucket's whole lifecycle configuration, adds its rules and writes the result back, exactly as `1.0.0-rc.2` did — but `rc.2` returned as soon as that one write was acknowledged, with no re-read and no wait: a call right after another's write, such as two adapters or processes provisioning one bucket, could read the configuration from before that write and silently overwrite its rules, with no way to tell a merely stale read from a genuine rival. S3 serves a bucket's configuration eventually consistently, and documents specifically that a lifecycle configuration can take a few minutes to propagate. `ensureS3LifecycleRule()` now re-reads after every write, so a rule a competing writer added is carried forward when this call's own next re-read happens to show it. A re-read that still shows the same rules — by id and the fields this call manages — as the one behind the last write is treated as that propagation lag rather than loss, prompting another wait rather than another write; only a re-read that shows a genuinely different configuration, still without this call's own rules, counts as a competing writer, and it rewrites, merged with whatever that read now holds. `CONTENTION` fires only when every one of the five rounds this polls for needs a write — a competing writer replacing the configuration on every single re-read; a last round that rewrites without reaching that count, or that finds only lag, logs a `warn` and returns instead — the rules were written, only their visibility could not be confirmed within the polling window. This is user-visible even when nothing is contending it: a call that needs to write now waits before returning — at least about 1 second, up to about 15 across the five rounds — where `rc.2` returned as soon as its one write was acknowledged. This does not reach a *different* call's own first read, though — a lifecycle GET carries no version, so nothing here can tell that read was stale — so two adapters or processes provisioning one bucket must still be called sequentially, one at a time, and each re-run after a few minutes once every one of them has run.
- **`scripts/find-stranded-payloads.mjs` no longer reports a row past its `ttl` as stranded when every reader already treats it as gone.** A checkpoint META row, a store item row and a history message row are: `getTuple`, `list`, `store.get`/`search` and `history.getMessages` each check a row's own `ttl` before serving it, so reporting one of those past its `ttl` was a false positive; such a row is now counted apart instead. A checkpoint PAYLOAD row is not — `getTuple`/`list` serve it once the checkpoint's META row is judged live, without ever checking the PAYLOAD row's own `ttl` — so one past its own `ttl` is still reported unless its checkpoint's META row is itself past its `ttl` or absent, checked with one further `GetItem`. A pending-WRITE row is always reported past its own `ttl`, whatever its checkpoint's META row says: a pre-v4 checkpoint's child serves its parent's pending writes (`migratePendingSends`) through the child's own `getTuple`/`list` without ever reading the parent's META row, so no cheap check here can rule out a live child still serving it. The script also now detects that it was run directly with `is-main.mjs`, so it no longer silently exits 0 having done nothing when reached through a linked path.
- **`store.batch` holds `readConcurrency` payload decodes at once, not its square.** It ran up to `readConcurrency` operations together and each search decoded up to `readConcurrency` payloads, so a batch of searches could hold 64 decodes at the defaults — about 6.4 GiB — against the documented per-call ceiling of 800 MiB. Operations running together now share one budget.
- **`putWrites` keeps at most 32 regular writes in flight.** It sent every pending write at once, so a large `Send` fan-out queued far more requests than the SDK agent's 50 sockets; the request timeout counts that queue, so a wider fan-out, larger values, or an injected client with a shorter request timeout could time out healthy writes that this package then re-sends. The README also no longer says a re-sent regular write overwrites: it is first-write-wins.
- **`reconcileVectorIndex` no longer prunes the vector of an item re-put during the reconcile.** A candidate the snapshot had seen yielding no embedding was pruned on that evidence alone, so an item re-put with indexable text in between lost the vector its put had just synced. The row's revision is now re-read first.
- **A download refused on its declared `Content-Length` releases its socket.** The body stream was left unread and open until the idle timer closed it.

### Documentation

- The IAM policy recommends `s3:ListBucket` on the offload bucket, with why: without it S3 reports a missing object as `AccessDenied`, which the library cannot tell from a refused one.
- `indexShards` is documented as fixed for the table's life: the backfill writes keys only to rows that have none and cannot re-shard, raising the count is safe, and lowering it hides rows.
- The README no longer says leaked objects are "all reclaimed by `ensureS3LifecycleRule()`": that holds only with a `ttl`, and the new orphan sweep finds and, with `--delete`, removes them on a deployment without one — though on a versioned bucket, freeing the storage `--delete` leaves behind as a delete marker still needs a noncurrent-version-expiration and delete-marker-reclaim rule, which only `ttl` gets written automatically. The same claim, and a decision record saying a TTL-less deployment "has no backstop at all", are corrected in the same places in the guide and `docs/decisions/0005`.
- **The README's "S3 lifecycle rules" section no longer invites a `ttl`-less deployment to copy `ensureS3LifecycleRule()`'s rules verbatim.** Their `Expiration.Days` clause has nothing to correlate with when no row ever expires, so copying it deletes every live payload's current version once it turns that many days old. The section now shows, and the guide and the sweep's own docs now point to, the safe shape for a deployment without a `ttl`: a `NoncurrentVersionExpiration` rule alone, plus the unchanged delete-marker-reclaim rule.
- **The README and guide now document that turning a `ttl` off does not remove the `Expiration.Days` rule an earlier `ttl`-configured call wrote.** `ensureLifecycleFor` returns early without a `ttl`, so it neither writes nor removes anything; the stale rule keeps expiring every live payload's current version on its old schedule. Both now say how to find and remove it (by its id or its `Filter.Prefix`), and how to replace it with the safe shape if reclaim is still wanted.

## [1.0.0-rc.2] - 2026-09-27

Relative to `1.0.0-rc.1`, every adapter now refuses a caller's mistake instead of ignoring it, crashing, answering with a silently empty result, or reporting it as an AWS failure: a refused input raises a `DynamoDBLangGraphError` with `code === ErrorCode.VALIDATION` naming the argument, in every case listed under *Changed (breaking)* below. Every error this package throws is one class, `DynamoDBLangGraphError`, told apart by `code` rather than by a menagerie of subclasses — throttled, unavailable, contended, denied, not found, rejected, and so on — with the two codes that report more than a message carrying it as typed `details`; the retry layer's default retryable names are derived from the same classification table. Caller input is now parsed once, at each public method's boundary, into types only a parser can build, closing a race where mutating an argument object mid-call changed what had already been validated. The public API is otherwise unchanged from `1.0.0-rc.1`: every method signature and exported type is the same, and so is the field each refusal names, except where a change below says otherwise.

### Added

- **`JSON_SERDE`** — the plain JSON serializer the store and chat-history adapters already default to — is now exported from the package root, so a checkpointer can be given it in place of LangGraph's `JsonPlusSerializer`. The two differ on the read: `JsonPlusSerializer` reconstructs a `Map`, `Set`, `Uint8Array` or allow-listed `langchain_core` class from an `lc` marker the row carries, while `JSON_SERDE` runs `JSON.parse` and reconstructs nothing — narrowing the [deserialisation trust boundary](README.md#trust-boundary) for anyone who wants that, at the cost of the JSON projection the README's *Table schema* now tabulates. It is frozen, like `ErrorCode`, since one object serves every adapter that passed no `serde` of its own. `loadsTyped` also raises `VALIDATION` naming `data` for input that is not bytes.
- **`SearchOptions`**, the type of `store.search()`'s options (`filter`, `limit`, `offset`, `query`, `signal`), is now exported, alongside `GetMessagesOptions`, `ListSessionsOptions`, `CancelOptions` and `BackfillOptions`.
- **`ListNamespacesOptions`** (`store.listNamespaces()`'s `prefix`, `suffix`, `maxDepth`, `limit`, `offset`) and **`DeltaChannelHistoryOptions`** (`saver.getDeltaChannelHistory()`'s `config`, `channels`) are exported too — the same parameter types upstream declares inline, pinned equal to them by a type test, so what a call accepts is unchanged. The API reference now lists their fields.
- **A `warn` when one `getMessages()` call reads a very large session** (past 10,000 messages). The read still completes — a caller who wants a bound passes `limit` — but an operator is now told, the same way the checkpointer reports a checkpoint with very many pending writes.
- **`backfillRecencyIndex()`**, an operator tool that gives rows written before the recency index existed their index keys. Run it before setting `indexName`, or the index hides every pre-existing row. Resumable, re-runnable, and safe against a live table.
- **`readConcurrency`** (default 8, unchanged behaviour): the number of payloads one call decodes at once, and of recency-index shards one listing queries at once. It bounds this package's memory ceiling — `readConcurrency × (s3.maxDownloadBytes + compression.maxDecompressedBytes)`, 800 MiB at the defaults — previously undocumented and unadjustable. Lower it on a small container.
- **A recency index (`indexName`, `indexShards`).** Naming a GSI on the `gsi1pk`/`gsi1sk` attributes every listed row now carries (checkpointer `META`, store items, history `SESSION`) turns `history.listSessions()` from a full-table scan with an in-memory sort, and a thread-less `saver.list()` from a table scan, into a pageable, streamed index read. The partition key is sharded (`indexShards`, 1–1024) to avoid the single hot partition AWS warns against; a listing queries at most `readConcurrency` shards at once, and a shard whose pages don't end within the iteration cap raises `RESULT_TRUNCATED` rather than a partial answer. `nextCursor` is present whenever a shard has more to report; a `cursor` that does not decode to an index sort key (`<timestamp>#<id>`, i.e. contains no `#`) raises `VALIDATION` naming `cursor`. `history.listSessions({ limit, cursor })`: with `indexName`, `limit` (default 100) and `cursor` page the index; without it, an explicit `limit` selects the newest N of a scan, omitting it returns every session (a scan has no cursor), and a `cursor` raises `VALIDATION` naming `cursor`. `store.search([])` and `listNamespaces()` without a prefix root stay scans — a recency index cannot express a namespace-prefix condition. Opt-in: without `indexName`, both listings scan the table exactly as before, so the index can be created and backfilled before any adapter reads it.
- **Every row carries its own format version (`v`)**, and a read now refuses one written by a newer release with `FORMAT_UNSUPPORTED` instead of guessing at an unknown shape. Rows without `v` read as version 0 under the old rules; nothing needs migrating.
- **Offloaded S3 objects are uploaded with `If-None-Match: *` and carry a backlink to their row.** A retried upload therefore writes nothing new: S3's `412 Precondition Failed` on the write's own key means an earlier attempt already stored the object, and counts as success. Each object also carries its row's DynamoDB key in S3 user metadata (`dynamodb-pk-b64`, `dynamodb-sk-b64`) — the backlink AWS recommends so an out-of-band sweeper can tell an orphan from a live object. The object key's write-id suffix is now appended as-is rather than base64url-encoded: `<keyPrefix><identifiers, each base64url-encoded>/<write id>.bin`. Objects written by `1.0.0-rc.1` are still read and deleted through the key their descriptor records; nothing needs migrating.
- **Every export now documents its contract, enforced by static tests**: an exported function (or reachable class member) whose doc comment omits what it accepts, returns or throws fails the build, as does an exported function no test names.
- **`ensureS3LifecycleRule()` writes a second lifecycle rule and reports the bucket's versioning state.** The second rule (`Expiration: { ExpiredObjectDeleteMarker: true }`, same prefix) reclaims the delete marker a release otherwise leaves behind forever — S3 refuses that expiration combined with `Days` in one rule, hence two. After writing both rules, the call reads `GetBucketVersioning` and logs one `warn` for anything but `Enabled` (never versioned, suspended, or a failed read), naming the missing containment; it never fails the call, since the rules are worth writing either way. `s3:GetBucketVersioning` is a new IAM action on the bucket, and the only one whose absence is not fatal. This package does not enable versioning itself and nothing enforces it — only reports it.
- **A sweep that reports rows whose offloaded payload has been released.** `scripts/find-stranded-payloads.mjs` lists delete markers under the offload prefix on a versioned bucket, reads each released object's backlink metadata, and checks whether the row that named it is still live — those are the rows a read would fail on, and the grace window is the only time the payload can still be restored. It prints the DynamoDB key, the object key, both version ids, and the remaining grace hours, with both remedies spelled out; it repairs nothing itself. It ships **in the repository, not in the npm tarball**, and has no `bin`. The runbook and the operator permissions it needs (`s3:ListBucketVersions`, `s3:GetObjectVersion`, `dynamodb:GetItem` — stated as prose, not added to the published policy) are in the README's [Finding rows whose payload was released](docs/guide.md#finding-rows-whose-payload-was-released).
- **Every payload descriptor and chat-history session row now carries the id of the write that produced it (`writeId`)** — an optional field, additive: a reader that doesn't know it is unaffected, and a row written before this release simply carries none. It is what the delete-side guarantee below (`deleteThread`/`clear`) reads to avoid releasing a payload a newer write superseded. A pending-write row is pinned on `writeGroup` instead, which it has carried since `0.8.0`, so that guarantee reaches back that far for those rows.
- **A pass-shaped `BATCH_WRITE_INCOMPLETE` now names what its counts count**, via `details.unit` (`'chunk'`, the default, or `'row'`); omitting it keeps the wording exactly as before. A partition delete reports its failure with the row unit.

### Changed (breaking)

- **One error class, replacing the ten `1.0.0-rc.1` exported.** Every error is a `DynamoDBLangGraphError`; branch on `code`. The nine subclasses `1.0.0-rc.1` exported, plus `ErrorCode.UPSTREAM`, are gone; `isDynamoDBLangGraphError` now narrows to a union discriminated by `code`, so `details` is typed without a cast.

  | `1.0.0-rc.1` | Now |
  |---|---|
  | `ValidationError` | `code === ErrorCode.VALIDATION`; `context.field` unchanged |
  | `ConflictError` | `code === ErrorCode.CONDITION_CONFLICT` |
  | `RetryExhaustedError` | `code === ErrorCode.RETRY_EXHAUSTED`; `context.attempts` unchanged |
  | `ResultTruncatedError` | `code === ErrorCode.RESULT_TRUNCATED`; `context.field` unchanged |
  | `AbortError` | `code === ErrorCode.ABORTED` |
  | `BatchWriteIncompleteError` | `code === ErrorCode.BATCH_WRITE_INCOMPLETE` with `details.kind === 'drain'`; `.succeededCount`, `.unprocessed` → `details.succeededCount`, `details.unprocessed`; the retry rounds are `details.retries` |
  | `BatchWriteAllIncompleteError` | `code === ErrorCode.BATCH_WRITE_INCOMPLETE` with `details.kind === 'pass'`; `.succeededChunks`, `.totalChunks`, `.failedChunks`, `.succeededCount` → `details.*`; the unit is `details.unit` |
  | `CompensationFailedError` | `code === ErrorCode.COMPENSATION_FAILED`; `.rollbackError` → `details.rollbackError` |
  | `UpstreamError` / `ErrorCode.UPSTREAM` | the code the classifier assigns — `THROTTLED`, `SERVICE_UNAVAILABLE`, `CONTENTION`, `ACCESS_DENIED`, `NOT_FOUND`, `AWS_REJECTED`, `CONDITION_CONFLICT`, `ABORTED`, `AWS_REQUEST_FAILED`, or `UNEXPECTED_ERROR` for a failure that is not AWS's; `.upstreamName`, `.requestId`, `.httpStatusCode` → `context.awsErrorName`, `context.requestId`, `context.httpStatusCode` (or `cause.name` for a non-AWS failure) |
  | `error.name === 'ValidationError'` (any subclass name) | `error.name` is always `'DynamoDBLangGraphError'`; test `code` |
  | `.unprocessed: WriteRequest[]`, `.failedChunks: Error[]` (mutable arrays) | `details.unprocessed: readonly WriteRequest[]`, `details.failedChunks: readonly Error[]`; copy before mutating (`[...details.unprocessed]`) |
  | `JSON.stringify(error)` carried flat fields (`upstreamName`, `requestId`, `httpStatusCode`, `succeededCount`, `unprocessed`, `succeededChunks`, `totalChunks`, `failedChunks`, `rollbackError`) | it carries `code`, `context` and `details`: the AWS fields are `context.awsErrorName`, `context.requestId`, `context.httpStatusCode`, the counts are `details.*`. A log pipeline or alert keyed on a flat field reads the nested one instead |

- **A row whose `s3Key` points outside its own path is now reported by `history.getMessages`, not silently skipped.** Such a key is not payload loss — the object is very likely intact, just under a prefix this reader may not follow (a misconfigured `keyPrefix`, a shared table, or a planted row) — so `getMessages` now rejects with `VALIDATION` naming `s3Key` under **both** `onCorruptMessage` policies, matching what `store.get()` and `saver.getTuple()` already did for the same row shape. A genuinely unreadable descriptor is still skipped under `'skip'`. If a foreign row was being silently healed over, delete or repair it, or check `s3.keyPrefix`.
- **A stored payload the configured serializer refuses to reconstruct is now `VALIDATION` with `context.field: 'serde'`** (serializer's error as `cause`) — an `lc` constructor record naming a class outside LangChain's allow-list is the case that matters. It previously escaped as an unbranded `UpstreamError` and **copied the stored record verbatim into `err.message`**, which this package's errors are contracted never to carry; `history.getMessages` silently dropped the message under `'skip'`. It is deliberately **not** classified as payload loss: the bytes are undamaged, and a reader with the right import map reads the row fine. All three adapters now refuse it alike. Affected: anything branching on `UPSTREAM` for this case, and any `'skip'` reader silently losing such messages.
- **`JSON_SERDE` now reads only the `json` form it writes; a row declaring another `serdeType` is reported instead of misread.** It previously ignored the declared type and ran `JSON.parse` on whatever it was handed — so a non-parsing row was `PAYLOAD_CORRUPT` under the checkpointer default and silently dropped (`'skip'`) under the store/chat-history defaults, and a row that *did* parse decoded to the wrong value with nothing raised (a stored `Uint8Array` read back as a number). A `serdeType` other than `json` is now `VALIDATION` naming `serde`, raised before a byte is read. Affected: anyone reading rows written under one default through the other, and any `'skip'` reader losing such messages. Remedy: read a row with the serializer that wrote it, or rewrite it.
- **A row a newer release wrote is now reported before its shape is judged: a read that used to skip it now raises `FORMAT_UNSUPPORTED`.** The checkpointer's `META#`, the store's item, and `history.listSessions`'s session narrows each tested attributes first and `v` last, so a row with a later, differently-shaped format was silently treated as foreign and dropped — leaving `saver.list`, `getTuple`, `store.get`/`search`/`listNamespaces` and `listSessions` silently short. All three now read `v` first (as `history.getMessages` already did) and raise `FORMAT_UNSUPPORTED` naming `v`. A row at a readable version whose attributes are foreign is still skipped exactly as before. Breaking for anyone reading a table a newer release also writes to, and for a hand-written row carrying `v > 1` **inside the reading adapter's own key space** — now narrowed to exactly that space, since the two cross-partition scans (`store.search([])`/`listNamespaces()` without a prefix root, and thread-less `listSessions()`) now restrict to their own adapter's partition tag first. Nothing changes for rows any release of this package wrote. Remedy: upgrade to a release that reads the row, or delete/repair a hand-written one.
- **A row in a session's message-key space that this adapter did not write is now reported by `getMessages`, not skipped.** Such a row (no `message` descriptor, `null`, no `sessionId`, or a `sessionId` naming another session) previously reached the codec, was misclassified as unrecoverable payload loss, and — under `'skip'` — was silently dropped from the conversation, shortening it. The row is now narrowed (bound to its own partition) before decoding, as the checkpointer and store already do; a failure is `VALIDATION` naming `message` under **both** policies, with a `warn` naming the row. `history.reconcileMessageCount` now refuses the same row rather than counting it, so a call that used to inflate `messageCount` now rejects instead. Breaking for a caller that was silently handed a shorter conversation; remedy: delete or repair the row the `warn` names.

- **`s3.keyPrefix` must now name a real path.** Every segment before the trailing `/` must be non-empty and neither `.` nor `..`, and the prefix must be free of control characters and well-formed UTF-16; `../`, `a/../b/`, `./`, `/a/`, `//`, and similar were all accepted before. Each now throws `VALIDATION` naming `s3.keyPrefix`, at construction and again from `ensureS3LifecycleRule()`. An S3 key is a byte string, not a path, so `a/../b/x.bin` and `b/x.bin` are different objects — a prefix like this wrote outside the path a deployment granted and outside what its lifecycle rule sweeps.
- **`getMessages({ before })` now refuses a date outside the range a message id can encode** (before the epoch, or at/after 2^50 ms — year 37648) with `VALIDATION` naming `before`. Such a date previously resolved with the wrong answer: a negative millisecond encoded as `undefined` characters that sorted **above** every real id, so a window asking for messages before 1969 returned the entire session; a too-large date wrapped to the smallest bound and returned none of it.
- **A `serde` may no longer encode a value it accepts to zero bytes.** Such a payload is now refused at the write with `VALIDATION` naming `value`. Under the default serializers only a function or a symbol does this (and such rows were already unreadable on the next read, so this is a repair); a custom `serde` whose canonical empty message *is* zero bytes (an empty protobuf message, say) can no longer store that value — add a byte of framing in your own encoder.
- **`limit` is one rule everywhere now, with a ceiling of 10,000.** Every `limit` this package takes (`saver.list`, `store.search`, `store.listNamespaces`, `history.getMessages`, `forSession`, `listSessions`) is checked by one validator instead of five with three different semantics and no ceiling. Two changes are breaking: **`saver.list(config, { limit: -1 })` now throws `VALIDATION` naming `limit`**, where it used to silently yield nothing; and **any `limit` above 10,000 throws**, naming the ceiling — the most this package will ever collect across one paginated query, since every row is held decoded for the whole page (an offloaded row costs its own S3 GET and decompression). Every default is unchanged.

  **There is one floor of 1, and it's deliberate:** `getMessages` and the `forSession` window refuse `limit: 0`, where every other read answers it with an empty page and no request — an empty *conversation window* reads as though the conversation never happened, rather than as a visibly empty answer.
- **Identifiers now reject C1 control characters** (`U+0080`–`U+009F`), alongside the C0 range and DEL already rejected — closing a gap where `U+009B` (a single-byte `CSI`) could still open a terminal escape sequence (CWE-117).
- **`ttl` must name exactly one unit, and nothing else.** `{}`, a misspelt unit (`{ day: 1 }`), a non-object, and `null` used to be resolved arbitrarily or raise a misdirecting message; each now raises `VALIDATION` naming `ttl` (or `ttl.<key>` for a misspelt/extra key, checked before the unit itself — `{ days: 1, foo: 1 }` used to silently ignore `foo`).
- **Options objects now reject keys this package does not read**, across every adapter's own options, their nested `ttl`/`retry`/`compression`/`s3`, the store's `index`, `backfillRecencyIndex`'s options and `retry`, `forSession`'s window, and the per-call options of `saver.list`, `getDeltaChannelHistory`, `store.search`, `listNamespaces`, `getMessages`, `listSessions`, and every `{ signal }`. An unknown key raises `VALIDATION` naming `options.<key>` (`retry.<key>`, `window.<key>`, and so on when nested) — where a misspelling (`readConcurency`, `retry.maxAttempt`, `{ limt: 10 }`) used to be silently ignored and the caller ran on a default it believed it had overridden. The accepted key sets are checked against the option types at compile time and cannot drift from them.
- **A non-object `options` value now raises `VALIDATION` naming it**, everywhere it previously read as no options, threw a bare `TypeError`, or surfaced as an `UpstreamError` — an adapter constructor, `store.search`/`listNamespaces`, and the three `DynamoDBFactory` create methods (naming `options`, or the section name for `createAll`) all included. A `signal` that is not `AbortSignal`-shaped (a boolean `aborted` plus callable `addEventListener`/`removeEventListener`) now raises `VALIDATION` naming `signal` (`retry.signal` for `backfillRecencyIndex`) instead of being accepted unchecked and possibly throwing uncaught from inside a retry wait; this covers the checkpointer's `config.signal` too, on `getTuple`, `list`, `put`, `putWrites` and `getDeltaChannelHistory` — the README records it as V-28. `clientConfig`/`s3.clientConfig` must be objects (their own keys stay unchecked, since they belong to the AWS SDK); `s3.keyPrefix` must be a string; `s3.sseKmsKeyId`, when given, a non-empty string (only its type is checked — a falsy value is still silently dropped, so objects upload without the key you named). A store's `index` that is falsy now means no index rather than being silently accepted, and `index.fields` must be an array of strings. `DynamoDBFactory`'s constructor and `createAll` validate their own `clientConfig` and `logger` the same way.
- **Every dependency floor moves to the current release, peers included.** `@aws-sdk/client-dynamodb`/`lib-dynamodb` now require `^3.1132.0`, the optional `@aws-sdk/client-s3` peer `^3.1132.0` (was `^3.901.0`), `@langchain/core` `^1.2.11` (was `^1.2.9`); `@langchain/langgraph-checkpoint` stays `^1.1.5`. A consumer pinned below any of these must move up. CI now installs every peer at exactly its declared floor and runs the type check and unit tier against it.
- **`history.listSessions()` returns a page, not an array: `{ sessions, nextCursor? }`.** A caller reading the result directly now reads `.sessions`.
- **Numeric options now have ceilings**, each raising `VALIDATION` naming the option at construction if exceeded: `indexShards` 1024 (adapters and `backfillRecencyIndex`, which must match), `readConcurrency` 128, `retry.baseDelayMs`/`retry.maxDelayMs` 60,000 ms, `compression.minSizeBytes`/`maxDecompressedBytes` and `s3.maxDownloadBytes` 512 MiB, `maxScanItems` 1,000,000, `maxSearchCandidates` 100,000. Every default is unchanged; the README's *Limits* table lists each default beside its ceiling.
- **Injected collaborators are now checked at construction, by shape.** `client` must provide `get`/`put`/`delete`/`update`/`query`/`scan`/`batchWrite`/`transactWrite` (so a raw `DynamoDBClient` is refused where a `DynamoDBDocument` belongs); `logger` all four of `debug`/`info`/`warn`/`error`; `serde` `dumpsTyped`/`loadsTyped`; `index.embeddings` `embedQuery`/`embedDocuments`; `vectorBackend` `upsert`/`query`/`delete` (`listKeys` optional). A non-object, an array, or `null` (which used to silently select the default, or mean "none" for `vectorBackend`) now raises `VALIDATION` naming the option or its first missing method — where a deficient collaborator used to fail only when this package first called the missing method.
- **A read cap must now be an integer of at least 1, checked before any read.** `listSessions()`'s `maxItems`/`maxIterations` used to be checked *after* an item was handed out, so `0` returned one row or threw `RESULT_TRUNCATED` depending on paging luck; a fraction passed unchecked, and `null` silently meant the default. `Infinity` still means no cap.
- **A non-object `config` now raises `VALIDATION` naming `config`**, on `saver.getTuple`/`list`/`put`/`putWrites`/`getDeltaChannelHistory`, before any property is read — where `null`/`undefined` used to surface as an `UpstreamError` and anything else was read as naming no thread (`list('x')` scanned every thread). A non-object `configurable` (present but malformed) raises `VALIDATION` naming `configurable` the same way — it was likewise read as naming no thread, so `list({ configurable: 'thread-1' })` scanned every thread while `getTuple` silently answered `undefined`. README: V-14.
- **A checkpoint id of `0`, `false` or `NaN` is now refused**, whether given as `configurable.checkpoint_id` or the legacy `thread_ts` — only `undefined`/`null`/`''` mean "no id" now; it used to silently address the latest checkpoint. README: V-15.
- **`saver.list()` now checks its `before` and `filter`.** A non-string or empty `checkpoint_id` inside `before` used to make every checkpoint fail comparison (a silently empty listing) or, for a malformed id, be used as an unchecked bound; it's now validated, naming `before`, with an empty id meaning no bound. `filter` must be an object, not an array — a string/array filter used to silently empty the listing, and `null` (meaning none) is refused too. README: V-15, V-16.
- **`saver.put()`/`putWrites()` now refuse arguments they cannot read.** A `null`/`undefined` checkpoint raises `VALIDATION` naming `checkpoint`; a non-array `writes`, or one holding a non-array entry, raises one naming `writes` — checked in full before anything is encoded or written (`writes: []` is still a no-op). Both used to surface as `UpstreamError`. README: V-17.
- **`saver.getDeltaChannelHistory()` now takes exactly `{ config, channels }`** as declared upstream. A missing/non-object argument or `config`/`channels`, or an extra key, raises `VALIDATION` naming the right one — where a missing argument used to surface as `UpstreamError` and a non-array `channels` (`'x'`, `[1]`) was silently coerced to a single named channel. `channels: []` still returns `{}`. README: V-18.
- **`store.put()`, `get()`, `delete()` and `listNamespaces()` are now validated in this package rather than inherited from upstream's `InvalidNamespaceError`,** which escaped with no `code`. An empty namespace or a `"langgraph"` root now raises `VALIDATION` naming `namespace`; a bad label names `namespace element`. `put(namespace, key, null)` now raises `VALIDATION` naming `value` instead of silently deleting the item — `put` is typed to take an object, and upstream's `null`-means-delete encoding only applies to `delete()`/`batch()`. README: V-19.
- **Store operations are now checked on every route, `batch()` included** (the route a graph's `AsyncBatchedStore` actually uses). A non-object/array put `value`, a bad `index`, a non-array `namespacePrefix` (a string used to silently answer an empty page), a non-array `matchConditions` entry, and a malformed `operations` argument (used to surface as `UpstreamError`) all now raise `VALIDATION` naming the right field. README: V-20, V-21, V-24.
- **`store.batch()` now answers a put or delete operation with `null`, as the reference `InMemoryStore` does** (was `undefined`). `store.put()`/`delete()` still resolve with `undefined`.
- **`store.search()` and `listNamespaces()` now check their arguments.** A non-object/array `filter` (used to silently answer an empty page, or mean none for `null`) and a non-string `query` (silently ignored, or sent to the embeddings model regardless) now raise `VALIDATION`; `search`/a `batch()` search operation refuse a `null` `offset`/`limit` (used to be read as 0, then the default). `listNamespaces` refuses a non-array `prefix`/`suffix`. A label in a search prefix or listing path that isn't a usable key segment (non-blank, ≤256 bytes, free of `#`/control chars/unpaired surrogates) raises `VALIDATION` naming the element — used to silently answer empty. `'*'` still wildcards a listing, and an empty search prefix still spans every namespace. README: V-21, V-22, V-23.
- **`history.forSession()` now checks its arguments synchronously**, throwing `VALIDATION` for a malformed `sessionId`, a bad `window`, or a `limit` under 1 — where it used to return an adapter regardless and fail only later, inside the promise `RunnableWithMessageHistory` awaits. Code calling `forSession` outside a promise now gets the exception at that call. An error a custom `backend` throws is no longer passed through untouched: a foreign one now reaches the caller as a classified `DynamoDBLangGraphError` (`UNEXPECTED_ERROR` unless it's already AWS-shaped) with the original as `cause`.
- **History calls no longer report a caller's mistake as an AWS failure.** `getMessages(sessionId, { before: null })` now raises `VALIDATION` naming `before`, and a non-array `addMessages` `messages` names `messages` (`[]` still a no-op) — both used to surface as `UpstreamError`.
- **`backfillRecencyIndex()` now checks every option before touching the table**, naming it in a `VALIDATION`: an unknown key or non-object options; an out-of-range `tableName`; a `client` missing `scan`/`update`; an `indexShards` outside 1–1024; a non-positive-integer `pageSize`/`maxPages`; a non-boolean `dryRun` (which used to read `"false"` as true and silently write nothing); an out-of-bounds `retry` or one with a non-function `onRetry`/`isRetryable`/`rng`; a bad `signal`/`retry.signal`; and a `cursor` it did not issue. An unretried AWS SDK error now reaches the caller as a classified `DynamoDBLangGraphError` with the SDK error as `cause`, where it used to escape unwrapped.
- **`saver.put()` of an existing `checkpoint_id` now keeps whichever write *committed* last, not whichever *landed* last.** Two distinct calls still race exactly as the reference savers do, but a *retry* of an already-committed write is now answered from DynamoDB's idempotency cache instead of re-landing and winning — matching the README's (now corrected) description of last-writer-wins.
- **`deleteThread()` and `clear()` now delete exactly the rows they read, and can refuse a row that changed under them**, instead of an unconditional batch delete that could erase an already-acknowledged write. A row rewritten between the read and its own delete is refused, not removed: nothing it names is released, it's logged at `warn` with its sort key, and it's counted as skipped (for a checkpoint, the rest of that checkpoint's rows are skipped behind it). Two breaking effects, detailed in the guide's [What a partition delete promises](docs/guide.md#what-a-partition-delete-promises) and [What a partition delete costs](docs/guide.md#what-a-partition-delete-costs): a call that used to report every row gone can now report some skipped (re-run once the thread/session is quiescent), and the request cost rises roughly 25× (~10,000 requests for a 10,000-row thread, at most 8 in flight; write capacity for rows actually deleted is unchanged). The `BATCH_WRITE_INCOMPLETE` from these two calls now counts **rows**, not chunks (`details.unit: 'row'`). Rows written before this release carry no write id and are deleted unconditionally, as before.
- **A `vectorBackend` search now fails when it cannot read a matched item, instead of returning a shorter page.** Every re-read error used to be swallowed with a silent `warn`, so a throttled or cancelled read looked identical to a deleted item and the caller got a page quietly short with no way to tell. `RETRY_EXHAUSTED`, any AWS-classified code, `ABORTED`, `PAYLOAD_CORRUPT`, `S3_OFFLOAD_FAILED`, `FORMAT_UNSUPPORTED` and the relevant `VALIDATION`s now all reach the caller. One case is unchanged: a backend key this store cannot address (a reserved separator in a namespace element) is still dropped with a `warn` and repaired by `reconcileVectorIndex`, since one bad key must not fail a whole search. Breaking for a caller that treated a short page as complete under load.
- **`store.delete()` now reads the row before removing it, and can resolve without removing it.** It used to send one unconditional `DeleteItem`; it now issues a strongly-consistent read plus a conditioned `TransactWriteItems`, retried up to three times. Three consequences: deleting a key with **no row** now costs a read and can **fail**, whereas it always succeeded before; three concurrent writes landing between re-pins exhaust the compare-and-swap, so the call **resolves with the item still there** and logs a `warn` (README: V-29 — remedy is to re-run once the key is idle); and the removal, being a transaction, is now charged twice the write units of a plain `DeleteItem`, plus a strongly-consistent pre-read. In exchange, the leak this path used to have by construction — the object of a delete whose acknowledgement was lost — is gone. `store.delete` still takes no `AbortSignal`; the pre-read keeps the full retry budget (about three and a half minutes at the defaults).

### Changed

- **Text this library did not length-check is now cut before it reaches an error message or log line — consistently, wherever it came from.** Previously the same value could get two different answers (an `s3Key` cut at 256 characters in one `warn` and quoted whole in a `VALIDATION` about the same row). Affected fields — an out-of-scope `s3Key`, an S3 object key, an unknown `location`, a forward `schemaVersion`, a message `type`, expired-ancestor ids, a lifecycle rule id — are now cut at 256 characters and marked `…(len N)`. **The structured `context` on every error is unchanged and still carries the value whole** — that's what the README tells you to branch on; error text never was the contract.
- **A relayed cause's text is now bounded too, at its own larger cap of 1024 characters** — the last family the truncation rule hadn't reached, covering a relayed AWS SDK error, a spent retry budget, an S3 transfer failure, `COMPENSATION_FAILED`, and a consumer's own `serde`/`vectorBackend` throw. 1024, not the 256-character identifier cap, because this is prose (an IAM `AccessDenied` naming a principal, action and resource ARN runs long and is worth reading whole) rather than a name; redaction still runs before the cut. A failure's **`name`** is cut at the 256-character identifier cap wherever a message or log line quotes it. `err.cause` is untouched and carries the original message in full. One field is exempt: the `options.<key>` an unknown-option `VALIDATION` names is also its `context.field`, which is never cut, since callers branch on it.
- **A namespace or channel list is now bounded in both dimensions — how many labels, and how long each is** — not just the per-string cap that left an unbounded label count uncapped. Lists are now cut at 8 labels as well as 256 characters per label, in the two log lines that quote a `vectorBackend`'s own `namespace`, and in a `namespacePrefix`/reconcile `prefix`. A `namespace`+`key` pair that already passed validation is still quoted whole.
- **`resolveLogger` now returns a wrapper around a caller-supplied logger, not the object itself** — identity is no longer preserved. Every call delegates with its message and arguments unchanged; only a throw from the caller's own method is absorbed (see *Fixed*, below).

- **A page can now come back shorter than its `limit` for a few more reasons.** `history.listSessions` also drops a SESSION row whose `messageCount`/`createdAt`/`updatedAt`/`title` has the wrong type, or whose `sessionId` disagrees with its partition; `store.search` drops a row carrying no timestamps. For `listSessions` the cursor still advances past a dropped row.
- **An offloaded write now costs two write units per KB instead of one, and more requests on a contended row** — inline writes are unchanged, so this falls only on the offload path. See the guide's [What a token costs](docs/guide.md#what-a-token-costs) for the measured request overhead under contention.
- **A write carrying an idempotency token now stops retrying after 300 s**, half of DynamoDB's ten-minute token window, whatever `retry` is configured to — so a long policy can now end in `RETRY_EXHAUSTED` where it might once have eventually succeeded. A policy whose nominal worst case exceeds the deadline logs one `warn` at construction naming both numbers, rather than being refused. The deadline can only refuse to *begin* the next wait, never cut an attempt already in flight — the 10 s per-attempt request timeout (see *Fixed*) is the other half of that bound. A read keeps the full configured retry budget.
- **An inline write can now meet a `TransactionConflictException`.** Because an offloaded write to a row is now a transaction while an inline write to the same row stays a `PutItem`, the inline side can be turned away by a conflict it couldn't see before (measured: 18% of inline attempts under ten-against-ten contention on one row). It's already retryable by name, so this costs requests, not correctness — the price of scoping the transaction by payload rather than by adapter.
- **The real-AWS test tier (14 suites, 70 tests against live DynamoDB/S3/Bedrock) no longer runs on a schedule.** `npm run test:aws` is now a maintainer step before a release, so a scheduled job billing Bedrock unattended can't happen; no coverage was lost by removing the schedule.
- The release gate now names the checks it requires, instead of comparing "succeeded" against "registered so far" — which could have published before the unit matrix, integration, conformance or package smoke had run.
- The dead `overrides.uuid` entry is gone, and the two dev-only advisories (`js-yaml`, `@humanfs/node`) are resolved; `npm audit` reports no vulnerabilities.
- **The manifest now declares `"type": "commonjs"` and a full `git+https://….git` repository URL**, the last two things `publint` had to say about the package — the emitted `dist/` is unchanged either way. `npm run pack:check` now reports a clean `publint`.
- **`docs/STABILITY.md` and `docs/CONTRACTS.md` are gone**, folded into the README's *Versioning and compatibility* (one document instead of two that could disagree). Its differences-from-the-reference table gained three entries the README carried and the old policy didn't: type-strict range comparison, an array used as a field condition, and key-ordered `search` results.
- **README corrections where the code had moved on**: the store embeds one vector per indexed field and ranks by the best match, not a single joined vector; the inline-vector size budget is per field, not per item; `$eq`/`$ne`/`$in`/`$nin` compare by deep equality, which *is* a difference from upstream's `===` (now recorded as V-25); and the cost table now shows the indexed path for `listSessions` and a thread-less `saver.list`.
- **The README now states what each layer does not cover**, in a new *What can still go wrong* list (write-idempotency window, strand grace window, the inline re-land race, an unversioned bucket, the conflict rates above, the store's unguarded fallback, the single-pass partition delete, and unchanged leaks) — it previously claimed a compare-and-swap "prevented" two races that it only decides *which* payload a write supersedes, never re-landing after a lost acknowledgement. The sweep's cost is corrected alongside it (one to two cents per sweep, not "a few dollars") — money was never the reason to run it on demand rather than hourly; the load of 40,000 requests against a live table is.
- **`SECURITY.md` and the README now state the deserialisation trust boundary.** Neither mentioned it before, though it's the property of this package a security reviewer most needs handed to them: **write access to the table selects a code path in every process that reads it.** Both now say so at measured scope — allow-listed `langchain_core` construction with attacker-chosen arguments, not arbitrary code, and a `__proto__` payload reaches only the revived object's own prototype, not the process-wide one — and name the control (table write access is trusted access, scoped by `dynamodb:LeadingKeys`) and the alternative (`serde: JSON_SERDE`, added above, with its costs).
- **The README now tabulates what each default serializer does to a value JSON cannot hold, measured rather than described** — and corrects the impression that the two defaults agree. They don't: a `Map`/`Set` is `{}` under plain JSON and a real `Map`/`Set` under `JsonPlusSerializer`; an `undefined` object-key value is dropped under plain JSON and survives under the other; `-0` is `0` under both. Two related claims are corrected: `serdeType` does not select a serializer on read (it's a tag for whichever one is configured), and each adapter's `serde` option now documents its own default instead of one phrase that fit neither.
- **The README no longer tells chat-history users to import a symbol that does not exist.** *Chat history semantics* said to pass `serde: new JsonPlusSerializer()` from `@langchain/langgraph-checkpoint`, which exports no such symbol — the snippet threw for anyone who copied it. The supported way to get that serializer is off a saver's default: `serde: new MemorySaver().serde`. The same sentence's `Date`-fidelity claim is also corrected: that serializer reads a `Date` back as an ISO string, so keep dates as a string or number yourself.

- **The default retry tokens are now derived from the error classification table, shared by DynamoDB and S3.** Newly retried on DynamoDB: `InternalFailure`, `ReplicatedWriteConflictException`, and S3's `SlowDown`/`InternalError`/`ConditionalRequestConflict`. No longer listed: `NetworkingError`, an SDK v2 name no installed package emits (every error it stood in for is still retried under its own name). The retry layer still also retries by the SDK's `$retryable` trait and walks the cause chain for `errno`/`syscall`, which the classifier doesn't.
- A raw SDK `AbortError` reaching a public method is now reported as `ABORTED` rather than as an upstream failure.
- **`ensureS3LifecycleRule()` now starts from an empty rule set only when the bucket has no lifecycle configuration (`NoSuchLifecycleConfiguration`).** Any other read failure — a missing bucket included — now fails the call; a missing bucket reaches the caller as `NOT_FOUND` where `1.0.0-rc.1` raised an `UpstreamError`.
- **Six log events now quote a library error's `code` instead of its class name, and still quote a foreign error's own name.** Every library error previously shared one class name, so `retrying after a transient error`, `getMessages: skipped a corrupt message item`, `Failed to clean up orphaned S3 objects after`, `store vector-index sync failed; reconcileVectorIndex will repair`, `factory.destroy: an adapter did not release its resources`, and `search: skipped an unusable vectorBackend match` all logged `reason: 'DynamoDBLangGraphError'` regardless of whether the failure was a refused input or a spent retry budget. Each now logs its real `reason` (`'VALIDATION'`, `'RETRY_EXHAUSTED'`, …).

- **`saver.putWrites` now refuses an over-long composed sort key before encoding anything**, instead of after serializing (and, with `s3`, uploading and releasing) the earlier writes of the same call. A call with both an unencodable earlier value and an over-long later key now reports `VALIDATION` naming `sortKey` rather than the serializer's refusal.
- **`store.batch` now schedules an operation by the kind its parser decided, not by re-reading its shape.** The planner used to test `'value' in op` before `namespacePrefix` — the opposite order the parser uses — so an object literal carrying keys from more than one `Operation` member (reachable from JavaScript, or through an excess-property loophole in TypeScript) could run as a search but be scheduled as a write or a point read. Both are now scheduled as the broad, unscoped read a search is; this affects only which other operations of the same batch may run alongside it, not what the operation itself does.

### Deprecated

- **`SessionBackend` is now `MultiSessionHistory`.** The type a `DynamoDBSessionChatMessageHistory` wraps is exported under the name that says what it is, since "backend" elsewhere in this package means the store's `vectorBackend`. `SessionBackend` stays exported, but as a `type` alias rather than an `interface` — a caller who augmented it by declaration merging needs `MultiSessionHistory` instead. It is removed in the next major release. The adapter's `backend` constructor parameter and the `backend` field its refusal names are unchanged.

### Removed

- **Mutation testing is retired.** The weekly workflow and its configuration are gone: every scheduled run since 2026-06-01 had failed silently (the runner resolved a real `typescript` package the `npx` sandbox fetched into, while this repository aliases that name to `@typescript/typescript6`), so its 70% break threshold was never once evaluated — a gate that never reports is worse than no gate, since it reads like coverage that exists. The quality floor is unchanged and enforced on every run: 100% branches/functions/lines/statements, the static guards under `test/static`, and the surface baseline.

### Fixed

- **A caller mutating its own input while a call awaits no longer changes what was checked.** `store.put/get/delete/search/batch`, `listNamespaces`, `saver.putWrites`, `getDeltaChannelHistory`, and `DynamoDBSessionChatMessageHistory`'s window now act on a copy made at validation time, not the caller's live object.
- **`listSessions` no longer reports a session id a planted row merely claimed.** The summary tested a row's sort key and the presence of `sessionId` without binding it to the partition the row was found in (the binding every other narrow makes) — so a row written anywhere under a `HISTORY#SESSION` sort key was summarised under whatever id it carried, sending a caller's `getMessages` into a partition the row never lived in. Such a row is now dropped like any other foreign one.
- **`reconcileMessageCount` no longer repairs a count for a session no read can open.** It now refuses the same rows `getMessages` refuses (a message row a newer release wrote, or one in the key space this adapter did not write) instead of counting them and writing an inflated `messageCount` back onto a session whose every read fails.
- **`store.get`, `put`, `delete` and `listNamespaces` now report their own method in a failure's `context.operation`**, instead of all four reporting `'store.batch'` (the shared dispatch they ran through). An operator counting `UpstreamError` by `context.operation`, as the README's *Monitoring* note recommends, can now tell a failing read from a failing write.
- **Six README claims about what fails, and how, were corrected.** The *Monitoring* note pointed at the wrong field for an SDK `requestId` (it's on the error's `cause`, not `context.attempts`); the error table listed a failed **delete** of an offloaded object as a source of `S3_OFFLOAD_FAILED` (a delete failure is logged as an orphan, never raised); *S3 offloading* claimed an over-large item raises a **raw** `ValidationException` where it's wrapped as `AWS_REJECTED`; the `CONDITION_CONFLICT` row and the `reconcileMessageCount` note each omitted one of that method's two `CONDITION_CONFLICT` cases (a session that does not exist); and the cancellation paragraph read as though `store.get` takes a signal, which — like upstream's `BaseStore` — it does not.
- **The metadata-filtering sample named six filter operators where the store accepts eight** — `$in` and `$nin` were missing from both the comment and the sample filter.
- **The CDK and Terraform infrastructure snippets are now valid, and both declare the optional recency index.** The CDK sample now runs inside a proper stack class (it previously called `new dynamodb.Table(this, …)` at module scope, with no `this`); the Terraform sample no longer puts more than one attribute per line. Both now also declare the optional `gsi1` recency index alongside the base table.
- **The `Throws:` contracts on `store.get` and `saver.getTuple` now name what they actually raise** — both omitted every failure a payload can produce on the way back (`S3_OFFLOAD_FAILED`, `COMPRESSION_LIMIT`, and the relevant `VALIDATION`s), and `getTuple` omitted `PAYLOAD_CORRUPT`; `store.get` also wrongly listed `ABORTED`, which it cannot raise (it takes no signal).
- **Three log lines that quoted an unbounded row-sourced string are now capped**, like every other row-sourced field: `reconcileVectorIndex: skipped a row that is not a store item`, `getMessages: skipped a corrupt message item`, and `putWrites: write row held by an unexpected channel` — each fires once per offending row on a pass that can walk a whole prefix or partition, so an uncapped one could turn into megabytes of log against hand-written rows.
- **A refused value no longer puts its own property names on a public error message.** `JSON_SERDE.dumpsTyped` used to quote the underlying refusal verbatim, and V8's own circular-structure message includes the property path it walked (e.g. a field named `socialSecurityNumberRef`) — reaching `err.message` of the default serializer's `VALIDATION`. The message is now fixed text naming the two possible causes; the refusal still travels as `cause` for a caller who wants the path.
- **A logger you supply can no longer fail the operation it was observing.** This package calls `Logger` almost entirely from `catch` blocks and, at the retry hook, synchronously — so a throwing logger used to replace the error being reported, or end an operation that was still succeeding (reproduced: `store.get` abandoning its retry budget after the first throttle, `store.put`/`saver.put` rejecting for a write or checkpoint that had already committed). `resolveLogger`'s wrapper (see *Changed*, above) now absorbs anything the caller's method throws.
- **Every exported predicate and text helper that takes a caught error is now total for any value a `throw` can produce** — nine of twelve weren't. `redactedMessage`, which a static guard requires every `catch` in this package to use, read `.message` unguarded, so a value whose `toJSON` throws a primitive (legal JavaScript) made the default serializer answer a caller's mistake with an unbranded `TypeError`.
- **`saver.deleteThread` no longer reports a thread deleted that is mostly still in the table.** The flush recorded a failure only from the delete's own rejection, so a throw from decoding a row or from the caller's own logger was silently dropped — stopping the rest of a 25-row buffer and still resolving as a clean `deleteThread: deleted rows` (reproduced: 20 rows in the partition, 7 actually deleted, call resolved clean). Every failure now reaches the tally, so the pass raises `BATCH_WRITE_INCOMPLETE` with counts that account for every row attempted; a row whose refusal couldn't be reported is now counted as a failure rather than as both.
- **`history.addMessages` no longer skips its rollback when the caller's logger throws.** The compensation saga opened with an unguarded `logger.warn`, so a throwing logger skipped the S3 cleanup, the deletion of already-committed chunks, the `messageCount` revert, and the rethrow all at once — reproduced as ninety-nine orphaned rows with `messageCount` still counting them, and the caller handed a `TypeError` about the logger instead of `COMPENSATION_FAILED`. Both logger calls in that path are now guarded.
- **A cancelled S3 upload or download now raises `ABORTED` instead of `S3_OFFLOAD_FAILED`**, matching the documented contract the wrappers were rebranding.
- **`getDeltaChannelHistory` now honours `config.signal` for the whole ancestor walk**, not only the read of the target checkpoint — each hop (three DynamoDB requests plus an S3 download per offloaded payload) used to run to completion after the caller had stopped waiting. A cancel is now reported as `ABORTED` in preference to `ANCESTOR_EXPIRED`.
- **`signal` now cancels the request in flight, not only the wait between retries.** Every DynamoDB and S3 call now carries the caller's signal as the SDK's `abortSignal`; a cut request is reported as `ABORTED` instead of being classified and retried as a transport failure (a cut request otherwise looks like a retryable `ECONNRESET` and would burn the whole retry budget against an already-fired signal). `uploadObject`/`downloadObject` previously received no signal at all. Cleanup and verification reads after a failure stay uncancelled, so an abort still can't strand a live row pointing at a deleted object.
- **`history.addMessages` now passes its `signal` to each message's S3 upload** — an offloaded append used to spend one uncancellable upload per message before the first row was even written.
- **First-write-wins for pending writes now survives an upgrade.** A write row from before `writeGroup` existed carries none, and a `Map` can't tell an absent value from an explicit `undefined` — so the newer row used to win, the opposite of the documented contract. The missing group is now normalised at the edge.
- **A row holding `null` in its payload attribute no longer ends a partition delete.** `deleteThread()`/`clear()` used to destructure the descriptor through a cast that allowed only `undefined`, so `null` raised a raw `TypeError` mid-buffering — before any delete was issued, leaving the whole partition in place. Such a row is now treated as carrying no write id (deleted unconditionally, releasing nothing), and the helper one layer down that collects an offloaded row's object keys now accepts a missing descriptor by signature instead of by luck.
- **`store.get()` now answers a coded error when a concurrent overwrite leaves the row without a descriptor**, instead of a bare `TypeError` — its recovery re-read a row whose descriptor had gone `null` and read `.location` off it unchecked. It now raises the same `VALIDATION` naming `descriptor` every other read path already answers such a row with.
- **`history.listSessions` no longer fails the whole call on one malformed SESSION row.** A `ttl` that wasn't a plain number (`'soon'`, `NaN`, `Infinity`, or out of `Date`'s range) used to survive the expiry filter and then throw `RangeError: Invalid time value`, taking every healthy session in the page down with it. Such a row is now skipped, like any other foreign row.
- **`store.get` and `store.search` no longer return an item whose `createdAt`/`updatedAt` is an `Invalid Date`.** A row with no timestamps is now skipped; `get` answers `null` for it, as for any other absent, expired or foreign row.
- **A checkpointer pending write or store row whose payload descriptor is `null` or absent now raises `VALIDATION` naming `descriptor`**, matching what the chat-history adapter already produced for the same row — `decodePayload` used to read `descriptor.serdeType` before the guard that refuses it ran, escaping as a bare `TypeError` rebranded `UpstreamError`.
- **A recency listing no longer skips or repeats a row at a page boundary.** The in-memory merge across shards compared sort keys with JavaScript's `>` (UTF-16 code units), while DynamoDB's own key condition that resumes the next page orders by UTF-8 bytes — the two disagree above the BMP, so a tied timestamp with ids on either side of that boundary could drop a row or hand it out twice. The comparison now follows the server's own rule.
- **`saver.list({ before })` no longer silently omits a checkpoint, or answers differently depending on which read path served it** — the same UTF-16-vs-UTF-8 disagreement applied to the in-memory bound check that the thread-less scan path relies on exclusively (having no server-side bound of its own).
- **A namespace listing's page boundary no longer depends on the host's default locale.** `listNamespaces` used to sort with bare `localeCompare`, so a fleet whose nodes disagreed on collation (German vs. Swedish, say) could cut page two from a different order than page one — missing one namespace and repeating another. The collation is now pinned.
- **`listNamespaces()` now orders namespaces reproducibly.** The pinned collation still calls some distinct namespaces equal (precomposed vs. decomposed `café`), so ties are now broken by code unit — never reordering a pair the collation itself already orders — instead of by whatever order DynamoDB happened to return them in.
- **A concurrent read can no longer start zero workers, or swallow a rejection whose value is `undefined`.** `mapWithConcurrency`'s worker-count formula was `NaN` for a `NaN` concurrency, which computes to zero workers — an infinite, I/O-free busy-spin on the recency-index listing's per-shard loop, reachable from JavaScript or through a cast. The floor is now a proper range check. Separately, `failure ??= error` couldn't distinguish "nothing has failed yet" from a rejection whose value *is* `undefined` (reachable from a third-party `VectorBackend`), so such a rejection was silently swallowed and the call resolved as a success; a boolean now records that a failure happened.
- **The error helpers no longer throw at the caller that caught them.** `isDynamoDBLangGraphError` used a bare `in`, which throws on `null`/`undefined`/a string/a number — precisely what a `catch` clause can hold — so the brand check the README recommends *inside a `catch`* could itself crash. The AWS/foreign-failure and failed-rollback wrappers now normalise whatever was thrown before reading `.name`/`.message` off it, so `cause` (and `details.rollbackError`) is always error-shaped.
- **`ErrorCode` is now frozen.** It used to compile to a writable object, so one dependency reassigning a member silently broke `error.code === ErrorCode.X` for every other consumer in the process, with nothing raised anywhere. `error.context`, `details.unprocessed` and `details.failedChunks` are now copied rather than held by reference, since a caller could otherwise rewrite an error already in flight by reusing its own builder object.
- **`redactSecrets` now keeps its own "throws nothing" promise.** It caught `RangeError` alone and rethrew everything else, so a throwing getter escaped as a bare `Error` at a caller who only wanted a safe copy to log. Both pattern arguments are now validated where supplied, `redactLogger` validates its wrapped logger the same way every adapter does, and it now absorbs a failure of the logger it wraps.
- **S3 offload errors no longer quote the AWS SDK's message verbatim.** A signing or credential failure names the credential it signed with, so `aws_secret_access_key=`/`x-amz-security-token=` could reach `err.message` of a caught, printed or returned error. `uploadObject`/`downloadObject` (and the JSON serializer and message validator, changed alongside them) now redact the quoted text with the same helper the retry wrapper already used; `NoSuchKey` and similar stay distinguishable via `cause`. A static guard now refuses any read of a caught error's `message` under `src/`.
- **S3 orphan cleanup no longer lets a broken logger replace the caller's error.** `cleanUpS3Orphans` promises it never throws, and every one of its nine call sites depends on that — but two of its three `warn` calls sat outside any `try`, so a throwing `Logger` escaped the cleanup and became the error the caller saw instead of the real one (a refused payload came back as `UNEXPECTED_ERROR` naming `saver.putWrites`, with the actual cause gone). A logger failure is now absorbed like every other cleanup failure; no log message changed.
- **A checkpoint write refused partway through encoding no longer leaves its earlier uploads behind.** `put()`/`putWrites()` offload each payload as they encode it, so a call whose second payload the serde refuses had already uploaded the first — and only a failed *write* triggered cleanup, never a failed *encode*, leaving the object unreachable until a lifecycle rule swept it. Both builders now release what they uploaded before rethrowing, matching what the chat-history adapter already did.
- **The published tarball no longer carries modules whose source was deleted.** `npm run build` used to compile into whatever `dist/` already held, so a `1.0.0-rc.1` `stored-channels` module with no source behind it shipped anyway. The build now clears `dist/` first, and the pack check refuses any `dist/**/*.js` without a matching `src/**/*.ts`.
- **`saver.put()` no longer narrows what it stores by `newVersions`** — it now stores every channel value the checkpoint carries, as `MemorySaver` does. Narrowing was losing user state: LangGraph passes an empty `newVersions` when forking a checkpoint or writing an empty-checkpoint update, and a put with no named channels used to store no values at all. The `storedChannels` attribute is no longer written (rows carrying it are still read); this package's own conformance run now exempts itself from LangChain's checkpointer suite assertion the same way `MemorySaver` and the Mongo/SQLite savers already are, and records the difference as V-10.
- **Identifiers must now be well-formed UTF-16.** A lone surrogate (which `slice()` on an astral-character string can produce) used to pass every other rule and then encode lossily, so two distinct identifiers could address one offloaded S3 object. `checkpoint_ns`, which bypasses the shared validator because empty is legal for it, is now checked too.
- **`saver.list(config, { limit: 0 })` now yields nothing**, instead of reaching DynamoDB as `Limit: 0` and raising a raw `ValidationException`.
- **`saver.list()` with a `checkpoint_id` but no `checkpoint_ns` now searches every namespace** — it used to point-read the root namespace only, so a checkpoint written inside a subgraph was never found.
- **`store.batch()` now runs operations in the caller's order** — it used to run every write before every read, so `[delete, get]` returned the deleted value and `[get, put]` returned the new one, the opposite of the reference store.
- **An empty filter condition now imposes no constraint.** `{ field: {} }` used to match nothing; the reference store matches every item that has the field.
- **`history.reconcileMessageCount()` is now safe on a live session.** The count write is now conditioned on the value the row held when it was counted, so a concurrent append fails the write and the tool recounts instead of discarding the increment — throwing `CONDITION_CONFLICT` if the session stays busy through every attempt.
- **The unprocessed-items drain now honours the configured `retry` policy**, instead of module constants.
- **`redactSecrets()` now visits a shared node once.** The cycle guard used to re-walk every node reachable by more than one path — exponential on a graph that merely shares structure — so deep-enough nesting exhausted the stack with a raw `RangeError` instead of yielding `[UNREDACTABLE]`.
- **A classified `DynamoDBLangGraphError`'s message now redacts the cause it quotes**, since that message reaches `err.message`, which an application may print without a redacting logger.
- **Semantic search now embeds each extracted path separately and scores an item by its best-matching one**, as `InMemoryStore` does — joining configured fields and embedding once used to average a long document into one vector, so a document with one perfectly-matching section could rank below one that matched everywhere but weakly. Items now carry `embeddings` (one vector per path) instead of `embedding`; old rows still read and rank as before. A configured `vectorBackend` is unaffected.
- **A delta channel whose history has a hole in it now fails loudly.** `DeltaChannel` (LangGraph 1.2+, beta) rebuilds from the nearest ancestor with a stored value; the ancestor walk used to stop silently at an ancestor it couldn't read (typically one expired by a per-put `ttl`), restarting the channel from its initial value with no signal. `saver.getDeltaChannelHistory()` now throws `ANCESTOR_EXPIRED` (with `threadId`, `checkpointId`) when a checkpoint a channel still needs has expired; an ancestor that was never written, or one a nearer ancestor already answered for, is unaffected.
- **`ensureS3LifecycleRule()` now refuses a rule-id collision instead of silently mis-scoping.** The rule id is a slug of the key prefix, and slugging maps every non-alphanumeric character to `-`, so `a/b/` and `a-b/` produced the same id — letting one prefix take over the other's rule, or be left with none. The prefix is now part of the correctness check; a genuine id collision raises `VALIDATION` naming `s3.keyPrefix`.
- **`saver.getTuple()` now validates the identifiers a thread-less config does give**, instead of returning `undefined` before looking at anything — a malformed `checkpoint_ns`/`checkpoint_id` used to go unreported here while `saver.list()` on the same config rejected it. A config naming no thread still answers `undefined`.
- **A write index that is not an integer is now refused.** Padding a fraction used to produce a sort key like `00000009.5`, which no longer orders numerically. Unreachable through `putWrites` itself (whose indices are array positions), but the encoder no longer relies on its caller for that.
- **A stored payload that is not a descriptor is now refused, not dereferenced.** A row whose `checkpoint`/`metadata`/`value`/`message` held `null` used to raise a raw `TypeError` reading `.schemaVersion` off it; it now raises `VALIDATION` naming `descriptor`, and the checkpointer's own row narrowing (which tested only `!== undefined`) now skips such a row instead of accepting it as its own.
- **`saver.list()` with a metadata filter no longer fails on one odd row.** Metadata that decoded to `null` used to reach `Object.hasOwn(null, …)` and throw out of the public method; it now simply matches no filter clause.
- **`saver.list({ limit })` now refuses a non-integer** instead of reaching DynamoDB as `Limit: 1.5` and returning a raw `ValidationException` naming neither the option nor the caller.
- **A custom redaction pattern without the `g` flag used to redact only the first occurrence** (`String.prototype.replace` without it substitutes once), hiding the first secret in a string while printing every later one verbatim. Every pattern is now applied globally regardless.
- **`redactLogger` now rejects options that would protect nothing.** A non-string in `extraKeys` used to throw a bare `TypeError` at the first log call, and a string where a `RegExp` was expected produced `/(?:)/` — matching everything, protecting nothing. Both now raise `VALIDATION` where configured.
- **`toError()` no longer throws from inside a `catch`.** Normalising a thrown circular object or `BigInt` used to raise a `TypeError` from `JSON.stringify`, discarding the failure being reported; a thrown `undefined` or symbol produced an empty-message `Error`. Each is now described instead.
- **An unreadable payload is now reported, not retried.** A row marked compressed whose bytes aren't gzip, or a payload that doesn't parse, used to raise a bare zlib/`SyntaxError` with no package code — so `isPermanentPayloadLoss` classified them as transient and a caller retried a payload that could never be read. Both now raise the new `PAYLOAD_CORRUPT` code, classified permanent.
- **A payload that serialises to nothing is now refused, whichever adapter writes it.** The check used to live only in the store's serializer, so `putWrites(config, [['ch', () => 1]], task)` wrote a pending-write row with **zero bytes** under an ordinary descriptor and succeeded — making every later `getTuple` of that checkpoint fail with `UpstreamError(SyntaxError)`. The refusal now sits in the shared encoder every adapter and `serde` passes through, raising `VALIDATION` naming `value` (distinct from the `VALIDATION` naming `payload` an over-large inline payload raises) before compression, so no S3 object is uploaded for an unreadable payload either. Under the default `JsonPlusSerializer`, a function and a symbol encode this way; `BigInt`/`NaN` are substituted silently instead, per the README's serializer table.
- **A value plain JSON cannot represent is now refused at the write, under `JSON_SERDE`** (the store/chat-history default). `undefined`, a function and a symbol all used to stringify to `undefined` — zero bytes, a write that succeeded and a later read that failed to parse. They now raise `VALIDATION` naming `value`, as do a circular structure and a `BigInt` (previously raw `TypeError`s). This is the serializer's own refusal: the checkpointer's default substitutes rather than refuses for three of the five, per the README's column-by-column table.
- **A malformed identifier now always raises `VALIDATION`.** `checkpoint_ns`, the one identifier allowed to be empty, used to skip the non-blank rule and reach `Buffer.byteLength` directly — so a non-string value surfaced as a raw Node `TypeError [ERR_INVALID_ARG_TYPE]`. Every validation primitive now checks the type first.
- **A checkpoint row may only speak for the partition it lives in.** A META row's `threadId`/`checkpointNs`/`checkpointId` used to be trusted without being tied to the DynamoDB key the row was found at — so a writer confined to its own partition by `dynamodb:LeadingKeys` could plant a row claiming another tenant's `thread_id`, and `saver.list()` would fetch that tenant's object under it. The row narrowing now requires the attributes to reproduce the key, as `narrowStoreRecord` already did for store items.
- **A `search` no longer fails on one unusual stored value.** `matchesStoreFilter` used to reach `Object.hasOwn` on a non-object value (a row holding `null` or a scalar) and throw, failing a whole search over one row. Such a value now satisfies no condition and the search continues.
- **An unknown `matchType` is now refused instead of guessed.** `listNamespaces({ matchConditions })` used to resolve anything but `'prefix'` as a suffix match, so a typo silently answered a different question. Only the two the contract defines are accepted now; anything else raises `VALIDATION` naming `matchConditions`.
- **An indexed field holding `undefined` no longer fails the put.** Text extraction used to return `[undefined]` typed as `string[]`, and the caller's own length check threw reading it — for a value `JSON.stringify` stores without complaint and `InMemoryStore` indexes as no text. A function/symbol did the same; a circular structure/`BigInt` escaped as a raw `TypeError`. Each now yields no index text; a value that genuinely can't be stored is refused by the codec instead, naming `value`.
- **`history.addMessages()` now names the value that is not a message**, raising `VALIDATION` naming `messages` and the offending index before any write — it used to fail with `TypeError: message.toDict is not a function` from inside LangChain, with no sign of which field was wrong.
- **A `vectorBackend` search now reads each matched item once for the whole call**, instead of re-reading a previous round's matches every time the search asked for a larger `topK` to backfill a filtered page — up to roughly twice the final round's reads at the cap. This also covers a backend returning one key twice in a single round.
- **A `vectorBackend` search now reads its matched items concurrently**, using the same bounded concurrency as the in-DynamoDB path (as does the item decode inside `reconcileVectorIndex`) — each match used to cost a sequential round trip (plus an S3 download for an offloaded item).
- **`createAll()` now gives its adapters the DynamoDB region for S3.** An adapter reads that region off its own `clientConfig` when `s3` names none, but `createAll`'s adapters share one `client` instead (a `clientConfig` can't travel beside it) — so the region was lost, and a bucket reachable only through it failed with an opaque `PermanentRedirect` on first offload, though the same configuration worked through `createStore()` directly. The region now travels on the `s3` config, which still needs it.
- **`DynamoDBFactory` now validates its own defaults, at construction** — a base carrying both `client` and `clientConfig` used to be refused by the first `createSaver`/`createStore`/`createChatMessageHistory` call but accepted by `createAll`, for the same factory. It's now refused where it's written, together with any key the factory doesn't read.
- **`createAll()` now refuses a section name it does not build**, raising `VALIDATION` naming the key — a misspelt one used to build nothing silently and hand back three `undefined`s.
- **Tearing down a `createAll()` result is now total.** One adapter throwing from `destroy()` used to strand every resource after it (including the shared client nothing else can reach), and — inside a failed build's rollback — replace the constructor error the caller needed with its own. Each release is now independent, and a failure is logged at `warn`.
- **Two log events (`Failed to clean up orphaned S3 objects after`, `store vector-index sync failed`) now carry the error's `reason` (its name) instead of its whole message**, matching this package's promise that logs hold identifiers and counts only.
- **`store.batch()` now writes nothing when one of its operations is malformed**, instead of writing everything checked before the bad one and rejecting mid-way — which mattered inside a graph, where `AsyncBatchedStore` sends every store call in one tick as a single batch, so one caller's typo used to reject every caller in the tick, including one whose put had already landed. Every operation is now checked before any runs, matching the reference store.
- **A legacy `thread_ts` is now honoured when `checkpoint_id` is `''`**, not only when it's `null` — matching the reference's `checkpoint_id || thread_ts` fallthrough the README already claimed.
- **A write whose acknowledgement was lost can no longer put its row back after something else released the payload it names** — previously a lost-then-retried write could re-land after a concurrent delete or a `ttl`/lifecycle sweep had already released the object, leaving a live row permanently pointing at a deleted one (`S3_OFFLOAD_FAILED`/`NoSuchKey` on every later read). Every write referencing an offloaded object is now sent as a one-item `TransactWriteItems` carrying a `ClientRequestToken`, so a retried already-committed attempt is answered from DynamoDB's idempotency cache instead of applying twice. See the guide's [Write idempotency](docs/guide.md#write-idempotency) and [What a token guarantees, and what it does not](docs/guide.md#what-a-token-guarantees-and-what-it-does-not) for the full contract: a write whose first attempt **committed** applies exactly once; one **rejected by its condition** carries no idempotency at all.
- **One request attempt on a client this library builds is now bounded.** `maxAttempts: 1` disabled the SDK's own retries but left a single attempt unbounded, so a hung socket could hang indefinitely, outside both the retry budget and the token deadline. Such a client now gets a 10 s request timeout (with `throwOnRequestTimeout`) and a 5 s socket timeout, so a hung request fails with a retryable `TimeoutError` instead. No connect timeout is set, deliberately — measured, one killed 14 of 100 healthy requests under a one-socket agent's fan-out, all of which succeeded once unset. The S3 client gets the idle timeout only, since a `PutObject`'s response doesn't arrive until the whole body has uploaded. An injected `client` gets none of this — give it a request timeout of its own if you set `maxAttempts: 1`.
- **`ensureS3LifecycleRule()` no longer shortens a noncurrent retention you configured.** It used to set `NoncurrentVersionExpiration` at its own computed object-expiry window, and S3 honours the *shorter* of two overlapping expirations — so a bucket-wide 90-day retention quietly became 32 days under this prefix. The value written is now the longest `NoncurrentDays` among every enabled rule that governs these keys, floored at the release grace and never lowered.
- **`backfillRecencyIndex()` no longer re-creates a row that was deleted while it ran.** Its `UpdateItem` upsert was guarded only by `attribute_not_exists(gsi1pk)`, which a fully-deleted key also satisfies — so a row deleted between the scan and the update was written back as a bare stub carrying only `PK`/`SK`/index keys, visible to `saver.list()`/`listSessions()` once `indexName` is set (each skipped it silently, `saver.list()` with a recurring `warn` on every listing thereafter). The condition is now `attribute_exists(PK) AND attribute_not_exists(gsi1pk)`, a true update.
- **`backfillRecencyIndex()` no longer abandons a run because one row could not be written.** A `ConditionalCheckFailedException` (a row already indexed, or deleted since the scan) is not retryable, so it used to escape the row's write and discard the whole `BackfillResult` — counts and cursor for every row already indexed included. Both refusal cases now count the row as `skipped` and the walk continues; `nextPages`/`nextCursor` resume past it. This mattered most on exactly the table the tool is for — one with a live adapter also writing to it — where a migration could previously stop at its first live write and report nothing about the work already done.
- **A cancelled `saver.deleteThread()` or `history.clear()` now reports the cancel.** Both documented `ABORTED` but raised `BATCH_WRITE_INCOMPLETE` instead — and the chunked form's abort carried no `succeededCount`, making the reported total `NaN` while the loop kept offering remaining chunks to an already-fired signal. An abort is now rethrown unwrapped the moment a chunk or row reports it; only an error that actually carries a count now contributes to one.
- **A consumer's own DocumentClient now type-checks.** `client` was typed as `DynamoDBDocument` from *this package's* nested copy of the SDK, so a consumer on an older, differently-versioned SDK got a same-name-different-type compiler error (`TS2741`) at every documented injection point, though it always worked at runtime. `client` is now `DynamoDBDocumentLike`, exported, naming exactly the eight methods this package calls — a `DynamoDBDocument` still satisfies it unchanged.
- **A payload whose bytes are intact is no longer called corrupt just because the serializer refused it.** A failed decode used to be classified by what the `serde` threw, so any refusal became `PAYLOAD_CORRUPT` — dropping a history message under `'skip'` for it. The two are now told apart by the bytes themselves: bytes that no longer parse are `PAYLOAD_CORRUPT`; bytes that parse while the serializer declines to rebuild the value (an `lc` record naming a disallowed class, say) are `VALIDATION` naming `serde`, carrying the refusal as `cause` and reported rather than skipped.
- **A payload a newer release wrote is now reported as unsupported, not as lost.** A descriptor's forward `schemaVersion` used to raise `FORMAT_UNSUPPORTED` but then be counted as permanent payload loss downstream — so `'skip'` silently dropped a message a newer reader reads fine. It's now outside that bucket entirely, surfacing as `FORMAT_UNSUPPORTED` naming `schemaVersion` on every adapter under either policy, exactly like a forward `v` on the row.
- **Tearing down an adapter now releases every resource it owns, even when one refuses to close.** `destroy()`/`stop()` used to be a sequence of statements, so an S3 client throwing from its own `destroy` left the DynamoDB client behind it leaked for the life of the process. Every resource is now offered its release before anything is raised, and the first failure is now raised rather than silently swallowed. An injected `client` is still never destroyed; `createAll()`'s `destroy()` is unchanged.

### Documentation

- The README now opens user-first — an at-a-glance table, features, an architecture diagram, and a quick start ending in a complete minimal agent — ahead of the reference material.
- Eleven usage examples (resuming/deleting a thread, semantic and filtered search, memory in a graph, chat history, `RunnableWithMessageHistory`, the factory, S3 offload/compression, TTL, an injected client, cancellation, listings) replace the old four, beside a configuration reference tabulating every option's type, default and ceiling read from `src`. Every code sample in the README, `CONTRIBUTING.md` and this file now compiles against `src` in CI (`npm run check:docs`).
- A known-limitations section and a migration guide from `MemorySaver`/`InMemoryStore` (there is no importer; what to change by hand).
- A new [`docs/guide.md`](docs/guide.md) now holds the deepest reference material — offload and idempotency mechanics, partition-delete cost, search internals, the request-unit cost table, monitoring, the full *What can still go wrong* list, the stranded-payload sweep, Lambda notes, IaC snippets, and the on-disk-layout/error/log-cap/differences tables — so the README reads as a scannable entry point. Every relative link and `#anchor` across the hand-written docs is now checked in CI (`npm run check:links`), and every heading that moved keeps its exact README anchor as a short summary linking to its guide section.
- A per-class API reference links every documented method to its generated entry under [`docs/api`](docs/api/README.md); `docs/README.md` and `examples/README.md` index the hand-written docs and example scripts.
- `CONTRIBUTING.md`, the bug report and pull request templates, `SUPPORT.md`, and `package.json`'s `description`/`keywords` were updated to match the current feature set and checks.

### Internal

- Type-aware lint and unused-code checks now gate the build; no behaviour change.
- A static gate refuses an import that runs against the layer direction or between features ([decision 20](docs/decisions/0020-make-the-layer-direction-a-build-gate.md)); no public type or behaviour changed.
- Each adapter now parses its input once, at the boundary, into branded types internal functions require ([decision 21](docs/decisions/0021-parse-caller-input-once-into-types-only-a-parser-can-build.md)) — the checks that used to run two or three times per call now run once, and the store dispatches a batch on the kind its parser decided instead of re-reading each operation's shape.
- `src` went from 167 modules to 86, each merged module opening with the decision it hides, with one owning module per row format, denormalised copy and write protocol ([decision 22](docs/decisions/0022-give-each-row-format-denormalised-copy-and-write-protocol-one-owner.md)); code moved verbatim — no public name, type, error, log message or request changed.
- Interface documentation is now JSDoc only, every other comment a `//` line, and every concept has one name and every kind of check one verb ([decisions 23](docs/decisions/0023-write-interface-docs-as-jsdoc-and-other-comments-as-line-comments.md) and [24](docs/decisions/0024-give-each-concept-one-name-and-each-kind-of-check-one-verb.md)) — enforced by new static guards under `test/static`.
- `npm run test:surface` now runs under a hard external time limit (`scripts/run-with-timeout.mjs`), so a Node teardown hang after the last test finishes can no longer leave the run stuck unattended.

### Performance

- **`getTuple` now reads the latest checkpoint in one `Query` instead of one per expired row.** DynamoDB applies a page size before its filter expression, so every checkpoint past its `ttl` at the head of a thread used to empty a whole page and cost its own round trip — 26 `Query` calls to step over 25 expired rows, on the read that begins every graph step. The read now evaluates 50 rows per page, still stops at the first live checkpoint, and returns exactly the same tuple; a thread with no `ttl` now pays in read capacity (up to 50 light `META` rows, ~26 KB, ~7 strongly-consistent read units) rather than in round trips.

## [1.0.0-rc.1] - 2026-09-02

The 1.0.0 hardening: every finding of an independent, enterprise-grade review of `0.9.0` (188 findings across the checkpointer, store, chat history, DynamoDB layer, codec and S3, error model, security and IAM, packaging, tests and documentation) was fixed or, where the finding was a documentation gap, documented. Every fix landed test-first, the test tiers now include a compiled LangGraph graph over the saver and LangChain's official checkpointer validation suite against DynamoDB Local, and the README states what each tier proves. Rows written by `0.9.0` remain fully readable; the two new row attributes (`storedChannels` on checkpoint META rows, `schemaVersion` inside payload descriptors) are additive.

### Changed (breaking)

- **The input a `ValidationError` names moved from `context.operation` to `context.field`.** In `0.9.0`, `ErrorContext` had one field, `operation`, and `new ValidationError(message, field)` stored the offending input there; `ResultTruncatedError` stored the cap it hit in the same place. `ErrorContext` now has both, with `operation` meaning the public operation that failed and the new `field` meaning the input at fault, and both errors write to `field`. Code reading `error.context.operation` to learn which option or argument was rejected reads `undefined` and must read `error.context.field`.
- **`DynamoDbLangGraphError` is now `DynamoDBLangGraphError`**, matching every other export; the `name` property changed with it. There is no alias.
- **Raw AWS SDK errors no longer escape a public method.** Each is wrapped in a new `UpstreamError` (`code: 'UPSTREAM'`) with the SDK error as `cause` and its `upstreamName`, `requestId` and `httpStatusCode` copied. Code that matched `error.name === 'AccessDeniedException'` must look at `error.cause` (or `error.upstreamName`).
- **`saver.list()` without a `thread_id` scans every thread** (a table `Scan`, as the reference savers do) instead of throwing `ValidationError`, and `saver.getTuple()` with a config that names no thread returns `undefined` instead of throwing — both required by LangChain's checkpointer validation suite. Grant `dynamodb:Scan` only to roles that may read across tenants.
- **`saver.put()` honours `newVersions`.** Only the channels `newVersions` names, plus those the parent checkpoint stored, are persisted; a caller that passed values for channels outside `newVersions` and never wrote them before no longer gets them back. LangGraph itself is unaffected. A put without `newVersions` stores every value, as before.
- **The `createClient` and `createS3Client` hooks are `@internal`** and are stripped from the shipped declarations; they remain as test seams in the source.
- **Options are validated at construction.** A bad `tableName`, `ttl`, `compression`, `s3`, `retry`, `index`/`vectorBackend` combination or `vectorScoreDirection` throws `ValidationError` from the constructor instead of surfacing later as a raw AWS error.
- **Identifier and key lengths are bounded**: `thread_id` and `sessionId` at 1024 bytes, every sort-key segment (`checkpoint_ns`, `checkpoint_id`, `taskId`, channel, store namespace element and key) at 256 bytes, composed sort keys at 1024 bytes and offloaded S3 keys at 1024 bytes, all as `ValidationError` before the request. `ttl.seconds` is capped at five years like `ttl.days`, and `{ days, seconds }` together is rejected.
- **`ensureS3LifecycleRule()` requires a scoped `keyPrefix`** (non-empty, ending in `/`); an empty or root prefix, which would have installed a whole-bucket expiration rule, is rejected. The rule now expires objects `ceil(ttl days) + 2` days after creation (the sweep-lag margin) and expires noncurrent versions after the same period.
- **The `examples/verify-*.mjs` scripts are gone**; the real-AWS test tier (`npm run test:aws`, nightly in CI) covers what they did.
- **The conformance matrix tests the declared floor** (`@langchain/langgraph-checkpoint` 1.1.5) rather than 1.0.3, a version outside the peer range.
- **`@langchain/langgraph` is no longer a peer dependency.** The package only needs `@langchain/langgraph-checkpoint` and `@langchain/core`; your application depends on `@langchain/langgraph` itself, and any 1.x release whose checkpoint dependency is in the supported range works. Installs that relied on the peer being pulled in transitively must add it.
- **The tarball ships no source maps** (`.js.map`, `.d.ts.map`) and declares `sideEffects: false`; bundlers can tree-shake unused adapters. `npm run pack:check` (the pack listing, `publint` and `@arethetypeswrong/cli`) guards the published shape.

### Added

- `history.getMessages(sessionId, { limit, before })`: a bounded read window (the newest `limit` messages, or those before an instant), `forSession(sessionId, { limit })` for the LangChain adapter, `SessionMetadata.expiresAt`, and the `MessageWindow`, `GetMessagesOptions` and `ListSessionsOptions` types.
- Cancellation on every long-running method: the checkpointer reads `RunnableConfig.signal`; `deleteThread`, `search`, `reconcileVectorIndex`, `getMessages`, `addMessages`, `addMessage`, `clear`, `listSessions` and `reconcileMessageCount` take `{ signal }`; any abort surfaces as `AbortError` (`ABORTED`) with the raw reason as `cause`.
- A `retry` option on every adapter (`maxAttempts`, `baseDelayMs`, `maxDelayMs`), every retry logged at `debug`, and the `RetryPolicy`, `RetryOptions` and `RetryAttemptInfo` types.
- `DynamoDBFactory` shares `ttl`, `compression`, `s3` and `retry` across the adapters it builds, `createAll` accepts any subset of sections with a result typed by them, and a constructor failure inside `createAll` destroys the client it had built.
- `DynamoDBStore.stop()` releases owned clients, hooking LangGraph's `BaseStore` lifecycle.
- Exported types for every public signature: `VectorScoreDirection`, `RedactLoggerOptions`, `Redactable`, `SessionBackend`, `AdapterWindow`, `S3ClientLike`, `S3ClientConfigLike`, `S3ClientOptions`, `S3ClientOption`, `S3CommandLike`, `S3RegionLike`, `AdapterSection`, and `CancelOptions`.
- `S3OffloadConfig.maxDownloadBytes` (default 50 MiB) caps the size of an offloaded object the adapters will buffer, checked before and while reading.
- The S3 client inherits the DynamoDB `clientConfig.region` when its own config names none.
- Payload descriptors carry `schemaVersion: 1`; a reader refuses a higher version or an unknown `location` with a `ValidationError` instead of guessing.
- `exports['./package.json']` for tooling that reads the manifest.
- Documentation: a least-privilege IAM policy and a `dynamodb:LeadingKeys` tenant policy, a multi-tenancy section, the complete log-events table, an Operations section (limits, per-operation request costs, monitoring, Lambda), a Testing section stating what each tier proves, `docs/STABILITY.md`, `SECURITY.md`, `SUPPORT.md`, `CONTRIBUTING.md`, issue and pull-request templates.

### Fixed

- The optional `@aws-sdk/client-s3` peer floor is `^3.901.0`; the previous `^3.900.0` named a version that was never published, so nothing could install it. The `peer-floors` CI job installs every declared floor and runs the type check and unit tier against it.
- Checkpointer: a failed `put` or `putWrites` no longer deletes an S3 object a live row may point at — the rows are read back first and only a confirmed non-commit cleans up its own nonced upload; checkpoint and metadata objects are nonced per put; a regular write's upload is never deleted on an unverified failure; `list()` covers every namespace when none is given, applies `before` at the key, reads eventually consistently and passes `limit` to the query when unfiltered; `getTuple` reads large fan-outs completely, treats a falsy `checkpoint_id` as "latest", narrows the head row instead of trusting it, and rebuilds a pre-v4 checkpoint's pending sends from its parent; pending-write channel names are validated like every other key segment.
- Store: ambiguous writes are verified by revision (an inline overwrite whose acknowledgement was lost is reported as success and cleans up the previous object), `delete` uses `ReturnValues: ALL_OLD` instead of a pre-read so a racing put can no longer orphan its object, pre-write reads project only the fields they need, a revision swap whose re-read finds the row gone takes the put timestamp as `createdAt`, an overwrite racing a `get` is re-read once, embedding-dimension mismatches are reported at search time, `embedDocuments` is used for documents and fields are extracted like `InMemoryStore`, and the in-DB ranker refuses a candidate set over `maxSearchCandidates` before decoding anything.
- Chat history: only a provably unreadable message is skipped under `onCorruptMessage: 'skip'` (a transient S3 or permission failure propagates), messages that could never be read back are rejected at write time, reads are strongly consistent, titles are derived from content blocks, `reconcileMessageCount` counts only unexpired rows, a re-created session is never decremented during rollback, and an ambiguous chunk failure is re-read before compensating.
- Every read path filters rows past their `ttl` during DynamoDB's sweep lag (store `get`/`search`/`listNamespaces`, checkpointer `getTuple`/`list`, history `getMessages`/`listSessions`).
- Retries: HTTP 429/5xx, `$retryable` errors and every SDK socket code are classified as transient with exact-token matching; S3 uploads and downloads retry SDK timeouts and status-only 5xx through the one classifier; `ResultTruncatedError` no longer fires when the page after the cap is empty; an injected DynamoDB client that keeps the SDK's own retries is warned about at construction.
- S3: offloaded keys are bound to the adapter prefix and the row's own identifiers before any download or delete, so a tampered row cannot reach another item's object; a missing `@aws-sdk/client-s3` peer fails with a typed error naming the remedy; the shipped declarations compile without the optional peer installed.
- Errors and logging: `DynamoDBLangGraphError` carries structured context, redaction covers error text without over-redacting telemetry, and a payload that cannot fit a DynamoDB item is refused before the write.
- ULIDs draw their random component from `crypto.randomBytes`.
- Metadata filters compare own properties only, and the lifecycle-rule slug no longer uses a quadratic regex.
- The lockfile installs with npm 10 (Node 22) as well as npm 11.

### Performance

- Offloaded payloads are decoded up to eight at a time on every read path instead of one S3 GET after another.
- A plain `store.search()` stops reading once `offset + limit` matches are in hand; `store.batch()` runs independent operations concurrently (writes to one item stay ordered, then reads); `listNamespaces` projects only the key attributes; a compare-and-swap that loses takes the rejected row from the exception instead of a second read; `reconcileVectorIndex` embeds in batches; `list()` passes its limit to DynamoDB when unfiltered.

### Documentation

- README: corrected IAM actions, error-handling section rewritten around `UpstreamError` and the real throwers, maintenance operations, complete log-events table, accuracy pass over options and semantics (checkpointer last-writer-wins and single-pass deletes, chat-history ordering, serde caveats, chunked appends and worst-case latency, differences from `InMemoryStore`, retroactive TTL, bundling of the lazy S3 import, CommonJS usage), operations and multi-tenancy sections, and the tested envelope.
- `docs/api` is regenerated from a JSDoc pass over every public method (`@throws`, consistency and cost remarks) and no longer bakes in the package version; CI fails when it is stale.
- The live demos under `examples/` read `AWS_REGION` and `LANGGRAPH_DEMO_TABLE`; the personal model probe is gone.

### Internal

- Static guards: no `any`/`unknown`/`instanceof` in `src`, no re-exports outside the entry, no import cycles, no dead error codes (AST-based, whole-token references), every log event documented, the IAM policy equal to the actions used, `@internal` on the client seams, the optional S3 peer out of every public module, and the public export set and adapter signatures locked by type tests.
- Test tiers: property tests for sort-key order, item-size estimation, write resolution, redaction and backoff; write races against DynamoDB Local with an in-memory S3 fake; the DynamoDB semantics the unit mocks assume pinned against the engine; differential runs against `InMemoryStore` and `InMemoryChatMessageHistory`; a compiled LangGraph graph and LangChain's checkpointer validation suite in the conformance tier; failure-safe real-AWS teardown and a clean Bedrock skip; the unit tier times out at 15 s; failing DynamoDB-Local tests are surfaced as check-run annotations.

### Dependencies

- `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` resolve to 3.1124.0 in the lock file (declared ranges unchanged). Development tooling updated in the same step: jest 30.5.1, eslint 10.9.1, typescript-eslint 8.69.0, knip 6.34.0, jscpd 5.1.1, typedoc-plugin-markdown 4.13.0, `@types/node` 26.4.1, `@langchain/langgraph` 1.4.13 for the conformance tier, `@aws-sdk/client-s3` 3.1124.0 for the S3 tests.

## [0.9.0] - 2026-08-29

Closing every open finding from an independent review of `0.8.0` itself: 4
important and 2 minor findings, plus one recorded code-quality inconsistency,
and 2 further defects found while designing the fixes. A further, more
serious defect surfaced only while reviewing this release's own
compare-and-swap fix — not in the original review — and is described first
below as the most serious defect in this release. Every functional fix
landed test-first, with a regression test that fails without it; the
compare-and-swap fixes additionally carry a dedicated proof against real
DynamoDB Local (`test/integration/overwrite-swap.integration.test.ts`).

Two new row attributes are purely additive — `occurrence` on checkpointer
WRITE rows and `rev` on store rows — and neither changes an existing key.
**0.8.0 data remains fully readable**, unlike the 0.8.0 release itself,
which required a recreated table.

One of the review's own findings did not warrant a code change; its
rationale is recorded under Documentation below so it is not "fixed" again
in a later round.

### Changed

- **New opt-in `vectorScoreDirection` store option converts a distance-native `vectorBackend`'s scores to relevance.** `VectorBackend.query()`'s score direction was documented and warned about but never actually enforced: a backend surfacing a raw distance (S3 Vectors, FAISS L2, pgvector's `<->`) still returns nearest-first, so result *order* looked correct while every *score* meant the opposite of what a caller thresholding or displaying it expected. Setting `vectorScoreDirection: 'distance'` negates and re-sorts the backend's matches; the default `'relevance'` forwards them unchanged, exactly as before, and a `'relevance'` backend's results are never reordered.
- **A `DynamoDBStore` with a malformed `index` now throws a typed `ValidationError` at construction**, not a raw, uncoded `TypeError` at the first `put()`/`search()`. Previously only `index`'s *presence* was checked, so e.g. `index: { dims: 1024 }` (no usable `embeddings`) passed construction and crashed deep inside the first call that needed to embed something. The `vectorBackend`-requires-`index` construction message no longer promises `dims` — this package never reads that field, and rejecting an otherwise-working config over it would break callers who never needed it.

### Fixed

- The optional `@aws-sdk/client-s3` peer floor is `^3.901.0`; the previous `^3.900.0` named a version that was never published, so nothing could install it. The `peer-floors` CI job installs every declared floor and runs the type check and unit tier against it.
- **A lost `PutItem` acknowledgement could strand a live row on a deleted S3 object — the most serious defect in this release, found while reviewing this release's own fix, not the original review.** `withDynamoDBRetry` retries transient errors, so a compare-and-swap put that had already committed server-side but lost its response was retried, hit the row it had itself just written, and failed the identical guard a genuine competitor's win would have failed. Both compare-and-swap loops introduced in this release — the store's `putWithRevisionSwap` and the checkpointer's `attemptCasWrites` — read that rejection as having been superseded by a competitor and deleted the S3 object the live row itself now points at. Each loop now pins the state it observed *before* issuing its own put, and recognizes a re-read that finds the row already holding its own revision token, reporting what it actually superseded instead of its own just-committed value.
- **Overwrite paths now compare-and-swap, so two concurrent overwrites can no longer both orphan the loser's S3 upload.** `store.put()`'s concurrent-write race and the checkpointer's special-write race (`__error__`/`__interrupt__`/`__resume__`/`__scheduled__`) both let two writers read the same previous payload descriptor, each commit their own nonced upload, and both then try to clean up that same previous descriptor — orphaning the loser's own upload with nothing left recording it ever existed. Each overwrite now pins the revision (store: a new `rev` attribute; checkpointer: the existing `writeGroup`) it observed and re-reads on rejection, so it supersedes exactly the payload actually there. The swap engages **only when an S3 offloader is configured** — with none there is nothing to orphan — and is bounded to 3 attempts, since a *failed* conditional write still consumes write capacity sized on the existing item; on exhaustion it falls back to an unconditional overwrite (the exact pre-0.9.0 behaviour) and logs a `warn`.
- **A retry that legitimately wrote a channel more times than the original call had its extra write silently discarded on read.** The read-side dedup keyed identity on `(taskId, channel)` alone, so any second row for a channel — including one a retry validly added at an occurrence no earlier call had ever written, which the write-side first-write-wins guard accepted cleanly — was treated as a superseding duplicate and dropped. `putWrites()` had reported success; a later `getTuple()`/`list()` simply returned fewer values than were written. Every row now carries the occurrence ordinal of its channel within its own call, and identity is `(taskId, channel, occurrence)`; this restores the outcome the upstream `MemorySaver` already has, which keys first-write-wins on `(taskId, idx)` and keeps both values. **Rolling-deploy note:** a row written by a pre-0.9.0 node carries no `occurrence` attribute and reads back as occurrence `0`, so the fix takes effect for rows written by 0.9.0+ nodes — during a mixed-version rollout, a grown retry issued by an *old* node against *new* rows can still lose its extra value.
- **Credential redaction missed a value written as JSON, and truncated a multi-word value at its first space.** The credential-pair pattern required its separator immediately after the bare keyword, so `JSON.stringify`'d output — the shape most downstream HTTP errors actually arrive in (`{"password":"hunter2"}`) — matched nothing at all, a silent, complete bypass on the single most common real-world shape. Its value side also stopped at the first whitespace, so `password: correct horse battery staple` redacted only `correct`, leaving the rest of the secret in the log untouched. `redactText` now preserves a pattern's field-name capture group and replaces only the value, and the value side prefers a fully-quoted span before falling back to end-of-line. **Behaviour change:** an *unquoted* credential value now redacts to end of line rather than to the first whitespace — `token=abc123 expired` becomes `token=[REDACTED]`, losing the trailing ` expired`. This is a deliberate fail-safe tradeoff: under-redaction leaks a credential, over-redaction costs a few words of operational text, and the multi-word case above cannot be fixed without it.
- **A stored `NaN` satisfied `$lt`/`$lte` against any number in a store filter**, contradicting the range comparators' own documented contract. The ordering helper collapsed any *unordered* pair — which `NaN` is, against everything including itself — into "less than" rather than "no order," so a filter like `{ score: { $lt: 5 } }` matched a row whose `score` had decoded to `NaN`. Reachable through the public `serde` option with any serializer that preserves `NaN` natively. An unordered pair now never matches any range operator; equality (`$eq`/`$ne`) is unaffected, since `NaN` equals `NaN` under the deep-equality check those already use.
- **`list()` had no operational signal at all once its old, wrong safety cap was removed in 0.8.0.** That earlier fix was the right correctness call — the cap counted raw rows scanned rather than filter-matched ones, so a caller asking for a handful of rare matches over a large thread got a hard `ResultTruncatedError` instead of the true answer — but it left the read with no trace at all. `list()` now warns once, at the same 10,000-row threshold, when a single call scans a very large number of rows without the caller stopping; the read itself stays deliberately unbounded.
- **`reconcileVectorIndex`'s row-collection step raw-cast every row instead of narrowing it**, the one read path added since `store.get()`/checkpointer `list()` were fixed to narrow-and-skip a foreign row in 0.8.0 that had not been brought in line. It now narrows through the same shared helper and warns on a skipped foreign row, matching every other narrowing site.

### Documentation

- **`WRITE_INDEX_OFFSET` stays a hardcoded constant, deliberately — not changed in this release.** A prior review flagged it as a hardcoded assumption about the peer dependency's `WRITES_IDX_MAP`. The runtime cross-check that finding asked for already exists: `writeSortKey` throws a typed `ValidationError` naming the offset for any index it cannot encode, and `test/static/writes-idx-map-headroom.test.ts` pins the 4 slots of headroom the constant currently carries. Deriving the offset from `WRITES_IDX_MAP` at runtime — the obvious "fix" — would be actively worse: it would silently change every WRITE sort key the moment upstream added a negative slot, breaking existing data with no error, where the constant fails loudly instead. Recorded here so a future review does not "fix" it again.
- The README's S3-orphan paragraph — previously documenting both overwrite races as live leaks reclaimed only by lifecycle rules — is rewritten: both races are now *prevented* by compare-and-swap, and a leak remains possible only in the residual cases enumerated there (compare-and-swap exhaustion under pathological contention, a delete that genuinely fails, one double-fault interleaving that orphans a single object without ever deleting a live one, and the checkpointer's regular-write first-write-wins race, which is unchanged and unrelated to this release).

## [0.8.0] - 2026-08-29

Closing every finding of an independent four-agent review of `0.7.0` that was
reproduced against real AWS: 4 critical, 7 important and 15 minor findings,
plus 4 further defects found while designing the fixes. Each fix landed
test-first, with a regression test that fails against `0.7.0`.

Three of the review's own premises did not survive verification against the
installed peer dependency and are recorded here so they are not "fixed" again:
positional write indexing is the upstream `MemorySaver` contract, not a
library invention; the store's filter-coercion example (`'10'` matching
`{ $gt: 5 }`) is what upstream `compareValues` does; and the regression tests
the review cited were never present in this repository.

### Changed (breaking)

- **Every adapter's partition key is now adapter-tagged**: `CHKPT#<thread_id>`, `STORE#<namespace[0]>`, `HIST#<sessionId>`. Previously all three wrote a bare, untagged caller-supplied string, so reusing one identifier across adapters on a table shared via `createAll()` — a "conversation id" used as both a `thread_id` and a `sessionId`, an entirely ordinary design — put unrelated rows in one partition. `deleteThread()` then deleted the chat history along with the thread (and `history.clear()` the reverse), and identically-composed sort keys let `store.put()` silently overwrite a real checkpoint, or `store.get()` return another thread's pending-write payload as the caller's own value. The three tags differ in their first character, so the key spaces are now disjoint by construction. **Data written by 0.7.x is not found** — back up and recreate the table.
- **Pending-write sort keys carry their channel**: `WRITE#<ns>#<id>#<task>#<idx>#<channel>`. See "a retried task no longer loses writes" below.
- **A `DynamoDBStore` with a `vectorBackend` but no `index` now throws at construction** rather than silently degrading.
- **`getMessages` skips an undecodable message** instead of failing the whole read; pass `onCorruptMessage: 'throw'` for the previous behaviour.
- **Store range filters (`$gt`/`$gte`/`$lt`/`$lte`) no longer coerce across types.** A stored `'10'` no longer satisfies `{ $gt: 5 }`. Two strings now compare lexicographically, where upstream reduces both to `NaN`.

### Fixed

- The optional `@aws-sdk/client-s3` peer floor is `^3.901.0`; the previous `^3.900.0` named a version that was never published, so nothing could install it. The `peer-floors` CI job installs every declared floor and runs the type check and unit tier against it.
- **`deleteThread()` and `history.clear()` deleted an entire shared partition with no sort-key scoping** (Critical). Both paged a partition `Query` carrying no sort-key condition and deleted every row it returned. Beyond the tagged partition keys above, each now deletes only rows whose sort key belongs to it, leaves anything else in place, and logs both counts.
- **Reads cast raw rows instead of narrowing them** (Critical). `store.get()` cast `result.Item` straight to a store record: a colliding checkpointer WRITE row carries a `value` descriptor in the identical shape, so it decoded cleanly and returned another thread's pending write as the caller's own value — no exception, no signal. Checkpointer `list()` blind-cast every `META#` match the same way. Both now narrow and skip a foreign row with a `warn`.
- **A retried task with a changed write mix silently lost writes and duplicated others** (Critical). A regular write's index is its position in the call's array, so a retry that emitted a new channel first put that channel on an index another already held; the first-write-wins guard cannot tell a genuine retry from an unrelated write, so the new channel was permanently dropped while the shared one was written twice — `putWrites()` returning success either way. Fixed from both ends. The sort key now carries the **channel**, so two different channels can never contend for one row and nothing is lost. Positional indexing is kept (it is what makes writes replay in the order the task emitted them, and it matches the reference `MemorySaver`), so a re-emitted channel can still land at a second index; each call therefore stamps its rows with a shared `writeGroup`, and the read side drops rows a *later* call added for a channel an earlier one had already committed. That distinguishes the retry case from a channel a single call legitimately wrote more than once (a task emitting two Sends), where every value must survive — so an accumulating channel such as a `messages` add-reducer is never double-counted. Separately, the index was being computed twice — once during dedup, once from the position in the *deduped* array — which diverged from upstream for a mixed special/regular write array; it is now resolved once.
- **A real-AWS test's assertion on the rollback error chain could never have matched.** `BatchWriteAllIncompleteError.cause` is the failing chunk's `BatchWriteIncompleteError`, and the raw underlying error is *that* error's cause — one level deeper than the test looked. Pre-existing on `0.7.0`; it surfaced only because this tier runs nightly rather than per-PR.
- **A failed multi-chunk append left a "ghost session"** (Critical). `title`, `createdAt` and `sessionId` are written via `if_not_exists`, and the rollback never touched them, so a caller told the whole append had failed was left with a session reporting `messageCount: 0` whose title still held up to 80 characters of the supposedly-deleted first message — with no API to clear it. The rollback now deletes the session row outright when this call created it, guarded by `messageCount = :total AND createdAt = :now`. When that condition fails — a concurrent append has since added messages, so deleting the row would destroy *that* caller's data — it falls back to the count decrement and then strips just the title this call contributed, guarded on both `createdAt` and the title's own value so a pre-existing title (or one a concurrent caller won the `if_not_exists` race for) is never touched. The content leak is therefore closed in the concurrent window too, not only when the row can be removed outright.
- **Redaction never scanned an error's `message`/`stack` text**, only structured fields — so a secret interpolated into a `RetryExhaustedError`'s message rode through `redactLogger` untouched. Recognisable credential shapes are now redacted inside any string value.
- **Redaction silently dropped an error's whole `cause` chain.** `new Error(msg, { cause })` defines `cause` as non-enumerable per spec, so the rebuild path — which copies own *enumerable* properties plus `name`/`message`/`stack` — never carried it. Every error type in this library attaches an enumerable `code`/`context`, so that path always fires for them: a redacted `RetryExhaustedError` no longer said whether the underlying failure was a throttle, a validation error or a network fault, which is precisely what its cause exists to report. Pre-existing on `0.7.0`; the new value-pattern scanning widened when the rebuild path fires, so it would have become easier to hit. The cause is now copied and recursed, so the chain survives *and* secrets inside it are redacted.
- **Redaction destroyed non-plain values**: `Date`/`Map`/`Set`/`RegExp` collapsed to `{}` and `Buffer`/`Uint8Array` exploded into per-index numeric keys. `Date`/`RegExp` now keep their identity, `Set`/`Map` render as their contents, and binary views become a short label.
- **`store.delete()` had no ambiguous-failure verification**, unlike `store.put()`: a retry-exhausted delete skipped S3-orphan cleanup and the vector-backend delete even when the row was gone server-side and only the acknowledgement was lost.
- **S3 objects uploaded mid-batch were permanently orphaned** when a later message in the same `addMessages()` call failed to encode — the uploads happen before the append saga's compensation machinery is ever reached.
- **One malformed message made an entire session permanently unreadable**, with no API to remove just the bad item.
- **`VectorBackend.query()`'s score direction was undocumented and unenforced.** A backend surfacing a raw distance still returns nearest-first, so the order looks right while every score means the opposite of what a caller thresholding or displaying it expects. The contract is now explicit, and ascending scores are warned about. Results are never reordered.
- **The critical paths produced no operational trace at all** — not a configuration gap but an absence of log statements, so enabling logging could not surface them. Delete counts, foreign rows skipped, narrowing failures, guard rejections, backend-contract violations and corrupt items are now all logged, at levels matching their severity.
- **`S3Offloader.destroy()` was a no-op mid-construction**, leaking the client that arrived moments later.
- **An empty `CancellationReasons` array was treated as retryable** by vacuous truth on `.every()`, contradicting the function's own doc comment.
- **`list()` with a metadata filter and a small `limit` could throw `ResultTruncatedError`** instead of returning the matches, because the page cap counts raw rows pulled rather than filter-matched ones.
- **`deleteThread` validated its thread id more weakly than every other checkpointer action** (no reserved-separator check), and a mid-stream flush failure reported only the failing flush's progress, hiding earlier flushes' persisted deletes.
- **`assertNoControlChars` was exported but called nowhere**, so no identifier was checked — a `thread_id` carrying a raw ANSI escape was accepted and persisted, a log-injection surface for any consuming app. Every key-bound identifier is now validated.
- **`WRITE_INDEX_OFFSET` hardcoded an assumption about the peer dependency's `WRITES_IDX_MAP`** with no cross-check; it is now pinned by a static test, and `writeSortKey` asserts the index is encodable.
- **`listNamespaces` never validated `maxDepth`**, so a negative value silently inverted truncation through `Array.prototype.slice`.
- **`reconcileVectorIndex`'s prune could delete a live vector**: its live-set snapshot and prune read are not point-in-time consistent, so an item written between them looked orphaned. Each candidate is now re-checked with a strongly-consistent read.
- **`getMessages`/`clear` never validated `sessionId`**, surfacing a raw AWS SDK exception where `addMessages` threw this library's typed `ValidationError` for the identical input.
- **`estimateItemBytes` measured identifiers in UTF-16 code units**, understating a non-ASCII session id threefold and breaking the "at or above the real size" guarantee its own doc comment makes.
- **`deriveTitle` could split a surrogate pair**, and returned 81 characters where it documented 80.
- **`listSessions` sorted with `localeCompare`** on ISO-8601 timestamps, and returned sessions past their TTL while `getMessages` filtered expired messages — the two read paths now agree.
- **`searchViaBackend` failed an entire search** when a backend returned a namespace element containing the reserved separator, instead of dropping the one unusable match.
- **`matchesStoreFilter` read `value[field]` without an own-property check**, so a filter naming an absent field could compare against an inherited member.

### Documentation

- The checkpointer's special-write overwrite path carries the same S3 orphan race the store's concurrent puts already documented; it is now written down beside it, with the same reclamation guidance.

## [0.7.0] - 2026-08-28

Addressing an independent deep review of `0.6.0` itself: three critical
findings and one high-severity cross-adapter key collision. Every fix
carries a dedicated regression test, verified against real DynamoDB Local
for the two fixes that touch on-wire key construction.

### Changed (breaking)

- **Chat-history's sort keys now carry a `HISTORY#` item-kind tag** (`SESSION` → `HISTORY#SESSION`, `MSG#<ULID>` → `HISTORY#MSG#<ULID>`), closing a real key collision on a table shared via `DynamoDBFactory.createAll()`: an unprefixed `SESSION` sort key was reachable by an entirely ordinary store call (`store.put([sessionId], 'SESSION', …)`, since a single-element namespace's sort key collapses to just the bare key), silently grafting one adapter's attributes onto the other's item. **Existing chat-history data is not compatible** — `getMessages`/`listSessions`/`clear` will not find rows written before this change. Back up and migrate (or recreate) any table with real chat-history data before upgrading. Checkpointer and store keys are unaffected.

### Fixed

- The optional `@aws-sdk/client-s3` peer floor is `^3.901.0`; the previous `^3.900.0` named a version that was never published, so nothing could install it. The `peer-floors` CI job installs every declared floor and runs the type check and unit tier against it.
- **A checkpoint's own `id` was never validated against the reserved `#` sort-key separator**, unlike every other identifier this module handles (`thread_id`, `checkpoint_ns`, the parent `checkpoint_id`). A caller-supplied id containing `#` (e.g. `"legit-cp#task-1"`) produced a WRITE sort-key prefix that was a literal string-prefix of a different, unrelated checkpoint's own WRITE row, so `getTuple`/`list` silently absorbed the wrong checkpoint's pending writes into the crafted one. `putCheckpoint` now validates `checkpoint.id` the same way the incoming parent id already is.
- **`redactLogger`/`redactSecrets` provided zero redaction for this library's own error subclasses.** The pass-through exemption meant to preserve a bare `Error`'s stack trace matched *every* `Error` subclass by `Object.prototype.toString`, including this library's own `BatchWriteIncompleteError.unprocessed`, `BatchWriteAllIncompleteError.failedChunks`, and `CompensationFailedError.rollbackError` — each of which can carry raw checkpoint/message/store content. Logging a caught error through the package's own recommended `redactLogger` wrapper (`logger.error('failed', err)`) shipped that content unredacted. An `Error` (or subclass) with no own enumerable data still passes through unchanged by reference (nothing to redact, identity/stack trace preserved); one carrying its own data is now rebuilt with `name`/`message`/`stack` preserved and every other own property redacted or recursed like any other object.
- **`batchWriteAll`'s `succeededCount` (added in 0.6.0 to fix rollback undercounting) could still undercount when a chunk partially drained before a later retry round failed outright** — e.g. 20 of 25 items persist, then sustained throttling exhausts the retry budget on the remaining 5: the earlier 20 confirmed successes were silently discarded to 0 instead of being reported. `drainUnprocessedWrites` now carries the running persisted-count through every exit path — a hard write-call failure, the backoff wait's own signal aborting, or clean `UnprocessedItems` exhaustion — not just the last of these. This directly improves the accuracy of `append-saga.ts`'s rollback `messageCount` reversion, the exact call site the 0.6.0 fix targeted.

## [0.6.0] - 2026-08-28

_There is no 0.5.0: the work between 0.4.0 and 0.6.0 was never published under that number._

A second hardening pass, addressing an independent max-effort review of
`0.4.0` itself (the previous hardening release): two critical data-integrity
bugs, a concurrency-correctness bug, two high-severity bugs, and a set of
medium/lower-severity fixes below, plus CI and documentation hardening.
Every functional fix carries a dedicated regression test.

### Fixed

- The optional `@aws-sdk/client-s3` peer floor is `^3.901.0`; the previous `^3.900.0` named a version that was never published, so nothing could install it. The `peer-floors` CI job installs every declared floor and runs the type check and unit tier against it.
- **A repeated write to the same special (negative-index) checkpoint channel across two `putWrites` calls could silently corrupt the previously-committed payload.** The special-write S3 key was deterministic (not nonce'd) and uploaded before the DynamoDB write was attempted, so a second call's upload could overwrite the bytes a still-live row pointed at; if that second call's DynamoDB write then failed, the row kept describing the first call's content while the S3 bytes underneath were already the second call's. Separately, deduping a duplicate special write happened after it was already uploaded, leaking the discarded upload with no DynamoDB failure required. Special writes now nonce their S3 key like every other write, dedup happens before any upload, and a read-before-write step cleans up the correct side (old descriptor on confirmed commit, new upload on confirmed non-commit, neither when the outcome is genuinely ambiguous) once the batch write settles.
- **`store.put()` could delete a just-written S3 payload that had actually landed server-side**, when the final `PutItem` retry attempt failed with a network-class error (e.g. `ETIMEDOUT`) after DynamoDB had already applied the write — the ack was lost, not the write. `persistRecord` now verifies by reading the row back before deleting anything on that specific ambiguous case, and treats a confirmed landing as success.
- **Two concurrent `addMessages` calls on the same stale-or-missing-TTL-anchor chat session could let the shared `ttl` anchor regress backward**, since a stale-anchor heal force-set it unconditionally. The anchor `SET` is now guarded by a monotonic `ConditionExpression`, and a lost race retries the same chunk once without forcing ttl (safe: `if_not_exists` then converges to whichever value already won) instead of losing the message writes to a benign ttl race.
- **A SESSION row concurrently deleted (e.g. by `history.clear()` racing a failed `addMessages` rollback) could be resurrected as a permanent, ttl-less, invisible junk row** by the rollback's compensating count-revert, which issued an unconditional `ADD`. Guarded with the same `attribute_exists(PK)` condition `reconcileMessageCount` already uses, swallowing that specific condition failure (nothing to revert) instead of surfacing a spurious error.
- **`clearSession` could finish without deleting a message written moments before**, due to an eventually-consistent scan of the session partition — the identical bug class `deleteThread` was fixed for in `0.4.0`, left open on this sibling path. `clearSession` now reads the session partition strongly-consistently too.
- **A failed rollback delete during `addMessages` compensation could leave `messageCount` silently overstated with zero compensating write**, since the count-revert only ran after a fully successful delete. It now reverts by the exact number of rows the delete actually persisted before failing (via a new `BatchWriteAllIncompleteError.succeededCount`, aggregated across every chunk instead of only reporting `succeededChunks`/`totalChunks`), rather than skipping the revert entirely.
- **`$in`/`$nin` store filters never matched an object- or array-valued field that an equivalent `$eq` would match**, since they compared array membership by reference instead of by the same deep equality `$eq`/`$ne` already use. Both now use deep equality too.
- **A custom `createS3Client` factory didn't receive the `maxAttempts: 1` retry-parity default** that `resolveDynamoDBClient` already applies to a custom DynamoDB `createClient` factory, leaving the AWS SDK's own internal retries enabled for a persistent S3 failure. Both the default and custom-factory S3 client paths now apply the default consistently.
- **`reconcileVectorIndex()` stayed hard-capped at the old unconfigurable 10,000-item scan limit** even after raising `maxScanItems` specifically to unblock `search()` on an oversized namespace — this sibling maintenance path never received the override. It now honors the same configured cap `search()` does.
- **`DynamoDBFactory.createAll()` couldn't accept an injected `client`** the way the individual `createSaver`/`createStore`/`createChatMessageHistory` methods already could — `new DynamoDBFactory({ client })` was a compile error even though the underlying client-resolution already supported reusing one. `FactoryBaseOptions` now accepts it.
- **`npm run typecheck:all` now runs in CI and on `prepublishOnly`**, catching cross-tsconfig type errors before publish instead of only in local development. The README's error-model section and its TTL rollback-tradeoff note were also corrected and completed.
- **A checkpoint write to a channel literally named `constructor` (or another inherited `Object.prototype` property name, e.g. `toString`/`valueOf`) could silently misroute or corrupt its stored index**, since `WRITES_IDX_MAP[channel] ?? positional` resolved through `Object.prototype`'s inherited properties instead of falling through to the write's actual position — collapsing every such channel into the same dedup key, then stringifying a function reference into the DynamoDB sort key. The lookup is now guarded with `Object.hasOwn`, so only `WRITES_IDX_MAP`'s own genuine special-channel entries resolve; anything else correctly falls through to `positional`.

## [0.4.0] - 2026-08-26

A hardening pass over the whole library, addressing a third-party review of
`0.3.2`: one critical data-loss bug, five high-severity correctness bugs, and
a broader set of medium/lower-severity fixes below. This release carries two
breaking changes (peer dependencies, S3 key-prefix default) plus a smaller
error-shape change to `batchWriteAll`; treat it as a minor version bump (e.g.
`0.3.2` → `0.4.0`), not a patch.

Every fix in this release is backed by a dedicated regression test verified
against real DynamoDB and, where S3 or genuine AWS-account behavior was in
play, real AWS — several with mutation-testing proof (temporarily reverting
the fix to confirm the test actually fails without it).

### Changed (breaking)

- **`@langchain/core` and `@langchain/langgraph-checkpoint` are now peer dependencies.** This prevents dual-instance version skew when the host project pins a different version of `@langchain/langgraph-checkpoint`. Both packages must be explicitly installed at compatible versions alongside `@langchain/langgraph`. Consumers relying on automatic transitive installation will need to add these to their own `package.json`.
- **Each adapter's default S3 key prefix is now adapter-scoped.** `DynamoDBSaver`, `DynamoDBStore`, and `DynamoDBChatMessageHistory` previously all defaulted to the same shared prefix (`langgraph-checkpoints/`); co-locating them in one bucket meant whichever adapter last called `ensureS3LifecycleRule()` silently overwrote the S3 lifecycle expiration rule for the others (their `Filter.Prefix` matched every adapter's objects). The default is now `langgraph-checkpoints/store/`, `.../checkpointer/`, `.../history/` respectively. **Existing data is unaffected** — every offloaded object's S3 key is stored explicitly in its DynamoDB descriptor and is never recomputed from the prefix. **If you already called `ensureS3LifecycleRule()`**, after upgrading you must manually delete the old shared-prefix rule (ID `langgraph-ttl-langgraph-checkpoints`) from your bucket's lifecycle configuration, then call `ensureS3LifecycleRule()` again for each adapter — otherwise the stale rule's prefix filter still matches every adapter's new sub-prefix, and S3 applies whichever matching rule has the shortest `Expiration.Days`, so one adapter's objects can keep expiring on the old shared schedule instead of its own configured TTL. An explicit `keyPrefix` override is unaffected either way.
- **`batchWriteAll` now attempts every chunk of a multi-chunk write instead of aborting on the first failure**, and reports an aggregate result via the new `BatchWriteAllIncompleteError` (`{ succeededChunks, totalChunks, failedChunks }`) instead of surfacing just the first chunk's raw error. This affects `deleteThread`, `clearSession`, `putWrites`, and the chat-history append-rollback path. If you specifically caught the previous raw error type/message from one of these calls, switch to `err instanceof BatchWriteAllIncompleteError` (now exported) or check `err.code === 'BATCH_WRITE_INCOMPLETE'` instead.

### Fixed

- The optional `@aws-sdk/client-s3` peer floor is `^3.901.0`; the previous `^3.900.0` named a version that was never published, so nothing could install it. The `peer-floors` CI job installs every declared floor and runs the type check and unit tier against it.
- **A failed overwrite `store.put()` could delete the *previous* version's S3-offloaded payload, losing data permanently** (`get`/`search` on that item would then throw `S3_OFFLOAD_FAILED` forever). This was the most serious bug found in the review. Every S3-offloaded write now carries a per-call nonce in its key, so a failed write can only ever clean up its own (never-committed) object; the previous object is only cleaned up after the new row is safely committed.
- **Chat-history TTL anchors could get permanently stuck on an already-expired value.** DynamoDB's TTL sweep can lag up to ~48h, and the anchor was written once via `if_not_exists`, so once a stale value landed it could never self-correct. `resolveTtlAnchor` no longer trusts a stored anchor that has already passed; when the persisted anchor is missing or stale, the next append force-refreshes it instead of leaving the session stuck.
- **S3 lifecycle rules could collide across adapters sharing one bucket** — fixed by the adapter-scoped default key prefix; see the breaking-change note above for migration steps if you already provisioned a lifecycle rule.
- **Vector-backend `search()` could silently under-return, or return nothing, past a metadata filter.** The backend-search path now refills and re-queries with a larger candidate count when filtered-out results leave too few, up to `maxSearchCandidates`. A page request that itself needs more than `maxSearchCandidates` candidates (`offset + limit`) now throws `ValidationError` up front instead of silently truncating.
- **Plain (non-semantic) `search()` was hard-capped at 10,000 scanned items, with no override and no documentation.** The cap is now `DynamoDBStoreOptions.maxScanItems` (default unchanged at 10,000) and can be raised per adapter for oversized namespaces.
- **Checkpointer `putWrites` could fail an entire graph run on a duplicate special-channel write.** Two writes to the same negative-index channel in one call (e.g. from a multi-interrupt human-in-the-loop node) produced identical DynamoDB keys, and `BatchWriteItem` rejects duplicate keys outright. Special writes are now deduped by sort key (last-write-wins, matching LangGraph's own semantics) before batching.
- **`deleteThread` now reads the thread partition strongly-consistently before deleting it**, closing a window where an eventually-consistent scan could miss recently-written checkpoints/writes and leave them behind.
- **`list()` now honors `config.configurable.checkpoint_id`**, matching `MemorySaver`'s behavior, instead of silently ignoring it.
- **Hardened DynamoDB retry classification and idempotency**: `TransactionInProgressException` and `RequestTimeout`(`Exception`) are now classified as retryable; the chat-history session-count revert (the one retried write that wasn't previously idempotent) now uses `TransactWriteItems` with a `ClientRequestToken` so a retried revert can't double-apply.
- **`listSessions` can now escape the 10,000-item scan cap** via a new `maxItems` override, alongside the existing `maxIterations`.
- **`matchesStoreFilter` now matches upstream's operator-detection *method*** — the official `InMemoryStore`'s exact known-operator-name matching (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`), not a `$`-prefix heuristic — with a few small deliberate improvements over it: an empty operator object (`{}`) is treated as a literal value instead of vacuously matching every item; `$eq`/`$ne` use deep equality instead of `===`; `$gt`/`$gte`/`$lt`/`$lte` compare directly instead of coercing both sides through `Number()`. `$in`/`$nin` are now supported, and a stored value whose keys happen to start with `$` (e.g. a JSON Schema document with a `$schema` key) is compared as a literal instead of throwing `ValidationError`.
- **Vector-index reconciliation now prunes a backend vector whose item's indexable text became empty**, instead of treating it as still live.
- **A dimension-mismatched embedding now ranks as unscored** instead of a misleading cosine score of 0.
- **`reconcileMessageCount` no longer creates a permanent junk row for a nonexistent session.**
- **S3 retry-exhaustion now surfaces as `S3_OFFLOAD_FAILED`** with operation/key context, instead of masking it behind a bare `RETRY_EXHAUSTED`.
- **The DynamoDB and S3 clients this library constructs itself now consistently default to a single SDK attempt (`maxAttempts: 1`)**, disabling the AWS SDK's own internal retries so this library's own retry/backoff/classification system is the sole retry layer (an explicit `maxAttempts` override still wins). This was already true for some client-construction paths; it's now consistent across DynamoDB and S3, including clients built via `DynamoDBFactory`.

### Added

- **`BatchWriteAllIncompleteError`** exported from the package root, alongside its sibling `BatchWriteIncompleteError` (see the `batchWriteAll` breaking-change note above).

## [0.3.2] - 2026-08-24

### Fixed

- The optional `@aws-sdk/client-s3` peer floor is `^3.901.0`; the previous `^3.900.0` named a version that was never published, so nothing could install it. The `peer-floors` CI job installs every declared floor and runs the type check and unit tier against it.
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

- The optional `@aws-sdk/client-s3` peer floor is `^3.901.0`; the previous `^3.900.0` named a version that was never published, so nothing could install it. The `peer-floors` CI job installs every declared floor and runs the type check and unit tier against it.
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

- The optional `@aws-sdk/client-s3` peer floor is `^3.901.0`; the previous `^3.900.0` named a version that was never published, so nothing could install it. The `peer-floors` CI job installs every declared floor and runs the type check and unit tier against it.
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

- The optional `@aws-sdk/client-s3` peer floor is `^3.901.0`; the previous `^3.900.0` named a version that was never published, so nothing could install it. The `peer-floors` CI job installs every declared floor and runs the type check and unit tier against it.
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

- The optional `@aws-sdk/client-s3` peer floor is `^3.901.0`; the previous `^3.900.0` named a version that was never published, so nothing could install it. The `peer-floors` CI job installs every declared floor and runs the type check and unit tier against it.
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

[Unreleased]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v1.0.0-rc.2...HEAD
[1.0.0-rc.2]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v1.0.0-rc.1...v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.9.0...v1.0.0-rc.1
[0.9.0]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.4.0...v0.6.0
[0.4.0]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v0.3.0...v0.3.1
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
