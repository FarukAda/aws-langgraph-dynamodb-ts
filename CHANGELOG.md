# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The adapters, the single-session adapter, the factory and `backfillRecencyIndex` now refuse a caller's mistake with a `ValidationError` naming the argument, in every case listed under *Changed (breaking)* below, where they used to ignore it, crash, answer with a silently empty result or report it as an AWS failure. No case in the surface tier's table of malformed inputs now ends in `UpstreamError` or `RetryExhaustedError`.

### Removed

- **Mutation testing is retired.** The weekly workflow and its configuration are gone. The gate never produced a number: every scheduled run since 2026-06-01 failed, because the runner was fetched into an `npx` sandbox that resolves a real `typescript` package while this repository aliases that name to `@typescript/typescript6`. A `break` threshold of 70 was therefore never once evaluated. Keeping a gate that has never reported is indistinguishable from having no gate, and worse, because it reads like coverage that exists. The quality floor is unchanged and is enforced on every run: 100 % branches, functions, lines and statements, the static guards under `test/static`, and the surface baseline.

### Changed

- **The real-AWS test tier no longer runs on a schedule.** The nightly workflow is gone; `npm run test:aws` is a maintainer step before a release. One of its nine suites exercises Bedrock, and a scheduled job that retried or looped would bill the account unattended — the kind of cost nobody notices until the invoice arrives. Running it by hand keeps the spend attached to a person who chose it. What the tier covers is unchanged: 52 tests over real DynamoDB, S3 and Bedrock, each creating and deleting its own uniquely named resources.

### Fixed

- **The published tarball no longer carries modules whose source was deleted.** `npm run build` compiled into whatever `dist/` already held, so output outlived the source it came from — `1.0.0-rc.1` shipped a `stored-channels` module with nothing behind it. The build now clears `dist/` first, and the pack check refuses any `dist/**/*.js` without a matching `src/**/*.ts`, so the same drift cannot reappear silently.

- **`saver.put()` no longer narrows what it stores by `newVersions`** — it stores every channel value the checkpoint carries, as `MemorySaver` does. Narrowing lost user state: LangGraph passes an empty `newVersions` when forking a checkpoint (`updateState(..., '__copy__')`) and when writing an empty-checkpoint update, and a put with no named channels stored no values at all. The `storedChannels` attribute is no longer written; rows that carry it are still read. LangChain's checkpointer validation suite asserts the narrowing in one test, which it already exempts its own `MemorySaver` and its MongoDB and SQLite savers from ("TODO: … doesn't store channel deltas"); since the exemption is keyed on a module-name list, this package applies it by name in its own conformance run and records the difference in the README's "Versioning and compatibility" section (V-10).
- **Identifiers must be well-formed UTF-16.** A lone surrogate — which `slice()` on a string containing an astral character produces — passed every other rule and then encoded lossily, so two distinct identifiers addressed one offloaded S3 object. `checkpoint_ns`, which bypasses the shared validator because an empty value is legal, is checked too.
- **`saver.list(config, { limit: 0 })` yields nothing** instead of reaching DynamoDB as `Limit: 0` and raising a raw `ValidationException`; the scan path no longer yields one tuple before testing the limit.
- **`saver.list()` with a `checkpoint_id` but no `checkpoint_ns` searches every namespace.** It point-read the root namespace, so a checkpoint written inside a subgraph was never found.
- **`store.batch()` runs operations in the caller's order.** Every write ran before every read, so `[delete, get]` returned the deleted value and `[get, put]` returned the new one — the opposite of the reference store, and reachable through `AsyncBatchedStore`.
- **An empty filter condition imposes no constraint.** `{ field: {} }` matched nothing; the reference store matches every item that has the field.
- **`history.reconcileMessageCount()` is safe on a live session.** The count is written under a condition on the value the row held when it was counted, so a concurrent append fails the write and the tool recounts instead of discarding the increment. It throws `ConflictError` when the session stays busy through every attempt.
- **The unprocessed-items drain honours the configured `retry` policy** instead of module constants.
- **`redactSecrets()` visits a shared node once.** The cycle guard re-walked every node reachable by more than one path, which is exponential on a graph that merely shares structure. Nesting deep enough to exhaust the stack now yields `[UNREDACTABLE]` rather than throwing `RangeError` at the caller.
- **`UpstreamError` redacts the cause it quotes.** Its message reaches `err.message`, which an application may print without a redacting logger.
- **Semantic search embeds each extracted path separately** and scores an item by its best-matching one, as `InMemoryStore` does. Joining the configured fields and embedding once averaged a long document into a single vector, so a document whose one relevant section matched perfectly ranked below a document that matched everywhere but weakly. Items now carry `embeddings` (a vector per path) instead of `embedding`; rows holding the old single vector are still read and rank exactly as they did. A configured `vectorBackend` is unaffected and still receives one vector per item.
- **A delta channel whose history has a hole in it now fails loudly.** `DeltaChannel` (LangGraph 1.2+, beta) rebuilds a channel from the nearest ancestor that stored a value, and the walk inherited from `BaseCheckpointSaver` stops at an ancestor it cannot read and reports no seed — after which the consumer restarts the channel from its initial value. A `ttl` is computed per put, so a long-running thread expires its own older checkpoints while the newer ones live on, and the result was a silently shortened channel. `saver.getDeltaChannelHistory()` now throws the new `ANCESTOR_EXPIRED` code (with `threadId` and `checkpointId`) when a checkpoint a channel still needs has expired. An ancestor that was never written is still an ordinary root, and an expired ancestor a nearer one already answered for is never reached.
- **`ensureS3LifecycleRule()` refuses a rule-id collision instead of silently mis-scoping.** The rule id is a slug of the key prefix, and slugging maps every non-alphanumeric character to `-`, so `a/b/` and `a-b/` produce one id. The existing rule was also judged correct without checking which prefix it scoped: one prefix could take over the other's rule, or be left with no rule at all so its objects never expired. The prefix is now part of that check, and a genuine id collision raises `ValidationError` naming `s3.keyPrefix`.
- **`saver.getTuple()` validates the identifiers a thread-less config does give.** It returned `undefined` before looking at anything else, so a malformed `checkpoint_ns` or `checkpoint_id` went unreported there while `saver.list()` on the same config rejected it. The reference saver asserts `checkpoint_ns` whether or not a thread id is present (`@langchain/langgraph-checkpoint@1.1.5` `dist/memory.js:86-92`). The answer for a config naming no thread is still `undefined`, not an error.
- **A write index that is not an integer is refused.** Padding a fraction produced a sort key like `00000009.5`, which no longer orders numerically — the whole point of the fixed-width encoding. Unreachable through `putWrites`, whose indices are array positions, but the encoder no longer relies on its caller for that.
- **A stored payload that is not a descriptor is refused, not dereferenced.** A row whose `checkpoint`, `metadata`, `value` or `message` held `null` raised a raw `TypeError` from reading `.schemaVersion` off it; it now raises `ValidationError` naming `descriptor`, like every other unreadable descriptor shape. The checkpointer's own row narrowing accepted such a row as one of its own — its guard tested `!== undefined` — and now skips it.
- **`saver.list()` with a metadata filter no longer fails on one odd row.** A row whose metadata decoded to `null` reached `Object.hasOwn(null, …)` and threw out of the public method; metadata that is not an object now simply matches no filter clause, so the listing continues.
- **`saver.list({ limit })` refuses a non-integer.** A fractional limit reached DynamoDB as `Limit: 1.5` and came back as a raw `ValidationException` naming neither the option nor the caller who set it.
- **A custom redaction pattern without the `g` flag redacted only the first occurrence.** `String.prototype.replace` substitutes once without it, so an `extraValuePatterns` entry written as `/token-\d+/` hid the first secret in a string and printed every later one verbatim. Every pattern is now applied globally whether or not it says so.
- **`redactLogger` rejects options that would protect nothing.** A non-string in `extraKeys` raised a bare `TypeError` at the first log call, and a string where a `RegExp` was expected read `.source` as `undefined` — `new RegExp(undefined)` is `/(?:)/`, which prefixed the redaction marker to every value while matching no secret at all. Both now raise `ValidationError` where they are configured.
- **`toError()` no longer throws from inside a `catch`.** Normalising a thrown circular object or a `BigInt` raised a `TypeError` from `JSON.stringify`, discarding the failure being reported and replacing it with its own; a thrown `undefined` or symbol produced an `Error` with an empty message. Each is now described instead.
- **An unreadable payload is reported, not retried.** A row marked compressed whose bytes are not gzip raised a bare zlib `Error` with `code: 'Z_DATA_ERROR'`, and a payload that does not parse raised a bare `SyntaxError`: neither carried a package code, so `isPermanentPayloadLoss` classified them as transient and a caller retried a payload that can never be read. Both now raise the new `PAYLOAD_CORRUPT` code, which is classified permanent.
- **A payload that serialises to nothing is refused, whichever adapter writes it.** The check that catches these values lived in the store's own serializer, so the store refused them and the checkpointer did not: `putWrites(config, [['ch', () => 1]], task)` wrote a pending-write row whose `value` held **zero bytes** under an ordinary `INLINE` descriptor, and the write succeeded. Zero bytes is not a document in any format, so from then on every `getTuple` of that checkpoint failed with `UpstreamError(SyntaxError)` — one unrepresentable value, silently accepted, made the whole checkpoint unreadable. The refusal now sits in the encoder every adapter and every `serde` passes through, immediately after serialization and before compression, so an inline payload and an offloaded one are refused identically and no S3 object is uploaded for a payload nothing could ever read. It raises `ValidationError` naming `value`, distinct from the `ValidationError` naming `payload` that an over-large inline payload raises. Under the default `JsonPlusSerializer` a function and a symbol are what encode this way; `BigInt` and `NaN` do not — they are substituted silently, which the README now records where a reader chooses a `serde`.

- **A value JSON cannot represent is refused at the write.** `undefined`, a function and a symbol all stringify to `undefined`, which encoded to **zero bytes**: the write succeeded and every later read of that row failed to parse. They now raise `ValidationError` naming `value`, as do a circular structure and a `BigInt`, which previously escaped as raw `TypeError`s.
- **A malformed identifier always raises `ValidationError`.** `checkpoint_ns` is the one identifier allowed to be empty, so it skipped the non-blank rule and reached `Buffer.byteLength` directly: a non-string value surfaced as a raw Node `TypeError [ERR_INVALID_ARG_TYPE]` out of a public method instead of this package's error. Every validation primitive now checks the type first, so every entry point is covered.
- **A checkpoint row may only speak for the partition it lives in.** A META row's `threadId`, `checkpointNs` and `checkpointId` name the S3 scope its payloads are read under and the thread the assembled tuple reports, and nothing tied them to the DynamoDB key the row was found at. A writer confined to its own partition — the isolation `dynamodb:LeadingKeys` gives — could therefore store a row claiming another tenant's `thread_id`, and `saver.list()` would fetch that tenant's offloaded object and hand it back under their id. The row narrowing now requires the attributes to reproduce the key, exactly as `narrowStoreRecord` already did for store items (SEC-03).
- **A `search` no longer fails on one unusual stored value.** `matchesStoreFilter` reached `Object.hasOwn` on a value that is not an object — a row holding `null` or a scalar — and threw `TypeError: Cannot convert undefined or null to object` out of the public method, failing a search over many rows because of one. Such a value now satisfies no condition, and the search continues.
- **An unknown `matchType` is refused instead of guessed.** `listNamespaces({ matchConditions })` resolved anything that was not `'prefix'` as a suffix match, so a typo or a value read from a configuration file silently answered a different question. The contract defines exactly two (`@langchain/langgraph-checkpoint@1.1.5` `dist/store/base.d.ts:211`); anything else now raises `ValidationError` naming `matchConditions`.
- **An indexed field holding `undefined` no longer fails the put.** Text extraction returned a one-element list containing `undefined` typed as `string[]`, and the caller's own length check then threw `TypeError: Cannot read properties of undefined` from inside the embedding step — for a value `JSON.stringify` stores without complaint and that `InMemoryStore` indexes as no text. A function and a symbol did the same; a circular structure and a `BigInt` escaped as a raw `TypeError` from `JSON.stringify`. Each now yields no index text, and a value that genuinely cannot be stored is refused by the codec with `ValidationError` naming `value`.
- **`listNamespaces()` orders namespaces reproducibly.** Sorting by `localeCompare`, as the reference store does, calls some *distinct* namespaces equal — `café` written precomposed and decomposed is one such pair — and their order then came from whichever order DynamoDB returned the rows in, so the same listing could place a page boundary between them differently on two calls, skipping one namespace and repeating another. Ties are now broken by code unit, which never reorders a pair the collation itself orders.
- **`history.addMessages()` names the value that is not a message.** Serialization failed with `TypeError: message.toDict is not a function` from inside LangChain — no index, no field, no sign of which library refused it. It now raises `ValidationError` naming `messages` and the offending index, before any write.
- **A `vectorBackend` search reads each matched item once.** When a metadata filter leaves the page short, the search asks the backend for a larger `topK`, and the answer contains the previous round's matches — which were then read from DynamoDB again, one read (and one S3 download for an offloaded item) per match per round, up to roughly twice the final round at the cap. Each distinct match is now read once for the whole call, which also covers a backend that returns one key twice in a single round.
- **A `vectorBackend` search reads its matched items concurrently.** Each match costs a canonical DynamoDB read (and an S3 download for an offloaded item), and they were issued one at a time, so a page of matches was a page of sequential round trips. They now use the same bounded concurrency as the in-DynamoDB path, as does the item decode inside `reconcileVectorIndex`.
- **`createAll()` gives its adapters the DynamoDB region for S3.** An adapter reads that region off its own `clientConfig` when the `s3` config names none, and the adapters `createAll` builds are handed the one shared `client` instead — a `clientConfig` may not travel beside it, since for the client it would be ignored. The region was therefore lost, and a bucket reachable only through it failed with an opaque `PermanentRedirect` on the first offload, while the identical configuration through `createStore()` worked. It now travels on the `s3` config, which is what still needs it.
- **`DynamoDBFactory` validates its own defaults, at construction.** A base carrying both a `client` and a `clientConfig` was refused by the first `createSaver`/`createStore`/`createChatMessageHistory` call and accepted by `createAll`, for the same factory — so whether the mistake was reported depended on which method the caller reached for. It is now refused where it was written, together with any key the factory does not read.
- **`createAll()` refuses a section name it does not build.** `CreateAllOptions` has three keys, and a misspelt one escapes the type through any variable that is not an object literal; the call then built nothing and handed back three `undefined`s. It now raises `ValidationError` naming the key.
- **Tearing down a `createAll()` result is total.** One adapter throwing from `destroy()` stranded every resource after it, including the shared client that nothing else can reach once `destroy` has returned; inside the rollback of a failed build it also replaced the constructor error the caller needs with its own. Each release is now independent, and a failure is logged at `warn`.
- **Two log events carried a whole error message** (`Failed to clean up orphaned S3 objects after`, `store.put vector-index sync failed`); they now carry the error's `reason` (its name), as this package promises its logs hold identifiers and counts only.
- **`store.batch()` writes nothing when one of its operations is malformed.** Each operation was checked as it ran, so `[put A, malformed]` wrote A and then rejected. Inside a graph that meant more than one caller: `AsyncBatchedStore` sends every store call made in one tick as a single batch, so it rejected every one of them, including the caller whose put had landed. Every operation is now checked before any runs, and nothing is written — the same outcome as the reference store, which applies no put until it has read every operation.
- **A legacy `thread_ts` is honoured when `checkpoint_id` is `''`.** The checkpointer read an empty `checkpoint_id` as "the latest checkpoint" and ignored a `thread_ts` beside it, although its own documentation said it resolved the id the way the reference's `getCheckpointId` does, which falls through to `thread_ts` (`checkpoint_id || thread_ts`). It now falls through for `''` as it already did for `null`.
- **A write whose acknowledgement was lost can no longer put its row back after something else released the payload that row names.** The payload lives in S3 and the pointer row in DynamoDB with no transaction across the two: a write committed its row, its acknowledgement was lost, and its own retry re-landed the row after a concurrent delete — or a `ttl` sweep and the lifecycle rule — had already released the object. The row was then live and named a deleted object, and every later read of it failed with `S3_OFFLOAD_FAILED` / `NoSuchKey`, permanently. Every write that references an offloaded object is now sent as a one-item `TransactWriteItems` carrying a `ClientRequestToken` drawn once per retry budget and re-sent unchanged by every attempt of that budget, so a re-send of an attempt that already committed is answered from DynamoDB's idempotency cache instead of being applied a second time. A compare-and-swap that loses and re-pins draws a fresh token, because the re-pinned request is a different request and the service refuses the same token with changed parameters. The writes that were transactions already — `saver.put`'s two rows, a `history.addMessages` chunk with its session row, and the session-row writes that roll such an append back — carry a token whether or not anything was offloaded, since it costs them nothing. What a token guarantees is narrower than the short version, and the README now states it in full: a write whose first attempt **committed** is applied exactly once, at that moment, while a write whose first attempt was **rejected by its condition** carries no idempotency at all — a cancelled transaction never completes, so DynamoDB caches no result for its token, and a retry with the same token is a fresh evaluation against the table as it stands at retry time.
- **One request attempt on a client this library builds is bounded.** `maxAttempts: 1` switched off the SDK's own retries but nothing bounded a single attempt, so a hung socket held one open indefinitely and neither the retry budget nor the deadline that keeps a token inside its window could bound anything. Such a client now passes the SDK's request handler a 10 s request timeout — with `throwOnRequestTimeout`, without which the handler only logs the breach — and a 5 s socket timeout, so a hung request fails with a retryable `TimeoutError` and is retried. No **connect** timeout is set, deliberately: its timer starts at request creation and is cleared only when the agent assigns a socket, so the whole wait behind a wide fan-out counts against it. Measured with a one-socket agent, a connect timeout of 800 ms killed 14 of 100 healthy requests and one of 2 500 ms killed 226 of 400 — every one of which succeeded with the field unset, and each of which this library's own retry layer then re-sent. The S3 client is given the idle timeout **only**, because a `PutObject`'s response headers do not arrive until the whole body has been uploaded: at the 50 MB ceiling that path carries, a 10 s request timeout would demand a sustained 5 MB/s for the entire upload and would destroy — and re-send — anything slower. An injected `client` is used exactly as it was handed over and gets none of this, which is why `maxAttempts: 1` is now documented as necessary and not sufficient: give it a request timeout of its own.
- **`ensureS3LifecycleRule()` no longer shortens a noncurrent retention you configured.** It put `NoncurrentVersionExpiration` on its own prefix-scoped rule at the object expiry it had just computed — the `ttl` rounded up to whole days plus a two-day margin — and S3 honours the *shorter* of two overlapping expirations, so a bucket-wide 90-day retention quietly became 32 days for the keys under this prefix. The value written is now the longest `NoncurrentDays` among every enabled rule that governs these keys, floored at the release grace and never lowered; the library's own rule is one of the rules it measures against, so the floor ratchets rather than drifting back down. On a bucket with no such rule the noncurrent window is now that one-day grace rather than the object expiry, which is what a released payload needs to stay restorable, and the two rule shapes are in the README verbatim for a deployment that manages its own lifecycle.
- **`backfillRecencyIndex()` no longer re-creates a row that was deleted while it ran.** `UpdateItem` upserts, and the backfill's write was guarded by `attribute_not_exists(gsi1pk)` alone — a condition on the index attribute, which a key holding nothing at all satisfies. A row deleted between the scan that found it and the update that backfilled it was therefore written back, as a stub carrying nothing but `PK`, `SK` and the two index keys. No lost acknowledgement and no retry were involved: it is an ordinary read-then-write race between the tool's own scan and its own update. Because the stub carried the index keys it landed in the recency index, which is what a thread-less `saver.list()` and `history.listSessions()` read once `indexName` is set — so the resurrection was visible on exactly the path the backfill exists to enable. Neither listing ever served it as a session or a thread and neither raised: `saver.list()` recognised it as not a checkpoint meta item, skipped it and logged one `warn` naming its sort key — **on every listing, indefinitely**, because the stub carries `gsi1pk` and the tool's own scan filter therefore never looks at that row again, so a re-run does not clear it — and `listSessions()` dropped it with no log at all, returning a page one row shorter than its `limit` while the cursor advanced past it. The condition is now `attribute_exists(PK) AND attribute_not_exists(gsi1pk)`, which makes the write a true update; the tool exists to give keys to rows that are already there, so nothing legitimate is refused.

- **`backfillRecencyIndex()` no longer abandons a run because one row could not be written.** The conditional update that gives a row its keys is refused in two ordinary cases — a row another writer indexed since the scan, and (since the fix above) a row deleted since the scan — and `ConditionalCheckFailedException` is not retryable, so the refusal escaped the row's write, stopped every row still to be started, and reached the caller as `UpstreamError` with the whole `BackfillResult` discarded: the counts and the cursor for the rows already indexed went with it. Both refusals mean the same thing — this run has nothing to do for that row, because it already has keys or is no longer there — so the row is now counted in `skipped` and the walk carries on. A run capped by `maxPages` still returns its `nextCursor`, so resuming continues past the refused row rather than re-reading it, and re-running is cheap because the scan's own `attribute_not_exists(gsi1pk)` filter never looks again at a row an earlier run indexed. Every other failure still ends the run exactly as it did; only the guard's own rejection is treated as an outcome. The effect was worst on precisely the table the tool is for — one with adapters writing to it — where a row indexed by a live adapter between the scan and the update is not an edge case but the expected one, so a migration could stop at its first live write and report nothing about the work it had done.

- **A cancelled `saver.deleteThread()` or `history.clear()` reports the cancel.** Both documented `AbortError` when the signal fires, and both raised `BatchWriteAllIncompleteError` (`code: 'BATCH_WRITE_INCOMPLETE'`) instead, so a caller branching on `ABORTED` read its own deliberate stop as a delete that had half-landed. The chunked form went further: the `AbortError` carried no `succeededCount`, and adding it to the running total made the reported count `NaN`, while the loop went on offering every remaining chunk to a signal that had already fired — three chunks attempted, three abort errors collected, for a call the caller had cancelled after the first. An abort is now rethrown unwrapped the moment a chunk or a row reports it, nothing further is issued, and only an error that actually carries a count contributes to one. Every other failure is reported exactly as before, counts included.

- **A consumer's own DocumentClient type-checks.** `client` was declared as `DynamoDBDocument`, which names the class in *this package's* copy of `@aws-sdk/lib-dynamodb`. A consumer pinned to an older SDK is given a second, newer copy nested under the package, so the client they built is a different type with the same name and the compiler refused it — `TS2741: Property 'searchVectors' is missing` — at every documented injection point: the three adapters, the factory and `backfillRecencyIndex`. Injection always worked at runtime; only the compiler stood in the way, and it stood in the way of the integration path the README recommends. `client` is now `DynamoDBDocumentLike`, exported, naming exactly the eight methods this package calls (`get`, `put`, `delete`, `update`, `query`, `scan`, `batchWrite`, `transactWrite`) — the same eight an adapter's constructor already required of an injected client, held equal to that list by a test, with each signature still picked off the SDK's own class. A `DynamoDBDocument` satisfies it unchanged, and `client: {}` is still refused naming `client.get`. The SDK packages remain direct dependencies, so a consumer on an older SDK still ends up with two copies of them installed; that is a bundle-size and duplication cost, not a correctness one.

### Added

- **`SearchOptions`**, the type of `store.search()`'s options (`filter`, `limit`, `offset`, `query` and `signal`), is exported beside `GetMessagesOptions`, `ListSessionsOptions`, `CancelOptions` and `BackfillOptions`, so a caller can type the options it builds for a search.
- **`ListNamespacesOptions` and `DeltaChannelHistoryOptions`**, the types of `store.listNamespaces()`'s options (`prefix`, `suffix`, `maxDepth`, `limit` and `offset`) and of `saver.getDeltaChannelHistory()`'s (`config` and `channels`), are exported. Each is the parameter type upstream declares inline, pinned equal to it by a type test, so what a call accepts is unchanged; the API reference now lists their fields, where it rendered the first as `{} | undefined` and the second with no type.
- **A warning when one `getMessages()` call reads a very large session.** Past 10 000 messages the read still completes — silently truncating a conversation is worse than a slow read, and a caller that wants a bound passes `limit` — but an operator is told the session is unusually large, the same way the checkpointer reports a checkpoint carrying very many pending writes.
- **`backfillRecencyIndex()`**, an operator tool that gives rows written before the index their index keys. Run it before setting `indexName`: without it, enabling the index hides every pre-existing row from the listings that read it. Resumable, re-runnable, and safe to run against a live table.
- **`readConcurrency`**, the number of payloads one call decodes at once (default 8, unchanged behaviour), and of recency-index shards one listing queries at once. It is the multiplier on this package's memory ceiling — `readConcurrency × (s3.maxDownloadBytes + compression.maxDecompressedBytes)`, 800 MiB at the defaults — which was previously neither documented nor adjustable: the per-payload caps bound one payload, not the several a read decodes at once. Lower it on a small container.
- **A recency index (`indexName`, `indexShards`)**. Rows that are listed across partitions — checkpointer `META`, store items and history `SESSION` — carry `gsi1pk`/`gsi1sk`, and naming a GSI on those attributes turns `history.listSessions()` from a full-table scan with an in-memory sort into a pageable read of the index, and `saver.list()` without a `thread_id` from a table scan into a streamed index read. A listing reads each shard one DynamoDB page at a time, follows it across DynamoDB's 1 MB page boundary, and reads a shard's next page whenever that shard has no row buffered and the page still needs one, even if the page then takes none of the rows that read returns; it holds the page it is building — up to `limit` rows for `listSessions`, which sets no ceiling on `limit`, and 100 for `saver.list` — plus at most one DynamoDB page per shard, and queries at most `readConcurrency` shards at once. A shard whose pages do not end within the iteration cap raises `ResultTruncatedError` rather than returning part of itself, and `nextCursor` is present exactly when some shard has not reported its end or holds a row the page did not take. A `cursor` whose decoded value carries no `#`, and so cannot be an index sort key (`<timestamp>#<id>`), raises `ValidationError` naming `cursor`, and `indexShards` must be an integer from 1 to 1024. `history.listSessions()` takes `limit`, a positive integer checked on both read paths, and `cursor`: with `indexName` they are the page size (100 when omitted) and the position to resume from; without it an explicit `limit` selects the newest N sessions of the scan and omitting it returns every session, since a scan has no cursor to fetch the rest with, and a `cursor` raises `ValidationError` naming `cursor`, as does a `cursor` that is not a string when `indexName` is set. `store.search([])` and `listNamespaces()` without a prefix root stay scans: they enumerate a namespace prefix, which a recency index cannot express as a key condition. Opt-in: without `indexName` both listings scan the table, so the index can be created and backfilled before any adapter reads it. The index partition key is sharded because mapping one identifier onto one partition key is the hot-spot anti-pattern AWS names directly.
- **Every row carries its own format version (`v`)**, and every read that returns a row's content refuses one written by a newer release with the new `FORMAT_UNSUPPORTED` code instead of guessing at a shape it does not know. Rows without the attribute read as version 0 under the rules that applied when they were written, so nothing needs migrating.

- **Offloaded S3 objects are uploaded with `If-None-Match: *` and carry a backlink to their row.** An object's key still ends in an id unique to the write that uploaded it — a store put's `rev`, a checkpoint put's ULID, a `putWrites` call's `writeGroup`, a history message's ULID — and that id is now appended as it is rather than base64url-encoded: `<keyPrefix><the row's identifiers, each base64url-encoded>/<write id>.bin`, where a history message's identifiers are its session alone. The conditional upload means a retried request writes nothing new and never overwrites what an earlier attempt stored: S3's `412 Precondition Failed` on the write's own key means an earlier attempt of that upload already stored the object, and counts as success. Each object also carries its row's DynamoDB key in S3 user metadata (`dynamodb-pk-b64`, `dynamodb-sk-b64`), the backlink AWS recommends so an out-of-band sweeper can tell an orphan from a live object. No other write uses a write's id, so the cleanup behind a `store.put`, `store.delete`, `saver.put` or `putWrites` releases only the payload of a row its write superseded or removed, or its own upload once a read of the row, or the row returned with a rejected write, shows that the row does not hold its write. Whatever a cleanup cannot establish or fails to delete is left to the lifecycle rule, and so are the objects of the rows a `saver.put` replaces: writing a checkpoint id again replaces its two rows and deletes neither of the objects they named. Objects written by `1.0.0-rc.1` are still read and deleted through the key their descriptor records; nothing needs migrating.

- **Every export documents its contract, and static tests keep it that way.** `test/static/export-contracts.test.ts` fails the build for an exported function — or a reachable member of an exported class, constructors included — whose doc comment does not state what it accepts, what it returns and what it throws. `test/static/export-tests.test.ts` fails the build for an exported function no test names, which coverage alone does not catch: a function reached only through its callers has no test stating what it promises. The logging guard now checks the documented *level* too, not only the message text and field list.

- **`ensureS3LifecycleRule()` writes a second lifecycle rule, and reports the bucket's versioning state.** The second rule — its own id, the same prefix filter, `Expiration: { ExpiredObjectDeleteMarker: true }` — reclaims the delete marker a release leaves behind, once the last noncurrent version under that key has expired. Without it every release on a versioned bucket left a marker that never went away, and anything sweeping those keys had to walk a set that grew for the life of the bucket. It has to be a separate rule because S3 refuses `ExpiredObjectDeleteMarker` inside an `Expiration` that also carries `Days`. After the rules are written, the call reads `GetBucketVersioning` and logs one `warn` for anything but `Enabled` — never versioned, suspended, or a read that failed — naming what containment is missing in each case, because the remedies differ. It never refuses: the rules are worth writing either way, and a deployment that worked yesterday on an unversioned bucket must not start failing today. `s3:GetBucketVersioning` is a new IAM action on the bucket and the only one whose absence is not fatal. The library does not enable versioning itself and nothing stops a deployment running without it, with no recovery window at all — reported, never enforced.
- **A sweep that reports rows whose offloaded payload has been released.** `scripts/find-stranded-payloads.mjs` lists the delete markers under the offload prefix on a versioned bucket, reads each released object's backlink metadata, and asks DynamoDB whether the row that named it is still live: those are the rows a read would fail on, and the grace window is the only time the payload can still be restored. Each finding prints the DynamoDB key, the object key, the two version ids, and the hours of grace remaining, with both remedies spelled out; the script repairs nothing, because which remedy is right depends on why the row is there. It lives **in the repository and not in the npm tarball**, and has no `bin`: publishing it would turn its command line into a `1.x` compatibility promise for a tool run a handful of times per deployment. The runbook is in the README, including the permissions the operator running it needs — `s3:ListBucketVersions`, `s3:GetObjectVersion` and `dynamodb:GetItem` — which are stated there as prose rather than added to the published policy, because that policy grants exactly what the library itself calls.
- **Every payload descriptor, and every chat-history session row, carries the id of the write that produced it.** `writeId` is an optional field inside an attribute the row already carries — 33 bytes on a checkpointer or history row, 43 on a store row — and one new top-level attribute on the session row. It is additive in both places: a reader that does not know it is unaffected, nothing needs migrating, and a row written before this release simply carries none. What reads it is the delete side, under *Changed (breaking)*. A pending-write row is pinned on `writeGroup` instead — the same per-write id, one level up and top-level, which it has carried since `0.8.0` — so for those rows the delete-side guarantee reaches back that far rather than only to this release.
- **`BatchWriteAllIncompleteError` says what its counts count.** Its constructor takes an optional fifth argument naming the unit — `'chunk'` or `'row'` — which the message quotes; omitting it keeps the batch wording exactly as it was, so nothing that constructs or reads one has to change. It is not a property on the error: the unit shapes the message and nothing else, and the counts themselves are read from `succeededChunks`, `totalChunks`, `succeededCount` and `failedChunks` as before. A partition delete raises the error with the row unit, because `1/3 chunk(s) succeeded` would describe a pass that never sent a chunk.

### Changed (breaking)

- **A `serde` of your own may no longer encode a value it accepts to zero bytes.** A payload that serialises to an empty buffer is refused at the write with a `ValidationError` naming `value`, whichever adapter and whichever `serde` is configured. Under the default serializers only a value that *is* a function or a symbol does this, and such a row was unreadable from the moment it landed — every later read of it failed to parse zero bytes — so for those the refusal is strictly a repair. It binds a custom `serde` as well, and there the restriction is real rather than theoretical: an encoding whose empty message is canonically zero bytes, as an empty protobuf message is, can no longer store that value. The rule is a contract on the `serde`, not a claim about the value, and the remedy is a byte of framing in your own encoder.

- **Identifiers reject C1 control characters** (`U+0080`–`U+009F`), alongside the C0 range and DEL that were already rejected. `U+009B` is a single-byte `CSI` and opens a terminal escape sequence exactly as `ESC[` does, so the rule now matches the guarantee it was documented to give (CWE-117).
- **`ttl` must name exactly one unit, and nothing else.** `{}`, a misspelt unit (`{ day: 1 }`), a non-object and `null` were resolved by whichever key happened to be checked first, or produced a misdirecting `ttl.seconds must be an integer`; each now raises `ValidationError` naming `ttl`, except the misspelt unit, which names the key written (`ttl.day`). Any key other than `days` and `seconds` is refused the same way, naming `ttl.<key>` before the unit is checked: `{ days: 1, foo: 1 }` was accepted and the extra key ignored.
- **Options objects reject keys this package does not read.** This holds for each adapter's own options (`DynamoDBSaver`, `DynamoDBStore`, `DynamoDBChatMessageHistory`, and a `DynamoDBFactory` section built into one), their nested `ttl`, `retry`, `compression` and `s3`, the store's `index`, `backfillRecencyIndex`'s options and its `retry`, `forSession`'s window, and the options of `saver.list`, `saver.getDeltaChannelHistory`, `store.search`, `store.listNamespaces`, `history.getMessages`, `history.listSessions`, and the `{ signal }` taken by `deleteThread`, `reconcileVectorIndex`, `addMessages`, `addMessage`, `clear` and `reconcileMessageCount`. An unknown key raises `ValidationError` naming `options.<key>` (`retry.<key>`, `window.<key>` and so on when nested). A misspelt key — `readConcurency`, `retry.maxAttempt`, `{ limt: 10 }` — was accepted and ignored, so the caller ran on a default they believed they had overridden; an option that belongs to another adapter, such as `vectorBackend` on a saver, was ignored the same way. The accepted key sets are checked against the option types at compile time and cannot drift from them. A key `index` does not read is reported before its `embeddings` is checked, so `{ dims, embed }` names `index.embed`, where the displaced `embeddings` was reported as missing.
- **An options value that is not an object raises `ValidationError` naming it.** An adapter's `options` did so already, except that an array was reported as a missing `tableName`, and `new DynamoDBSaver(null)` threw a bare `TypeError`, because its constructor read `options.serde` before anything checked it; both now name `options`. For the methods listed above and `backfillRecencyIndex`, `null`, a string or a number where the options belong was either read as no options at all or failed with an `UpstreamError` or a bare `TypeError`; `store.search(prefix, null)` and `store.listNamespaces(null)` threw the bare `TypeError`. A `signal` that is not `AbortSignal`-shaped — an object with a boolean `aborted` and callable `addEventListener` and `removeEventListener` — raises `ValidationError` naming `signal` (`retry.signal` for `backfillRecencyIndex`'s nested one); it was accepted unchecked. A signal without `removeEventListener` is refused too: once a request was retried, the wait between attempts called it from inside its timer, an uncaught exception that also left the call unsettled. The checkpointer's `config.signal` is checked the same way, naming `signal`, on `getTuple`, `list`, `put`, `putWrites` and `getDeltaChannelHistory`: it was never checked, so `getTuple` with `signal: {}` reported an `UpstreamError` once a request was throttled. The README records the signal refusal, where the reference has a counterpart, as V-28. `clientConfig` and `s3.clientConfig` must be objects too, where a string, `null` or an array was accepted and spread into the configuration the SDK client was built from; their keys stay unchecked, because they belong to the AWS SDK, which adds keys between releases, and an application may install a newer SDK than this package was built against. `s3.keyPrefix` must be a string, where a number or `null` escaped as a bare `TypeError` from every constructor and factory route, and `s3.sseKmsKeyId`, when given, a non-empty string, where a number or an object was handed to `PutObject` unchecked at the first offload, and `''`, `null` or another falsy value was dropped, so objects were uploaded without the key the caller named; only its type is checked, not whether it names a key. A store's `index` that is `null` or another falsy value — `false`, `0`, `''` — meant no index and is now refused naming `index`, as a non-object that is not falsy already was, and an `index.fields` that is not an array of strings is refused naming `index.fields`, where a string failed at the first put as an `UpstreamError`. `DynamoDBFactory`'s `createSaver`, `createStore` and `createChatMessageHistory` refuse options that are not an object, and `createAll` a section that is not one, naming `options` as the adapter's own constructor does, before any client is built for `createAll`: `null` and `undefined` threw a bare `TypeError`, a string, a number or an array was reported as a missing `tableName`, and a `null` or other falsy section built nothing and came back as that value. The factory's constructor refuses a `clientConfig` that is not an object, since `createAll` hands its adapters the client built from it, never the config, and a `logger` that is not an object or lacks one of `debug`, `info`, `warn` and `error`, naming `logger` or `logger.<method>`, since `createAll` logs its own teardown failures through it, apart from any adapter.
- **Every dependency floor moves to the current release, peers included.** `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` now require `^3.1132.0`, the optional `@aws-sdk/client-s3` peer `^3.1132.0` (was `^3.901.0`) and `@langchain/core` `^1.2.11` (was `^1.2.9`); `@langchain/langgraph-checkpoint` stays `^1.1.5`. A consumer pinned below any of these must move up, which is why this is listed as breaking rather than as a routine bump. The CI job that installs every peer at exactly its declared floor and runs the type check and the unit tier against it was re-run against the new floors.
- **`history.listSessions()` returns a page, not an array**: `{ sessions, nextCursor? }`. A caller that used the result directly reads `.sessions`. The old shape could not express paging, and the read behind it was a full-table scan.
- **Numeric options have ceilings.** `indexShards` accepts at most 1024 (on the adapters and on `backfillRecencyIndex`, which must match them), `readConcurrency` 128, `retry.baseDelayMs` and `retry.maxDelayMs` 60 000 ms each, `compression.minSizeBytes`, `compression.maxDecompressedBytes` and `s3.maxDownloadBytes` 512 MiB each, `maxScanItems` 1 000 000 and `maxSearchCandidates` 100 000. A larger value raises `ValidationError` naming the option — at construction, for an adapter. Options that `1.0.0-rc.1` already had carried no upper bound, so a typo such as `s3.maxDownloadBytes: 1e15` was accepted; `indexShards` and `readConcurrency` are new in this release and are bounded from the start, which matters because an indexed listing issues at least one query per shard. Every default is unchanged; the README's *Limits* table lists each default beside its ceiling.
- **Injected collaborators are checked at construction.** `client` must provide `get`, `put`, `delete`, `update`, `query`, `scan`, `batchWrite` and `transactWrite`, so a raw `DynamoDBClient` is refused where a `DynamoDBDocument` belongs; `logger` all four of `debug`, `info`, `warn` and `error`; `serde` `dumpsTyped` and `loadsTyped`; `index.embeddings` `embedQuery` and `embedDocuments`; and `vectorBackend` `upsert`, `query` and `delete`, with `listKeys` still optional. A value that is not an object, or is an array, raises `ValidationError` naming the option, and one missing a method names the first one missing, such as `client.get` or `logger.debug`. A deficient `client`, `logger`, `serde` or `vectorBackend` used to be accepted and fail only when this package first called the missing method. `null` is refused too, where for `client`, `logger` and `serde` it selected the default and for `vectorBackend` it meant none. The check is by shape, not by class, so a second copy of a dependency in the tree still passes. An unusable `index.embeddings`, already refused at construction, is now reported as `index.embeddings` or `index.embeddings.<method>`, in the same wording as the other collaborators, where it was reported as `index`.
- **A read cap must be an integer of at least 1.** `history.listSessions()`'s `maxItems` and `maxIterations` were checked *after* an item was handed out, so a cap of `0` returned one row when the page held one and threw `ResultTruncatedError` after one when it held more — the cap it was given was exceeded either way, and which of the two you got depended on how DynamoDB happened to page. A fraction such as `1.5` passed that check without being an integer, and `null` was read as the default cap. Each is now refused before any read, naming the option; `Infinity` still asks for no cap.
- **A `config` that is not an object raises `ValidationError` naming `config`**, on `saver.getTuple`, `list`, `put`, `putWrites` and `getDeltaChannelHistory`, before any property is read from it. `null` and `undefined` surfaced as an `UpstreamError`, reporting the caller's mistake as an AWS failure, and any other value was read as a config naming no thread, so `list('x')` scanned every thread. A `configurable` that is present but is not an object, `null` included, raises `ValidationError` naming `configurable`, before any identifier is read: it has no `thread_id` to read, so it was taken for a config naming no thread too, and `list({ configurable: 'thread-1' })` scanned every thread while `getTuple` answered `undefined`; `put` and `putWrites` already refused one, but named `thread_id`. `list` reports a bad `config` before a bad `options`. The README records this as V-14.
- **A checkpoint id of `0`, `false` or `NaN` is refused**, whether it arrives as `config.configurable.checkpoint_id` or as the legacy `thread_ts`, naming the field that carried it. It used to address the latest checkpoint silently; only `undefined`, `null` and `''` now mean "no id". A `thread_ts` that is not a string is reported as `thread_ts`, where it was reported as `checkpoint_id`. The README records this as V-15.
- **`saver.list()` checks its `before` and `filter`.** `before`, when given, must be an object — `{}` stays legal — and its `configurable.checkpoint_id` counts as absent only when it is `undefined`, `null` or `''`; anything else is validated as a checkpoint id, naming `before`. A non-string id, or an empty one, made every checkpoint fail the comparison, so the listing came back silently empty, and a malformed one such as `'a#b'` was used as a bound unchecked; an empty id now means no bound, as in the reference. `filter` must be an object and not an array: a non-empty string or array filter compared its indices with metadata fields and also emptied the listing, and a `null` filter, which meant none, is refused as well. The README records these as V-15 and V-16.
- **`saver.put()` and `saver.putWrites()` refuse arguments they cannot read.** A `null` or `undefined` checkpoint raises `ValidationError` naming `checkpoint`. `writes` that is not an array, or holds an entry that is not itself an array, raises one naming `writes`, and the whole array is checked before anything is encoded or written; `writes: []` is still a no-op. Each surfaced as an `UpstreamError`. The README records this as V-17.
- **`saver.getDeltaChannelHistory()` takes exactly `{ config, channels }`**, as the upstream signature declares. A missing or non-object argument, a missing `channels`, `channels` that is not an array of strings, or an extra key raises `ValidationError` naming `options`, `config`, `channels` or `options.<key>`. A missing argument, `config` or `channels` surfaced as an `UpstreamError`, `channels: 'x'` returned a history for a channel named `"x"`, and `channels: [1]` one for `"1"`. `channels: []` still returns `{}`. The README records this as V-18.
- **`store.put()`, `get()`, `delete()` and `listNamespaces()` are checked in this package.** They were inherited from upstream `BaseStore`, whose `put` refuses an empty namespace, a label that is not a non-empty string, a `.` in a label and a `"langgraph"` root by throwing its own `InvalidNamespaceError`, which escaped with no `code`. Each is now overridden and guarded like every other method, and those namespaces raise `ValidationError`: an empty namespace and a `"langgraph"` root name `namespace`, and a label that is not a non-empty string or holds a `.` names `namespace element`. `put(namespace, key, null)` raises `ValidationError` naming `value` instead of deleting the item: `put` is typed to take an object, and a put operation carrying `null` is upstream's encoding of a delete. `delete()` and a `batch()` put operation with `value: null` still delete. `listNamespaces(null)`, which threw a bare `TypeError`, now names `options`. The `.` and `"langgraph"` rules stay `put()`'s alone, as upstream: `get`, `delete`, `search`, `listNamespaces` and every `batch()` operation accept both. The README records the `null` refusal as V-19.
- **Store operations are checked on every route, `batch()` included** — the route LangGraph's `AsyncBatchedStore` takes for every store call a graph makes. A put value that is not an object, or is an array, raises `ValidationError` naming `value`, and an `index` other than absent, `false` or an array of strings names `index`; both used to be written. A search whose `namespacePrefix` is not an array names `namespacePrefix`, where a string answered with an empty page. A listing whose `matchConditions` is not an array, or holds an entry that is not an object, names `matchConditions`. An `operations` argument that is not an array, or an entry that is `null`, not an object or an array, names `operations`, where it surfaced as an `UpstreamError`. The README records these as V-20, V-21 (the search prefix) and V-24.
- **`store.batch()` answers a put or a delete operation with `null`**, as the reference `InMemoryStore` does. It answered with `undefined`. `store.put()` and `store.delete()` still resolve with `undefined`.
- **`store.search()` and `store.listNamespaces()` check their arguments.** `search` refuses a `filter` that is not an object or is an array — a non-empty string or array filter answered with a silently empty page, and a `null` one meant none — and a `query` that is not a string, which was ignored without an index and handed to the embeddings model with one; `query: ''` still ranks nothing. `search` and a `batch()` search operation refuse an `offset` or `limit` of `null`, naming it, where `null` was checked as 0 and then read as the default, so `limit: null` returned a page of up to ten items. `listNamespaces` refuses a `prefix` or `suffix` that is not an array, `null` included, which upstream reads as absent. A label in a search prefix or a listing path that is not a usable key segment — anything but a non-blank string of at most 256 bytes free of `#`, control characters and unpaired surrogates — raises `ValidationError` naming `namespacePrefix element`, `prefix element` or `suffix element`; a number or a `#` there used to answer with a silently empty result. `'*'` stays a listing wildcard, and an empty search prefix still spans every namespace. `reconcileVectorIndex` names a bad prefix `namespacePrefix` or `namespacePrefix element`, as `search` does, where it named `namespace` or `namespace element`. The README records these as V-21, V-22 and V-23.
- **`history.forSession()` checks its arguments when it is called**, and throws `ValidationError` synchronously for a malformed `sessionId`, a window that is not an object or names a key other than `limit` (`window`, `window.<key>`), or a `limit` that is not an integer of at least 1, where it used to return an adapter regardless. Under `RunnableWithMessageHistory`, which calls `getMessageHistory` from inside an async method, the invocation still rejects; code that calls `forSession` outside a promise now gets the exception at that call. Constructing `DynamoDBSessionChatMessageHistory` directly checks the same arguments, and that `backend` provides `getMessages`, `addMessages` and `clear`. An error that backend throws is no longer passed through untouched: one that is not this package's own reaches the caller as `UpstreamError`, with the original as `cause`.
- **History calls no longer report a caller's mistake as an AWS failure.** `getMessages(sessionId, { before: null })` raises `ValidationError` naming `before`, and `addMessages` with `messages` that is not an array names `messages` (`messages: []` is still a no-op); both surfaced as an `UpstreamError`.
- **`backfillRecencyIndex()` checks every option before it reads the table**, naming the option in a `ValidationError`: an unknown key, or options that are not an object; a `tableName` outside DynamoDB's rule, as the adapters check it; a `client` missing `scan` or `update`, the two methods it calls; an `indexShards` that is not an integer from 1 to 1024, the adapters' ceiling; a `pageSize` or `maxPages` that is not an integer of at least 1; a `dryRun` that is not a boolean; a `retry` outside the adapters' numeric bounds, or whose `onRetry`, `isRetryable` or `rng` is not a function, or whose `retryableErrors` is not an array of strings; a `signal` or `retry.signal` that is not `AbortSignal`-shaped; and a `cursor` it did not issue, which must decode to exactly `{ PK, SK }`. A `retry.signal` now cancels the run when no top-level `signal` is given, and when both are given the top-level one wins. `dryRun: "false"` used to read as true, so the run reported success and wrote nothing; a malformed `retry` ended in `RetryExhaustedError`; `null` for a number was read as its default; and options without a usable `client` escaped as a bare `TypeError`. An AWS SDK error the tool does not retry now reaches the caller as `UpstreamError`, with the SDK error as `cause`, where it used to escape unwrapped.
- **`saver.put()` of an existing `checkpoint_id` keeps whichever write *committed* last, where it used to keep whichever landed last.** The transaction is still unconditional, and two distinct calls still race exactly as the reference savers do — each draws a token of its own, so neither deduplicates the other. What changes is the case where the last thing to land is a *retry*: A commits, A's acknowledgement is lost, B commits, A retries. A's retry used to re-land and A won; it is now answered from DynamoDB's idempotency cache, and B's checkpoint survives. "Committed last" is also the better match for what last-writer-wins means in the reference savers, and the README sentence that said "landed" has been corrected.
- **`deleteThread()` and `clear()` delete exactly the rows they read, and refuse one that changed under them.** Both used to delete by key with no condition, twenty-five rows to a `BatchWriteItem`, and release every offloaded object the partition query had seen a row name. Each row now goes out as its own `DeleteItem` conditioned on the per-write id that query observed on it, and a row rewritten between the read and its delete is **refused** rather than removed: it is left exactly as its writer left it, nothing it names is released, it is logged at `warn` with its sort key and counted as skipped, and — for a checkpoint, whose rows are settled `META`, then `PAYLOAD`, then `WRITE` — the rest of that checkpoint's rows are skipped behind it instead of being half-deleted. The old shape erased a write that had already been acknowledged to its author and deleted the object that write had uploaded, so this is strictly safer; it is breaking in two ways. A call that used to report every row gone now reports some skipped, so code that reads `deleteThread`/`clear` as "the partition is empty afterwards" has to re-run once the thread or session is quiescent — the single-pass caveat is unchanged, and refusals join it. And the request cost rises by about **25×**: one request per row where a batch carried twenty-five, so a 10 000-row thread costs roughly 10 000 requests instead of 400, at most 8 of them in flight. There is no cheaper shape — `BatchWriteItem` silently ignores a condition written on a delete request and removes the row anyway. Write capacity for the rows actually deleted is unchanged, since a conditional `DeleteItem` is charged what the unconditional one was and this path sends no transaction; what DynamoDB bills for a *refused* delete is not a figure this project has measured, and the README leaves it unstated rather than quoting one. `BatchWriteAllIncompleteError` from these two calls now counts **rows** rather than chunks, and its message says so. Rows written before this release carry no id and are deleted unconditionally, exactly as every row was, so the guarantee drains in as rows are rewritten rather than needing a migration.
- **A `vectorBackend` search fails when it cannot read a matched item, where it used to return a shorter page.** Every error from the canonical re-read of a match was caught and the match dropped with one `warn`, which the default silent logger never prints — so a throttled, cancelled or otherwise failed read was indistinguishable from an item that had been deleted, and `search()` handed back a page quietly one item short and called it complete. Under throttling that is most of a page, and the caller has no way to tell. The in-DynamoDB path has always failed the search instead, so the two paths disagreed about the same question; they now agree. `RETRY_EXHAUSTED`, `UPSTREAM`, `ABORTED`, `PAYLOAD_CORRUPT` and `S3_OFFLOAD_FAILED` all reach the caller, and so do `FORMAT_UNSUPPORTED` and the `ValidationError` a payload the decode cannot honour raises — an offloaded row read by an adapter with no `s3` configured, a descriptor written by a newer library, an `s3Key` outside the row's own path — which are reads that did not happen rather than items that are not there. One case is unchanged and is the one the drop exists for: a backend returning a key this store cannot address — a namespace element holding the reserved separator — is refused before its read is issued, dropped with that `warn`, and repaired by `reconcileVectorIndex`, because a single bad key must not fail a whole search. Breaking for a caller that treated a short page as the complete answer under load; the remedy is the retry or the report the failure now permits.
- **`store.delete()` reads the row before removing it, and can now resolve without removing it.** It used to send one unconditional `DeleteItem`. It now issues one strongly-consistent read and then a one-item `TransactWriteItems` conditioned on the revision that read observed, carrying a request token and re-pinning from a rejection up to three times. Three consequences are breaking. A delete of a key with **no row** now costs a read and can **fail** where it always succeeded; nothing is written when it does — no row removed, no object released, no vector touched — so "deleting an item that is not there is not an error" now describes the outcome rather than the round trip. Three writes landing at the key, each between a re-pin and its attempt, exhaust the compare-and-swap: the call **resolves with the item still there**, releases nothing — correctly, a live row names the object — and logs one `warn`, where the reference store always removes the item; the README records this as V-29, and the remedy is to re-run once the key is idle. And the call costs more: the removal is a transaction, so it is charged twice the write units a `DeleteItem` was, and the pre-read is a strongly-consistent read charged on the whole row rather than on the attributes it projects. What it stops paying for is the leak it used to have by construction — the object of a delete whose acknowledgement was lost is now released from the pre-read's observation instead of travelling with the lost response — and a put that commits while a key with no row is being deleted now survives, because there is nothing to pin and no write is sent. `store.delete` still takes no `AbortSignal`, and the 300 s write-lifetime deadline covers only the tokened transactions, so the pre-read keeps the full configured retry budget: about three and a half minutes of wall time for the whole call at the defaults, hours at the ceilings `retry` accepts, with nothing able to interrupt it.

### Changed

- **First-write-wins for pending writes survives an upgrade.** A write row written before `writeGroup` existed carries none, and a `Map` cannot tell a key whose value is absent from one whose value *is* `undefined` — so the newer row won, the opposite of the documented contract. The missing group is now normalised at the edge.
- The release gate names the checks it requires instead of comparing "succeeded" to "registered so far", which could publish before the unit matrix, integration, conformance and package smoke had run.
- The dead `overrides.uuid` entry is gone, and the two dev-only advisories (`js-yaml`, `@humanfs/node`) are resolved; `npm audit` reports no vulnerabilities.
- **`docs/STABILITY.md` and `docs/CONTRACTS.md` are gone.** The stability policy now lives in the README as *Versioning and compatibility* — one document to keep current instead of two that could disagree, and the one a consumer already has open. Its table of differences from `MemorySaver`/`InMemoryStore` gained the three the README carried and the policy did not: type-strict range comparison, an array used as a field condition, and key-ordered `search` results. `docs/CONTRACTS.md` was an internal authoring standard, not consumer documentation; the static guard that enforces it (`test/static/export-contracts.test.ts`) is unchanged.
- README corrections where the code had moved on: the store embeds one vector per indexed field and ranks an item by its best-matching one (the *Differences from `InMemoryStore`* list still called the joined single vector a deliberate difference, and still said an empty field condition `{}` matches nothing); the inline-vector size budget is per field, not per item; and the cost table now shows the indexed path for `history.listSessions` and a thread-less `saver.list`. The same list said `$eq`/`$ne`/`$in`/`$nin` compare by deep equality "as upstream does": upstream compares with `===`, so that is a difference and is now recorded as V-25. The options table said a store with a `vectorBackend` or an `index` but not the other throws; only a `vectorBackend` without an `index` does.
- **`limit` errors share one wording**, such as `limit must be >= 1`, where some methods said `limit must be a positive integer`. What each method accepts is unchanged: `saver.list` still answers `0` and below with nothing, history reads and indexed listings still require at least 1, and store paging at least 0.
- **An offloaded write costs two write units per KB instead of one, and more requests on a contended row.** A one-item transaction is charged at twice a `PutItem`'s write capacity. It falls on the offloaded write paths only — an inline write is unchanged, which is why the decision is made per payload rather than per adapter, so a `Send` fan-out of a thousand small inline writes stays at 1× where wrapping every write of an S3-enabled adapter would have doubled it for no durability gain. On a *contended* row an offloaded write also costs about 2.6 requests per logical write, because most attempts come back as retryable transaction conflicts rather than as a clean win-or-lose: measured against DynamoDB, conflicts were 38% of attempts with two writers racing on one row, 65% with five and 86% with twenty, against 0% at every width for the conditional `PutItem` this replaces. The retry budget absorbs them — the same measurement produced 60 clean outcomes and no exhaustion over 60 logical writes at the worst width — so the cost is requests and write units, not failures, and the README says both because sizing a table needs the units and sizing a bill needs the requests.
- **A write that carries a token stops retrying after 300 s**, half the ten minutes DynamoDB honours a token for, whatever `retry` is configured to — so a long policy can now end in `RetryExhaustedError` where it might once have eventually succeeded. `retry: { maxDelayMs: 60000 }` alone already puts the `addMessages` path at 8.7 minutes of nominal backoff. A policy whose nominal worst case exceeds the deadline logs one `warn` at construction naming both numbers rather than being refused, because a long policy is a legitimate choice and the deadline already makes it safe; a deadline cut and a spent budget arrive as the same error, which is what makes saying so at construction worth a line. The deadline is tested before each backoff, so it can refuse to begin the next wait and can never shorten an attempt already in flight — the per-attempt timeout above is the other half of that bound. Nothing else carries it: a read, `store.delete`'s pre-read included, keeps the full configured budget.
- **An inline write can now meet a `TransactionConflictException`.** Because an offloaded write to a row goes out as a transaction while an inline write to the same row stays a `PutItem`, the inline side can be turned away by a conflict it could not see before — 18% of the inline side's attempts under ten-against-ten contention on one row. It is already retryable by name, so it costs requests rather than correctness, but it is a behaviour change on a path that is otherwise untouched, and it is the price of scoping by payload. On an offloaded path, `RetryExhaustedError.cause` can likewise now be a `TransactionCanceledException` whose `CancellationReasons[0].Code` is `TransactionConflict`, where a guard rejection arrives as the same exception with `ConditionalCheckFailed`; both still answer the same handling as before.
- **The README states what each layer does not cover.** It claimed that both the store's concurrent-`put` overwrite race and the checkpointer's special-write overwrite race were "prevented by a compare-and-swap", and listed only leaks as what remained. The compare-and-swap decides *which* payload a write supersedes; it never prevented a lost acknowledgement from re-landing a write, and the races it left are data loss rather than leaks. Both mechanisms are now described for what each does, and *What can still go wrong* lists the rest in one place: the write that outlives the token window, the strand older than the grace window, the inline write that can still re-land, an unversioned bucket, the conflict rates above, the unguarded fallback the store still falls back to, the single-pass partition delete, and the leaks that are unchanged. The sweep's cost is corrected with them — one to two cents per sweep at the worked figure, not "a few dollars" — and so is the conclusion drawn from it: money was never the reason to run it on demand rather than hourly; 40 000 requests against a live table and bucket, most of them strongly-consistent reads on rows a running graph is using, is.

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
