# @farukada/aws-langgraph-dynamodb-ts

[![npm version](https://img.shields.io/npm/v/%40farukada%2Faws-langgraph-dynamodb-ts)](https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts)
[![CI](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/actions/workflows/ci.yml)
[![CodeQL](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/actions/workflows/codeql.yml/badge.svg)](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/FarukAda/aws-langgraph-dynamodb-ts/badge)](https://scorecard.dev/viewer/?uri=github.com/FarukAda/aws-langgraph-dynamodb-ts)
![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![AWS SDK v3](https://img.shields.io/badge/AWS%20SDK-v3-FF9900)
[![npm provenance](https://img.shields.io/badge/npm-provenance-2ea44f?logo=npm)](https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts#provenance)
![coverage 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)
[![Sponsor](https://img.shields.io/badge/Sponsor-FarukAda-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/FarukAda)

Built with [LangGraph](https://langchain-ai.github.io/langgraphjs/) · [LangChain](https://github.com/langchain-ai/langchainjs) · [AWS SDK v3](https://aws.amazon.com/sdk-for-javascript/) — [npm](https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts) · [GitHub](https://github.com/FarukAda/aws-langgraph-dynamodb-ts) · [Issues](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/issues)

---

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
- [Retries and backoff](#retries-and-backoff)
- [Error handling](#error-handling)
- [Logging](#logging)
- [Infrastructure setup](#infrastructure-setup)
- [IAM permissions](#iam-permissions)
- [Migrating from earlier versions](#migrating-from-earlier-versions)
- [Versioning and compatibility](#versioning-and-compatibility)
- [Production notes](#production-notes)
- [Operations](#operations)
- [Testing](#testing)
- [Support and policies](#support-and-policies)
- [License](#license)

---

## Install

```bash
npm install @farukada/aws-langgraph-dynamodb-ts \
  @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb \
  @langchain/core @langchain/langgraph-checkpoint
# plus @langchain/langgraph itself, which your application already depends on
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
| `gsi1pk` | String | (optional) recency-index partition key; written to the rows that listings cross partitions for — checkpointer `META`, store items, history `SESSION` |
| `gsi1sk` | String | (optional) recency-index sort key, `<updatedAt>#<id>` |

Those two index attributes are always written; they cost nothing until the table
carries a global secondary index on them and an adapter is told its name with
`indexName`. Without it every listing behaves exactly as before, so upgrading
changes nothing until you create the index — see
[Infrastructure setup](#infrastructure-setup) for the definition and
[Maintenance operations](#maintenance-operations) for the backfill that must run
first.

Payloads live under one reserved attribute per row kind (`checkpoint`, `metadata`, `value`, `message`) as a **payload descriptor**: `{ schemaVersion: 1, location: 'INLINE' | 'S3', serdeType, compressed, bytes | s3Key }`. This shape is a compatibility contract: unknown fields are ignored, a missing `schemaVersion` reads as 1, and a higher `schemaVersion` or an unknown `location` is refused with a `ValidationError` (field `descriptor`) rather than misread. Offloaded S3 keys are `<keyPrefix><the row's identifiers, each base64url-encoded>/<write id>.bin` (for a history message, whose own ULID is the write id, the identifiers above it are its session) — the row above the id, so an object belongs to exactly one row, and below it the id of the write that uploaded it, so two writes never share an object, even when they store the same bytes. The identifier segments are trivially reversible — treat S3 keys and `S3_OFFLOAD_FAILED` error context as identifier-bearing in your log-redaction policy.

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
// { sessions: [{ sessionId, title, messageCount, expiresAt?, ... }], nextCursor?: string }
const page = await history.listSessions({ limit: 50 });
const next = page.nextCursor ? await history.listSessions({ cursor: page.nextCursor }) : undefined;
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

`forSession` checks its arguments when it is called: a malformed session id, a window naming a key other than `limit`, or a `limit` that is not an integer of at least 1 throws `ValidationError` synchronously, rather than returning an adapter that fails on first use. `RunnableWithMessageHistory` calls `getMessageHistory` from inside an async method, so there the throw surfaces as a rejected invocation.

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

The argument of each `create*` method, and each `createAll` section, is one adapter's options, and a mistake in it is named the way that adapter's constructor names it: `options` for a value that is not an object — `null` included, so a `null` section is refused rather than skipped — and `options.<key>`, `tableName` and so on for one inside it. `createAll` also refuses a key other than `saver`, `store` and `history`, naming `options.<key>`. The factory's own options are checked when it is constructed: options that are not an object, an unknown key, a `client` beside a `clientConfig`, a `clientConfig` that is not an object, and a `logger` missing one of its four methods, since `createAll` logs its own teardown failures through it. Its `ttl`, `compression`, `s3` and `retry` are checked by each adapter that inherits them, since an adapter's own options may replace them.

## Options

All adapters share a common base. Provide **either** a prebuilt `client` (which the adapter will not own/close) **or** `clientConfig` (the adapter builds and owns the client).

Options are checked at construction, and a mistake raises `ValidationError` naming the option:

- **Unknown keys.** An option key the adapter does not read — a misspelling such as `readConcurency`, or an option that belongs to another adapter, such as `vectorBackend` on a saver — is refused, naming `options.<key>`, including in a `DynamoDBFactory` section. So is a key `ttl`, `retry`, `compression`, `s3` or `index` does not read (`ttl.<key>`, `index.<key>`, …): `ttl` takes only `days` or `seconds`, and `index` only `dims`, `embeddings` and `fields`.
- **AWS SDK configuration.** `clientConfig` and `s3.clientConfig` must be objects when given, so a string, `null` or an array is refused, naming `clientConfig` or `s3.clientConfig`. The keys inside them are passed to the AWS SDK unchecked: they belong to the SDK's `DynamoDBClientConfig` and `S3ClientConfig`, which gain keys between SDK releases, and your application may install a newer SDK than the one this package was built against, so a key list checked here would refuse valid configuration.
- **Collaborators.** `client`, `logger`, `serde`, `index.embeddings` and `vectorBackend` are checked by shape, not by class, so the check holds when two copies of a dependency are installed. A value that is not an object (`null` included) names the option; an object missing a method this package calls names the first one missing, such as `client.get` or `logger.debug`.
- **Ceilings.** A numeric option above its ceiling is refused. The ceilings are in the table below and in [Limits](#limits).

| Option | Type | Applies to | Notes |
| --- | --- | --- | --- |
| `tableName` | `string` | all | **required** |
| `client` | `DynamoDBDocument` | all | reuse an existing client; not closed by `destroy()`. It must provide `get`, `put`, `delete`, `update`, `query`, `scan`, `batchWrite` and `transactWrite`, so a raw `DynamoDBClient` is refused. Construct it with `maxAttempts: 1` (`DynamoDBDocument.from(new DynamoDBClient({ maxAttempts: 1, … }))`): the SDK's own retries are not disabled on an injected client and would stack inside the library's retry budget — a `warn` is logged at construction when they would |
| `clientConfig` | `DynamoDBClientConfig` | all | used to build a client when `client` is omitted; must be an object, and its keys go to the AWS SDK unchecked |
| `ttl` | `{ days: number }` \| `{ seconds: number }` | all | expiry written to the `ttl` attribute; one form only and no other key, capped at five years |
| `logger` | `Logger` | all | per-instance logger (default: silent); all four methods — `debug`, `info`, `warn`, `error` — are required |
| `retry` | `{ maxAttempts?, baseDelayMs?, maxDelayMs? }` | all | retry budget and backoff for every DynamoDB call (default 5 attempts, 100 ms base, 5 s cap — see [Retries and backoff](#retries-and-backoff)). Ceilings: 100 attempts, and 60 s for either delay |
| `compression` | `CompressionConfig` | all | `{ enabled, minSizeBytes?, level?, maxDecompressedBytes? }`; `level` is 0–9, and `minSizeBytes` and `maxDecompressedBytes` have a ceiling of 512 MiB each |
| `s3` | `S3OffloadConfig` | all | offload large payloads to S3 (see below) |
| `serde` | `SerializerProtocol` | all | serializer override (checkpointer defaults to LangGraph's; store/history to JSON); must provide `dumpsTyped` and `loadsTyped` |
| `indexName` | `string` | all | the name of the recency index (a GSI on `gsi1pk`/`gsi1sk`) on this table. Naming it turns `history.listSessions()` and a thread-less `saver.list()` from a table scan into a read of the index: each shard is read newest-first one DynamoDB page at a time, and its next page whenever it has no row buffered and the page being built still needs one — which can be a query whose rows that page never takes — with at most `readConcurrency` shards queried at once. A listing holds the page it is building, up to `limit` rows for `listSessions` (which sets no ceiling on `limit`) and 100 rows at a time for `saver.list`, plus at most one DynamoDB page (up to 1 MB) per shard. Opt-in: whether the table has the index is your deployment fact, not something this package probes for. **Run `backfillRecencyIndex()` before setting it** — a row written before the index carries no keys, so the listings that read it would not find rows that are still there |
| `indexShards` | `number` | all | index partitions per adapter (default 8, ceiling 1024). Fixed when the table is created: changing it changes every row's shard and requires another backfill. One partition per adapter would concentrate every listing on one key, which is worse than the scan it replaces |
| `readConcurrency` | `number` | all | payloads decoded at once by a single call (default 8, ceiling 128). It is the multiplier on this package's memory ceiling — `readConcurrency × (s3.maxDownloadBytes + compression.maxDecompressedBytes)`, 800 MiB at the defaults — so lower it on a small container. It also bounds how many recency-index shards one listing queries at once |
| `onCorruptMessage` | `'skip' \| 'throw'` | history only | what `getMessages` does with an item it cannot decode (default `skip`: drop it, log at `error`, return the rest) |
| `index` | `IndexConfig` | store only | `{ dims, embeddings, fields? }` for semantic search; `embeddings` must provide `embedQuery` and `embedDocuments`, and `fields`, when given, is an array of strings. Any other key is refused, and so is a value that is not an object, `null` included, rather than read as no index |
| `vectorBackend` | `VectorBackend` | store only | delegate similarity search to an external index; DynamoDB keeps the canonical item. It must provide `upsert`, `query` and `delete`; `listKeys` is optional (see [Vector index consistency](#features)). **Requires `index`** — constructing a store with a `vectorBackend` and no `index` throws |
| `maxSearchCandidates` | `number` | store only | cap for the in-DB ranker before it errors (default 1000, ceiling 100 000) |
| `maxScanItems` | `number` | store only | cap on rows read for one call before it errors (default 10000, ceiling 1 000 000; counts rows, not namespaces). Gates a plain `search()` page only when the page cannot be filled from fewer rows, semantic candidate collection, `listNamespaces()` and `reconcileVectorIndex()` |
| `vectorScoreDirection` | `'relevance' \| 'distance'` | store only | the direction of the score a `vectorBackend` returns (default `relevance`, higher is better); `distance` negates and re-sorts so a distance-native backend ranks correctly; any other value throws at construction |

`S3OffloadConfig`: `{ bucketName, keyPrefix?, thresholdBytes?, serverSideEncryption?, sseKmsKeyId?, maxDownloadBytes?, clientConfig? }`. `clientConfig` takes an `S3ClientConfig`; it is typed structurally (`S3ClientConfigLike`), so the shipped declarations compile whether or not `@aws-sdk/client-s3` is installed. Like the adapter's own `clientConfig`, it must be an object, and its keys go to the SDK unchecked. `sseKmsKeyId`, when given, must be a non-empty string; whether it names a key you can use is for S3 to answer. When `clientConfig.region` is omitted here, the S3 client inherits the adapter's DynamoDB `clientConfig.region` (the S3 SDK does not follow region redirects, so a cross-region bucket otherwise fails with `PermanentRedirect`). `maxDownloadBytes` (default 50 MiB, ceiling 512 MiB) caps the size of an offloaded object the adapter will buffer from S3 — checked against `ContentLength` before the body is read, and while streaming when the length is unknown — so together with `maxDecompressedBytes` no single payload can claim more memory than you allow. Defaults: `thresholdBytes` 350 KB (ceiling 392 KB, the largest payload stored inline), `serverSideEncryption` `AES256` (set `'aws:kms'` plus `sseKmsKeyId` for a customer key), `maxDownloadBytes` 50 MiB, and a per-adapter `keyPrefix` under `langgraph-checkpoints/`.

When `keyPrefix` is omitted, each adapter defaults to its own sub-prefix under the shared base (`langgraph-checkpoints/store/`, `langgraph-checkpoints/checkpointer/`, `langgraph-checkpoints/history/`) so that multiple adapters can safely share one bucket — their offloaded object keys and `ensureS3LifecycleRule()` TTL rules never collide. An explicit `keyPrefix` is always honored verbatim, including across adapters if you want them to share one; at that point avoiding a lifecycle-rule collision (e.g. by giving them the same TTL) is your responsibility, same as with any other explicit override. A `keyPrefix` must be a string holding a non-empty path ending in `/`: it is also the lifecycle rule's `Filter.Prefix`, so an empty or root prefix would expire the whole bucket and a slash-less one would match sibling prefixes — both are rejected at construction and again by `ensureS3LifecycleRule()`.

## Features

**Gzip compression** — set `compression: { enabled: true }`. Payloads at or above `minSizeBytes` (default 1 KB, ceiling 512 MiB) are gzipped transparently; the stored descriptor records whether a payload was compressed, so reads never infer it from the bytes, and decompression is guarded against decompression-bomb expansion (`maxDecompressedBytes`, default 50 MiB, ceiling 512 MiB).

**S3 offloading** — set `s3: { bucketName }`. Any serialized payload at or above `thresholdBytes` (default 350 KB) is written to S3, with only a reference stored in DynamoDB. Only the payload counts toward the threshold: the store's inline vectors sit on the same item and are not weighed against it. Budget about 10 bytes per dimension **per configured field** — the store embeds one vector per extracted path, so `fields: ['title', 'body', 'summary']` at 1024 dims costs roughly 30 KB, not 10 KB — and keep `thresholdBytes` plus that total under DynamoDB's 400 KB item limit or the put fails with a raw `ValidationException`. A value near the threshold indexed over many fields is the combination to watch. Reads rehydrate transparently. Requires the optional `@aws-sdk/client-s3` peer: constructing an adapter with `s3` starts loading it, and a missing package fails the first S3 operation with a `ValidationError` naming the install command — bundlers must keep it installed or external. Deleting a checkpoint thread / chat session also best-effort deletes its offloaded objects. When a `ttl` is also configured, call `ensureS3LifecycleRule()` once (e.g. during deployment) to install a matching S3 lifecycle expiration rule. It **throws** on failure rather than logging — a `ValidationError` for a `keyPrefix` it will not scope a rule to, and an `UpstreamError` for anything S3 refuses, most often a missing `s3:PutLifecycleConfiguration` — so call it from a provisioning step and treat a rejection as a deployment error, not as something to ignore. It is opt-in rather than automatic because it needs that broader bucket-level permission and is not safe to fire on every adapter construction. If you configure `ttl` + `s3` but never call it, nothing reclaims objects that best-effort cleanup misses — they stay in the bucket until you remove them or add a lifecycle rule yourself. Both the store's concurrent-`put` overwrite race and the checkpointer's *special*-write overwrite race (`__error__`, `__interrupt__`, `__resume__`, `__scheduled__`) are now **prevented** by a compare-and-swap: each overwrite pins the previous descriptor it observed and re-reads on rejection, so it deletes exactly the payload it actually superseded instead of racing another writer for the same one. A leak from either path remains possible in these cases, all backstopped by `ensureS3LifecycleRule()`: the bounded compare-and-swap (3 attempts) is exhausted under pathological contention, which falls back to an unconditional overwrite and logs a `warn`; a best-effort delete genuinely fails; a failed write cannot be verified, or a special write's first read of its row fails, so nothing is deleted; or one double-fault interleaving — a write that loses the swap and then exhausts its transient-error retries on an attempt that actually landed — leaves cleanup releasing the stale descriptor rather than the one it truly superseded, orphaning that one. Every write uploads under an id of its own — a store put's `rev`, a checkpoint put's ULID, a `putWrites` call's `writeGroup`, a history message's ULID — so no row another write commits names its objects, and no cleanup reads the row again before it deletes: a `store.put` or special write releases the payload it superseded once its own write has committed, `store.delete` releases the object of the row it removed, and a failed `store.put`, `saver.put` or `putWrites` releases its own uploads only once a read of the row, or the row returned with a rejected write, shows that the row does not hold its write. Uploads are sent with `If-None-Match: *`, so a retried upload request writes nothing new. Two writes of the same bytes store two objects. Separately, and unchanged by any of the above, the checkpointer's *regular* (non-special) writes still resolve a genuine race first-write-wins with no compare-and-swap, so the loser's own upload there remains an orphan reclaimed only by best-effort cleanup and `ensureS3LifecycleRule()`. Likewise, a store `delete` whose acknowledgement is lost after the row was removed cannot learn which object that row referenced — the row is gone and its `ReturnValues` travelled with the lost response — so that one object is left to the lifecycle rule too.

**TTL expiry** — set `ttl: { days }` or `ttl: { seconds }`. The `ttl` attribute is written as a Unix-epoch-seconds timestamp; enable DynamoDB TTL on the `ttl` attribute for automatic deletion. Every adapter filters rows past their `ttl` on read — `get`/`search`/`listNamespaces` in the store, `getTuple`/`list` in the checkpointer, `getMessages`/`listSessions` in chat history — so nothing expired comes back during DynamoDB's sweep lag. For the checkpointer that means a thread whose head expired reads as its newest *live* checkpoint (or as empty), older checkpoints can expire while the head lives (so `parentConfig` may point at a checkpoint that is gone, which LangGraph's resume path does not need), and a swept payload reads as "no checkpoint" only for an already-expired head. Chat history anchors a single **uniform whole-conversation TTL** on the session's metadata row, shared by every message: normally it's set once, at session creation, via `if_not_exists`; but if the previously-stored anchor is ever found missing or already expired (DynamoDB's own TTL sweep can lag up to ~48h), the next append heals it with a plain overwrite instead of staying stuck. Every message written at any point in time shares whatever the current anchor is; expired messages are also filtered out on read. If the append that triggers a stale-anchor heal is itself later rolled back (a later chunk in the same call failed), the healed ttl is not reverted — the session simply keeps the fresher, never-shorter expiry rather than risk regressing a value a concurrent legitimate extension may have since written; this is a deliberate, self-healing tradeoff, not a bug. Turning `ttl` on for a chat-history table that already holds sessions stamps the anchor and every *new* message only; message rows written before that keep no `ttl`, outlive their session row, and still come back from `getMessages` — clear those sessions or backfill a `ttl` onto their rows when enabling expiry retroactively.

**Plain (metadata) search** (store) — a `search()` call with no `query` (or with a `query` but no `index`/`vectorBackend` configured) reads rows under the `namespacePrefix` and decodes them in batches of 8 — applying `filter` in-process — until `offset + limit` matching items are in hand, then stops: the page is the complete answer, so a namespace far larger than the page costs neither a full decode nor a `ResultTruncatedError`. Only a page that cannot be filled from fewer rows is bounded by `maxScanItems` (default 10,000; exceeding it throws rather than silently returning a partial result). This is a different cap from `maxSearchCandidates` below: `maxScanItems` gates rows read, `maxSearchCandidates` gates the in-DB semantic ranker. For namespaces that routinely exceed the default, prefer a `vectorBackend` or a narrower `namespacePrefix` over raising the cap, which stops at 1,000,000.

**Semantic search** (store) — provide `index` with a LangChain `Embeddings` implementation. On `put`, each configured field is embedded separately — one vector per extracted path, as the reference store does — and on `search` with a `query` an item is ranked by its **best-matching** vector, so a long document with one strongly relevant section is found instead of being averaged away. By default those vectors are stored on the item and ranking happens in-process over the scoped candidate set (bounded by `maxSearchCandidates`, default 1000 and ceiling 100,000 — exceeding it throws a `ValidationError` as soon as more rows than that exist under the prefix, before any row is decoded or the query embedded, steering you to an external index). A row written before the per-path change carries a single vector and still ranks exactly as it did. A `vectorBackend` search that reaches `maxSearchCandidates` while its `filter` has left fewer than `offset + limit` matches throws the same error instead of returning a silently short page. For large corpora, pass a `vectorBackend`: a **single** vector over the joined fields is sent there instead of the per-path set, similarity search is delegated to it, and DynamoDB still holds the canonical item. Per-item indexing can be overridden via the `index` argument to `put` (`false` to skip, or a `string[]` of fields).

**Vector index consistency** — when a `vectorBackend` is configured, **DynamoDB holds the canonical item** and the backend is a rebuildable index. After each canonical write the embedding is synced to the backend best-effort: a failure is logged (not thrown), so a backend hiccup never fails an otherwise-successful `put`/`delete`. To repair drift, call `store.reconcileVectorIndex(namespacePrefix)` — it re-pushes every live embedding and, when the backend implements the optional `listKeys`, prunes vectors with no canonical item; it returns `{ upserted, pruned }`. Run it when the namespace is idle. Caveats: reconciliation re-embeds with the store's **configured** index fields, so per-`put` field overrides are not reproduced; prune happens only when `listKeys` is implemented (otherwise reconcile re-pushes only and logs that prune was skipped); the prefix must be a non-empty namespace.

**Checkpointer semantics** — `put()` of an existing `checkpoint_id` is last-writer-wins, as in the reference savers: the transaction is unconditional, so two processes writing the same id keep whichever landed last, and the loser's offloaded objects wait for the lifecycle rule. `putWrites` issues one guarded `PutItem` per write, all in parallel, so a `Send` fan-out of a thousand branches is a thousand concurrent puts (fine on on-demand tables; size provisioned capacity accordingly). `deleteThread()` reads the partition once and deletes what it saw, rows first and then their offloaded objects, with no read in between. A graph still running on the thread can leave fresh rows behind, and a write whose own attempt committed before the partition was read can, when its retry lands after the delete, put its row back naming an object this call released — call it when the thread is quiescent. A delete that fails part-way leaves the objects of its already-deleted rows to the lifecycle rule. `list()` without a `thread_id` lists every thread in the table: through a table scan, like the reference savers, or through the recency index when `indexName` is set.

**Chat history semantics** — message order is the write order of one adapter instance (its ULIDs are strictly monotonic even within a millisecond); across instances or processes it is the writers' wall clocks at millisecond precision, so a process whose clock lags can sort a later turn before an earlier one. The default `serde` is plain JSON: a `Uint8Array`/`Buffer` inside a message (a `ToolMessage.artifact`, say) reads back as an index-keyed object and a `Date` as a string — pass `serde: new JsonPlusSerializer()` from `@langchain/langgraph-checkpoint` for binary and `Date` fidelity. A batch over 99 messages or 3.5 MB is committed in chunks and is atomic from the writer's perspective only: a concurrent reader can see the first chunks before the append settles, and a rolled-back append still bumps the session's `updatedAt`. Under heavy contention on one session an append can spend up to about 61 seconds per chunk in retries (18 attempts, 5 s cap) — three times that when an injected client keeps the SDK's own retries. `clear()` has the same single-pass, quiescent-session caveat as `deleteThread()`: a message appended while it runs may survive it. Each message's object is keyed by that message's own id, so a new message never shares an object with a row being deleted.

**Differences from `InMemoryStore`** — the store follows the reference semantics, and every observable difference is listed under [Versioning and compatibility](#differences-from-the-reference-implementations). The ones a caller meets first: `$gt`/`$gte`/`$lt`/`$lte` compare like types only, where the reference reduces both sides with `Number()` (a stored `'10'` does not match `{ $gt: 5 }` here, and two ISO-8601 date strings compare as dates rather than as `NaN`); results come back in key order, not insertion order; and the per-item `index` argument of `put` is honoured only on direct `DynamoDBStore` calls — LangGraph's `AsyncBatchedStore`, which wraps the store inside a graph, does not forward it. `$eq`/`$ne`/`$in`/`$nin` and a plain field condition compare by deep equality, where upstream compares with `===`, so there an object- or array-valued field never equals a condition, even an identical one. An empty field condition `{}` constrains nothing, as upstream does. `put()` refuses a `null` value, which the reference treats as a delete; call `delete()` instead.

**Strong consistency** — checkpointer read-your-writes (`getTuple`) and every `store.get` use `ConsistentRead`, so a value written and immediately read back is never served a stale replica. Bulk reads (`list`, `listNamespaces`, `listSessions`) stay eventually consistent for lower cost.

## Retries and backoff

Every DynamoDB call the library makes runs inside its own retry layer, and that layer is the only one: clients the library constructs disable the SDK's retries (`maxAttempts: 1`), so the numbers below are exact. `list()` without a `checkpoint_ns` covers every namespace of the thread (rows come grouped by namespace, newest first within each); with an explicit namespace, `before` is applied in the key condition so newer rows are never read, and a `checkpoint_id` is fetched directly instead of scanning. An injected `client` that keeps SDK retries stacks them inside each attempt — construct it with `maxAttempts: 1` (a `warn` is logged at construction otherwise).

- **What is retried** — throttling and capacity errors, transaction conflicts, request timeouts, HTTP 429/5xx responses (including ones the SDK cannot map to a modeled exception), errors carrying the SDK's `$retryable` trait, and Node socket errors. Everything else — `ValidationException`, `ConditionalCheckFailedException`, `ResourceNotFoundException`, `AccessDeniedException`, a `TransactionCanceledException` with a permanent reason — is thrown on the first attempt.
- **Schedule** — `retry.maxAttempts` (default 5, ceiling 100) attempts with full-jitter exponential backoff from `retry.baseDelayMs` (default 100 ms), doubling per attempt and capped at `retry.maxDelayMs` (default 5 s; a value below `baseDelayMs` is refused, and both delays have a ceiling of 60 s): about 1.5 s worst case and 0.75 s expected before `RetryExhaustedError`. `addMessages` never uses fewer than 18 attempts (about 61 s worst case), because every concurrent append to one session contends on the same metadata row. `BatchWriteItem` `UnprocessedItems` are re-submitted for up to 10 rounds with the same backoff.
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
| `VALIDATION` | `ValidationError` | every constructor for a bad option, an option key it does not read, or a collaborator missing a method; every method for a bad identifier, key, window, value, `config` or options object; `backfillRecencyIndex` for a bad option; S3 offload configured without the `@aws-sdk/client-s3` peer; a descriptor the reader cannot honour |
| `UPSTREAM` | `UpstreamError` | every public method and `backfillRecencyIndex`, wrapping an AWS SDK error that was not retryable or that the library does not classify (`AccessDeniedException`, `ResourceNotFoundException`, `ValidationException`, …); the single-session adapter, wrapping an error its backend throws that is not one of this library's |
| `RETRY_EXHAUSTED` | `RetryExhaustedError` | every DynamoDB call after `retry.maxAttempts` transient failures (`context.attempts`, the last error as `cause`) |
| `ABORTED` | `AbortError` | any cancellable method whose `AbortSignal` fired |
| `CONDITION_CONFLICT` | `ConflictError` | `history.reconcileMessageCount` when the session changed while it counted |
| `COMPENSATION_FAILED` | `CompensationFailedError` | `history.addMessages` / `addMessage` when a multi-chunk append failed and the rollback of the committed chunks failed too (`rollbackError`; run `reconcileMessageCount`) |
| `BATCH_WRITE_INCOMPLETE` | `BatchWriteAllIncompleteError` | `saver.deleteThread`, `history.clear` when a multi-chunk delete does not fully drain (`succeededCount`, `failedChunks`); `BatchWriteIncompleteError` is the per-chunk error inside it |
| `RESULT_TRUNCATED` | `ResultTruncatedError` | the paginated reads that keep rows in memory — `store.search`, `store.listNamespaces`, `store.reconcileVectorIndex`, `history.listSessions` — past `maxScanItems` / `maxItems` / `maxIterations`; and a listing through the recency index — `history.listSessions`, or `saver.list` without a `thread_id` — for an index shard that needs more than 1000 DynamoDB pages while one page of the listing is built |
| `S3_OFFLOAD_FAILED` | `DynamoDBLangGraphError` | an upload, download or delete of an offloaded object that failed after the S3 retries, an object over `maxDownloadBytes`, or an object that no longer exists (`context.key`) |
| `COMPRESSION_LIMIT` | `DynamoDBLangGraphError` | a payload whose decompressed size would exceed `maxDecompressedBytes` |
| `PAYLOAD_CORRUPT` | `DynamoDBLangGraphError` | a stored payload that can never be read: bytes marked compressed that are not gzip, or bytes the serializer cannot parse. Classified permanent, so a caller reports it instead of retrying |
| `FORMAT_UNSUPPORTED` | `DynamoDBLangGraphError` | a row written by a newer release of this package than the one reading it. Raised rather than skipped: hiding a row that exists is worse than failing |
| `ANCESTOR_EXPIRED` | `DynamoDBLangGraphError` | `saver.getDeltaChannelHistory` when a checkpoint a delta channel still needs has expired (`context.threadId`, `context.checkpointId`). Lower `snapshotFrequency`, or do not put a `ttl` on threads that use delta channels |

**Cancellation** — every long-running method takes an `AbortSignal`: the checkpointer reads `RunnableConfig.signal` (which LangGraph propagates) on `getTuple`, `list`, `put` and `putWrites`, and `deleteThread`, `search`, `reconcileVectorIndex`, `getMessages`, `addMessages`, `addMessage`, `clear`, `listSessions` and `reconcileMessageCount` take a trailing `{ signal }`. A signal that is not an `AbortSignal` — an object with a boolean `aborted` and callable `addEventListener` and `removeEventListener` — is refused with `ValidationError` naming `signal`, before any request, wherever it is passed: in a trailing `{ signal }`, or as `config.signal` to the checkpointer's `getTuple`, `list`, `put`, `putWrites` and `getDeltaChannelHistory`, which check it the same way. A signal that is already aborted, or aborts while the library waits (a retry backoff, the next page of a paginated read), rejects the call with the library's `AbortError` (`code: 'ABORTED'`) whatever the abort reason was — the raw reason (a `DOMException` for a bare `controller.abort()`) is kept as `cause`. Cleanup and verification reads that run after a failure are not cancelled, so an abort never strands a live row pointing at a deleted object. Typed subclasses are exported where callers commonly branch: `ValidationError`, `ConflictError`, `RetryExhaustedError`, `BatchWriteIncompleteError`, `BatchWriteAllIncompleteError`, `ResultTruncatedError`, `AbortError`, `CompensationFailedError`.

`CompensationFailedError` is the one error that carries another: the append's original failure is `cause` and the rollback failure is `rollbackError`, which can itself be a `BatchWriteAllIncompleteError`. Check `rollbackError.code` (or `.name`) rather than `instanceof` for the same package-copy reason as above. The session's stored `messageCount` may be wrong at that point; `reconcileMessageCount` repairs it.

### Maintenance operations

Four tools repair or provision state and are meant for deployment scripts and operators, not request paths:

- **`ensureS3LifecycleRule()`** (all three adapters) — installs the S3 lifecycle expiration rule that matches the configured `ttl` under the adapter's key prefix, idempotently. It **throws** when the bucket cannot be read or written (`AccessDenied`, `NoSuchBucket`, throttling) — nothing is swallowed or merely logged — so call it once at deployment time, from a role that holds the two lifecycle actions, and treat a failure as a deployment failure. It is a no-op when `s3` or `ttl` is not configured.
- **`store.reconcileVectorIndex(namespacePrefix)`** — re-pushes every live item's embedding to the configured `vectorBackend` and, when the backend implements `listKeys`, prunes vectors whose item is gone; returns `{ upserted, pruned }`. Run it when the namespace is idle; it reads every row under the prefix (bounded by `maxScanItems`).
- **`backfillRecencyIndex({ tableName, client, … })`** — gives rows written before the recency index their `gsi1pk`/`gsi1sk`. **Run it before setting `indexName` on any adapter**: a row without the keys is not in the index, so enabling the index first makes every pre-existing session, item and checkpoint vanish from the listings that read it — the rows are still there, and every other read still returns them, but a listing would not. Resumable by passing back the `nextCursor` it returns as `cursor`, re-runnable, and safe against a live table: every write is conditional on the row having no keys yet. `indexShards` must match what the adapters use. Every option is checked before the first read, with `ValidationError` naming it: an unknown key, a `tableName` DynamoDB would refuse, a `client` without `scan` and `update`, an `indexShards` outside 1–1024, a `pageSize` or `maxPages` that is not an integer of at least 1, a `dryRun` that is not a boolean, a `retry` whose numbers break the adapters' bounds or whose hooks are not functions, a `signal` that is not an `AbortSignal`, and a `cursor` the tool did not issue. `signal` cancels the run; so does `retry.signal` when no top-level `signal` is given, and when both are given the top-level one wins. An AWS SDK error it does not retry reaches the caller as `UpstreamError`, with the SDK error as `cause`.
- **`history.reconcileMessageCount(sessionId)`** — recounts a session's live messages and rewrites the stored `messageCount`; returns the count. Run it after a `CompensationFailedError` or the `rollback failed` log event, when the session is idle; it throws `ConflictError` if an append lands while it counts.

## Logging

Logging is **per-instance and silent by default** — the library never writes to your console uninvited. Pass any object matching the `Logger` interface — all four of `info`, `warn`, `error` and `debug` are required, and a logger missing one is refused at construction, naming it (`logger.debug`):

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
| `error` | `history.addMessages rollback failed; messageCount may have drifted` | `sessionId`, `committedChunks` | a multi-chunk append failed and its rollback failed too (`CompensationFailedError`); run `reconcileMessageCount` for the session once it is idle |
| `error` | `getMessages: skipped a corrupt message item` | `sessionId`, `sortKey`, `reason` | a message row could not be decoded (or its S3 object is gone) and was dropped under `onCorruptMessage: 'skip'`; inspect or delete the row |
| `warn` | `store.put: compare-and-swap exhausted; overwriting unconditionally` | `namespace`, `key`, `attempts` | three concurrent overwrites of one item; the put succeeded but one S3 object may be orphaned until the lifecycle rule sweeps it |
| `warn` | `putWrites: special-write compare-and-swap exhausted; overwriting unconditionally` | `sortKey`, `channel`, `attempts` | same, for an interrupt/resume/error write written concurrently for one task |
| `warn` | `Some orphaned S3 objects could not be deleted after` | `failedCount` | objects leaked after a failed write or a delete; `ensureS3LifecycleRule()` reclaims them, otherwise clean up by prefix |
| `warn` | `Failed to clean up orphaned S3 objects after` | `reason` | the cleanup itself failed after retries; same remedy |
| `warn` | `: refusing to delete an S3 object outside this row's scope` | `key` | a row referenced an object outside its own key path — a tampered or foreign row; the object was left alone, investigate the writer |
| `warn` | `store.put vector-index sync failed; reconcileVectorIndex will repair` | `namespace`, `key`, `reason` | the `vectorBackend` rejected an upsert or delete; the canonical item is fine, run `reconcileVectorIndex` when convenient |
| `warn` | `factory.destroy: an adapter did not release its resources` | `reason` | one adapter's teardown failed; the rest were released anyway and the process may hold that adapter's sockets until it exits |
| `warn` | `injected DynamoDB client keeps the SDK's own retries` | `maxAttempts` | construct the injected client with `maxAttempts: 1` unless you want the SDK's retries to stack inside the library's budget |
| `warn` | `putWrites: write row held by an unexpected channel; write not persisted` | `sortKey`, `expected`, `found` | another writer holds this task's row for a different channel; only this library should write the key space |
| `warn` | `history.addMessages compensating committed chunks after a chunk failed` | `sessionId`, `committedChunks` | a large append is being rolled back; the caller receives the original error |
| `warn` | `list: scanned a large number of rows without the caller stopping` | `threadId`, `checkpointNs`, `scanned` | a `list()` walked over 10 000 rows; pass `limit` or narrow the filter |
| `warn` | `getMessages: a session holds very many messages; the read is complete but slow. Pass a ` | `sessionId`, `messages` | over 10 000 messages read in one call; pass `limit` to read only the newest turns |
| `warn` | `getTuple: a checkpoint carries very many pending-write rows; the read is complete but slow` | `threadId`, `checkpointId`, `rows` | over 10 000 pending writes on one checkpoint (a huge fan-out or many retried tasks); the read is correct |
| `warn` | `search: some candidates carry an embedding of a different dimension than the query` | `namespacePrefix`, `count` | items embedded with another model or `dims`; re-put them or run `reconcileVectorIndex` |
| `warn` | `search: vectorBackend returned ascending scores; VectorMatch.score must be a relevance` | `namespacePrefix` | the backend reports distances; set `vectorScoreDirection: 'distance'` |
| `warn` | `search: skipped an unusable vectorBackend match` | `namespace`, `key`, `reason` | the backend returned a key this store cannot address; run `reconcileVectorIndex` |
| `warn` | `: left a foreign row in place` | `sortKey` | `deleteThread`/`clear` found a row another adapter owns in the partition and kept it |
| `warn` | `: left a row rewritten since the read` | `sortKey` | `deleteThread`/`clear` found the row changed under it: another write landed after the partition was read, so the row and the object it names were kept. Re-run the call once the thread or session is idle |
| `warn` | `: skipped a row whose unit was refused` | `sortKey` | a `deleteThread` kept a checkpoint's payload or pending-write row because the same checkpoint's earlier row was rewritten and kept; re-run once the thread is idle |
| `warn` | `list: skipped a row that is not a checkpoint meta item` | `sortKey` | a foreign row shares the `META#` prefix on a shared table |
| `warn` | `getTuple: skipped a row that is not a checkpoint meta item` | `sortKey` | same, on the read-your-writes path |
| `warn` | `store.get: ignored a row that is not a store item` | `partitionKey`, `sortKey` | a foreign row at a store key |
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

// Optional: the recency index. Add it, run backfillRecencyIndex(), then set
// `indexName: 'gsi1'` on the adapters. Without it every listing still works.
table.addGlobalSecondaryIndex({
  indexName: 'gsi1',
  partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
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

  # Optional: the recency index. Add it, run backfillRecencyIndex(), then set
  # `indexName = "gsi1"` on the adapters. Without it every listing still works.
  attribute { name = "gsi1pk" type = "S" }
  attribute { name = "gsi1sk" type = "S" }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
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

When the table carries the recency index and an adapter names it with `indexName`, the `Query` action also needs the index's own ARN — a permission on the table alone does not cover its indexes:

```json
"Resource": [
  "arn:aws:dynamodb:<region>:<account>:table/langgraph",
  "arn:aws:dynamodb:<region>:<account>:table/langgraph/index/gsi1"
]
```

`LangGraphTableScans` is needed only by the table-wide reads — a rootless `store.search([])`, `store.listNamespaces()` without a concrete prefix root, `backfillRecencyIndex()`, and, on an adapter without `indexName`, `history.listSessions()` and `saver.list()` without a `thread_id` (with `indexName` those two `Query` the index instead). Every other operation is a `GetItem`, a `Query` or a write. Leave the statement out of any role that must not read across tenants (see below).

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

Four operations read the whole table and return **every tenant's** rows by construction: `store.search([])`, `store.listNamespaces()` without a prefix root, `history.listSessions()` and `saver.list()` without a `thread_id` — the first two as table scans, the last two as table scans or, with `indexName`, as reads of the recency index. Treat them as administrative. `listSessions()` also returns each session's `title`, which is derived from the first human message — user content.

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

## Versioning and compatibility

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). For a persistence adapter the storage layout is as much a contract as the TypeScript API, so both are stated here: what a `1.x` release promises to keep, what a minor may add, and what only a `2.0` may change.

### The public API

The public API is everything exported from the package entry point (`dist/index.js` / `dist/index.d.ts`): the five classes `DynamoDBSaver`, `DynamoDBStore`, `DynamoDBChatMessageHistory`, `DynamoDBSessionChatMessageHistory` and `DynamoDBFactory`; the error model (`DynamoDBLangGraphError`, `ErrorCode`, the typed error classes, `UpstreamError`, `isDynamoDBLangGraphError`); the operator tool `backfillRecencyIndex`; the logging helpers (`redactLogger`, `redactSecrets`); and every exported type. A test (`test/types/public-surface.test.ts`) enumerates the set and pins the adapter method signatures.

- A **minor** may add exports, add optional options and parameters, add optional fields to returned objects, and widen accepted inputs.
- A **patch** changes behaviour only to fix a defect against the documented behaviour.
- Removing or renaming an export, making an option required, narrowing an input, or changing a return type requires a **major**, preceded by a deprecation.
- Deep imports (`@farukada/aws-langgraph-dynamodb-ts/dist/...`) are blocked by the `exports` map and are not part of the API. The `createClient` / `createS3Client` seams are test hooks stripped from the shipped declarations and are not supported.

### The on-disk layout

Every `1.x` release reads every row a `1.0` release wrote. New attributes may be added in a minor; they are optional, and a row without them keeps its `1.0` meaning. The key formats, the required attributes and the payload descriptor change only in a major, with a migration note.

| Adapter | Partition key | Sort keys | Attributes |
| --- | --- | --- | --- |
| Checkpointer | `CHKPT#<thread_id>` | `META#<ns>#<checkpoint_id>`, `PAYLOAD#<ns>#<checkpoint_id>`, `WRITE#<ns>#<checkpoint_id>#<task>#<idx>#<channel>` | META: `threadId`, `checkpointNs`, `checkpointId`, `metadata`, `v`, optional `parentCheckpointId`, `gsi1pk`, `gsi1sk`, `ttl`; PAYLOAD: `checkpoint`, `v`, optional `ttl`; WRITE: `taskId`, `index`, `channel`, `writeGroup`, `value`, `v`, optional `occurrence`, `ttl` |
| Store | `STORE#<namespace[0]>` | `<namespace[1..]>#<key>` | `namespace`, `key`, `value`, `createdAt`, `updatedAt`, `v`, optional `embeddings`, `embedding`, `gsi1pk`, `gsi1sk`, `rev`, `ttl` |
| Chat history | `HIST#<sessionId>` | `HISTORY#SESSION`, `HISTORY#MSG#<ULID>` | session: `sessionId`, `messageCount`, `createdAt`, `updatedAt`, `v`, optional `title`, `gsi1pk`, `gsi1sk`, `ttl`; message: `sessionId`, `message`, `v`, optional `ttl` |

`gsi1pk`/`gsi1sk` are the [recency-index](#table-schema) keys; they are written whether or not a table defines the index, so enabling `indexName` later needs only a backfill. `embeddings` holds one vector per indexed field; `embedding` is the single joined vector older rows carry and is still read. `storedChannels` was written by `1.0.0-rc.1` and no longer is: it is ignored on read and rows carrying it keep their meaning.

Offloaded objects live at `<keyPrefix><base64url(part)/...>/<write id>.bin` — the parts identify the row that points at the object (for a history message, its session), and the last segment, not encoded, is the id of the write that uploaded it: a UUID for a store put, a ULID for a checkpoint put, a `putWrites` call or a history message. Each object also carries its row's key as S3 user metadata (`dynamodb-pk-b64`, `dynamodb-sk-b64`), the backlink AWS recommends for cleaning up orphans, and the lifecycle rule id is `langgraph-ttl-<slug of keyPrefix>`. All three are stable for `1.x`. Objects written by `1.0.0-rc.1`, whose last segment was the same kind of id base64url-encoded, are still read and deleted exactly as before — a descriptor always records the full key, so nothing needs migrating. The `ttl` attribute is Unix epoch seconds; compression is gzip; `serdeType` names the serializer that produced the bytes and is honoured on read even when the adapter is configured with another one.

### Errors, logs and row versions

Every row this release writes carries `v`, its format version. A reader treats a row without `v` as version 0 and reads it under the rules that applied when it was written; a row whose `v` is higher than the reader understands fails with `FORMAT_UNSUPPORTED`, on every read that returns a row's content, rather than being read as though its unknown attributes did not matter. A minor may raise the version it writes only in a way older `1.x` readers still accept.

`ErrorCode` values are append-only in `1.x`; error class names and the `code` each carries are stable, and `ErrorContext` only gains fields. Error *messages* and log *messages* are not covered — branch on `code`, `name` and the structured fields, never on text.

### Supported runtimes and peers

| Dependency | Supported | Verified by |
| --- | --- | --- |
| Node.js | 22 and 24 | the unit tier on Linux, macOS and Windows |
| TypeScript (consumers) | 5.x and later | the package smoke type-checks the shipped declarations with both the 5.x floor and the newest release |
| `@langchain/langgraph-checkpoint` | `^1.1.5` | the conformance tier against the floor and the latest release, including LangChain's checkpointer validation suite |
| `@langchain/langgraph` | any 1.x release depending on a supported `@langchain/langgraph-checkpoint` (not a peer of this package) | the compiled-graph conformance tests |
| `@langchain/core` | `^1.2.11` | the differential and history tests |
| AWS SDK v3 (`@aws-sdk/client-dynamodb`, `lib-dynamodb`, optional `client-s3`) | the ranges in `package.json` | every tier |

Raising a floor (dropping a Node major after its end of life, requiring a newer LangChain minor) is a **minor** and is announced in the CHANGELOG. A peer range is never narrowed in a patch.

### Deprecation

Anything scheduled for removal is marked `@deprecated` in its JSDoc and listed in the CHANGELOG for at least one minor before the major that removes it. Deprecated members keep working until then.

### Not covered

`saver.getDeltaChannelHistory()` tracks an upstream API that `@langchain/langgraph-checkpoint` marks beta: its signature and return shape follow that contract, so a change there can reach a minor of this package. The `ANCESTOR_EXPIRED` code it raises is covered like every other code.

Also not covered: the wording of error messages and log lines, the order of rows returned by table scans, the exact request counts in the [cost table](#what-each-operation-costs), the layout of `docs/api`, timing characteristics, and the internal module structure.

### Differences from the reference implementations

`MemorySaver` and `InMemoryStore` are the behaviour this package matches. Every observable difference is listed here; anything not in this table is a defect, not a choice, and the differential tests are what enforce that. From `1.0.0`, adding a row is a **minor** at most, and only when the reference itself is the defect or this backend's storage and key rules require the difference; changing one a caller may already rely on is a **major**.

| # | Difference | Kept because |
| --- | --- | --- |
| V-1 | Write identity is `(taskId, channel, occurrence)` | index positions are unstable across a retry; kept unobservable by read-side dedup |
| V-2 | Namespace prefixes match element-wise | the reference compares the joined string, so `['users']` matches `['userspace']` |
| V-3 | Namespace elements may not contain `#` | the separator is structural in the sort key |
| V-4 | A namespace whose items are all deleted stops being listed | the reference retains an empty namespace with no row behind it |
| V-5 | `search` / `listNamespaces` raise `RESULT_TRUNCATED` past `maxScanItems` | silently truncating a result set is worse than refusing it |
| V-6 | Re-putting with `index: false` clears the stored vector | the reference keeps a stale vector for a changed value |
| V-8 | A value JSON refuses (circular, `BigInt`) yields no index text instead of throwing from inside text extraction | the put is refused a moment later by the codec, with a `ValidationError` naming `value` rather than a raw `TypeError` from the embedding step |
| V-9 | Namespaces the collation calls equal are ordered by code unit | the reference leaves that pair to insertion order, which here is DynamoDB's read order, so a page boundary could fall between them differently on two calls |
| V-10 | `put` stores every channel value, never only the ones `newVersions` names | narrowing stored *nothing* when LangGraph forks a checkpoint or writes an empty update, both of which pass an empty `newVersions`. `MemorySaver.put` takes no `newVersions` either, and LangChain's validation suite exempts its own `MemorySaver`, MongoDB and SQLite savers from the delta test on the same grounds; the exemption is keyed on a module-name list, so `test/conformance/validation.conformance.test.ts` applies it by name |
| V-11 | `$gt`/`$gte`/`$lt`/`$lte` compare like types only | the reference reduces both sides with `Number()`, which makes every comparison between two ISO-8601 date strings `NaN`-false; native `>` instead coerces, so a stored `'10'` satisfied `{ $gt: 5 }`. Comparing like types directly is well-defined in both cases |
| V-12 | An array used as a field condition is compared as a literal | upstream reaches `Object.keys([]).every(...)`, so `[]` as a condition matches everything there; comparing the stored array is the answer a caller means |
| V-13 | `search` results come back in key order, not insertion order | the sort key is the order DynamoDB reads a partition in, and paging has to be stable across calls |
| V-14 | `getTuple`, `list`, `put`, `putWrites` and `getDeltaChannelHistory` refuse a `config` that is not an object, and a `configurable` in it that is present but is not an object, `null` included | the reference crashes on `null` or `undefined`, and reads any other value as a config naming no thread, so `list('x')` lists every thread and `getTuple('x')` answers `undefined`. It reads a `configurable` of `'thread-1'` or `null` the same way: `list({ configurable: 'thread-1' })` lists every thread too, `getTuple` answers `undefined`, and `put` and `putWrites` report a missing `thread_id` |
| V-15 | A checkpoint id of `0`, `false` or `NaN` is refused, whether it arrives as `checkpoint_id`, as `thread_ts` or as `list`'s `before` bound; only `undefined`, `null` and `''` mean no id | the reference tests the id for truthiness, so a falsy one silently addresses the latest checkpoint, or drops the `before` bound |
| V-16 | `list` refuses an `options`, `before` or `filter` that is not an object or is an array, an option key it does not read, and a `limit` of `null`; `before: {}` stays legal | the reference ignores a misspelt key, reads a non-object `options` or `before`, or a `null` filter, as absent, and walks a string or array filter as field names, so the listing comes back silently empty; it also compares `limit: null` as `null <= 0`, which is true, so that listing is empty as well |
| V-17 | `put` refuses a `null` or `undefined` checkpoint, and `putWrites` refuses `writes` that is not an array of arrays, before anything is written | the reference crashes on both; it reads a string entry as a `[channel, value]` pair (`'ab'` writes `'b'` to channel `'a'`), and stores the entries beside a non-iterable one before it rejects |
| V-18 | `getDeltaChannelHistory` requires exactly `{ config, channels }`, with `channels` an array of strings | the reference crashes on a missing argument or `channels`, ignores an extra key, and iterates a string `channels` one character at a time, so `'ab'` answers for channels `'a'` and `'b'` |
| V-19 | `put()` refuses a `null` value; `delete()`, and a `batch()` put operation carrying `null`, still delete | `BaseStore.put` is typed to take an object, yet the reference passes `null` on as the delete operation, so a call named `put` silently removes the item |
| V-20 | A put value that is not an object or is an array, and an `index` other than absent, `false` or an array of strings, are refused on every route, `batch()` included | the reference stores any value, so the characters of a stored string answer a filter as fields (`{ 0: 'a' }` matches `'abc'`), and so do the elements and the `length` of a stored array (after `put(['a'], 'k', ['x', 'y'])`, `search(['a'], { filter: { 0: 'x' } })` and `{ filter: { length: 2 } }` each return the item); it ignores a malformed `index` when no embeddings are configured and crashes on a non-array one when they are, embeds the whole value for a number path, and reads `null` as the configured fields |
| V-21 | `search` refuses a `namespacePrefix` that is not an array, `options` that is not an object, an option key it does not read, a `filter` that is not an object or is an array, a `query` that is not a string, and an `offset` or `limit` of `null`; a `batch()` search operation refuses the same `namespacePrefix`, `offset` and `limit` | the reference throws a bare `TypeError` (`op.namespacePrefix.join is not a function`) for a `namespacePrefix` that is not an array, from `search` and from `batch()` alike; it crashes on `null` options, reads string options as none and ignores a misspelt key; it walks a string or array filter as field names, so the page is silently empty, reads a `null` filter as none, and ignores a non-string `query` when no index is configured; and it reads an `offset` or `limit` of `null` as its default, 0 or 10, on both routes |
| V-22 | `listNamespaces` refuses `options` that is not an object, an option key it does not read, a `prefix` or `suffix` that is not an array, and a `limit` or `offset` of `null` | the reference crashes on `null` options and on a string path, ignores a misspelt key, and reads string options, or a `null` or empty-string path, as none, listing every namespace; it also reads `limit: null` as no limit, listing every namespace, and `offset: null` as 0 |
| V-23 | A search prefix label, or a listing prefix or suffix label, that is not a non-empty string is refused; `'*'` stays a listing wildcard | the reference stringifies a non-string search label (`[1]` finds namespace `['1']`) and matches every namespace for an empty one, while a listing never matches either and answers with a silently empty list |
| V-24 | `batch` refuses an `operations` value that is not an array, and an operation or match condition that is not an object | the reference crashes on most of these and answers the rest wrongly: an `operations` object returns `[]`, an array operation is skipped without a result, shifting every later result, and a numeric `matchConditions` lists every namespace |
| V-25 | `$eq`, `$ne`, `$in`, `$nin` and a plain field condition compare by deep equality | the reference compares with `===`, so an object- or array-valued field never equals a condition, even an identical one: `$eq` and `$in` silently match nothing and `$ne` and `$nin` match everything |
| V-26 | Beyond V-3 and V-23, every store namespace label, item key and search or listing prefix label, and every checkpointer identifier — `thread_id`, `checkpoint_ns`, a given `checkpoint_id` or `thread_ts`, `taskId`, a pending-write channel and `list`'s `before` id — follows this backend's identifier rules: no `#`, no control character, no unpaired surrogate, at most 256 bytes of UTF-8 (1024 for `thread_id`), and not blank, except that `checkpoint_ns` may be empty or blank; the sort key a store item or a pending write composes from them is also held to 1024 bytes. The reference stores and finds any such value. An item's namespace must also hold at least one label on every route that addresses an item — `get`, `delete` and a `batch()` put or get as well as `put()` — where the reference refuses an empty namespace in `put()` alone | each of these values is, or is matched against, a segment of a DynamoDB key, and these are the rules a key segment follows here: `#` separates segments, the byte caps keep a composed key within DynamoDB's limits of 2048 bytes for a partition key and 1024 for a sort key, an unpaired surrogate would let two ids encode to one key, and a control character would reach this package's log lines unneutralised. A value outside the rules can never be stored, so a lookup, search or listing naming one is refused rather than answered empty. A store item's partition key is its namespace's first label, so an empty namespace addresses no partition; the reference answers `get([], key)` with `null`, stores a `batch()` put under `[]`, which `listNamespaces` then reports as `['']`, and reads it back and deletes it |
| V-27 | The store's `index` option must be an object naming only `dims`, `embeddings` and `fields`, with `embeddings` providing `embedQuery` and `embedDocuments` and `fields`, when given, an array of strings; `null` is refused rather than read as no index | the reference ignores a misspelt key, so `{ feilds: ['title'] }` embeds the whole document; reads an `index` without `embeddings`, or a `null` or string one, as no index and answers every query unranked; fails at the first put when `embeddings` lacks `embedDocuments`; and crashes at construction on a string `fields` |
| V-28 | A signal that is not an `AbortSignal` — an object with a boolean `aborted` and callable `addEventListener` and `removeEventListener` — is refused with `ValidationError` naming `signal`, before any request: as `config.signal` to `getTuple`, `list`, `put`, `putWrites` and `getDeltaChannelHistory`, and as the `signal` option of `search` and `deleteThread` | the reference never reads a signal: `MemorySaver` ignores `config.signal`, so `getTuple` with `signal: {}` answers as if none were given, `InMemoryStore.search` ignores a `signal` option, and `MemorySaver.deleteThread` takes no options. Here the wait before a retry calls the signal's `addEventListener` and `removeEventListener`, so a malformed one would otherwise fail partway through a call, after a throttled request and from inside a timer, while a call that is never retried would read only its `aborted` and ignore it silently; either way the option would go unnamed |

## Production notes

- **Sharing one table** across all three adapters is supported — adapter-tagged partition keys make the key spaces provably disjoint (see [Table schema](#table-schema)), and table-wide reads filter to their own items. Checkpointer, chat-history, and *scoped* store reads are all partition-scoped (`Query`/`GetItem`).
- **Scoped reads are `Query`s.** `store.search`/`store.listNamespaces` with a concrete namespace prefix and `history.getMessages` are native `Query`s. Only a rootless `store.search([])` / unprefixed `listNamespaces`, `history.listSessions` and a `saver.list()` called without a `thread_id` (which, like the reference savers, lists every thread in the table) fall back to `Scan` (cost scales with table size, and the result spans every tenant); with `indexName` the last two read the recency index instead, whose result still spans every tenant — keep those rare or use a dedicated table. `listSessions` accepts an optional `{ maxIterations }` override for tables where non-session rows dominate the scan.
- **One S3 GET per offloaded payload per read.** Every offloaded row a read touches (`getTuple` pending writes, a plain `search()` applying its filter, `getMessages`) costs one S3 GET, and the returned bytes are decoded in memory. Reads decode up to 8 offloaded payloads at a time rather than one after another, but the request count is still linear in the offloaded row count — keep `thresholdBytes` high and compression on so that few payloads offload, and prefer a `vectorBackend` over the in-DB ranker for large semantic corpora.
- **Hot partitions.** The store's partition key is `STORE#<namespace[0]>` and chat history's is `HIST#<sessionId>` — the adapter tag is constant, so throughput still concentrates on the identifier you choose. A single partition tops out around ~1000 WCU / 3000 RCU, so avoid funneling very high write throughput through one tenant/session id; spread load across scope roots (e.g. include a tenant id as `namespace[0]`).
- **Identifier rules.** Every caller-supplied identifier (thread_id, checkpoint_ns, checkpoint_id, taskId, sessionId, store namespace elements and keys, pending-write channels) is validated before it reaches DynamoDB: it must be a non-blank, well-formed string (no unpaired surrogate) with no control characters and no reserved `#`, at most 1024 bytes of UTF-8 for the partition identifiers (`thread_id`, `sessionId`) and 256 bytes for every sort-key segment (an empty `checkpoint_ns` is legal, it is the root namespace). The same rules hold for every label of a `search` namespace prefix and of a `listNamespaces` prefix or suffix (where `'*'` still matches any label), and for `list()`'s `before` checkpoint id. Upstream's two further namespace rules — no `.` in a label, and a root other than `"langgraph"` — are applied by `store.put()` alone, exactly as `BaseStore.put` applies them: `get`, `delete`, `search`, `listNamespaces` and every `batch()` operation, which is how LangGraph reaches a store inside a graph, accept both, so a namespace such as `['memories', 'jane.doe@example.com']` that a graph writes through `batch()` can be read, searched, listed and deleted. Composed keys are checked too: a store namespace + key, or a checkpointer pending-write key, may not exceed DynamoDB's 1024-byte sort-key cap, and an offloaded S3 object key may not exceed S3's 1024 bytes. A violation is a `ValidationError` whose `context.field` names the offending value, thrown before any request is sent.
- **Very large vector corpora** outgrow the in-DB ranker (`maxSearchCandidates`). Configure a `vectorBackend` (OpenSearch, pgvector, …) — the library keeps DynamoDB as the source of truth and only delegates similarity ranking.
- **TTL deletion timing** is governed by DynamoDB (typically within 48 h of expiry) and S3 lifecycle expiry is day-granular — the library writes the correct expiry timestamp (and filters expired chat messages on read) but does not guarantee instant deletion. The matching S3 lifecycle rule is not written automatically: it is installed only when you call `ensureS3LifecycleRule()`. That rule expires objects `ceil(ttl in days) + 2` days after creation — the two-day margin covers DynamoDB's sweep lag so an object never disappears before its row — and also expires noncurrent versions after the same number of days, so a versioned bucket does not retain every superseded payload forever (on such buckets the library's best-effort deletes only add delete markers). `ensureS3LifecycleRule()` is a read-modify-write of the bucket's whole lifecycle configuration: call it sequentially across adapters and deployers, never concurrently.

## Operations

### Limits

*Value* is the limit in force: for an option, its default. *Ceiling* is the largest value that option accepts; a larger one is refused at construction with a `ValidationError` naming the option. *Fixed* marks a limit no option changes.

| Limit | Value | Ceiling | Where it bites |
| --- | --- | --- | --- |
| DynamoDB item size | 400 KB | fixed | a payload over `thresholdBytes` (default 350 KB, ceiling 392 KB) must offload to S3; without `s3` a serialized payload over 392 KB is refused with a `ValidationError` before the write |
| Partition identifiers (`thread_id`, `sessionId`) | 1024 bytes UTF-8 | fixed | `ValidationError` |
| Sort-key segments (`checkpoint_ns`, `checkpoint_id`, `taskId`, channel, store namespace element, store `key`) | 256 bytes each, 1024 bytes composed | fixed | `ValidationError` |
| S3 object key | 1024 bytes | fixed | identifiers are base64url-encoded into it, so long ids reach it first |
| `ttl` | none (no expiry) | 5 years | `ValidationError` at construction |
| Chat-history append transaction | 99 messages or 3.5 MB per chunk | fixed | larger batches are split into chunks with caller-observed atomicity |
| Delete batches | 25 rows per `BatchWriteItem`, `UnprocessedItems` re-driven up to 10 times | fixed | `BatchWriteAllIncompleteError` |
| Rows one store read holds in memory (`maxScanItems`) | 10 000 | 1 000 000 | `ResultTruncatedError` |
| Rows held in memory by `listSessions({ maxItems })` | 10 000 | none; `Infinity` asks for no cap | `ResultTruncatedError` |
| Pages walked by `listSessions({ maxIterations })` | 1000 | none; `Infinity` asks for no cap | `ResultTruncatedError` |
| In-DB semantic candidates (`maxSearchCandidates`) | 1000 | 100 000 | `ValidationError` |
| Decompressed payload (`compression.maxDecompressedBytes`) and buffered S3 object (`s3.maxDownloadBytes`) | 50 MiB each | 512 MiB each | `COMPRESSION_LIMIT` / `S3_OFFLOAD_FAILED` |
| Smallest payload compressed (`compression.minSizeBytes`) | 1 KB | 512 MiB | a smaller payload is stored uncompressed; not an error |
| Retries per DynamoDB call (`retry.maxAttempts`) | 5 (about 1.5 s worst case); message appends 18 (about 61 s) | 100 | `RetryExhaustedError` |
| Backoff delay (`retry.baseDelayMs`, `retry.maxDelayMs`) | 100 ms base, 5 s cap | 60 s each | latency, not an error |
| Offloaded payloads decoded concurrently by one read, and recency-index shards queried at once by one listing (`readConcurrency`) | 8 | 128 | latency and memory, not an error |
| Index shards per adapter (`indexShards`) | 8 | 1024 | an indexed listing issues at least one `Query` per shard, `readConcurrency` at a time; `backfillRecencyIndex` takes the same ceiling and must be given the same value |

### What each operation costs

Requests per call, before retries. "Consistent" reads are `ConsistentRead: true` (twice the read units of an eventually consistent read); S3 requests apply only to offloaded payloads.

| Operation | DynamoDB | S3 |
| --- | --- | --- |
| `saver.getTuple` | 1 consistent `GetItem` (by id) or `Query` (newest) for the META row, 1 consistent `GetItem` for the payload, 1 consistent `Query` for the pending writes; a pre-v4 checkpoint adds a `Query` of its parent's writes | 1 `GET` per offloaded payload, 8 at a time |
| `saver.put` | 1 `TransactWriteItems` (META + PAYLOAD); after a failed transaction with `s3`, 1 consistent `GetItem` of the row carrying an offloaded descriptor, when something was offloaded | 1 `PUT` per offloaded payload; after a failure that read shows did not commit, 1 `DeleteObjects` of those uploads |
| `saver.putWrites` | 1 `PutItem` per write, all in parallel, guarded except for a special write without `s3`; with `s3` each special write adds 1 consistent `GetItem` and up to 3 compare-and-swap attempts, then 1 unguarded `PutItem` if all 3 are rejected; with `s3`, each failed `PutItem` adds 1 consistent `GetItem` to learn whether it landed, except a regular write's conditional rejection and a special write's rejection that returned the row | 1 `PUT` per offloaded write, `DELETE` of a superseded special write |
| `saver.list` | 1 eventually consistent `Query` per page; without a `thread_id` a `Scan`, or — with `indexName` — per page of 100 rows 1 `Query` per index shard, `readConcurrency` at a time, and 1 more for a shard each time it has no row buffered while the page still needs one, even if the page then takes none of that query's rows, holding the 100 rows plus at most one DynamoDB page (1 MB) per shard; per yielded tuple 1 `GetItem` and 1 `Query` for its writes | `GET` per offloaded payload and metadata |
| `saver.deleteThread`, `history.clear` | 1 consistent `Query` per page, 1 `BatchWriteItem` per 25 rows | 1 `DeleteObjects` per 1000 keys |
| `store.get` | 1 consistent `GetItem` | 1 `GET` |
| `store.put` | 1 consistent `GetItem` (previous descriptor and revision), 1 `PutItem` (with `s3` guarded: up to 3 attempts under contention, each re-reading from the rejection, then 1 unguarded if all 3 are rejected), 1 consistent `GetItem` after a write that fails, to learn whether it landed, plus the `vectorBackend` upsert | 1 `PUT`, then `DELETE` of the superseded object |
| `store.delete` | 1 `DeleteItem` returning the old row, plus the `vectorBackend` delete | `DELETE` of the removed object |
| `store.search` | 1 eventually consistent `Query` per page (`Scan` for `[]`), reading rows in batches of 8 until the page is full; a `query` adds one embedding call | 1 `GET` per offloaded candidate |
| `store.listNamespaces` | `Query` (`Scan` without a prefix root) per page, projected to each item's key and format version | none |
| `history.addMessages` | 1 consistent `GetItem` of the session row when `ttl` is set, then 1 `TransactWriteItems` per chunk (up to 99 messages plus the session update); a rollback costs 1 `BatchWriteItem` per 25 rows plus a session update | 1 `PUT` per offloaded message |
| `history.getMessages` | 1 consistent `Query` per page (newest-first with a page cap under `limit`) | 1 `GET` per offloaded message, 8 at a time |
| `history.listSessions` | 1 `Scan` per page, or — with `indexName` — 1 `Query` per index shard (8 by default), `readConcurrency` at a time, and 1 more for a shard each time it has no row buffered while the page still needs one, even if the page then takes none of that query's rows, holding the page (up to `limit` rows, with no ceiling on `limit`) plus at most one DynamoDB page (1 MB) per shard; pageable by cursor | none |
| `history.reconcileMessageCount` | 1 consistent `GetItem` of the stored count, 1 eventually consistent `Query` per page returning only each message's `v` and `ttl`, 1 guarded `UpdateItem`; all three again, up to 3 attempts in all, when the stored count changes while it counts | none |
| `store.reconcileVectorIndex` | 1 `Query` per page, embedding calls in batches, backend upserts and deletes | `GET` per offloaded item |

### Monitoring

Alert on the two `error` events (a corrupt message row, a failed append rollback) and on the four `warn` events that name an orphan or an exhausted compare-and-swap (see [Logging](#logging)); count `RetryExhaustedError` and `UpstreamError` by `context.operation` and `httpStatusCode`. `RetryExhaustedError.context.attempts` and every `debug` retry line carry the SDK `requestId` of the last failure for AWS Support. Watch the table's `ThrottledRequests` and `ConsumedWriteCapacityUnits` per partition key prefix — the [hot-partition](#production-notes) note explains which identifier concentrates load.

### Lambda and other short-lived runtimes

Construct the adapters once at module scope (or one `DynamoDBFactory.createAll()`), reuse them across invocations, and pass a `client` you own if the function also uses DynamoDB elsewhere; `destroy()` is only needed when a process wants to release sockets before exit. Size the function timeout against the worst-case retry budgets above: a heavily contended chat append can take about a minute, and `retry.maxAttempts` / `retry.maxDelayMs` trade that ceiling against resilience to throttling. Every long-running method takes an `AbortSignal`, so a timeout can cancel cleanly (see [Error handling](#error-handling)).

### Multi-tenancy

See [Multi-tenant deployments](#multi-tenant-deployments) under IAM permissions for the identifier convention, the table-scan operations that are cross-tenant by construction, and the `dynamodb:LeadingKeys` policy.

## Testing

```bash
npm test            # unit + static-guard + property + type tests, 100% coverage
npm run test:static # the static guards alone
npm run typecheck
npm run lint
npm run build       # removes dist/ first, so no output outlives its source
```

The surface tier runs the public API against a large table of malformed inputs and compares the result — one line per case — to a committed baseline, so any change to what the package accepts or rejects shows up as a reviewed diff. It runs against the built package, so build first:

```bash
npm run build
npm run test:surface         # compare against test/surface/baseline.txt
npm run test:surface:update  # accept the current behaviour as the new baseline
```

Only run `test:surface:update` after reading the diff `test:surface` printed. A line that changed for a reason you cannot name is a regression, not a baseline to refresh.

Integration and contract tiers run against DynamoDB Local (Docker) and are kept out of the default `npm test`:

```bash
npm run test:integration:up     # docker compose up -d (DynamoDB Local)
npm run test:integration        # integration flows + LangGraph/LangChain contract conformance
npm run test:integration:down
```

The real-AWS tier runs the same adapters against real DynamoDB, S3 and Bedrock. Every suite creates and tears down its own uniquely named table and bucket (`aws-langgraph-<suite>test-<uuid>`) in the account of the default credential chain. It is not run by CI: a maintainer runs it on demand before a release, so no scheduled job bills this account.

```bash
npm run test:aws                # needs AWS credentials; AWS_REGION selects the region
```

The `examples/live-*.mjs` scripts are demos against real AWS, not a test tier: `live-checkpointer.mjs` runs a LangGraph agent across two saver instances and deletes its table afterwards; `live-agent.mjs`, `live-persist.mjs` and `live-store.mjs` leave their table in place so you can inspect the rows in the console. They read `AWS_REGION` (default `eu-west-1`) and `LANGGRAPH_DEMO_TABLE` (default `langgraph-saver-demo` / `langgraph-store-demo`), and `live-agent.mjs` needs a Bedrock model enabled in that region.

### What the suite does and does not prove

| Tier | Runs | Proves |
| --- | --- | --- |
| Unit, static guards, type locks, property tests (`npm test`) | every push and PR, three OSes × Node 22 and 24 | every code path (100 % coverage), the repository rules (file size, JSDoc-only comments, no `any`/`unknown`/`instanceof`, no re-exports, no import cycles, no dead error codes, every public async method behind the error boundary, no planning references or raw control characters in committed code), the exact public export set and adapter signatures, the stated invariants (sort-key order, item-size estimate, write resolution, redaction, backoff) |
| Integration (`npm run test:integration`, DynamoDB Local) | every push and PR | end-to-end adapter flows and fault injection; the write races the compare-and-swap exists for, with an in-memory S3 in the loop; the DynamoDB semantics the unit mocks assume; parity with `InMemoryStore` and `InMemoryChatMessageHistory` under `RunnableWithMessageHistory`; a 30-way single-session append storm |
| Conformance (`npm run test:conformance`, DynamoDB Local) | every push and PR, against the declared floor and the latest `@langchain/langgraph-checkpoint` | a compiled LangGraph graph over the saver (interrupt/resume, subgraph namespaces, forks, history windows, crash-and-resume, `Send` fan-out) and LangChain's official checkpointer validation suite |
| Package smoke (`npm run test:package-smoke`) | every push and PR | the packed tarball installs and imports without the optional S3 peer, and its declarations type-check without it |
| Real AWS (`npm run test:aws`) | on demand, before a release | S3 offload, lifecycle rules and the S3 error taxonomy against the real services; real 30-way append contention; Bedrock embeddings (skipped with a reason when the model is not enabled) |

Nothing in the suite provokes real throttling or `ProvisionedThroughputExceededException` (only its classification is tested), receives `UnprocessedItems` from a batch write (DynamoDB Local and on-demand tables never return them), observes DynamoDB's TTL sweep (only the stamped attribute is asserted), uses a versioned bucket, exercises a hot partition, or measures the write capacity the compare-and-swap fallback consumes. An injected `client` that keeps the SDK's own retries multiplies the library's attempt budget; the integration tier pins that count once and every adapter warns about it at construction.

## Support and policies

- [Versioning and compatibility](#versioning-and-compatibility) — what `1.x` promises for the API, the on-disk layout, error codes and peer ranges.
- [Security policy](SECURITY.md) — private reporting, response targets, what the library does and does not do.
- [Support](SUPPORT.md) — where to ask, what to include.
- [Contributing](CONTRIBUTING.md) — setup, the guards, the test tiers, the toolchain, commits and releases.

## License

MIT © [Faruk Ada](https://github.com/FarukAda)

---

<p align="center">
  Built with <a href="https://langchain-ai.github.io/langgraphjs/">LangGraph</a> · <a href="https://aws.amazon.com/sdk-for-javascript/">AWS SDK v3</a> · <a href="https://github.com/langchain-ai/langchainjs">LangChain</a>
  <br/>
  <a href="https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts">npm</a> · <a href="https://github.com/FarukAda/aws-langgraph-dynamodb-ts">GitHub</a> · <a href="https://github.com/FarukAda/aws-langgraph-dynamodb-ts/issues">Issues</a>
</p>
