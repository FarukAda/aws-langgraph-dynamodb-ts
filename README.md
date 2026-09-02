# @farukada/aws-langgraph-dynamodb-ts

[![npm version](https://img.shields.io/npm/v/%40farukada%2Faws-langgraph-dynamodb-ts)](https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts)
[![Sponsor](https://img.shields.io/badge/Sponsor-FarukAda-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/FarukAda)
![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![AWS SDK v3](https://img.shields.io/badge/AWS%20SDK-v3-FF9900)

A DynamoDB persistence layer for [LangGraph](https://langchain-ai.github.io/langgraphjs/) in TypeScript (CommonJS build, consumable from both ESM and CommonJS; Node ≥ 22). It provides three LangGraph/LangChain adapters plus a factory:

- **`DynamoDBSaver`** — checkpoint + pending-writes persistence (`extends BaseCheckpointSaver`).
- **`DynamoDBStore`** — long-term memory with optional semantic search (`extends BaseStore`).
- **`DynamoDBChatMessageHistory`** — multi-session chat history, with a single-session adapter for `RunnableWithMessageHistory`.
- **`DynamoDBFactory`** — convenience constructors, including `createAll` (one shared client + a `destroy()`).

Every adapter supports optional **gzip compression**, **S3 offloading** of payloads over DynamoDB's 400 KB item limit, and **TTL-based expiry**. The store additionally supports **vector semantic search** — in-DynamoDB by default, or delegated to a **pluggable `VectorBackend`** (e.g. OpenSearch / pgvector) for large corpora — via any LangChain `Embeddings` implementation.

## Table of Contents

- [Install](#install)
- [Table schema](#table-schema)
- [Quick start](#quick-start)
  - [Checkpointer](#checkpointer)
  - [Store + semantic search](#store--semantic-search)
  - [Chat history](#chat-history)
  - [Factory](#factory)
- [Options](#options)
- [Features](#features)
- [Error handling](#error-handling)
- [Logging](#logging)
- [Infrastructure setup](#infrastructure-setup)
- [IAM permissions](#iam-permissions)
- [Migrating from earlier versions](#migrating-from-earlier-versions)
- [Operations](#operations)
- [Testing](#testing)
- [License](#license)

---

## Install

```bash
npm install @farukada/aws-langgraph-dynamodb-ts \
  @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb \
  @langchain/core @langchain/langgraph @langchain/langgraph-checkpoint
```

Optional peer dependencies, installed only if you use the matching feature:

```bash
# Required only when S3 offloading is enabled
npm install @aws-sdk/client-s3

# Required only for semantic search in the store (any LangChain Embeddings works)
npm install @langchain/aws        # e.g. Bedrock Titan embeddings
```

The build is CommonJS and works from both module systems:

```typescript
import { DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts'; // ESM or TypeScript
const { DynamoDBSaver } = require('@farukada/aws-langgraph-dynamodb-ts'); // CommonJS
```

Node 22 or later is required; the shipped declarations target TypeScript 5.x and later. **Bundling:** the optional `@aws-sdk/client-s3` peer is loaded lazily through a dynamic `import()`, so a bundler (esbuild, rollup, webpack) must either have it installed or mark `@aws-sdk/*` external — CDK's `NodejsFunction` does the latter by default, a bare esbuild build does not.

## Table schema

Every adapter uses the **same simple key schema**: a string partition key `PK`, a string sort key `SK`, and an optional Number `ttl` attribute for expiry. **A single table can back all three adapters**, or you can use a separate table per adapter — your choice via the `tableName` option.

| Attribute | Type | Role |
| --- | --- | --- |
| `PK` | String (HASH) | partition key |
| `SK` | String (RANGE) | sort key |
| `ttl` | Number | (optional) Unix-epoch-seconds expiry; enable DynamoDB TTL on this attribute |

Payloads live under one reserved attribute per row kind (`checkpoint`, `metadata`, `value`, `message`) as a **payload descriptor**: `{ schemaVersion: 1, location: 'INLINE' | 'S3', serdeType, compressed, bytes | s3Key }`. This shape is a compatibility contract: unknown fields are ignored, a missing `schemaVersion` reads as 1, and a higher `schemaVersion` or an unknown `location` is refused with a `ValidationError` (field `descriptor`) rather than misread. Offloaded S3 keys embed the row's identifiers base64url-encoded (`<keyPrefix><enc(thread_id)>/<enc(checkpoint_ns)>/…`), which is trivially reversible — treat S3 keys and `S3_OFFLOAD_FAILED` error context as identifier-bearing in your log-redaction policy.

How each adapter lays out keys (informational — you don't manage this):

- **Checkpointer** — `PK = CHKPT#<thread_id>`; `SK` = `META#<ns>#<checkpoint_id>` (metadata), `PAYLOAD#<ns>#<checkpoint_id>` (checkpoint), `WRITE#<ns>#<checkpoint_id>#<task>#<idx>#<channel>` (pending writes).
- **Store** — `PK = STORE#<namespace[0]>` (the scope root); `SK = <namespace[1..]>#<key>`. This makes a scoped prefix search a native `Query` (`PK = root AND begins_with(SK, …)`); only a rootless "search everything" falls back to a `Scan`.
- **Chat history** — `PK = HIST#<sessionId>`; one item per message at `SK = HISTORY#MSG#<ULID>` (ordered, append-only) plus one `SK = HISTORY#SESSION` metadata item.

**Why the key spaces cannot collide.** Each adapter tags its partition key with its own prefix, and those three tags differ in their very first character, so no `CHKPT#…` can ever equal a `STORE#…` or `HIST#…` — whatever identifiers you pass. That matters because reusing one id across adapters (a "conversation id" used as both a `thread_id` and a `sessionId`) is an entirely ordinary design: without the tags it put unrelated adapters' rows in one partition, where `deleteThread()`/`history.clear()` would delete each other's data and identically-composed sort keys could silently overwrite one another.

Two further guards back that up, for a table holding hand-written rows or rows written before an upgrade: `deleteThread()`/`clear()` delete only rows whose sort key belongs to the calling adapter and log anything they leave in place, and every read narrows a row's shape before decoding it rather than trusting the key it was found at. An offloaded payload's `s3Key` is bound the same way: before it is downloaded or deleted it must lie under the adapter's `keyPrefix` *and* the S3 path the row's own identifiers produce (`enc(thread_id)/…`, `enc(namespace…)/enc(key)`, `enc(sessionId)/…`), and a store row's `namespace`/`key` must agree with the partition and sort key it was found at — so a row planted in one partition can never make the library read or delete another tenant's object. A read of such a row fails with a `ValidationError` (field `s3Key`; chat history treats it as a corrupt message), and a delete skips the object with a warning.

## Quick start

### Checkpointer

```typescript
import { DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts';

const checkpointer = new DynamoDBSaver({
  tableName: 'langgraph',
  clientConfig: { region: 'eu-west-1' },
});

const graph = workflow.compile({ checkpointer });

const config = { configurable: { thread_id: 'user-42' } };
await graph.invoke({ messages: [/* ... */] }, config);

// Resume later (even in a new process) — state is loaded from DynamoDB.
const resumed = await graph.invoke({ messages: [/* ... */] }, config);

checkpointer.destroy(); // releases the client this instance created
```

### Store + semantic search

```typescript
import { DynamoDBStore } from '@farukada/aws-langgraph-dynamodb-ts';
import { BedrockEmbeddings } from '@langchain/aws';

const store = new DynamoDBStore({
  tableName: 'langgraph',
  clientConfig: { region: 'eu-west-1' },
  index: {
    dims: 1024,
    embeddings: new BedrockEmbeddings({ model: 'amazon.titan-embed-text-v2:0', region: 'eu-west-1' }),
    fields: ['text'], // which fields to embed; defaults to the whole document ('$')
  },
});

await store.put(['library'], 'doc-1', { text: 'Amazon DynamoDB is a serverless NoSQL database' });
await store.put(['library'], 'doc-2', { text: 'Espresso is a concentrated coffee' });

// Metadata filtering (operators: $eq, $ne, $gt, $gte, $lt, $lte)
await store.search(['library'], { filter: { type: 'note', score: { $gte: 5 } } });

// Semantic search — ranked by cosine similarity to the query embedding
const hits = await store.search(['library'], { query: 'cloud database', limit: 5 });
//=> doc-1 ranks first, with a `score` on each SearchItem

await store.get(['library'], 'doc-1');
await store.delete(['library'], 'doc-1');
await store.listNamespaces({ prefix: ['library'], maxDepth: 1 });
```

### Chat history

```typescript
import { DynamoDBChatMessageHistory } from '@farukada/aws-langgraph-dynamodb-ts';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

const history = new DynamoDBChatMessageHistory({
  tableName: 'langgraph',
  clientConfig: { region: 'eu-west-1' },
});

await history.addMessages('session-1', [new HumanMessage('Hello!')]);
await history.addMessage('session-1', new AIMessage('Hi!'));
const messages = await history.getMessages('session-1');
const recent = await history.getMessages('session-1', { limit: 20 }); // newest 20, chronological
const sessions = await history.listSessions({ maxItems: 500 }); // [{ sessionId, title, messageCount, expiresAt?, ... }]
await history.clear('session-1');
```

Use it with LangChain's `RunnableWithMessageHistory` via the single-session adapter:

```typescript
import { RunnableWithMessageHistory } from '@langchain/core/runnables';

const withHistory = new RunnableWithMessageHistory({
  runnable: chain,
  getMessageHistory: (sessionId) => history.forSession(sessionId),
  inputMessagesKey: 'input',
  historyMessagesKey: 'history',
});
```

By default a read returns the whole session. `getMessages(sessionId, { limit, before })` returns a window instead — the newest `limit` messages, or only those appended before `before` — and `history.forSession(sessionId, { limit: 50 })` bounds what the adapter feeds the chain to the newest fifty, so a long-lived session does not grow the prompt without limit.

### Factory

`createAll` builds all three adapters on **one shared DynamoDB client** and returns a single `destroy()` that tears everything down.

```typescript
import { DynamoDBFactory } from '@farukada/aws-langgraph-dynamodb-ts';

const factory = new DynamoDBFactory({ clientConfig: { region: 'eu-west-1' } });

const { saver, store, history, destroy } = factory.createAll({
  saver: { tableName: 'langgraph' },
  store: { tableName: 'langgraph', index: { dims: 1024, embeddings } },
  history: { tableName: 'langgraph' },
});

// ... use saver / store / history ...

destroy(); // closes the one shared client
```

Any section may be omitted (`createAll({ store: { tableName } })` returns `saver` and `history` as `undefined`), the factory's own `ttl`, `compression`, `s3`, `retry` and `logger` apply to every adapter unless a section overrides them, and `createSaver`, `createStore` and `createChatMessageHistory` build one adapter each on its own client with the same defaults.

## Options

All adapters share a common base. Provide **either** a prebuilt `client` (which the adapter will not own/close) **or** `clientConfig` (the adapter builds and owns the client).

| Option | Type | Applies to | Notes |
| --- | --- | --- | --- |
| `tableName` | `string` | all | **required** |
| `client` | `DynamoDBDocument` | all | reuse an existing client; not closed by `destroy()`. Construct it with `maxAttempts: 1` (`DynamoDBDocument.from(new DynamoDBClient({ maxAttempts: 1, … }))`): the SDK's own retries are not disabled on an injected client and would stack inside the library's retry budget — a `warn` is logged at construction when they would |
| `clientConfig` | `DynamoDBClientConfig` | all | used to build a client when `client` is omitted |
| `ttl` | `{ days: number }` \| `{ seconds: number }` | all | expiry written to the `ttl` attribute; one form only, capped at five years |
| `logger` | `Logger` | all | per-instance logger (default: silent) |
| `retry` | `{ maxAttempts?, baseDelayMs?, maxDelayMs? }` | all | retry budget and backoff for every DynamoDB call (default 5 attempts, 100 ms base, 5 s cap — see [Retries and backoff](#retries-and-backoff)) |
| `compression` | `CompressionConfig` | all | `{ enabled, minSizeBytes?, level?, maxDecompressedBytes? }` |
| `s3` | `S3OffloadConfig` | all | offload large payloads to S3 (see below) |
| `serde` | `SerializerProtocol` | all | serializer override (checkpointer defaults to LangGraph's; store/history to JSON) |
| `onCorruptMessage` | `'skip' \| 'throw'` | history only | what `getMessages` does with an item it cannot decode (default `skip`: drop it, log at `error`, return the rest) |
| `index` | `IndexConfig` | store only | `{ dims, embeddings, fields? }` for semantic search |
| `vectorBackend` | `VectorBackend` | store only | delegate similarity search to an external index; DynamoDB keeps the canonical item. **Requires `index`** — constructing a store with one and not the other throws |
| `maxSearchCandidates` | `number` | store only | cap for the in-DB ranker before it errors (default 1000) |
| `maxScanItems` | `number` | store only | cap on rows read for one call before it errors (default 10000; counts rows, not namespaces). Gates a plain `search()` page only when the page cannot be filled from fewer rows, semantic candidate collection, `listNamespaces()` and `reconcileVectorIndex()` |
| `vectorScoreDirection` | `'relevance' \| 'distance'` | store only | the direction of the score a `vectorBackend` returns (default `relevance`, higher is better); `distance` negates and re-sorts so a distance-native backend ranks correctly; any other value throws at construction |

`S3OffloadConfig`: `{ bucketName, keyPrefix?, thresholdBytes?, serverSideEncryption?, sseKmsKeyId?, maxDownloadBytes?, clientConfig? }`. `clientConfig` takes an `S3ClientConfig`; it is typed structurally (`S3ClientConfigLike`), so the shipped declarations compile whether or not `@aws-sdk/client-s3` is installed. When `clientConfig.region` is omitted here, the S3 client inherits the adapter's DynamoDB `clientConfig.region` (the S3 SDK does not follow region redirects, so a cross-region bucket otherwise fails with `PermanentRedirect`). `maxDownloadBytes` (default 50 MiB) caps the size of an offloaded object the adapter will buffer from S3 — checked against `ContentLength` before the body is read, and while streaming when the length is unknown — so together with `maxDecompressedBytes` no single payload can claim more memory than you allow. Defaults: `thresholdBytes` 350 KB, `serverSideEncryption` `AES256` (set `'aws:kms'` plus `sseKmsKeyId` for a customer key), `maxDownloadBytes` 50 MiB, and a per-adapter `keyPrefix` under `langgraph-checkpoints/`.

When `keyPrefix` is omitted, each adapter defaults to its own sub-prefix under the shared base (`langgraph-checkpoints/store/`, `langgraph-checkpoints/checkpointer/`, `langgraph-checkpoints/history/`) so that multiple adapters can safely share one bucket — their offloaded object keys and `ensureS3LifecycleRule()` TTL rules never collide. An explicit `keyPrefix` is always honored verbatim, including across adapters if you want them to share one; at that point avoiding a lifecycle-rule collision (e.g. by giving them the same TTL) is your responsibility, same as with any other explicit override. A `keyPrefix` must be a non-empty path ending in `/`: it is also the lifecycle rule's `Filter.Prefix`, so an empty or root prefix would expire the whole bucket and a slash-less one would match sibling prefixes — both are rejected at construction and again by `ensureS3LifecycleRule()`.

## Features

**Gzip compression** — set `compression: { enabled: true }`. Payloads at or above `minSizeBytes` (default 1 KB) are gzipped transparently; the stored descriptor records whether a payload was compressed, so reads never infer it from the bytes, and decompression is guarded against decompression-bomb expansion (`maxDecompressedBytes`, default 50 MiB).

**S3 offloading** — set `s3: { bucketName }`. Any serialized payload at or above `thresholdBytes` (default 350 KB) is written to S3, with only a reference stored in DynamoDB. Only the payload counts toward the threshold: the store's inline embedding (about 10 bytes per dimension, so ~10 KB at 1024 dims and ~45 KB at 4096) is stored on the same item, so keep `thresholdBytes` plus the embedding's size under DynamoDB's 400 KB item limit or the put fails with a raw `ValidationException`; reads rehydrate transparently. Requires the optional `@aws-sdk/client-s3` peer: constructing an adapter with `s3` starts loading it, and a missing package fails the first S3 operation with a `ValidationError` naming the install command — bundlers must keep it installed or external. Deleting a checkpoint thread / chat session also best-effort deletes its offloaded objects. When a `ttl` is also configured, call `ensureS3LifecycleRule()` once (e.g. during deployment) to best-effort install a matching S3 lifecycle expiration rule (logged, never fatal) — this is opt-in rather than automatic, since it requires the broader `s3:PutLifecycleConfiguration` bucket-level permission and is not safe to fire on every adapter construction. If you configure `ttl` + `s3` but never call it, nothing reclaims objects that best-effort cleanup misses — they stay in the bucket until you remove them or add a lifecycle rule yourself. Both the store's concurrent-`put` overwrite race and the checkpointer's *special*-write overwrite race (`__error__`, `__interrupt__`, `__resume__`, `__scheduled__`) are now **prevented** by a compare-and-swap: each overwrite pins the previous descriptor it observed and re-reads on rejection, so it deletes exactly the payload it actually superseded instead of racing another writer for the same one. A leak from either path is now possible only in these residual cases, still backstopped by `ensureS3LifecycleRule()`: the bounded compare-and-swap (3 attempts) is exhausted under pathological contention, which falls back to an unconditional overwrite and logs a `warn`; a best-effort delete genuinely fails; or one double-fault interleaving — a write that loses the swap and then exhausts its transient-error retries on an attempt that actually landed — leaves cleanup targeting the stale descriptor rather than the one it truly superseded, orphaning one object (it never deletes a live object). Separately, and unchanged by any of the above, the checkpointer's *regular* (non-special) writes still resolve a genuine race first-write-wins with no compare-and-swap, so the loser's own upload there remains an orphan reclaimed only by best-effort cleanup and `ensureS3LifecycleRule()`. Likewise, a store `delete` whose acknowledgement is lost after the row was removed cannot learn which object that row referenced — the row is gone and its `ReturnValues` travelled with the lost response — so that one object is left to the lifecycle rule too.

**TTL expiry** — set `ttl: { days }` or `ttl: { seconds }`. The `ttl` attribute is written as a Unix-epoch-seconds timestamp; enable DynamoDB TTL on the `ttl` attribute for automatic deletion. Every adapter filters rows past their `ttl` on read — `get`/`search`/`listNamespaces` in the store, `getTuple`/`list` in the checkpointer, `getMessages`/`listSessions` in chat history — so nothing expired comes back during DynamoDB's sweep lag. For the checkpointer that means a thread whose head expired reads as its newest *live* checkpoint (or as empty), older checkpoints can expire while the head lives (so `parentConfig` may point at a checkpoint that is gone, which LangGraph's resume path does not need), and a swept payload reads as "no checkpoint" only for an already-expired head. Chat history anchors a single **uniform whole-conversation TTL** on the session's metadata row, shared by every message: normally it's set once, at session creation, via `if_not_exists`; but if the previously-stored anchor is ever found missing or already expired (DynamoDB's own TTL sweep can lag up to ~48h), the next append heals it with a plain overwrite instead of staying stuck. Every message written at any point in time shares whatever the current anchor is; expired messages are also filtered out on read. If the append that triggers a stale-anchor heal is itself later rolled back (a later chunk in the same call failed), the healed ttl is not reverted — the session simply keeps the fresher, never-shorter expiry rather than risk regressing a value a concurrent legitimate extension may have since written; this is a deliberate, self-healing tradeoff, not a bug. Turning `ttl` on for a chat-history table that already holds sessions stamps the anchor and every *new* message only; message rows written before that keep no `ttl`, outlive their session row, and still come back from `getMessages` — clear those sessions or backfill a `ttl` onto their rows when enabling expiry retroactively.

**Plain (metadata) search** (store) — a `search()` call with no `query` (or with a `query` but no `index`/`vectorBackend` configured) reads rows under the `namespacePrefix` and decodes them in batches of 8 — applying `filter` in-process — until `offset + limit` matching items are in hand, then stops: the page is the complete answer, so a namespace far larger than the page costs neither a full decode nor a `ResultTruncatedError`. Only a page that cannot be filled from fewer rows is bounded by `maxScanItems` (default 10,000; exceeding it throws rather than silently returning a partial result). This is a different cap from `maxSearchCandidates` below: `maxScanItems` gates rows read, `maxSearchCandidates` gates the in-DB semantic ranker. For namespaces that routinely exceed the default, prefer a `vectorBackend` or a narrower `namespacePrefix` over raising the cap indefinitely.

**Semantic search** (store) — provide `index` with a LangChain `Embeddings` implementation. On `put`, the configured `fields` are embedded; on `search` with a `query`, results are ranked by cosine similarity. By default the embedding is stored on the item and ranking happens in-process over the scoped candidate set (bounded by `maxSearchCandidates`, default 1000 — exceeding it throws a `ValidationError` as soon as more rows than that exist under the prefix, before any row is decoded or the query embedded, steering you to an external index). A `vectorBackend` search that reaches `maxSearchCandidates` while its `filter` has left fewer than `offset + limit` matches throws the same error instead of returning a silently short page. For large corpora, pass a `vectorBackend`: the embedding is sent there instead, similarity search is delegated to it, and DynamoDB still holds the canonical item. Per-item indexing can be overridden via the `index` argument to `put` (`false` to skip, or a `string[]` of fields).

**Vector index consistency** — when a `vectorBackend` is configured, **DynamoDB holds the canonical item** and the backend is a rebuildable index. After each canonical write the embedding is synced to the backend best-effort: a failure is logged (not thrown), so a backend hiccup never fails an otherwise-successful `put`/`delete`. To repair drift, call `store.reconcileVectorIndex(namespacePrefix)` — it re-pushes every live embedding and, when the backend implements the optional `listKeys`, prunes vectors with no canonical item; it returns `{ upserted, pruned }`. Run it when the namespace is idle. Caveats: reconciliation re-embeds with the store's **configured** index fields, so per-`put` field overrides are not reproduced; prune happens only when `listKeys` is implemented (otherwise reconcile re-pushes only and logs that prune was skipped); the prefix must be a non-empty namespace.

**Checkpointer semantics** — `put()` of an existing `checkpoint_id` is last-writer-wins, as in the reference savers: the transaction is unconditional, so two processes writing the same id keep whichever landed last, and the loser's offloaded objects wait for the lifecycle rule. `putWrites` issues one guarded `PutItem` per write, all in parallel, so a `Send` fan-out of a thousand branches is a thousand concurrent puts (fine on on-demand tables; size provisioned capacity accordingly). `deleteThread()` reads the partition once and deletes what it saw: a graph still running on the thread can leave fresh rows behind or recreate one, so call it when the thread is quiescent, and a delete that fails part-way leaves the objects of its already-deleted rows to the lifecycle rule. `list()` without a `thread_id` scans the whole table, like the reference savers.

**Chat history semantics** — message order is the write order of one adapter instance (its ULIDs are strictly monotonic even within a millisecond); across instances or processes it is the writers' wall clocks at millisecond precision, so a process whose clock lags can sort a later turn before an earlier one. The default `serde` is plain JSON: a `Uint8Array`/`Buffer` inside a message (a `ToolMessage.artifact`, say) reads back as an index-keyed object and a `Date` as a string — pass `serde: new JsonPlusSerializer()` from `@langchain/langgraph-checkpoint` for binary and `Date` fidelity. A batch over 99 messages or 3.5 MB is committed in chunks and is atomic from the writer's perspective only: a concurrent reader can see the first chunks before the append settles, and a rolled-back append still bumps the session's `updatedAt`. Under heavy contention on one session an append can spend up to about 61 seconds per chunk in retries (18 attempts, 5 s cap) — three times that when an injected client keeps the SDK's own retries. `clear()` has the same single-pass, quiescent-session caveat as `deleteThread()`.

**Differences from `InMemoryStore`** — the store follows the reference semantics with these deliberate exceptions: one embedding per item (the configured fields are joined and embedded once, where the reference embeds each field and ranks by the best); `$gt`/`$gte`/`$lt`/`$lte` never coerce types (`'10'` does not match `{ $gt: 5 }`), `$eq`/`$ne`/`$in`/`$nin` use deep equality, and an empty field condition `{}` matches nothing; results come back in key order, not insertion order; and the per-item `index` argument of `put` is honoured only on direct `DynamoDBStore` calls — LangGraph's `AsyncBatchedStore`, which wraps the store inside a graph, does not forward it.

**Strong consistency** — checkpointer read-your-writes (`getTuple`) and every `store.get` use `ConsistentRead`, so a value written and immediately read back is never served a stale replica. Bulk reads (`list`, `listNamespaces`, `listSessions`) stay eventually consistent for lower cost.

## Retries and backoff

Every DynamoDB call the library makes runs inside its own retry layer, and that layer is the only one: clients the library constructs disable the SDK's retries (`maxAttempts: 1`), so the numbers below are exact. `list()` without a `checkpoint_ns` covers every namespace of the thread (rows come grouped by namespace, newest first within each); with an explicit namespace, `before` is applied in the key condition so newer rows are never read, and a `checkpoint_id` is fetched directly instead of scanning. An injected `client` that keeps SDK retries stacks them inside each attempt — construct it with `maxAttempts: 1` (a `warn` is logged at construction otherwise).

- **What is retried** — throttling and capacity errors, transaction conflicts, request timeouts, HTTP 429/5xx responses (including ones the SDK cannot map to a modeled exception), errors carrying the SDK's `$retryable` trait, and Node socket errors. Everything else — `ValidationException`, `ConditionalCheckFailedException`, `ResourceNotFoundException`, `AccessDeniedException`, a `TransactionCanceledException` with a permanent reason — is thrown on the first attempt.
- **Schedule** — `retry.maxAttempts` (default 5) attempts with full-jitter exponential backoff from `retry.baseDelayMs` (default 100 ms), doubling per attempt and capped at `retry.maxDelayMs` (default 5 s): about 1.5 s worst case and 0.75 s expected before `RetryExhaustedError`. `addMessages` never uses fewer than 18 attempts (about 61 s worst case), because every concurrent append to one session contends on the same metadata row. `BatchWriteItem` `UnprocessedItems` are re-submitted for up to 10 rounds with the same backoff.
- **Visibility** — every retry is logged at `debug` with the attempt number, the delay about to be slept and the error name; `RetryExhaustedError` carries the last error as `cause` (with the SDK's `$metadata.requestId`) and `context.attempts`.

## Error handling

Every error the library throws extends `DynamoDBLangGraphError` and carries a stable `code` from the `ErrorCode` enum, a structured `context` (`tableName`, `operation`, `field`, `key`, `attempts` — identifiers and counts, never a payload) and a native `cause` chain. Raw AWS SDK errors never escape a public method: each one is wrapped in an `UpstreamError` (`code: 'UPSTREAM'`) that names the operation, keeps the SDK error as `cause`, and copies its `upstreamName`, `requestId` and `httpStatusCode` for logging and support tickets. Branch on `code` and detect library errors with the exported brand check rather than `instanceof`, which breaks when a bundler duplicates the package:

```typescript
import { ErrorCode, isDynamoDBLangGraphError } from '@farukada/aws-langgraph-dynamodb-ts';

try {
  await store.put([''], 'k', { v: 1 });
} catch (error) {
  if (isDynamoDBLangGraphError(error as Error)) {
    if (error.code === ErrorCode.VALIDATION) {  /* bad input: error.context.field names it */ }
    if (error.code === ErrorCode.UPSTREAM) {  /* an AWS error: error.cause, error.requestId */ }
  }
}
```

| `ErrorCode` | Class | Thrown by |
| --- | --- | --- |
| `VALIDATION` | `ValidationError` | every constructor for a bad option; every method for a bad identifier, key, window or value; S3 offload configured without the `@aws-sdk/client-s3` peer; a descriptor the reader cannot honour |
| `UPSTREAM` | `UpstreamError` | every public method, wrapping an AWS SDK error that was not retryable or that the library does not classify (`AccessDeniedException`, `ResourceNotFoundException`, `ValidationException`, …) |
| `RETRY_EXHAUSTED` | `RetryExhaustedError` | every DynamoDB call after `retry.maxAttempts` transient failures (`context.attempts`, the last error as `cause`) |
| `ABORTED` | `AbortError` | any cancellable method whose `AbortSignal` fired |
| `CONDITION_CONFLICT` | `ConflictError` | `history.reconcileMessageCount` when the session changed while it counted |
| `COMPENSATION_FAILED` | `CompensationFailedError` | `history.addMessages` / `addMessage` when a multi-chunk append failed and the rollback of the committed chunks failed too (`rollbackError`; run `reconcileMessageCount`) |
| `BATCH_WRITE_INCOMPLETE` | `BatchWriteAllIncompleteError` | `saver.deleteThread`, `history.clear` when a multi-chunk delete does not fully drain (`succeededCount`, `failedChunks`); `BatchWriteIncompleteError` is the per-chunk error inside it |
| `RESULT_TRUNCATED` | `ResultTruncatedError` | the paginated reads that keep rows in memory — `store.search`, `store.listNamespaces`, `store.reconcileVectorIndex`, `history.listSessions` — past `maxScanItems` / `maxItems` / `maxIterations` |
| `S3_OFFLOAD_FAILED` | `DynamoDBLangGraphError` | an upload, download or delete of an offloaded object that failed after the S3 retries, an object over `maxDownloadBytes`, or an object that no longer exists (`context.key`) |
| `COMPRESSION_LIMIT` | `DynamoDBLangGraphError` | a payload whose decompressed size would exceed `maxDecompressedBytes` |

**Cancellation** — every long-running method takes an `AbortSignal`: the checkpointer reads `RunnableConfig.signal` (which LangGraph propagates) on `getTuple`, `list`, `put` and `putWrites`, and `deleteThread`, `search`, `reconcileVectorIndex`, `getMessages`, `addMessages`, `addMessage`, `clear`, `listSessions` and `reconcileMessageCount` take a trailing `{ signal }`. A signal that is already aborted, or aborts while the library waits (a retry backoff, the next page of a paginated read), rejects the call with the library's `AbortError` (`code: 'ABORTED'`) whatever the abort reason was — the raw reason (a `DOMException` for a bare `controller.abort()`) is kept as `cause`. Cleanup and verification reads that run after a failure are not cancelled, so an abort never strands a live row pointing at a deleted object. Typed subclasses are exported where callers commonly branch: `ValidationError`, `ConflictError`, `RetryExhaustedError`, `BatchWriteIncompleteError`, `BatchWriteAllIncompleteError`, `ResultTruncatedError`, `AbortError`, `CompensationFailedError`.

`CompensationFailedError` is the one error that carries another: the append's original failure is `cause` and the rollback failure is `rollbackError`, which can itself be a `BatchWriteAllIncompleteError`. Check `rollbackError.code` (or `.name`) rather than `instanceof` for the same package-copy reason as above. The session's stored `messageCount` may be wrong at that point; `reconcileMessageCount` repairs it.

### Maintenance operations

Three methods repair or provision state and are meant for deployment scripts and operators, not request paths:

- **`ensureS3LifecycleRule()`** (all three adapters) — installs the S3 lifecycle expiration rule that matches the configured `ttl` under the adapter's key prefix, idempotently. It **throws** when the bucket cannot be read or written (`AccessDenied`, `NoSuchBucket`, throttling) — nothing is swallowed or merely logged — so call it once at deployment time, from a role that holds the two lifecycle actions, and treat a failure as a deployment failure. It is a no-op when `s3` or `ttl` is not configured.
- **`store.reconcileVectorIndex(namespacePrefix)`** — re-pushes every live item's embedding to the configured `vectorBackend` and, when the backend implements `listKeys`, prunes vectors whose item is gone; returns `{ upserted, pruned }`. Run it when the namespace is idle; it reads every row under the prefix (bounded by `maxScanItems`).
- **`history.reconcileMessageCount(sessionId)`** — recounts a session's live messages and rewrites the stored `messageCount`; returns the count. Run it after a `CompensationFailedError` or the `rollback failed` log event, when the session is idle; it throws `ConflictError` if an append lands while it counts.

## Logging

Logging is **per-instance and silent by default** — the library never writes to your console uninvited. Pass any object matching the `Logger` interface (`info`/`warn`/`error`/`debug`):

```typescript
import { redactLogger, type Logger } from '@farukada/aws-langgraph-dynamodb-ts';

const logger: Logger = {
  info: (m, ...a) => console.info(m, ...a),
  warn: (m, ...a) => console.warn(m, ...a),
  error: (m, ...a) => console.error(m, ...a),
  debug: () => {},
};

const store = new DynamoDBStore({ tableName: 'langgraph', logger: redactLogger(logger) });
```

`redactLogger` wraps a logger so secret-looking fields (access keys, tokens, passwords, …) are replaced with `[REDACTED]` in structured log arguments. It also scans **string values, including an error's `message` and `stack`**, for recognisable credential shapes — AWS access key ids, `Bearer` tokens, JWTs, and `password=`/`token=` assignments — replacing just the matched substring so the text stays readable. Pass `extraKeys` to add field names and `extraValuePatterns` to add shapes. `redactSecrets` exposes the same redaction for arbitrary objects.

**What is logged.** Identifiers and counts only: thread, namespace, checkpoint, session and task ids, store namespaces and keys, sort keys, channel names, S3 object keys, attempt and row counts, and the *name* of an underlying error. Never a payload, an embedding, a message body or a credential. `redactLogger` therefore matters most for the application logs around the library; it does not redact identifiers — pass `extraKeys: ['threadId', 'sessionId', 'namespace', 'key', 'sortKey', 's3Key']` when your deployment treats identifiers as personal data.

**Using pino or winston.** `Logger` methods take a message and then structured arguments — at most one plain object per call. winston and `console` accept that shape directly. pino treats a leading string as a format string and drops trailing objects, so merge the arguments into its first parameter:

```typescript
import pino from 'pino';
import type { LogArgument, Logger } from '@farukada/aws-langgraph-dynamodb-ts';

const base = pino();
const fields = (args: LogArgument[]) =>
  Object.assign({}, ...args.filter((arg) => typeof arg === 'object' && arg !== null));
const logger: Logger = {
  info: (message, ...args) => base.info(fields(args), message),
  warn: (message, ...args) => base.warn(fields(args), message),
  error: (message, ...args) => base.error(fields(args), message),
  debug: (message, ...args) => base.debug(fields(args), message),
};
```

**What the library logs.** Nothing until a logger is injected. Every `error` and `warn` below is actionable; the table is generated from the code and a static test fails when a new event is added without a row. `debug` carries retries (`retrying after a transient error`, with the attempt, the delay and the error name), lost-response commits and duplicate pending writes that were skipped.

| Level | Message | Fields | Meaning and what to do |
| --- | --- | --- | --- |
| `error` | `history.addMessages rollback failed; messageCount may have drifted` | `sessionId`, `committedChunks`, `message` | a multi-chunk append failed and its rollback failed too (`CompensationFailedError`); run `reconcileMessageCount` for the session once it is idle |
| `error` | `getMessages: skipped a corrupt message item` | `sessionId`, `sortKey`, `reason` | a message row could not be decoded (or its S3 object is gone) and was dropped under `onCorruptMessage: 'skip'`; inspect or delete the row |
| `warn` | `store.put: compare-and-swap exhausted; overwriting unconditionally` | `namespace`, `key`, `attempts` | three concurrent overwrites of one item; the put succeeded but one S3 object may be orphaned until the lifecycle rule sweeps it |
| `warn` | `putWrites: special-write compare-and-swap exhausted; overwriting unconditionally` | `sortKey`, `channel`, `attempts` | same, for an interrupt/resume/error write written concurrently for one task |
| `warn` | `Some orphaned S3 objects could not be deleted after` | `failedCount` | objects leaked after a failed write or a delete; `ensureS3LifecycleRule()` reclaims them, otherwise clean up by prefix |
| `warn` | `Failed to clean up orphaned S3 objects after` | `message`, `keys` | the cleanup itself failed after retries; same remedy |
| `warn` | `: refusing to delete an S3 object outside this row's scope` | `key` | a row referenced an object outside its own key path — a tampered or foreign row; the object was left alone, investigate the writer |
| `warn` | `store.put vector-index sync failed; reconcileVectorIndex will repair` | `namespace`, `key`, `message` | the `vectorBackend` rejected an upsert or delete; the canonical item is fine, run `reconcileVectorIndex` when convenient |
| `warn` | `injected DynamoDB client keeps the SDK's own retries` | `maxAttempts` | construct the injected client with `maxAttempts: 1` unless you want the SDK's retries to stack inside the library's budget |
| `warn` | `putWrites: write row held by an unexpected channel; write not persisted` | `sortKey`, `expected`, `found` | another writer holds this task's row for a different channel; only this library should write the key space |
| `warn` | `history.addMessages compensating committed chunks after a chunk failed` | `sessionId`, `committedChunks` | a large append is being rolled back; the caller receives the original error |
| `warn` | `list: scanned a large number of rows without the caller stopping` | `threadId`, `checkpointNs`, `scanned` | a `list()` walked over 10 000 rows; pass `limit` or narrow the filter |
| `warn` | `getTuple: a checkpoint carries very many pending-write rows; the read is complete but slow` | `threadId`, `checkpointId`, `rows` | over 10 000 pending writes on one checkpoint (a huge fan-out or many retried tasks); the read is correct |
| `warn` | `search: some candidates carry an embedding of a different dimension than the query` | `namespacePrefix`, `count` | items embedded with another model or `dims`; re-put them or run `reconcileVectorIndex` |
| `warn` | `search: vectorBackend returned ascending scores; VectorMatch.score must be a relevance` | `namespacePrefix` | the backend reports distances; set `vectorScoreDirection: 'distance'` |
| `warn` | `search: skipped an unusable vectorBackend match` | `namespace`, `key` | the backend returned a key this store cannot address; run `reconcileVectorIndex` |
| `warn` | `: left a foreign row in place` | `sortKey` | `deleteThread`/`clear` found a row another adapter owns in the partition and kept it |
| `warn` | `list: skipped a row that is not a checkpoint meta item` | `sortKey` | a foreign row shares the `META#` prefix on a shared table |
| `warn` | `getTuple: skipped a row that is not a checkpoint meta item` | `sortKey` | same, on the read-your-writes path |
| `warn` | `store.get: ignored a row that is not a store item` | `namespace`, `key` | a foreign row at a store key |
| `warn` | `reconcileVectorIndex: skipped a row that is not a store item` | `sortKey` | same, during reconciliation |
| `info` | `: deleted rows` | `deleted`, `skipped` | `deleteThread`/`clear` finished |
| `info` | `reconcileVectorIndex prune skipped: backend has no listKeys` | `prefix` | the backend cannot enumerate vectors, so stale ones were not pruned |
| `info` | `reconcileVectorIndex: kept a vector whose item reappeared` | `namespace`, `key` | an item was written while pruning; nothing to do |

## Infrastructure setup

One table backs all three adapters. Create it with **AWS CDK** or **Terraform**.

<details>
<summary><strong>AWS CDK (TypeScript)</strong></summary>

```typescript
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

new dynamodb.Table(this, 'LangGraph', {
  tableName: 'langgraph',
  partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'ttl', // optional; only needed if you use the `ttl` option
});
```

</details>

<details>
<summary><strong>Terraform</strong></summary>

```hcl
resource "aws_dynamodb_table" "langgraph" {
  name         = "langgraph"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute { name = "PK" type = "S" }
  attribute { name = "SK" type = "S" }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}
```

</details>

## IAM permissions

Transactional writes are authorised by the item-level actions they carry — there is no `TransactWriteItems` action to grant — and the library never calls `BatchGetItem`. A least-privilege policy for one table:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LangGraphItems",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:BatchWriteItem"
      ],
      "Resource": "arn:aws:dynamodb:<region>:<account>:table/langgraph"
    },
    {
      "Sid": "LangGraphTableScans",
      "Effect": "Allow",
      "Action": ["dynamodb:Scan"],
      "Resource": "arn:aws:dynamodb:<region>:<account>:table/langgraph"
    }
  ]
}
```

`LangGraphTableScans` is needed only by the four table-wide reads — a rootless `store.search([])`, `store.listNamespaces()` without a concrete prefix root, `history.listSessions()`, and `saver.list()` without a `thread_id`. Every other operation is a `GetItem`, a partition `Query` or a write. Leave the statement out of any role that must not read across tenants (see below).

When S3 offloading is enabled, the role also needs the object actions under the configured key prefix (`langgraph-checkpoints/` by default; adjust when `keyPrefix` is set) and, only for the deployment-time `ensureS3LifecycleRule()` call, the two lifecycle actions on the bucket itself:

```json
{
  "Sid": "LangGraphS3Objects",
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::<bucket>/langgraph-checkpoints/*"
},
{
  "Sid": "LangGraphS3Lifecycle",
  "Effect": "Allow",
  "Action": ["s3:GetLifecycleConfiguration", "s3:PutLifecycleConfiguration"],
  "Resource": "arn:aws:s3:::<bucket>"
}
```

With `serverSideEncryption: 'aws:kms'` the role additionally needs `kms:GenerateDataKey` (uploads) and `kms:Decrypt` (downloads) on the key. Semantic search through Bedrock embeddings needs `bedrock:InvokeModel` on the model. A static test (`test/static/iam-actions.test.ts`) keeps the DynamoDB and S3 actions above equal to the calls the code makes.

### Multi-tenant deployments

Isolation is anchored on the identifiers you choose. The library composes keys safely and never lets one adapter's rows collide with another's, but it does nothing to scope a read to a tenant: put the tenant first in every `thread_id`, `sessionId` and store namespace (`namespace[0]`), with a delimiter other than the reserved `#` (`acme/thread-7`, `acme:session-1`, `['acme', 'users', 'u1']`). Every checkpointer and chat-history operation, and every store operation with a concrete namespace prefix, then touches only that tenant's partitions.

Four operations are table scans and return **every tenant's** rows by construction: `store.search([])`, `store.listNamespaces()` without a prefix root, `history.listSessions()` and `saver.list()` without a `thread_id`. Treat them as administrative. `listSessions()` also returns each session's `title`, which is derived from the first human message — user content.

Tenancy can be enforced at the IAM layer with `dynamodb:LeadingKeys`, because every partition key starts with the adapter tag and then the identifier. A role for tenant `acme` grants the item actions with a key condition and omits `dynamodb:Scan` entirely (`LeadingKeys` does not apply to scans, so a role that may scan can read every tenant):

```json
{
  "Sid": "LangGraphTenantAcme",
  "Effect": "Allow",
  "Action": [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:Query",
    "dynamodb:BatchWriteItem"
  ],
  "Resource": "arn:aws:dynamodb:<region>:<account>:table/langgraph",
  "Condition": {
    "ForAllValues:StringLike": {
      "dynamodb:LeadingKeys": ["CHKPT#acme/*", "STORE#acme", "HIST#acme/*"]
    }
  }
}
```

For the store the tenant must be the whole first namespace element (`STORE#acme`), since the partition key is exactly `STORE#<namespace[0]>`; the checkpointer and history patterns match any identifier under the tenant prefix. Offloaded S3 objects can be scoped the same way with an object-key condition on `arn:aws:s3:::<bucket>/langgraph-checkpoints/<adapter>/<base64url tenant prefix>*`, or by giving each tenant its own `keyPrefix`.

## Migrating from earlier versions

**0.7.x → 0.8.0**: **every adapter's partition key is now adapter-tagged** —
`PK = <thread_id>` → `CHKPT#<thread_id>`, `PK = <namespace[0]>` →
`STORE#<namespace[0]>`, `PK = <sessionId>` → `HIST#<sessionId>` — and the
checkpointer's pending-write sort key gains a trailing channel segment
(`WRITE#<ns>#<id>#<task>#<idx>` → `…#<idx>#<channel>`).

This closes two real defects on a table shared via `createAll()`. Reusing one
identifier across adapters — a "conversation id" used as both a `thread_id`
and a `sessionId`, an entirely ordinary choice — put unrelated adapters' rows
in a single partition, where `deleteThread()` silently deleted the chat
history (and vice versa), and identically-composed sort keys let one adapter
overwrite another's item or hand its payload back on read. The channel segment
separately stops a retried task whose write mix changed from silently losing a
write; a per-call write group, also stored on each row, keeps such a retry from
replaying a channel twice. See the CHANGELOG for the full mechanism.

**Data written by 0.7.x is not found after upgrading**, for all three
adapters. Back up and recreate the table before upgrading.

Three behaviour changes are also worth checking before you upgrade:
constructing a `DynamoDBStore` with a `vectorBackend` but no `index` now
throws instead of silently returning unranked results; `getMessages` skips and
logs an undecodable message instead of failing the whole read (pass
`onCorruptMessage: 'throw'` to keep the old behaviour); and the store's
`$gt`/`$gte`/`$lt`/`$lte` filters no longer coerce across types, so a stored
`'10'` no longer matches `{ $gt: 5 }`.

**0.6.x → 0.7.0**: chat-history's sort keys now carry a `HISTORY#` item-kind
tag — `SK = SESSION` → `SK = HISTORY#SESSION`, `SK = MSG#<ULID>` →
`SK = HISTORY#MSG#<ULID>`. This closes a real key collision on a table
shared via `createAll()`: an unprefixed `SESSION` sort key was reachable by
an ordinary store call (`store.put([sessionId], 'SESSION', …)`), silently
corrupting both adapters' items. Existing chat history data written before
this change will not be found by `getMessages`/`listSessions`/`clear` after
upgrading — back up and migrate (or recreate) any table with real
chat-history data before upgrading. Checkpointer and store keys are
unaffected.

**0.2.x → 0.3.0** is a complete, ground-up rewrite. The public API is similar, but the table schema, on-disk layout, and several options changed, so existing data is **not compatible** — create a new table.

- **Table schema is now `PK`/`SK` strings** (one table for all adapters) instead of per-adapter custom key names. The key attribute names changed, so CDK/Terraform definitions need updating.
- **Store keys** are `PK = namespace[0]`, `SK = namespace[1..]#key` (was `PK = full namespace`, `SK = key`).
- **Chat history is one item per message** (`SK = MSG#<ULID>`) plus a `SESSION` metadata item, replacing the single per-session item.
- **Single `tableName` option** per adapter (was `checkpointsTableName`/`writesTableName`, etc.).
- **One `ttl` option** — `{ days }` or `{ seconds }` — replaces `ttlDays`/`ttlSeconds`.
- **S3 config option renamed** `s3OffloadConfig` → `s3`.
- **Per-instance `logger` option** replaces the global `setGlobalLogger` singleton; default logging is now silent.
- **Unified error model** — all errors extend `DynamoDBLangGraphError` with an `ErrorCode`.

## Production notes

- **Sharing one table** across all three adapters is supported — adapter-tagged partition keys make the key spaces provably disjoint (see [Table schema](#table-schema)), and table-wide reads filter to their own items. Checkpointer, chat-history, and *scoped* store reads are all partition-scoped (`Query`/`GetItem`).
- **Scoped reads are `Query`s.** `store.search`/`store.listNamespaces` with a concrete namespace prefix and `history.getMessages` are native `Query`s. Only a rootless `store.search([])` / unprefixed `listNamespaces`, `history.listSessions` and a `saver.list()` called without a `thread_id` (which, like the reference savers, lists every thread in the table) fall back to `Scan` (cost scales with table size, and the result spans every tenant) — keep those rare or use a dedicated table. `listSessions` accepts an optional `{ maxIterations }` override for tables where non-session rows dominate the scan.
- **One S3 GET per offloaded payload per read.** Every offloaded row a read touches (`getTuple` pending writes, a plain `search()` applying its filter, `getMessages`) costs one S3 GET, and the returned bytes are decoded in memory. Reads decode up to 8 offloaded payloads at a time rather than one after another, but the request count is still linear in the offloaded row count — keep `thresholdBytes` high and compression on so that few payloads offload, and prefer a `vectorBackend` over the in-DB ranker for large semantic corpora.
- **Hot partitions.** The store's partition key is `STORE#<namespace[0]>` and chat history's is `HIST#<sessionId>` — the adapter tag is constant, so throughput still concentrates on the identifier you choose. A single partition tops out around ~1000 WCU / 3000 RCU, so avoid funneling very high write throughput through one tenant/session id; spread load across scope roots (e.g. include a tenant id as `namespace[0]`).
- **Identifier rules.** Every caller-supplied identifier (thread_id, checkpoint_ns, checkpoint_id, taskId, sessionId, store namespace elements and keys, pending-write channels) is validated before it reaches DynamoDB: it must be a non-blank string with no control characters and no reserved `#`, at most 1024 bytes of UTF-8 for the partition identifiers (`thread_id`, `sessionId`) and 256 bytes for every sort-key segment (an empty `checkpoint_ns` is legal, it is the root namespace). Composed keys are checked too: a store namespace + key, or a checkpointer pending-write key, may not exceed DynamoDB's 1024-byte sort-key cap, and an offloaded S3 object key may not exceed S3's 1024 bytes. A violation is a `ValidationError` whose `context.field` names the offending value, thrown before any request is sent.
- **Very large vector corpora** outgrow the in-DB ranker (`maxSearchCandidates`). Configure a `vectorBackend` (OpenSearch, pgvector, …) — the library keeps DynamoDB as the source of truth and only delegates similarity ranking.
- **TTL deletion timing** is governed by DynamoDB (typically within 48 h of expiry) and S3 lifecycle expiry is day-granular — the library writes the correct expiry timestamp (and filters expired chat messages on read) but does not guarantee instant deletion. The matching S3 lifecycle rule is not written automatically: it is installed only when you call `ensureS3LifecycleRule()`. That rule expires objects `ceil(ttl in days) + 2` days after creation — the two-day margin covers DynamoDB's sweep lag so an object never disappears before its row — and also expires noncurrent versions after the same number of days, so a versioned bucket does not retain every superseded payload forever (on such buckets the library's best-effort deletes only add delete markers). `ensureS3LifecycleRule()` is a read-modify-write of the bucket's whole lifecycle configuration: call it sequentially across adapters and deployers, never concurrently.

## Operations

### Limits

| Limit | Value | Where it bites |
| --- | --- | --- |
| DynamoDB item size | 400 KB | a payload over `thresholdBytes` (default 350 KB) must offload to S3; without `s3` a serialized payload over 392 KB is refused with a `ValidationError` before the write |
| Partition identifiers (`thread_id`, `sessionId`) | 1024 bytes UTF-8 | `ValidationError` |
| Sort-key segments (`checkpoint_ns`, `checkpoint_id`, `taskId`, channel, store namespace element, store `key`) | 256 bytes each, 1024 bytes composed | `ValidationError` |
| S3 object key | 1024 bytes | identifiers are base64url-encoded into it, so long ids reach it first |
| `ttl` | 5 years | `ValidationError` at construction |
| Chat-history append transaction | 99 messages or 3.5 MB per chunk | larger batches are split into chunks with caller-observed atomicity |
| Delete batches | 25 rows per `BatchWriteItem`, `UnprocessedItems` re-driven up to 10 times | `BatchWriteAllIncompleteError` |
| Rows held in memory by a listing (`maxScanItems`, `listSessions({ maxItems })`) | 10 000 | `ResultTruncatedError` |
| Pages walked by a listing (`listSessions({ maxIterations })`) | 1000 | `ResultTruncatedError` |
| In-DB semantic candidates (`maxSearchCandidates`) | 1000 | `ValidationError` |
| Decompressed payload (`maxDecompressedBytes`) and buffered S3 object (`maxDownloadBytes`) | 50 MiB each | `COMPRESSION_LIMIT` / `S3_OFFLOAD_FAILED` |
| Retries per DynamoDB call (`retry.maxAttempts`) | 5 (about 1.5 s worst case); message appends 18 (about 61 s) | `RetryExhaustedError` |
| Offloaded payloads decoded concurrently by one read | 8 | latency, not an error |

### What each operation costs

Requests per call, before retries. "Consistent" reads are `ConsistentRead: true` (twice the read units of an eventually consistent read); S3 requests apply only to offloaded payloads.

| Operation | DynamoDB | S3 |
| --- | --- | --- |
| `saver.getTuple` | 1 consistent `GetItem` (by id) or `Query` (newest) for the META row, 1 consistent `GetItem` for the payload, 1 consistent `Query` for the pending writes; a pre-v4 checkpoint adds a `Query` of its parent's writes | 1 `GET` per offloaded payload, 8 at a time |
| `saver.put` | 1 `TransactWriteItems` (META + PAYLOAD); 1 consistent `GetItem` of the parent META when `newVersions` leaves channels to carry over; verification reads only after a failure | 1 `PUT` per offloaded payload |
| `saver.putWrites` | 1 guarded `PutItem` per write, all in parallel; with `s3` each special write adds 1 consistent `GetItem` and up to 3 compare-and-swap attempts | 1 `PUT` per offloaded write, `DELETE` of a superseded special write |
| `saver.list` | 1 eventually consistent `Query` per page (or `Scan` without a `thread_id`); per yielded tuple 1 `GetItem` and 1 `Query` for its writes | `GET` per offloaded payload and metadata |
| `saver.deleteThread`, `history.clear` | 1 consistent `Query` per page, 1 `BatchWriteItem` per 25 rows | 1 `DeleteObjects` per 1000 keys |
| `store.get` | 1 consistent `GetItem` | 1 `GET` |
| `store.put` | 1 consistent `GetItem` (previous descriptor and revision), 1 guarded `PutItem` (up to 3 attempts under contention, each re-reading from the rejection), plus the `vectorBackend` upsert | 1 `PUT`, then `DELETE` of the superseded object |
| `store.delete` | 1 `DeleteItem` returning the old row, plus the `vectorBackend` delete | `DELETE` of the removed object |
| `store.search` | 1 eventually consistent `Query` per page (`Scan` for `[]`), reading rows in batches of 8 until the page is full; a `query` adds one embedding call | 1 `GET` per offloaded candidate |
| `store.listNamespaces` | key-only `Query` (`Scan` without a prefix root) per page | none |
| `history.addMessages` | 1 consistent `GetItem` of the session row when `ttl` is set, then 1 `TransactWriteItems` per chunk (up to 99 messages plus the session update); a rollback costs 1 `BatchWriteItem` per 25 rows plus a session update | 1 `PUT` per offloaded message |
| `history.getMessages` | 1 consistent `Query` per page (newest-first with a page cap under `limit`) | 1 `GET` per offloaded message, 8 at a time |
| `history.listSessions` | 1 `Scan` per page | none |
| `history.reconcileMessageCount` | `Query` (`Select: COUNT`) per page, 1 guarded `UpdateItem` | none |
| `store.reconcileVectorIndex` | 1 `Query` per page, embedding calls in batches, backend upserts and deletes | `GET` per offloaded item |

### Monitoring

Alert on the two `error` events (a corrupt message row, a failed append rollback) and on the four `warn` events that name an orphan or an exhausted compare-and-swap (see [Logging](#logging)); count `RetryExhaustedError` and `UpstreamError` by `context.operation` and `httpStatusCode`. `RetryExhaustedError.context.attempts` and every `debug` retry line carry the SDK `requestId` of the last failure for AWS Support. Watch the table's `ThrottledRequests` and `ConsumedWriteCapacityUnits` per partition key prefix — the [hot-partition](#production-notes) note explains which identifier concentrates load.

### Lambda and other short-lived runtimes

Construct the adapters once at module scope (or one `DynamoDBFactory.createAll()`), reuse them across invocations, and pass a `client` you own if the function also uses DynamoDB elsewhere; `destroy()` is only needed when a process wants to release sockets before exit. Size the function timeout against the worst-case retry budgets above: a heavily contended chat append can take about a minute, and `retry.maxAttempts` / `retry.maxDelayMs` trade that ceiling against resilience to throttling. Every long-running method takes an `AbortSignal`, so a timeout can cancel cleanly (see [Error handling](#error-handling)).

### Multi-tenancy

See [Multi-tenant deployments](#multi-tenant-deployments) under IAM permissions for the identifier convention, the table-scan operations that are cross-tenant by construction, and the `dynamodb:LeadingKeys` policy.

## Testing

```bash
npm test            # unit + static-guard + type tests, 100% coverage
npm run typecheck
npm run lint
npm run build
```

Integration and contract tiers run against DynamoDB Local (Docker) and are kept out of the default `npm test`:

```bash
npm run test:integration:up     # docker compose up -d (DynamoDB Local)
npm run test:integration        # integration flows + LangGraph/LangChain contract conformance
npm run test:integration:down
```

The real-AWS tier runs the same adapters against real DynamoDB, S3 and Bedrock. Every suite creates and tears down its own uniquely named table and bucket (`aws-langgraph-<suite>test-<uuid>`) in the account of the default credential chain; CI runs it nightly through OIDC, and it runs on demand:

```bash
npm run test:aws                # needs AWS credentials; AWS_REGION selects the region
```

The `examples/live-*.mjs` scripts are demos that leave a table in place for inspection in the console; they are not a test tier.

### What the suite does and does not prove

| Tier | Runs | Proves |
| --- | --- | --- |
| Unit, static guards, type locks, property tests (`npm test`) | every push and PR, three OSes × Node 22 and 24 | every code path (100 % coverage), the repository rules (file size, JSDoc-only comments, no `any`/`unknown`/`instanceof`, no re-exports, no import cycles, no dead error codes), the exact public export set and adapter signatures, the stated invariants (sort-key order, item-size estimate, write resolution, redaction, backoff) |
| Integration (`npm run test:integration`, DynamoDB Local) | every push and PR | end-to-end adapter flows and fault injection; the write races the compare-and-swap exists for, with an in-memory S3 in the loop; the DynamoDB semantics the unit mocks assume; parity with `InMemoryStore` and `InMemoryChatMessageHistory` under `RunnableWithMessageHistory`; a 30-way single-session append storm |
| Conformance (`npm run test:conformance`, DynamoDB Local) | every push and PR, against the declared floor and the latest `@langchain/langgraph-checkpoint` | a compiled LangGraph graph over the saver (interrupt/resume, subgraph namespaces, forks, history windows, crash-and-resume, `Send` fan-out) and LangChain's official checkpointer validation suite |
| Package smoke (`npm run test:package-smoke`) | every push and PR | the packed tarball installs and imports without the optional S3 peer, and its declarations type-check without it |
| Real AWS (`npm run test:aws`) | nightly through OIDC | S3 offload, lifecycle rules and the S3 error taxonomy against the real services; real 30-way append contention; Bedrock embeddings (skipped with a reason when the model is not enabled) |

Nothing in the suite provokes real throttling or `ProvisionedThroughputExceededException` (only its classification is tested), receives `UnprocessedItems` from a batch write (DynamoDB Local and on-demand tables never return them), observes DynamoDB's TTL sweep (only the stamped attribute is asserted), uses a versioned bucket, exercises a hot partition, or measures the write capacity the compare-and-swap fallback consumes. An injected `client` that keeps the SDK's own retries multiplies the library's attempt budget; the integration tier pins that count once and every adapter warns about it at construction.

## License

MIT © [Faruk Ada](https://github.com/FarukAda)

---

<p align="center">
  Built with <a href="https://langchain-ai.github.io/langgraphjs/">LangGraph</a> · <a href="https://aws.amazon.com/sdk-for-javascript/">AWS SDK v3</a> · <a href="https://github.com/langchain-ai/langchainjs">LangChain</a>
  <br/>
  <a href="https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts">npm</a> · <a href="https://github.com/FarukAda/aws-langgraph-dynamodb-ts">GitHub</a> · <a href="https://github.com/FarukAda/aws-langgraph-dynamodb-ts/issues">Issues</a>
</p>
