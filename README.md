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

## Table schema

Every adapter uses the **same simple key schema**: a string partition key `PK`, a string sort key `SK`, and an optional Number `ttl` attribute for expiry. **A single table can back all three adapters**, or you can use a separate table per adapter — your choice via the `tableName` option.

| Attribute | Type | Role |
| --- | --- | --- |
| `PK` | String (HASH) | partition key |
| `SK` | String (RANGE) | sort key |
| `ttl` | Number | (optional) Unix-epoch-seconds expiry; enable DynamoDB TTL on this attribute |

How each adapter lays out keys (informational — you don't manage this):

- **Checkpointer** — `PK = CHKPT#<thread_id>`; `SK` = `META#<ns>#<checkpoint_id>` (metadata), `PAYLOAD#<ns>#<checkpoint_id>` (checkpoint), `WRITE#<ns>#<checkpoint_id>#<task>#<idx>#<channel>` (pending writes).
- **Store** — `PK = STORE#<namespace[0]>` (the scope root); `SK = <namespace[1..]>#<key>`. This makes a scoped prefix search a native `Query` (`PK = root AND begins_with(SK, …)`); only a rootless "search everything" falls back to a `Scan`.
- **Chat history** — `PK = HIST#<sessionId>`; one item per message at `SK = HISTORY#MSG#<ULID>` (ordered, append-only) plus one `SK = HISTORY#SESSION` metadata item.

**Why the key spaces cannot collide.** Each adapter tags its partition key with its own prefix, and those three tags differ in their very first character, so no `CHKPT#…` can ever equal a `STORE#…` or `HIST#…` — whatever identifiers you pass. That matters because reusing one id across adapters (a "conversation id" used as both a `thread_id` and a `sessionId`) is an entirely ordinary design: without the tags it put unrelated adapters' rows in one partition, where `deleteThread()`/`history.clear()` would delete each other's data and identically-composed sort keys could silently overwrite one another.

Two further guards back that up, for a table holding hand-written rows or rows written before an upgrade: `deleteThread()`/`clear()` delete only rows whose sort key belongs to the calling adapter and log anything they leave in place, and every read narrows a row's shape before decoding it rather than trusting the key it was found at.

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
import { HumanMessage } from '@langchain/core/messages';

const history = new DynamoDBChatMessageHistory({
  tableName: 'langgraph',
  clientConfig: { region: 'eu-west-1' },
});

await history.addMessages('session-1', [new HumanMessage('Hello!')]);
const messages = await history.getMessages('session-1');
const sessions = await history.listSessions(); // [{ sessionId, title, messageCount, ... }]
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

## Options

All adapters share a common base. Provide **either** a prebuilt `client` (which the adapter will not own/close) **or** `clientConfig` (the adapter builds and owns the client).

| Option | Type | Applies to | Notes |
| --- | --- | --- | --- |
| `tableName` | `string` | all | **required** |
| `client` | `DynamoDBDocument` | all | reuse an existing client; not closed by `destroy()` |
| `clientConfig` | `DynamoDBClientConfig` | all | used to build a client when `client` is omitted |
| `ttl` | `{ days: number }` \| `{ seconds: number }` | all | expiry written to the `ttl` attribute; one form only, capped at five years |
| `logger` | `Logger` | all | per-instance logger (default: silent) |
| `compression` | `CompressionConfig` | all | `{ enabled, minSizeBytes?, level?, maxDecompressedBytes? }` |
| `s3` | `S3OffloadConfig` | all | offload large payloads to S3 (see below) |
| `serde` | `SerializerProtocol` | all | serializer override (checkpointer defaults to LangGraph's; store/history to JSON) |
| `onCorruptMessage` | `'skip' \| 'throw'` | history only | what `getMessages` does with an item it cannot decode (default `skip`: drop it, log at `error`, return the rest) |
| `index` | `IndexConfig` | store only | `{ dims, embeddings, fields? }` for semantic search |
| `vectorBackend` | `VectorBackend` | store only | delegate similarity search to an external index; DynamoDB keeps the canonical item. **Requires `index`** — constructing a store with one and not the other throws |
| `maxSearchCandidates` | `number` | store only | cap for the in-DB ranker before it errors (default 1000) |
| `maxScanItems` | `number` | store only | cap on items scanned into memory during a plain (non-semantic) `search()` before it errors (default 10000, the shared in-memory cap used by every paginated read) |

`S3OffloadConfig`: `{ bucketName, keyPrefix?, thresholdBytes?, serverSideEncryption?, sseKmsKeyId?, clientConfig? }`.

When `keyPrefix` is omitted, each adapter defaults to its own sub-prefix under the shared base (`langgraph-checkpoints/store/`, `langgraph-checkpoints/checkpointer/`, `langgraph-checkpoints/history/`) so that multiple adapters can safely share one bucket — their offloaded object keys and `ensureS3LifecycleRule()` TTL rules never collide. An explicit `keyPrefix` is always honored verbatim, including across adapters if you want them to share one; at that point avoiding a lifecycle-rule collision (e.g. by giving them the same TTL) is your responsibility, same as with any other explicit override. A `keyPrefix` must be a non-empty path ending in `/`: it is also the lifecycle rule's `Filter.Prefix`, so an empty or root prefix would expire the whole bucket and a slash-less one would match sibling prefixes — both are rejected at construction and again by `ensureS3LifecycleRule()`.

## Features

**Gzip compression** — set `compression: { enabled: true }`. Payloads at or above `minSizeBytes` (default 1 KB) are gzipped transparently; decompression auto-detects on read and is guarded against decompression-bomb expansion (`maxDecompressedBytes`, default 50 MiB).

**S3 offloading** — set `s3: { bucketName }`. Any serialized payload at or above `thresholdBytes` (default 350 KB) is written to S3, with only a reference stored in DynamoDB; reads rehydrate transparently. Requires the optional `@aws-sdk/client-s3` peer. Deleting a checkpoint thread / chat session also best-effort deletes its offloaded objects. When a `ttl` is also configured, call `ensureS3LifecycleRule()` once (e.g. during deployment) to best-effort install a matching S3 lifecycle expiration rule (logged, never fatal) — this is opt-in rather than automatic, since it requires the broader `s3:PutLifecycleConfiguration` bucket-level permission and is not safe to fire on every adapter construction. If you configure `ttl` + `s3` but never call it, nothing reclaims objects that best-effort cleanup misses — they stay in the bucket until you remove them or add a lifecycle rule yourself. Both the store's concurrent-`put` overwrite race and the checkpointer's *special*-write overwrite race (`__error__`, `__interrupt__`, `__resume__`, `__scheduled__`) are now **prevented** by a compare-and-swap: each overwrite pins the previous descriptor it observed and re-reads on rejection, so it deletes exactly the payload it actually superseded instead of racing another writer for the same one. A leak from either path is now possible only in these residual cases, still backstopped by `ensureS3LifecycleRule()`: the bounded compare-and-swap (3 attempts) is exhausted under pathological contention, which falls back to an unconditional overwrite and logs a `warn`; a best-effort delete genuinely fails; or one double-fault interleaving — a write that loses the swap and then exhausts its transient-error retries on an attempt that actually landed — leaves cleanup targeting the stale descriptor rather than the one it truly superseded, orphaning one object (it never deletes a live object). Separately, and unchanged by any of the above, the checkpointer's *regular* (non-special) writes still resolve a genuine race first-write-wins with no compare-and-swap, so the loser's own upload there remains an orphan reclaimed only by best-effort cleanup and `ensureS3LifecycleRule()`.

**TTL expiry** — set `ttl: { days }` or `ttl: { seconds }`. The `ttl` attribute is written as a Unix-epoch-seconds timestamp; enable DynamoDB TTL on the `ttl` attribute for automatic deletion. Chat history anchors a single **uniform whole-conversation TTL** on the session's metadata row, shared by every message: normally it's set once, at session creation, via `if_not_exists`; but if the previously-stored anchor is ever found missing or already expired (DynamoDB's own TTL sweep can lag up to ~48h), the next append heals it with a plain overwrite instead of staying stuck. Every message written at any point in time shares whatever the current anchor is; expired messages are also filtered out on read. If the append that triggers a stale-anchor heal is itself later rolled back (a later chunk in the same call failed), the healed ttl is not reverted — the session simply keeps the fresher, never-shorter expiry rather than risk regressing a value a concurrent legitimate extension may have since written; this is a deliberate, self-healing tradeoff, not a bug.

**Plain (metadata) search** (store) — a `search()` call with no `query` (or with a `query` but no `index`/`vectorBackend` configured) decodes every row under the `namespacePrefix` — applying `filter` in-process — before slicing to `offset`/`limit`. That full-namespace decode is bounded by `maxScanItems` (default 10,000, the same in-memory cap shared by every other paginated read in the library); exceeding it throws rather than silently returning a partial result. This is a different cap from `maxSearchCandidates` below: `maxScanItems` gates the plain in-memory scan, `maxSearchCandidates` gates the in-DB semantic ranker. Raise `maxScanItems` for a one-off oversized namespace, but for namespaces that routinely exceed the default, prefer a `vectorBackend` or a narrower `namespacePrefix` over raising the cap indefinitely.

**Semantic search** (store) — provide `index` with a LangChain `Embeddings` implementation. On `put`, the configured `fields` are embedded; on `search` with a `query`, results are ranked by cosine similarity. By default the embedding is stored on the item and ranking happens in-process over the scoped candidate set (bounded by `maxSearchCandidates`, default 1000 — exceeding it throws, steering you to an external index). For large corpora, pass a `vectorBackend`: the embedding is sent there instead, similarity search is delegated to it, and DynamoDB still holds the canonical item. Per-item indexing can be overridden via the `index` argument to `put` (`false` to skip, or a `string[]` of fields).

**Vector index consistency** — when a `vectorBackend` is configured, **DynamoDB holds the canonical item** and the backend is a rebuildable index. After each canonical write the embedding is synced to the backend best-effort: a failure is logged (not thrown), so a backend hiccup never fails an otherwise-successful `put`/`delete`. To repair drift, call `store.reconcileVectorIndex(namespacePrefix)` — it re-pushes every live embedding and, when the backend implements the optional `listKeys`, prunes vectors with no canonical item; it returns `{ upserted, pruned }`. Run it when the namespace is idle. Caveats: reconciliation re-embeds with the store's **configured** index fields, so per-`put` field overrides are not reproduced; prune happens only when `listKeys` is implemented (otherwise reconcile re-pushes only and logs that prune was skipped); the prefix must be a non-empty namespace.

**Strong consistency** — checkpointer read-your-writes (`getTuple`) and every `store.get` use `ConsistentRead`, so a value written and immediately read back is never served a stale replica. Bulk reads (`list`, `listNamespaces`, `listSessions`) stay eventually consistent for lower cost.

## Error handling

All errors thrown by the library extend `DynamoDBLangGraphError` and carry a stable `code` from the `ErrorCode` enum plus a native `cause` chain. Branch on `code`:

```typescript
import { ErrorCode, DynamoDBLangGraphError } from '@farukada/aws-langgraph-dynamodb-ts';

try {
  await store.put([''], 'k', { v: 1 });
} catch (error) {
  if (error instanceof DynamoDBLangGraphError && error.code === ErrorCode.VALIDATION) {
    // bad input
  }
}
```

`ErrorCode` values: `VALIDATION`, `CONDITION_CONFLICT`, `RETRY_EXHAUSTED`, `BATCH_WRITE_INCOMPLETE`, `COMPRESSION_LIMIT`, `S3_OFFLOAD_FAILED`, `RESULT_TRUNCATED`, `ABORTED`, `COMPENSATION_FAILED`. Typed subclasses are exported where callers commonly branch: `ValidationError`, `ConflictError`, `RetryExhaustedError`, `BatchWriteIncompleteError`, `BatchWriteAllIncompleteError`, `ResultTruncatedError`, `AbortError`, `CompensationFailedError`.

`BatchWriteAllIncompleteError` is thrown directly by `deleteThread`, `clearSession`, and `putWrites` when a multi-chunk `BatchWriteItem` sequence doesn't fully drain. The chat-history append-rollback path can hit the same underlying failure while deleting a partially-committed batch's rows, but there it's never thrown directly — it surfaces as the `rollbackError` property of a `CompensationFailedError` (the append's original trigger error still needs reporting too), so check `err.rollbackError instanceof BatchWriteAllIncompleteError` there instead of `err instanceof BatchWriteAllIncompleteError`. Where the error may have crossed a package-copy boundary (e.g. a bundler duplicating this package), prefer `err.rollbackError.code === ErrorCode.BATCH_WRITE_INCOMPLETE` or `err.rollbackError.name === 'BatchWriteAllIncompleteError'` over `instanceof` — this library's own code avoids `instanceof` internally for the same reason. It carries `succeededChunks` / `totalChunks` / `failedChunks` / `succeededCount` so a caller can tell how much of the batch actually persisted before the failure, rather than just seeing the first chunk's raw error.

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

**What the library logs.** Nothing at all until you inject a logger — that is deliberate, a library should not write to your console uninvited. Once one is attached, the events worth alerting on are:

| Level | Event |
| --- | --- |
| `info` | `deleteThread` / `history.clear` completing, with rows deleted and rows skipped |
| `warn` | a row left in place by a delete because it belongs to another adapter |
| `warn` | a row skipped on read because its shape is not this adapter's (`store.get`, checkpointer `list`) |
| `warn` | a pending-write guard rejection whose existing row holds an unexpected channel |
| `warn` | a `vectorBackend` returning ascending scores, or a match this store cannot address |
| `error` | a chat message skipped because it could not be decoded, with its sort key |

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

Minimum DynamoDB actions on the table:

```
dynamodb:GetItem
dynamodb:PutItem
dynamodb:DeleteItem
dynamodb:Query
dynamodb:Scan
dynamodb:BatchGetItem
dynamodb:BatchWriteItem
dynamodb:TransactWriteItems
```

When S3 offloading is enabled, on the bucket/objects: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, and — only if TTL-driven lifecycle rules are desired — `s3:GetBucketLifecycleConfiguration` and `s3:PutBucketLifecycleConfiguration`. For semantic search via Bedrock embeddings: `bedrock:InvokeModel`.

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
- **Scoped reads are `Query`s.** `store.search`/`store.listNamespaces` with a concrete namespace prefix and `history.getMessages` are native `Query`s. Only a rootless `store.search([])` / unprefixed `listNamespaces` and `history.listSessions` fall back to `Scan` (cost scales with table size) — keep those rare or use a dedicated table. `listSessions` accepts an optional `{ maxIterations }` override for tables where non-session rows dominate the scan.
- **Hot partitions.** The store's partition key is `STORE#<namespace[0]>` and chat history's is `HIST#<sessionId>` — the adapter tag is constant, so throughput still concentrates on the identifier you choose. A single partition tops out around ~1000 WCU / 3000 RCU, so avoid funneling very high write throughput through one tenant/session id; spread load across scope roots (e.g. include a tenant id as `namespace[0]`).
- **Identifier rules.** Every caller-supplied identifier (thread_id, checkpoint_ns, checkpoint_id, taskId, sessionId, store namespace elements and keys, pending-write channels) is validated before it reaches DynamoDB: it must be a non-blank string with no control characters and no reserved `#`, at most 1024 bytes of UTF-8 for the partition identifiers (`thread_id`, `sessionId`) and 256 bytes for every sort-key segment (an empty `checkpoint_ns` is legal, it is the root namespace). Composed keys are checked too: a store namespace + key, or a checkpointer pending-write key, may not exceed DynamoDB's 1024-byte sort-key cap, and an offloaded S3 object key may not exceed S3's 1024 bytes. A violation is a `ValidationError` whose `context.field` names the offending value, thrown before any request is sent.
- **Very large vector corpora** outgrow the in-DB ranker (`maxSearchCandidates`). Configure a `vectorBackend` (OpenSearch, pgvector, …) — the library keeps DynamoDB as the source of truth and only delegates similarity ranking.
- **TTL deletion timing** is governed by DynamoDB (typically within 48 h of expiry) and S3 lifecycle expiry is day-granular — the library writes the correct expiry timestamp (and filters expired chat messages on read) but does not guarantee instant deletion. The matching S3 lifecycle rule is not written automatically: it is installed only when you call `ensureS3LifecycleRule()`. That rule expires objects `ceil(ttl in days) + 2` days after creation — the two-day margin covers DynamoDB's sweep lag so an object never disappears before its row — and also expires noncurrent versions after the same number of days, so a versioned bucket does not retain every superseded payload forever (on such buckets the library's best-effort deletes only add delete markers). `ensureS3LifecycleRule()` is a read-modify-write of the bucket's whole lifecycle configuration: call it sequentially across adapters and deployers, never concurrently.

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

Real-AWS verification scripts live in `examples/` (each creates and tears down its own resources):

```bash
node examples/verify-checkpointer.mjs   # save/resume/writes/list/delete, compression, S3, TTL
node examples/verify-store.mjs          # filters, semantic search, S3 offload, TTL
node examples/verify-history.mjs        # per-message model, concurrency, RunnableWithMessageHistory agent
node examples/verify-factory.mjs        # shared-client createAll across all three adapters
node examples/verify-agents.mjs         # real LangGraph agents using the saver + store as memory
node examples/verify-edge-cases.mjs     # filter operators, multi-page reads, compression+S3, scale
```

## License

MIT © [Faruk Ada](https://github.com/FarukAda)

---

<p align="center">
  Built with <a href="https://langchain-ai.github.io/langgraphjs/">LangGraph</a> · <a href="https://aws.amazon.com/sdk-for-javascript/">AWS SDK v3</a> · <a href="https://github.com/langchain-ai/langchainjs">LangChain</a>
  <br/>
  <a href="https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts">npm</a> · <a href="https://github.com/FarukAda/aws-langgraph-dynamodb-ts">GitHub</a> · <a href="https://github.com/FarukAda/aws-langgraph-dynamodb-ts/issues">Issues</a>
</p>
