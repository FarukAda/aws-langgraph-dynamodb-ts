# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-rc.1] - 2026-09-02

The 1.0.0 hardening: every finding of an independent, enterprise-grade review of `0.9.0` (188 findings across the checkpointer, store, chat history, DynamoDB layer, codec and S3, error model, security and IAM, packaging, tests and documentation) was fixed or, where the finding was a documentation gap, documented. Every fix landed test-first, the test tiers now include a compiled LangGraph graph over the saver and LangChain's official checkpointer validation suite against DynamoDB Local, and the README states what each tier proves. Rows written by `0.9.0` remain fully readable; the two new row attributes (`storedChannels` on checkpoint META rows, `schemaVersion` inside payload descriptors) are additive.

### Changed (breaking)

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
- Errors and logging: `ErrorContext.field` names the offending option or argument, `DynamoDBLangGraphError` carries structured context, redaction covers error text without over-redacting telemetry, and a payload that cannot fit a DynamoDB item is refused before the write.
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

[Unreleased]: https://github.com/farukada/aws-langgraph-dynamodb-ts/compare/v1.0.0-rc.1...HEAD
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
