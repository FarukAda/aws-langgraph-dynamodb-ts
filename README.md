# @farukada/aws-langgraph-dynamodb-ts

[![npm version](https://img.shields.io/npm/v/%40farukada%2Faws-langgraph-dynamodb-ts)](https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts)
[![Sponsor](https://img.shields.io/badge/Sponsor-FarukAda-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/FarukAda)
![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![AWS SDK v3](https://img.shields.io/badge/AWS%20SDK-v3-FF9900)

A DynamoDB persistence layer for [LangGraph](https://langchain-ai.github.io/langgraphjs/) in TypeScript (ESM, Node ≥ 22). It provides three LangGraph/LangChain adapters plus a factory:

- **`DynamoDBSaver`** — checkpoint + pending-writes persistence (`extends BaseCheckpointSaver`).
- **`DynamoDBStore`** — long-term memory with optional semantic search (`extends BaseStore`).
- **`DynamoDBChatMessageHistory`** — multi-session chat history, with a single-session adapter for `RunnableWithMessageHistory`.
- **`DynamoDBFactory`** — convenience constructors, including `createAll` (one shared client + a `destroy()`).

Every adapter supports optional **gzip compression**, **S3 offloading** of payloads over DynamoDB's 400 KB item limit, and **TTL-based expiry**. The store additionally supports **vector semantic search** via any LangChain `Embeddings` implementation.

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

Every adapter uses the **same simple key schema**: a string partition key `PK`, a string sort key `SK`, and an optional Number `ttl` attribute for expiry. Because the key spaces never collide, **a single table can back all three adapters**, or you can use a separate table per adapter — your choice via the `tableName` option.

| Attribute | Type | Role |
| --- | --- | --- |
| `PK` | String (HASH) | partition key |
| `SK` | String (RANGE) | sort key |
| `ttl` | Number | (optional) Unix-epoch-seconds expiry; enable DynamoDB TTL on this attribute |

How each adapter lays out keys (informational — you don't manage this):

- **Checkpointer** — `PK = <thread_id>`; `SK` = `META#<ns>#<checkpoint_id>` (metadata), `PAYLOAD#<ns>#<checkpoint_id>` (checkpoint), `WRITE#<ns>#<checkpoint_id>#<task>#<idx>` (pending writes).
- **Store** — `PK = <namespace joined by '#'>`; `SK = <key>`.
- **Chat history** — `PK = <sessionId>`; `SK = SESSION` (one item per session).

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
| `ttl` | `{ days: number }` \| `{ seconds: number }` | all | expiry written to the `ttl` attribute |
| `logger` | `Logger` | all | per-instance logger (default: silent) |
| `compression` | `CompressionConfig` | all | `{ enabled, minSizeBytes?, level?, maxDecompressedBytes? }` |
| `s3` | `S3OffloadConfig` | all | offload large payloads to S3 (see below) |
| `serde` | `SerializerProtocol` | all | serializer override (checkpointer defaults to LangGraph's; store/history to JSON) |
| `index` | `IndexConfig` | store only | `{ dims, embeddings, fields? }` for semantic search |

`S3OffloadConfig`: `{ bucketName, keyPrefix?, thresholdBytes?, serverSideEncryption?, sseKmsKeyId?, clientConfig? }`.

## Features

**Gzip compression** — set `compression: { enabled: true }`. Payloads at or above `minSizeBytes` (default 1 KB) are gzipped transparently; decompression auto-detects on read and is guarded against decompression-bomb expansion (`maxDecompressedBytes`, default 50 MiB).

**S3 offloading** — set `s3: { bucketName }`. Any serialized payload at or above `thresholdBytes` (default 350 KB) is written to S3, with only a reference stored in DynamoDB; reads rehydrate transparently. Requires the optional `@aws-sdk/client-s3` peer. When a `ttl` is also configured the library best-effort installs a matching S3 lifecycle expiration rule (logged, never fatal). Deleting a checkpoint thread / chat session also best-effort deletes its offloaded objects.

**TTL expiry** — set `ttl: { days }` or `ttl: { seconds }`. The `ttl` attribute is written as a Unix-epoch-seconds timestamp; enable DynamoDB TTL on the `ttl` attribute for automatic deletion. Chat sessions store all messages in one item under one TTL, so a live session never develops mid-history gaps.

**Semantic search** (store) — provide `index` with a LangChain `Embeddings` implementation. On `put`, the configured `fields` are embedded and the vector is stored on the item; on `search` with a `query`, results are ranked by cosine similarity. Per-item indexing can be overridden via the `index` argument to `put` (`false` to skip, or a `string[]` of fields).

## Error handling

All errors thrown by the library extend `DynamoDbLangGraphError` and carry a stable `code` from the `ErrorCode` enum plus a native `cause` chain. Branch on `code`:

```typescript
import { ErrorCode, DynamoDbLangGraphError } from '@farukada/aws-langgraph-dynamodb-ts';

try {
  await store.put([''], 'k', { v: 1 });
} catch (error) {
  if (error instanceof DynamoDbLangGraphError && error.code === ErrorCode.VALIDATION) {
    // bad input
  }
}
```

`ErrorCode` values: `VALIDATION`, `NOT_FOUND`, `CONDITION_CONFLICT`, `RETRY_EXHAUSTED`, `BATCH_WRITE_INCOMPLETE`, `COMPRESSION_LIMIT`, `S3_OFFLOAD_FAILED`, `S3_ORPHAN_CLEANUP_FAILED`, `ABORTED`. Typed subclasses are exported where callers commonly branch: `ValidationError`, `ConflictError`, `RetryExhaustedError`, `BatchWriteIncompleteError`, `AbortError`.

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

`redactLogger` wraps a logger so secret-looking fields (access keys, tokens, passwords, …) are replaced with `[REDACTED]` in structured log arguments. `redactSecrets` exposes the same redaction for arbitrary objects.

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

This is a ground-up rewrite with intentional, breaking API and schema changes:

- **Table schema is now `PK`/`SK` strings** (one table for all adapters) instead of per-adapter custom key names. Existing data is not compatible — create the new table.
- **Single `tableName` option** per adapter (was `checkpointsTableName`/`writesTableName`, etc.).
- **One `ttl` option** — `{ days }` or `{ seconds }` — replaces `ttlDays`/`ttlSeconds`.
- **S3 config option renamed** `s3OffloadConfig` → `s3`.
- **Per-instance `logger` option** replaces the global `setGlobalLogger` singleton; default logging is now silent.
- **Unified error model** — all errors extend `DynamoDbLangGraphError` with an `ErrorCode`.

## Testing

```bash
npm test            # unit + static-guard + type tests, 100% coverage
npm run typecheck
npm run lint
npm run build
```

Real-AWS verification scripts live in `examples/` (each creates and tears down its own resources):

```bash
node examples/verify-checkpointer.mjs   # save/resume/writes/list/delete, compression, S3, TTL
node examples/verify-store.mjs          # filters, semantic search, S3 offload, TTL
node examples/verify-history.mjs        # multi-session, concurrency, RunnableWithMessageHistory agent
node examples/verify-factory.mjs        # shared-client createAll across all three adapters
```

## License

MIT © [Faruk Ada](https://github.com/FarukAda)

---

<p align="center">
  Built with <a href="https://langchain-ai.github.io/langgraphjs/">LangGraph</a> · <a href="https://aws.amazon.com/sdk-for-javascript/">AWS SDK v3</a> · <a href="https://github.com/langchain-ai/langchainjs">LangChain</a>
  <br/>
  <a href="https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts">npm</a> · <a href="https://github.com/FarukAda/aws-langgraph-dynamodb-ts">GitHub</a> · <a href="https://github.com/FarukAda/aws-langgraph-dynamodb-ts/issues">Issues</a>
</p>
