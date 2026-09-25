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
[![coverage 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)](#testing)
[![Sponsor](https://img.shields.io/badge/Sponsor-FarukAda-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/FarukAda)

Built with [LangGraph](https://langchain-ai.github.io/langgraphjs/) · [LangChain](https://github.com/langchain-ai/langchainjs) · [AWS SDK v3](https://aws.amazon.com/sdk-for-javascript/) — [npm](https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts) · [GitHub](https://github.com/FarukAda/aws-langgraph-dynamodb-ts) · [Issues](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/issues)

---

A DynamoDB persistence layer for [LangGraph](https://langchain-ai.github.io/langgraphjs/) in TypeScript (CommonJS build, consumable from both ESM and CommonJS; Node ≥ 22). It provides three LangGraph/LangChain adapters — a checkpoint saver, a long-term memory store and a chat message history — plus a factory, and all three can live in a single DynamoDB table.

Every adapter supports optional **gzip compression**, **S3 offloading** of payloads over DynamoDB's 400 KB item limit, and **TTL-based expiry**. The store additionally supports **vector semantic search** — in-DynamoDB by default, or delegated to a **pluggable `VectorBackend`** (e.g. OpenSearch / pgvector) for large corpora — via any LangChain `Embeddings` implementation.

> **Independent project.** Maintained by [Faruk Ada](https://github.com/FarukAda), one person, in their own time — see [SUPPORT.md](SUPPORT.md) for what that means for response times. It is **not affiliated with, endorsed by, or sponsored by** Amazon Web Services, Inc. or LangChain, Inc. "AWS", "Amazon DynamoDB" and "Amazon S3" are trademarks of Amazon.com, Inc. or its affiliates; "LangChain" and "LangGraph" are trademarks of LangChain, Inc. They are used here only to name the service this package talks to and the framework it plugs into.

## At a glance

| | |
| --- | --- |
| **What it is** | Three LangGraph/LangChain adapters — a checkpoint saver, a memory store and a chat message history — plus a factory, over one DynamoDB table. [Architecture](#architecture) lists them; [Table schema](#table-schema) shows the layout. |
| **Maturity** | Release candidates of `1.0` come before `1.0.0`; the npm badge above shows the current version. [Versioning and support](#versioning-and-support) says what each release promises and who maintains it. |
| **What it costs** | Nothing for the package: you pay for DynamoDB, for S3 when payloads offload, and for your embeddings provider and `VectorBackend` if you use them. [What each operation costs](#what-each-operation-costs) gives the requests per call. |
| **The limits that bite** | Without `s3`, a payload over 392 KB is refused; `thread_id` and `sessionId` are at most 1024 bytes, other key segments at most 256 bytes, and no identifier may contain `#`. In-DynamoDB semantic search refuses more than 1000 candidates by default (`maxSearchCandidates`, ceiling 100 000); [full table](#limits). |
| **When it breaks** | One error class, `DynamoDBLangGraphError`, with a `code` from the 20 `ErrorCode` members, a structured `context` and the AWS error as `cause`. [Error handling](#error-handling) is the section to read first. |
| **When *not* to use it** | A large vector corpus with no external `VectorBackend`, writes to one `thread_id` or `sessionId` beyond one partition's throughput ([hot partitions](#production-notes)), or checkpoints to import from another saver, for which the package has no importer. Chat turns written to one session by several processes are ordered by their wall clocks ([chat history semantics](#chat-history-semantics)). |

## Table of Contents

- [Key features](#key-features)
- [Versioning and support](#versioning-and-support)
- [Architecture](#architecture)
- [Quick start](#quick-start)
  - [Installation](#installation)
  - [Peer dependencies](#peer-dependencies)
  - [Runtime requirements](#runtime-requirements)
  - [Minimal agent](#minimal-agent)
- [Usage examples](#usage-examples)
  - [Resume a thread and read its history](#resume-a-thread-and-read-its-history)
  - [Long-term memory with semantic search](#long-term-memory-with-semantic-search)
  - [Memory inside a graph](#memory-inside-a-graph)
  - [Chat history](#chat-history)
  - [RunnableWithMessageHistory](#runnablewithmessagehistory)
  - [One client for all three adapters](#one-client-for-all-three-adapters)
  - [Large payloads: S3 offload and compression](#large-payloads-s3-offload-and-compression)
  - [Expiry with TTL](#expiry-with-ttl)
  - [Bring your own DynamoDB client](#bring-your-own-dynamodb-client)
  - [Cancellation and timeouts](#cancellation-and-timeouts)
  - [Listing sessions, threads and namespaces](#listing-sessions-threads-and-namespaces)
- [Configuration reference](#configuration-reference)
  - [Shared options](#shared-options)
  - [Adapter options](#adapter-options)
  - [Nested options](#nested-options)
  - [Per-call options](#per-call-options)
- [Retries and backoff](#retries-and-backoff)
- [Error handling](#error-handling)
- [Logging](#logging)
- [Tracing and metrics](#tracing-and-metrics)
- [Advanced features](#advanced-features)
- [Production notes](#production-notes)
- [Migrating from earlier versions](#migrating-from-earlier-versions)
- [Infrastructure setup](#infrastructure-setup)
- [Table schema](#table-schema)
- [IAM permissions](#iam-permissions)
- [Operations](#operations)
- [Versioning and compatibility](#versioning-and-compatibility)
- [Testing](#testing)
- [Design decisions and evidence](#design-decisions-and-evidence)
- [Support and policies](#support-and-policies)
- [License](#license)

## Key features

| Feature | Description |
| --- | --- |
| **One table, disjoint key spaces** | All three adapters share one `PK`/`SK` table. Each tags its partition keys with its own prefix — `CHKPT#`, `STORE#`, `HIST#` — which differ in their first character, so one id reused as a `thread_id` and a `sessionId` can never touch the other adapter's rows. [Table schema](#table-schema) |
| **Tested against LangGraph itself** | The conformance tier runs LangChain's official checkpointer validation suite and a compiled LangGraph graph (interrupt and resume, subgraph namespaces, forks, `Send` fan-out) over the saver; the integration tier checks parity with `InMemoryStore` and `InMemoryChatMessageHistory`. [What the suite proves](#what-the-suite-does-and-does-not-prove) |
| **S3 offload behind a descriptor** | A payload at or above `s3.thresholdBytes` (default 350 KB) goes to S3 and the row keeps a small versioned descriptor; every write uploads under an id of its own, conditionally, so no two writes share an object. [S3 offloading](#s3-offloading) |
| **Gzip with a decompression guard** | `compression: { enabled: true }` gzips payloads of at least `minSizeBytes` (default 1 KB) when that saves more than 10%; reads refuse to inflate past `maxDecompressedBytes` (default 50 MiB). [Gzip compression](#gzip-compression) |
| **TTL with matching S3 lifecycle rules** | `ttl: { days }` or `{ seconds }` stamps a `ttl` attribute and every read hides expired rows during DynamoDB's sweep lag; `ensureS3LifecycleRule()` installs the lifecycle rules that expire the offloaded objects to match. [S3 lifecycle rules](#s3-lifecycle-rules) |
| **Semantic search, in DynamoDB or delegated** | With an `index`, the store embeds each configured field and ranks by the best-matching vector in process; with a `vectorBackend` it hands similarity search to OpenSearch, pgvector or anything else, and DynamoDB stays the canonical copy. [Semantic search](#semantic-search) |
| **Listings without table scans** | An opt-in recency index (`indexName`, a GSI on `gsi1pk`/`gsi1sk`) turns `history.listSessions()` and a thread-less `saver.list()` from a `Scan` into sharded `Query`s, newest first; `backfillRecencyIndex` prepares existing rows. [Maintenance operations](#maintenance-operations) |
| **Cancellation** | The long-running methods take an `AbortSignal`, which reaches the AWS SDK on every DynamoDB request and on both S3 transfers, so a cancel ends a request in flight and rejects with `ABORTED`. [Cancellation](#cancellation) |
| **One error class, stable codes, validated input** | Every failure is a `DynamoDBLangGraphError` with a branchable `code`; no raw AWS error escapes a public method. Options and identifiers are checked before any request, and a mistake is a `VALIDATION` error naming the field. [Error handling](#error-handling) |
| **Silent by default, redactable logging** | Nothing is written to your console unless you pass a `logger`; `redactLogger` replaces secret-looking fields with `[REDACTED]` in what you do log. [Logging](#logging) |
| **Supply-chain provenance** | Published to npm with provenance attestations. [npm provenance](https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts#provenance) |

## Versioning and support

- **Semantic versioning.** A **minor** may add exports, optional options and parameters, optional fields on returned objects, and widen accepted inputs. A **patch** only fixes behaviour against what is documented. Removing or renaming an export, making an option required, narrowing an input or changing a return type needs a **major**, preceded by a deprecation.
- **The data on disk.** Every `1.x` release reads every row a `1.0` release wrote; key formats, required attributes and the payload descriptor change only in a major, with a migration note.
- **Errors.** `ErrorCode` values are append-only in `1.x`. Error and log *messages* are not covered — branch on `code` and the structured fields, never on text.
- **Runtimes.** Node.js 22, 24 and 26; consumers on TypeScript 5.x and later. Peer ranges are in [Supported runtimes and peers](#supported-runtimes-and-peers).
- **Who maintains it.** One person, in their own time; response times are best effort ([SUPPORT.md](SUPPORT.md)). Security reports go through [SECURITY.md](SECURITY.md), which commits to an acknowledgement within three business days.

Full detail: [Versioning and compatibility](#versioning-and-compatibility).

## Architecture

```mermaid
graph LR
    App["Your LangGraph / LangChain app"] --> Saver["DynamoDBSaver"]
    App --> Store["DynamoDBStore"]
    App --> History["DynamoDBChatMessageHistory"]
    Factory["DynamoDBFactory.createAll()"] -. "one shared client" .-> Saver
    Factory -.-> Store
    Factory -.-> History
    Saver --> Table[("DynamoDB table<br/>PK / SK, optional gsi1")]
    Store --> Table
    History --> Table
    Saver -. "payload at or above s3.thresholdBytes" .-> Bucket[("S3 bucket, optional")]
    Store -.-> Bucket
    History -.-> Bucket
    Store -. "embedDocuments / embedQuery" .-> Embeddings["LangChain Embeddings, optional"]
    Store -. "similarity search" .-> Backend["VectorBackend, optional"]
```

Four classes do the work:

- **`DynamoDBSaver`** — checkpoint + pending-writes persistence (`extends BaseCheckpointSaver`).
- **`DynamoDBStore`** — long-term memory with optional semantic search (`extends BaseStore`).
- **`DynamoDBChatMessageHistory`** — multi-session chat history, with a single-session adapter (`forSession`) for `RunnableWithMessageHistory`.
- **`DynamoDBFactory`** — convenience constructors, including `createAll` (one shared client + a `destroy()`).

Every payload — a checkpoint, its metadata, a pending write, a store value, a chat message — goes through the same codec.

- **On the way in**, the adapter's `serde` serializes it, and zero bytes are refused. With `compression` enabled, bytes of at least `minSizeBytes` are gzipped, and kept gzipped only when that saves more than 10%. With `s3` configured, stored bytes at or above `thresholdBytes` are uploaded with `If-None-Match: *`, under a key made of the row's identifiers and the write's id, with the row's key as S3 metadata. The row keeps a descriptor saying where the payload is.
- **On the way out**, an offloaded key must lie under the row's own path before it is downloaded. The download is capped at `s3.maxDownloadBytes` and the gunzip at `compression.maxDecompressedBytes`, 50 MiB each by default. The configured `serde` then decodes the bytes.

**Checkpoint write — `saver.put`:**

1. The config and every identifier are validated before anything is encoded.
2. The checkpoint, then its metadata, are encoded as above; the saver's `serde` defaults to LangGraph's `JsonPlusSerializer`. If the metadata cannot be encoded, the checkpoint's upload is released at once.
3. Without `s3`, a payload over 392 KB is refused with a `VALIDATION` error naming `payload` before any write.
4. One `TransactWriteItems` writes the `META` row (the metadata descriptor, the parent checkpoint id, the recency-index keys) and the `PAYLOAD` row (the checkpoint descriptor), both stamped with the `ttl` when one is configured. It carries a client request token drawn once, so every retry re-sends the identical request and a retry after a lost acknowledgement is not applied twice.
5. If the transaction fails with `s3` configured and a payload was offloaded, a consistent `GetItem` of the row carrying the offloaded descriptor decides the outcome: the transaction committed after all (success), did not commit (this call's uploads are deleted, the error is thrown), or cannot be told (nothing is deleted, the error is thrown). With nothing offloaded there is nothing to protect: no read is spent and the error is thrown as it came.

**Checkpoint read — `saver.getTuple`:**

1. A config naming no thread answers `undefined`. Otherwise the `META` row is a consistent `GetItem` when `checkpoint_id` is given, or a consistent newest-first `Query` of the namespace's `META#` rows, 50 per page, keeping the first live one.
2. A consistent `GetItem` reads the `PAYLOAD` row; when it is not there the answer is `undefined`.
3. The checkpoint and the metadata are decoded while a consistent `Query` reads every pending `WRITE` row of the checkpoint, uncapped; superseded writes are dropped and the rest decoded `readConcurrency` at a time (8 by default).
4. A row whose format version `v` is newer than this release understands fails with `FORMAT_UNSUPPORTED`. A `META` row past its `ttl` is treated as absent, however long DynamoDB's sweep lags.

**Store — `store.put` and `store.search`:**

1. `put` reads the row it replaces with a consistent `GetItem` for its `createdAt`, revision and descriptor.
2. It embeds with `embedDocuments`: one vector per configured field onto the row, or — with a `vectorBackend` — one vector over the joined fields for the backend instead, never both. `index: false` embeds nothing.
3. It encodes the value (plain-JSON `JSON_SERDE` by default) under this put's own revision id and writes the row: a `PutItem`, or with `s3` a compare-and-swap on the revision it read — a one-item `TransactWriteItems` with a request token when the payload was offloaded. A failed write is read back before this put's upload is released.
4. Once the row is committed it releases the object the old row named, then syncs the `vectorBackend` best-effort: it upserts the new vector, or deletes the item's vector when the put has nothing to embed (`index: false`, or no indexable text). A backend failure is logged at `warn`, not thrown, and `reconcileVectorIndex` repairs it.
5. `search` with a `query` and a `vectorBackend` embeds the query, asks the backend for the top `offset + limit` matches, reads each canonical item from DynamoDB and applies `filter`, doubling the number it asks for until the page is full. It is capped too: a page with `offset + limit` over `maxSearchCandidates`, or one the filter still leaves short at that cap, is refused with a `VALIDATION` error.
6. Any other `search` — no `query`, or no `vectorBackend` — runs an eventually consistent `Query` of the `STORE#<namespace[0]>` partition (a `Scan` only for the empty prefix `[]`), decodes rows `readConcurrency` at a time and applies `filter` in process — stopping as soon as the page is full when there is nothing to rank, and otherwise refusing more than `maxSearchCandidates` rows before any decode, then ranking every candidate by cosine similarity to the embedded query.

**Chat history — `history.addMessages` and `history.getMessages`:**

1. `addMessages` validates the session id and every message before anything is sent; with a `ttl`, a consistent `GetItem` of the session row reads the conversation's expiry anchor, which every message then shares.
2. Each message is encoded under its own ULID (plain-JSON `JSON_SERDE` by default); if one fails, the uploads before it are released.
3. The messages are cut into chunks of at most 99 messages or 3.5 MB. Each chunk is one `TransactWriteItems` of its message rows plus the update of the `HISTORY#SESSION` row — the message count, `updatedAt`, the title and the TTL anchor — so the count never disagrees with the messages. If a later chunk fails, the chunks already committed are deleted and the session row reverted; a rollback that cannot finish is `COMPENSATION_FAILED`.
4. `getMessages` is a consistent `Query` of the session's `HISTORY#MSG#` rows — the whole session oldest first, or newest first up to `limit` — skipping expired rows and refusing a row this adapter did not write.
5. Messages are decoded `readConcurrency` at a time and returned oldest first. A message whose payload is permanently lost is handled by `onCorruptMessage` — `'skip'`, the default, logs it at `error` and leaves it out; `'throw'` fails the read — and every other failure fails the read under either setting.

The key each row is stored under is in [Table schema](#table-schema).

---

## Quick start

### Installation

```bash
npm install @farukada/aws-langgraph-dynamodb-ts \
  @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb \
  @langchain/core @langchain/langgraph-checkpoint \
  @langchain/langgraph
```

`@langchain/langgraph` is your application's own dependency rather than this package's: the minimal agent below imports it to build the graph. The two DynamoDB SDK packages already ship with this package as dependencies; they are listed so that your own code can import them, as [Bring your own DynamoDB client](#bring-your-own-dynamodb-client) does.

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
```

```js
const { DynamoDBSaver } = require('@farukada/aws-langgraph-dynamodb-ts'); // CommonJS
```

### Peer dependencies

| Package | Range | Needed for |
| --- | --- | --- |
| `@langchain/core` | `^1.2.11` | every adapter: messages, `Embeddings`, `RunnableConfig` |
| `@langchain/langgraph-checkpoint` | `^1.1.5` | every adapter: `BaseCheckpointSaver`, `BaseStore`, the serializer protocol |
| `@aws-sdk/client-s3` | `^3.1132.0` | S3 offloading only; an optional peer |
| `@langchain/langgraph` | any 1.x release depending on a supported `@langchain/langgraph-checkpoint` | your application's, not a peer: the graphs in the examples below |

`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` and `@aws-sdk/util-dynamodb` are regular dependencies and install with the package. What each range is tested against is in [Supported runtimes and peers](#supported-runtimes-and-peers).

### Runtime requirements

- **Node.js** 22 or later; CI runs 22, 24 and 26 on Linux, macOS and Windows.
- **Module format:** one CommonJS build, usable from both `import` and `require`, as shown above.
- **TypeScript:** the shipped declarations target TypeScript 5.x and later.
- **Tree-shaking:** the package declares `"sideEffects": false`.
- **Bundling:** the optional `@aws-sdk/client-s3` peer is loaded lazily through a dynamic `import()`, so a bundler (esbuild, rollup, webpack) must either have it installed or mark `@aws-sdk/*` external — CDK's `NodejsFunction` does the latter by default, a bare esbuild build does not.
- **Top-level `await`:** the samples in this README use it, which needs an ES module (a `.mjs` file, `"type": "module"`, or TypeScript emitting ES modules). In CommonJS, wrap a sample's body in an `async` function and call it.

### Minimal agent

The table must exist before the first call: [Infrastructure setup](#infrastructure-setup) creates it, and [IAM permissions](#iam-permissions) lists the actions the adapters call. This is a complete LangGraph agent whose conversation lives in DynamoDB:

```typescript
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts';

declare const model: BaseChatModel; // any LangChain chat model, e.g. ChatBedrockConverse

const checkpointer = new DynamoDBSaver({
  tableName: 'langgraph',
  clientConfig: { region: 'eu-west-1' },
});

const agent = new StateGraph(MessagesAnnotation)
  .addNode('model', async (state) => ({ messages: [await model.invoke(state.messages)] }))
  .addEdge(START, 'model')
  .addEdge('model', END)
  .compile({ checkpointer });

const thread = { configurable: { thread_id: 'user-42' } };
await agent.invoke({ messages: [{ role: 'user', content: 'My name is Ada.' }] }, thread);

// A later request, even from another process: the conversation is read back from DynamoDB.
const { messages } = await agent.invoke(
  { messages: [{ role: 'user', content: 'What is my name?' }] },
  thread,
);
console.log(messages.at(-1)?.content);

checkpointer.destroy(); // releases the DynamoDB client this saver created
```

Every step of the graph writes a checkpoint under `thread_id`, and the second `invoke` starts from the newest one, so the model sees both turns. The saver built its own client from `clientConfig`, which is why `destroy()` closes it; an injected `client` is never closed ([Bring your own DynamoDB client](#bring-your-own-dynamodb-client)). The [examples](examples/README.md) directory has runnable scripts against real AWS, including an agent on a Bedrock chat model whose only memory is `DynamoDBSaver`.

## Usage examples

Each example below compiles in CI against the package's source. A sample that uses `saver`, `store`, `history`, `model` or `embeddings` without constructing it assumes an adapter built as in the examples around it, a LangChain chat model and a LangChain `Embeddings`. The [examples](examples/README.md) directory holds scripts that run against real AWS.

### Resume a thread and read its history

Use this when a user comes back to a conversation, or when you need to show, audit or delete what a thread did.

```typescript
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';

const agent = new StateGraph(MessagesAnnotation)
  .addNode('model', async (state) => ({ messages: [await model.invoke(state.messages)] }))
  .addEdge(START, 'model')
  .addEdge('model', END)
  .compile({ checkpointer: saver });

const thread = { configurable: { thread_id: 'user-42' } };

// Resume: the graph starts from the thread's newest checkpoint in DynamoDB.
await agent.invoke({ messages: [{ role: 'user', content: 'Where were we?' }] }, thread);

// The newest checkpoint of the thread. A thread with no checkpoint reads as
// { values: {}, next: [] }, so `messages` may be absent.
const current = await agent.getState(thread);
console.log(current.values.messages?.length ?? 0, current.next);

// Every checkpoint of the thread, newest first.
for await (const snapshot of agent.getStateHistory(thread)) {
  console.log(snapshot.config.configurable?.checkpoint_id, snapshot.metadata?.step);
}

// Remove the thread: its checkpoints and pending writes, then (best-effort) their offloaded payloads.
await saver.deleteThread('user-42');
```

`invoke` on an existing `thread_id` continues from its newest checkpoint; on an unknown one it starts empty, and `getState` of an unknown thread returns empty `values` rather than throwing. `getState` reads through `saver.getTuple`, which is strongly consistent, so a checkpoint just written is always seen; `getStateHistory` reads through `saver.list`, which is eventually consistent. `deleteThread` reads the thread's partition once and deletes what it saw, so run it when no graph is still writing to the thread ([Checkpointer semantics](#checkpointer-semantics)).

### Long-term memory with semantic search

Use the store for facts that outlive one thread — a user's preferences, notes, documents — and search them by meaning, by field values, or both.

```typescript
import { BedrockEmbeddings } from '@langchain/aws';
import { DynamoDBStore } from '@farukada/aws-langgraph-dynamodb-ts';

const store = new DynamoDBStore({
  tableName: 'langgraph',
  clientConfig: { region: 'eu-west-1' },
  index: {
    dims: 1024,
    embeddings: new BedrockEmbeddings({ model: 'amazon.titan-embed-text-v2:0', region: 'eu-west-1' }),
    fields: ['text'], // which fields to embed; defaults to the whole document ('$')
  },
});

await store.put(['library'], 'doc-1', {
  text: 'Amazon DynamoDB is a serverless NoSQL database',
  kind: 'note',
  stars: 5,
});
await store.put(['library'], 'doc-2', {
  text: 'Espresso is a concentrated coffee',
  kind: 'recipe',
  stars: 3,
});

// Metadata filtering (operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin)
const notes = await store.search(['library'], { filter: { kind: 'note', stars: { $gte: 4 } } });
const either = await store.search(['library'], { filter: { kind: { $in: ['note', 'recipe'] } } });

// Semantic search — ranked by cosine similarity to the query embedding
const hits = await store.search(['library'], { query: 'cloud database', limit: 5 });
//=> doc-1 should rank first, with a `score` on each SearchItem

await store.get(['library'], 'doc-1');
await store.delete(['library'], 'doc-1');
await store.listNamespaces({ prefix: ['library'], maxDepth: 1 });

store.destroy();
```

With an `index`, `put` embeds each configured field separately and `search` ranks an item by its best-matching vector, in process; a prefix holding more than `maxSearchCandidates` candidates (default 1000) is refused with a `VALIDATION` error rather than ranked. A filter names top-level fields of the stored value, every condition must hold, and `$gt`/`$gte`/`$lt`/`$lte` compare like types only — numbers with numbers, strings with strings — where `InMemoryStore` converts both sides with `Number()` ([Differences from the reference implementations](#differences-from-the-reference-implementations)). For a corpus larger than that cap, configure a `vectorBackend` ([Semantic search](#semantic-search), [Vector index consistency](#vector-index-consistency)).

### Memory inside a graph

Use this when a node should recall what it learned about a user in earlier threads, and remember new facts for later ones.

```typescript
import { SystemMessage } from '@langchain/core/messages';
import {
  END,
  type LangGraphRunnableConfig,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';

async function respond(state: typeof MessagesAnnotation.State, config: LangGraphRunnableConfig) {
  const userId: unknown = config.configurable?.user_id;
  if (typeof userId !== 'string' || userId === '') {
    throw new Error('configurable.user_id is required: memories are namespaced per user');
  }
  const query = String(state.messages.at(-1)?.content ?? '');

  const memories = (await config.store?.search(['memories', userId], { query, limit: 3 })) ?? [];
  const recalled = memories.map((memory) => String(memory.value.text)).join('\n');

  const reply = await model.invoke([
    new SystemMessage(`What you know about this user:\n${recalled}`),
    ...state.messages,
  ]);
  // Stored verbatim to keep the sample short; a real app would extract facts first.
  await config.store?.put(['memories', userId], randomUUID(), { text: query });
  return { messages: [reply] };
}

const agent = new StateGraph(MessagesAnnotation)
  .addNode('respond', respond)
  .addEdge(START, 'respond')
  .addEdge('respond', END)
  .compile({ checkpointer: saver, store });

await agent.invoke(
  { messages: [{ role: 'user', content: 'I prefer answers in French.' }] },
  { configurable: { thread_id: 'thread-7', user_id: 'user-42' } },
);
```

The checkpointer keeps this thread; the store keeps what outlives it, keyed by user rather than by thread. Inside a graph LangGraph reaches the store through `batch()`, so upstream's `put()`-only namespace rules (no `.` in a label, no `"langgraph"` root) do not apply there, and the per-item `index` argument of `put` is not forwarded ([Production notes](#production-notes), [Differences from `InMemoryStore`](#differences-from-inmemorystore)). Without an `index` on the store, a `search` with a `query` falls back to a plain, unranked search.

### Chat history

Use this when your application stores a plain message list per session — a chat UI, a support transcript — rather than a LangGraph state.

```typescript
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { DynamoDBChatMessageHistory } from '@farukada/aws-langgraph-dynamodb-ts';

const history = new DynamoDBChatMessageHistory({
  tableName: 'langgraph',
  clientConfig: { region: 'eu-west-1' },
});

await history.addMessages('session-1', [new HumanMessage('Hello!')]);
await history.addMessage('session-1', new AIMessage('Hi!'));
const messages = await history.getMessages('session-1');
const recent = await history.getMessages('session-1', { limit: 20 }); // newest 20, chronological
await history.clear('session-1');

history.destroy();
```

By default a read returns the whole session. `getMessages(sessionId, { limit, before })` returns a window instead — the newest `limit` messages, or only those appended before `before` — and `history.forSession(sessionId, { limit: 50 })` bounds what the adapter feeds the chain to the newest fifty, so a long-lived session does not grow the prompt without limit.

`forSession` checks its arguments when it is called: a malformed session id, a window naming a key other than `limit`, or a `limit` that is not an integer of at least 1 and at most 10,000 throws `VALIDATION` synchronously, rather than returning an adapter that fails on first use. `RunnableWithMessageHistory` calls `getMessageHistory` from inside an async method, so there the throw surfaces as a rejected invocation.

Listing sessions is in [Listing sessions, threads and namespaces](#listing-sessions-threads-and-namespaces).

### RunnableWithMessageHistory

Use this to give a LangChain chain (not a graph) a memory, through the single-session adapter `forSession`.

```typescript
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { RunnableWithMessageHistory } from '@langchain/core/runnables';
import { DynamoDBChatMessageHistory } from '@farukada/aws-langgraph-dynamodb-ts';

const history = new DynamoDBChatMessageHistory({
  tableName: 'langgraph',
  clientConfig: { region: 'eu-west-1' },
});

const prompt = ChatPromptTemplate.fromMessages([
  ['system', 'You are a helpful assistant.'],
  new MessagesPlaceholder('history'),
  ['human', '{input}'],
]);

const chat = new RunnableWithMessageHistory({
  runnable: prompt.pipe(model),
  getMessageHistory: (sessionId) => history.forSession(sessionId, { limit: 50 }),
  inputMessagesKey: 'input',
  historyMessagesKey: 'history',
});

const reply = await chat.invoke(
  { input: 'Hi, I am Ada.' },
  { configurable: { sessionId: 'session-1' } },
);

history.destroy();
```

Before each call the chain reads the newest fifty messages of the session into `{history}`; after it, the input and the reply are appended to the session. The window only bounds what is read — every message stays stored until `clear()` or its `ttl`.

### One client for all three adapters

Use the factory when one process runs the checkpointer, the store and the history together and should hold one DynamoDB client and one set of defaults.

```typescript
import { HumanMessage } from '@langchain/core/messages';
import { DynamoDBFactory } from '@farukada/aws-langgraph-dynamodb-ts';

const factory = new DynamoDBFactory({
  clientConfig: { region: 'eu-west-1' },
  ttl: { days: 30 },
  compression: { enabled: true },
});

const { saver, store, history, destroy } = factory.createAll({
  saver: { tableName: 'langgraph' },
  store: { tableName: 'langgraph', index: { dims: 1024, embeddings } },
  history: { tableName: 'langgraph' },
});

try {
  await store.put(['users', 'user-42'], 'profile', { text: 'Prefers French' });
  await history.addMessage('session-1', new HumanMessage('Bonjour'));
  // ... compile graphs with saver and store ...
} finally {
  destroy(); // closes the one shared client
}
```

`createAll` builds all three adapters on **one shared DynamoDB client** and returns a single `destroy()` that tears everything down.

Any section may be omitted (`createAll({ store: { tableName } })` returns `saver` and `history` as `undefined`), the factory's own `ttl`, `compression`, `s3`, `retry` and `logger` apply to every adapter unless a section overrides them, and `createSaver`, `createStore` and `createChatMessageHistory` build one adapter each on its own client with the same defaults.

`destroy()` on an adapter — `DynamoDBSaver`, `DynamoDBStore` (also `stop()`) or `DynamoDBChatMessageHistory` — offers **every** resource it owns its release before it reports anything, and then raises the first failure, so a client that refuses to close can no longer strand the one behind it. A `client` you injected is yours and is never destroyed. The factory's `destroy()` is the deliberate exception: it tears down three adapters at once, so it releases them all, logs any that failed and never throws.

The argument of each `create*` method, and each `createAll` section, is one adapter's options, and a mistake in it is named the way that adapter's constructor names it: `options` for a value that is not an object — `null` included, so a `null` section is refused rather than skipped — and `options.<key>`, `tableName` and so on for one inside it. `createAll` also refuses a key other than `saver`, `store` and `history`, naming `options.<key>`. The factory's own options are checked when it is constructed: options that are not an object, an unknown key, a `client` beside a `clientConfig`, a `clientConfig` that is not an object, and a `logger` missing one of its four methods, since `createAll` logs its own teardown failures through it. Its `ttl`, `compression`, `s3` and `retry` are checked by each adapter that inherits them, since an adapter's own options may replace them.

### Large payloads: S3 offload and compression

Use this when a checkpoint, a stored value or a message can approach DynamoDB's 400 KB item limit — long tool outputs, documents in state, many messages in one checkpoint.

```typescript
import { DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts';

const saver = new DynamoDBSaver({
  tableName: 'langgraph',
  clientConfig: { region: 'eu-west-1' }, // the S3 client uses this region too
  compression: { enabled: true },
  s3: { bucketName: 'my-langgraph-payloads' },
  ttl: { days: 30 },
});

await saver.ensureS3LifecycleRule(); // once, from a deployment step

saver.destroy();
```

Compression gzips a payload of at least 1024 bytes at level 6 and keeps the gzipped form only when it is more than 10% smaller. A stored payload of at least 350 KB goes to S3 under the saver's own prefix, `langgraph-checkpoints/checkpointer/`, and the row keeps a descriptor pointing at it; without `s3`, a payload over 392 KB is refused. The S3 client inherits the DynamoDB `clientConfig.region` unless `s3.clientConfig.region` names another, and it needs the optional `@aws-sdk/client-s3` peer. `ensureS3LifecycleRule()` installs the rules that expire offloaded objects to match the `ttl`; it throws when it cannot write them, so it belongs in a deployment step ([S3 lifecycle rules](#s3-lifecycle-rules), [S3 offloading](#s3-offloading)).

### Expiry with TTL

Use this when conversations and memories should disappear on their own after a retention period.

```typescript
import {
  DynamoDBChatMessageHistory,
  DynamoDBSaver,
  DynamoDBStore,
} from '@farukada/aws-langgraph-dynamodb-ts';

const table = { tableName: 'langgraph', clientConfig: { region: 'eu-west-1' } };

const saver = new DynamoDBSaver({ ...table, ttl: { days: 30 } });
const store = new DynamoDBStore({ ...table, ttl: { days: 365 } });
const history = new DynamoDBChatMessageHistory({ ...table, ttl: { seconds: 86_400 } });

saver.destroy();
store.destroy();
history.destroy();
```

`ttl` takes one form, `{ days }` or `{ seconds }`, capped at five years, and is written to the `ttl` attribute as Unix-epoch seconds; enable DynamoDB TTL on that attribute for rows to be deleted. DynamoDB can take up to about 48 hours to sweep an expired row, so every read filters rows past their `ttl` in the meantime. Chat history anchors one TTL for the whole conversation on its session row, set when the session is created and shared by every message. Turning `ttl` on for a table that already holds sessions stamps the session row and every *new* message only: message rows written before keep no `ttl` and outlive their session, so clear or backfill those sessions ([TTL expiry](#ttl-expiry)).

### Bring your own DynamoDB client

Use this when your application already configures a DynamoDB client — credentials, a VPC endpoint, tracing middleware — and the adapters should share it.

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts';

const client = DynamoDBDocument.from(
  new DynamoDBClient({
    region: 'eu-west-1',
    maxAttempts: 1, // the library retries; SDK retries would stack inside its budget
    requestHandler: { requestTimeout: 10_000, throwOnRequestTimeout: true },
  }),
);

const saver = new DynamoDBSaver({ tableName: 'langgraph', client });
saver.destroy(); // does not close `client`: an injected client is yours
```

The adapter takes a `DynamoDBDocument`, not a raw `DynamoDBClient`, and uses it exactly as handed over. `maxAttempts: 1` keeps the library's retry layer the only one — an injected client whose SDK retries are on logs a `warn` at construction — and the request timeout bounds a single attempt, which `maxAttempts: 1` alone does not ([Retries and backoff](#retries-and-backoff)).

### Cancellation and timeouts

Use this to bound how long a request may wait on DynamoDB, or to stop work when the caller has gone away. A signal passed to `invoke` bounds the whole run, the model calls included, so size it for the slowest turn you accept rather than for one DynamoDB request.

```typescript
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ErrorCode, isDynamoDBLangGraphError } from '@farukada/aws-langgraph-dynamodb-ts';

const agent = new StateGraph(MessagesAnnotation)
  .addNode('model', async (state) => ({ messages: [await model.invoke(state.messages)] }))
  .addEdge(START, 'model')
  .addEdge('model', END)
  .compile({ checkpointer: saver });
const thread = { configurable: { thread_id: 'user-42' } };

const signal = AbortSignal.timeout(30_000); // the whole turn: DynamoDB, S3 and the model
try {
  const recent = await history.getMessages('session-1', { limit: 20, signal });
  await agent.invoke({ messages: [{ role: 'user', content: 'Hello' }] }, { ...thread, signal });
} catch (error) {
  const e = error as Error;
  if (isDynamoDBLangGraphError(e) && e.code === ErrorCode.ABORTED) {
    console.warn('cancelled during a DynamoDB or S3 call', e.context.operation);
  } else if (signal.aborted) {
    console.warn('cancelled by LangGraph outside a saver call');
  } else {
    throw error;
  }
}
```

The signal reaches the AWS SDK on every DynamoDB request and S3 transfer, so a cancel ends a request in flight and rejects with `ABORTED`. LangGraph passes `config.signal` to the saver, and it also checks the signal itself: a timeout that fires while a node runs rejects `invoke` with LangGraph's own error rather than `ABORTED`, which is why the sample tests `signal.aborted` as well. `store.get`, `store.put` and `store.delete` take no signal, because upstream's `BaseStore` gives them no parameter for one ([Cancellation](#cancellation)).

### Listing sessions, threads and namespaces

Use this for an admin view or a "your conversations" page. Paging sessions by cursor needs the recency index, so the adapters here are built with `indexName`.

```typescript
import { DynamoDBChatMessageHistory, DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts';

const table = { tableName: 'langgraph', clientConfig: { region: 'eu-west-1' }, indexName: 'gsi1' };
const history = new DynamoDBChatMessageHistory(table);
const saver = new DynamoDBSaver(table);

// With `indexName`: newest-updated first, paged by cursor.
// Each page is { sessions: [{ sessionId, title, messageCount, expiresAt?, ... }], nextCursor?: string }
let cursor: string | undefined;
do {
  const page = await history.listSessions({ limit: 50, cursor });
  for (const session of page.sessions) {
    console.log(session.sessionId, session.title, session.messageCount, session.updatedAt);
  }
  cursor = page.nextCursor;
} while (cursor);

// Checkpoints of every thread in the table, newest first, through the recency index.
for await (const tuple of saver.list({}, { limit: 20 })) {
  console.log(tuple.config.configurable?.thread_id);
}

await store.listNamespaces({ prefix: ['memories'], maxDepth: 2 });

history.destroy();
saver.destroy();
```

A `cursor` requires `indexName` and is refused without it. Without `indexName`, `listSessions` is a table scan that cannot be paged: `{ limit: 50 }` returns the newest fifty, and omitting `limit` returns every session. That unpaged scan is still capped: past `maxItems` rows (default 10 000) or `maxIterations` pages (default 1000) it fails with `RESULT_TRUNCATED` rather than returning a partial list. Stop when `nextCursor` is absent, not when a page looks short — expired rows are dropped after the read. These listings cross tenants ([Multi-tenant deployments](#multi-tenant-deployments)), and `backfillRecencyIndex()` must run before `indexName` is set on a table that already holds rows ([Maintenance operations](#maintenance-operations)); the index definition is in [Infrastructure setup](#infrastructure-setup).

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

Payloads live under one reserved attribute per row kind (`checkpoint`, `metadata`, `value`, `message`) as a **payload descriptor**: `{ schemaVersion: 1, location: 'INLINE' | 'S3', serdeType, compressed, bytes | s3Key }`. This shape is a compatibility contract: unknown fields are ignored, a missing `schemaVersion` reads as 1, and a higher `schemaVersion` or an unknown `location` is refused with a `VALIDATION` error (field `descriptor`) rather than misread. Offloaded S3 keys are `<keyPrefix><the row's identifiers, each base64url-encoded>/<write id>.bin` (for a history message, whose own ULID is the write id, the identifiers above it are its session) — the row above the id, so an object belongs to exactly one row, and below it the id of the write that uploaded it, so two writes never share an object, even when they store the same bytes. The identifier segments are trivially reversible — treat S3 keys and `S3_OFFLOAD_FAILED` error context as identifier-bearing in your log-redaction policy.

**What the default serializers do with a value JavaScript can hold and JSON cannot.** The checkpointer defaults to LangGraph's `JsonPlusSerializer`; the store and history adapters default to this package's plain-JSON `JSON_SERDE`, which is exported, so a checkpointer can be given it too (see [Trust boundary](#trust-boundary) for why you might). They are two different serializers and they disagree, in both directions, and nothing is recorded anywhere to say a value was substituted — so the table below belongs in the decision of whether to pass a `serde` of your own. Each row was measured, not inferred from the implementations.

| A value JavaScript can hold | `JSON_SERDE` (store, history) | `JsonPlusSerializer` (checkpointer) |
| --- | --- | --- |
| `Map`, `Set` | stored as `{}`; every entry is gone | round-trips as a real `Map`/`Set` |
| `Uint8Array` | an index-keyed object, `{"0":1,"1":2}` | round-trips as a `Uint8Array` |
| `Date` | an ISO string | an ISO string — **neither** default round-trips one |
| `NaN`, `Infinity` | `null` | `null` |
| `-0` | `0` | `0` |
| `undefined` as an object's value | the key is dropped | the key survives, still holding `undefined` |
| `undefined` as an array element | `null` | `undefined` |
| a function or symbol *inside* an object or array | dropped from the object, `null` in an array | dropped from the object, `null` in an array |
| a `BigInt` anywhere in the value | refused at the write: `VALIDATION` naming `value` | the **whole payload** becomes the string `"[unable to serialize, circular reference is too complex to analyze]"` |
| a circular reference | refused at the write: `VALIDATION` naming `value` | the object is kept, with `"[Circular]"` written at the cycle |
| a value that *is* `undefined` | refused at the write | a 27-byte marker; reads back as `undefined` |
| a value that *is* a function or a symbol | refused at the write | zero bytes, refused by this package before the write |

Two rows deserve reading twice. The `BigInt` row is the worst outcome either default produces: one `BigInt` in one nested field of a checkpoint reads back as that placeholder string **instead of your entire state**, not instead of the field that held it, under a message naming a cause it does not have. And the `Map`/`Set`/`Uint8Array` rows are why moving an adapter from one default to the other is not free in either direction: plain JSON loses them, and the checkpointer default restores them by instantiating the class a stored record names.

What no serializer may do is produce **no bytes at all**: zero bytes is not a document in any format, and every later read of such a row fails to parse it, so it is refused at the write with a `VALIDATION` error naming `value`, before anything is stored and before any object is uploaded. The refusal binds whichever `serde` is configured, so a `serde` of your own may not encode any value it accepts to zero bytes; an encoding that legitimately produces an empty buffer needs a byte of framing of its own.

How each adapter lays out keys (informational — you don't manage this):

- **Checkpointer** — `PK = CHKPT#<thread_id>`; `SK` = `META#<ns>#<checkpoint_id>` (metadata), `PAYLOAD#<ns>#<checkpoint_id>` (checkpoint), `WRITE#<ns>#<checkpoint_id>#<task>#<idx>#<channel>` (pending writes).
- **Store** — `PK = STORE#<namespace[0]>` (the scope root); `SK = <namespace[1..]>#<key>`. This makes a scoped prefix search a native `Query` (`PK = root AND begins_with(SK, …)`); only a rootless "search everything" falls back to a `Scan`.
- **Chat history** — `PK = HIST#<sessionId>`; one item per message at `SK = HISTORY#MSG#<ULID>` (ordered, append-only) plus one `SK = HISTORY#SESSION` metadata item.

**Why the key spaces cannot collide.** Each adapter tags its partition key with its own prefix, and those three tags differ in their very first character, so no `CHKPT#…` can ever equal a `STORE#…` or `HIST#…` — whatever identifiers you pass. That matters because reusing one id across adapters (a "conversation id" used as both a `thread_id` and a `sessionId`) is an entirely ordinary design: without the tags it put unrelated adapters' rows in one partition, where `deleteThread()`/`history.clear()` would delete each other's data and identically-composed sort keys could silently overwrite one another.

Two further guards back that up, for a table holding hand-written rows or rows written before an upgrade: `deleteThread()`/`clear()` delete only rows whose sort key belongs to the calling adapter and log anything they leave in place, and every read tests a row against the attributes its kind must carry before decoding it, rather than trusting the key it was found at: the checkpointer's `META#` rows, the store's items and the chat history's session and message rows are each bound to the key they were found at as well, and a checkpoint's payload and pending-write rows are refused by the descriptor guard, which is the attribute a narrow would have tested. What a read does with a row that fails differs by read: the checkpointer's `getTuple` and `list` skip it and say so at `warn`, as does `store.reconcileVectorIndex`; `store.get` answers `null` and warns; `store.search` and `history.listSessions` drop it silently, because those two walk a whole prefix or table and one line per foreign row would fill a log rather than inform anyone; and a chat-history message read **reports** it whatever `onCorruptMessage` is set to — a conversation that quietly skips a row it cannot account for is the one outcome worse than a failed read. `history.reconcileMessageCount` refuses the same row for the same reason: a repaired count that disagreed with the read would describe a session nobody can open. Every one of those reads checks the row's own format version **before** its shape, so none of that applies to a row a newer release wrote: attribute names are this release's names rather than a later one's, and a row whose `v` is ahead of this reader is reported as `FORMAT_UNSUPPORTED` (field `v`) instead of being skipped as foreign because its attributes are no longer recognised. An offloaded payload's `s3Key` is bound the same way: before it is downloaded or deleted it must lie under the adapter's `keyPrefix` *and* the S3 path the row's own identifiers produce (`enc(thread_id)/…`, `enc(namespace…)/enc(key)`, `enc(sessionId)/…`), and a store row's `namespace`/`key` must agree with the partition and sort key it was found at — so a row planted in one partition can never make the library read or delete another tenant's object. A read of such a row fails with a `VALIDATION` error (field `s3Key`) on all three adapters — chat history included, whatever `onCorruptMessage` is set to, because a key outside the row's own path is a configuration or tenancy fault to report rather than a payload to write off — and a delete skips the object with a warning.

## Configuration reference

All adapters share a common base. Provide **either** a prebuilt `client` (which the adapter will not own/close) **or** `clientConfig` (the adapter builds and owns the client).

Options are checked at construction, and a mistake raises `VALIDATION` naming the option:

- **Unknown keys.** An option key the adapter does not read — a misspelling such as `readConcurency`, or an option that belongs to another adapter, such as `vectorBackend` on a saver — is refused, naming `options.<key>`, including in a `DynamoDBFactory` section. So is a key `ttl`, `retry`, `compression`, `s3` or `index` does not read (`ttl.<key>`, `index.<key>`, …): `ttl` takes only `days` or `seconds`, and `index` only `dims`, `embeddings` and `fields`.
- **AWS SDK configuration.** `clientConfig` and `s3.clientConfig` must be objects when given, so a string, `null` or an array is refused, naming `clientConfig` or `s3.clientConfig`. The keys inside them are passed to the AWS SDK unchecked: they belong to the SDK's `DynamoDBClientConfig` and `S3ClientConfig`, which gain keys between SDK releases, and your application may install a newer SDK than the one this package was built against, so a key list checked here would refuse valid configuration.
- **Collaborators.** `client`, `logger`, `serde`, `index.embeddings` and `vectorBackend` are checked by shape, not by class, so the check holds when two copies of a dependency are installed. A value that is not an object (`null` included) names the option; an object missing a method this package calls names the first one missing, such as `client.get` or `logger.debug`.
- **Ceilings.** A numeric option above its ceiling is refused. The ceilings are in the tables below and in [Limits](#limits).

In the tables below, *Default* is what an omitted option means and *Ceiling* is the largest value accepted; "—" means there is none. Every numeric option takes an integer. A constructor option takes one of at least 1, except `compression.level` and `compression.minSizeBytes`, which also accept `0`; a per-call `limit` or `offset` accepts `0` too, as its row says. `index.dims` is the one exception: it is not checked at construction at all, and only a positive integer is compared with the vectors the embeddings return — any other value turns that comparison off.

### Shared options

Every adapter — `DynamoDBSaver`, `DynamoDBStore` and `DynamoDBChatMessageHistory` — reads these.

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `tableName` | `string` | **required** | — | 3–255 characters from `[A-Za-z0-9_.-]`, the rule DynamoDB applies |
| `client` | `DynamoDBDocument` | — | — | a client you built and keep; see the note below the table |
| `clientConfig` | `DynamoDBClientConfig` | none: the SDK resolves the region and credentials itself | — | used to build a client when `client` is omitted; see the note below the table |
| `ttl` | `{ days: number }` \| `{ seconds: number }` | none: rows never expire | five years ([nested options](#nested-options)) | expiry written to the `ttl` attribute; one form only and no other key |
| `logger` | `Logger` | silent | — | per-instance logger; all four methods — `debug`, `info`, `warn`, `error` — are required ([Logging](#logging)) |
| `retry` | `RetryPolicy`: `{ maxAttempts?, baseDelayMs?, maxDelayMs? }` | 5 attempts, 100 ms base, 5 000 ms cap | 100 attempts, 60 000 ms for either delay | retry budget and backoff for every DynamoDB call ([nested options](#nested-options), [Retries and backoff](#retries-and-backoff)) |
| `compression` | `CompressionConfig` | none: payloads are stored uncompressed | per field ([nested options](#nested-options)) | gzip for payloads of at least `minSizeBytes` ([Gzip compression](#gzip-compression)) |
| `s3` | `S3OffloadConfig` | none: a payload over 392 KB is refused | per field ([nested options](#nested-options)) | offload large payloads to S3; needs the optional `@aws-sdk/client-s3` peer ([S3 offloading](#s3-offloading)) |
| `serde` | `SerializerProtocol` | saver: LangGraph's `JsonPlusSerializer`; store and history: the exported `JSON_SERDE` (plain JSON) | — | serializer override; must provide `dumpsTyped` and `loadsTyped`. See the note below the table |
| `indexName` | `string` | none: the listings that cross partitions scan the table | — | the name of the recency index (a GSI on `gsi1pk`/`gsi1sk`); a non-empty string. See the note below the table |
| `indexShards` | `number` | 8 | 1024 | index partitions per adapter. Fixed when the table is created: changing it changes every row's shard and requires another backfill. One partition per adapter would concentrate every listing on one key, which is worse than the scan it replaces |
| `readConcurrency` | `number` | 8 | 128 | payloads decoded at once by a single call. It is the multiplier on this package's memory ceiling — `readConcurrency × (s3.maxDownloadBytes + compression.maxDecompressedBytes)`, 800 MiB at the defaults — so lower it on a small container. It also bounds how many recency-index shards one listing queries at once |

**`client`** — reuse an existing client; not closed by `destroy()`. Passing it together with `clientConfig` is refused, naming `client`. It must provide `get`, `put`, `delete`, `update`, `query`, `scan`, `batchWrite` and `transactWrite`, so a raw `DynamoDBClient` is refused. Construct it with `maxAttempts: 1` **and a request timeout of its own** (`DynamoDBDocument.from(new DynamoDBClient({ maxAttempts: 1, requestHandler: { requestTimeout: 10_000, throwOnRequestTimeout: true }, … }))`): the SDK's own retries are not disabled on an injected client and would stack inside the library's retry budget — a `warn` is logged at construction when they would — and an injected client is used exactly as handed over, so one with no handler timeout leaves a single attempt unbounded, which `maxAttempts: 1` does not fix (see [Retries and backoff](#retries-and-backoff))

**`clientConfig`** — used to build a client when `client` is omitted; it must be an object, and its keys go to the AWS SDK unchecked. The client built from it gets `maxAttempts: 1` and a request handler with a 10 s request timeout and a 5 s socket timeout, unless the config names its own `maxAttempts` or `requestHandler` ([Retries and backoff](#retries-and-backoff)).

**`serde`** — serializer override; must provide `dumpsTyped` and `loadsTyped`. The checkpointer defaults to LangGraph's `JsonPlusSerializer`, the store and history adapters to the exported `JSON_SERDE` (plain JSON), and the two disagree in both directions — what each silently substitutes, and the one output no serializer may produce, is tabulated in [Table schema](#table-schema); what each does on the *read* is in [Trust boundary](#trust-boundary). A serde that stamps a `serdeType` other than `json` is taken at its word: this package has no grammar for that form, so it cannot tell a payload that rotted from one the serializer declined to rebuild, and every failure that serde raises is reported as the `serde` `VALIDATION` — never quarantined as `PAYLOAD_CORRUPT`, and so never dropped by `onCorruptMessage: 'skip'`. `JSON_SERDE` holds itself to the same rule from the other side: it reads only the `json` form it writes and refuses any other with that same `VALIDATION` error, before a byte is parsed

**`indexName`** — the name of the recency index (a GSI on `gsi1pk`/`gsi1sk`) on this table. Naming it turns `history.listSessions()` and a thread-less `saver.list()` from a table scan into a read of the index: each shard is read newest-first one DynamoDB page at a time, and its next page whenever it has no row buffered and the page being built still needs one — which can be a query whose rows that page never takes — with at most `readConcurrency` shards queried at once. A listing holds the page it is building, up to `limit` rows for `listSessions` (whose `limit` is capped at 10,000) and 100 rows at a time for `saver.list`, plus at most one DynamoDB page (up to 1 MB) per shard. Opt-in: whether the table has the index is your deployment fact, not something this package probes for. **Run `backfillRecencyIndex()` before setting it** — a row written before the index carries no keys, so the listings that read it would not find rows that are still there

### Adapter options

**`DynamoDBSaver`** takes nothing beyond the shared options. Its `serde` defaults to LangGraph's `JsonPlusSerializer`, the base class's default, and not to the `JSON_SERDE` the other two adapters use.

**`DynamoDBStore`** also takes:

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `index` | `IndexConfig`: `{ dims, embeddings, fields? }` | none: no semantic search | — | semantic search; `embeddings` must provide `embedQuery` and `embedDocuments`, and `fields`, when given, is an array of strings. Any other key is refused, and so is a value that is not an object, `null` included, rather than read as no index. `fields` defaults to `['$']`, the whole value; `dims`, when it is a positive integer, is checked against the length of every vector the embeddings return, and a mismatch is a `VALIDATION` error naming `index.dims` |
| `vectorBackend` | `VectorBackend` | none: ranking happens in process | — | delegate similarity search to an external index; DynamoDB keeps the canonical item. It must provide `upsert`, `query` and `delete`; `listKeys` is optional (see [Vector index consistency](#vector-index-consistency)). **Requires `index`** — constructing a store with a `vectorBackend` and no `index` throws |
| `maxSearchCandidates` | `number` | 1000 | 100 000 | cap for the in-DB ranker before it errors, and the furthest a `vectorBackend` page may reach (`offset + limit`) |
| `maxScanItems` | `number` | 10 000 | 1 000 000 | cap on rows read for one call before it errors; it counts rows, not namespaces. Gates a plain `search()` page only when the page cannot be filled from fewer rows, semantic candidate collection, `listNamespaces()` and `reconcileVectorIndex()` |
| `vectorScoreDirection` | `'relevance' \| 'distance'` | `'relevance'` | — | the direction of the score a `vectorBackend` returns (`relevance`: higher is better); `distance` negates and re-sorts so a distance-native backend ranks correctly; any other value throws at construction |

**`DynamoDBChatMessageHistory`** also takes:

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `onCorruptMessage` | `'skip' \| 'throw'` | `'skip'` | — | see the note below the table |

**`onCorruptMessage`** — what `getMessages` does with an item it cannot decode (default `skip`: drop it, log at `error`, return the rest). It covers a payload nobody can read — bytes that are no longer the form the row declares, a gone S3 object, a descriptor that is not one, a decompression-guard trip. It does **not** cover a row or a payload a newer release wrote (`FORMAT_UNSUPPORTED`), a row whose `s3Key` lies outside its own path, a payload whose bytes are intact and whose serializer merely refuses to rebuild the value they name (`VALIDATION`, field `serde`), nor any infrastructure failure (a throttle, a permission, a transport error): every one of them rejects the read under either policy, because a silently shorter conversation is what the chain re-persists as the truth.

**`DynamoDBFactory`** — `new DynamoDBFactory(base)` takes the defaults every adapter it builds inherits (`FactoryBaseOptions`); a per-adapter option wins.

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `client` | `DynamoDBDocument` | — | — | reused as-is by every adapter the factory builds, and never destroyed by it; construct it with `maxAttempts: 1`, as for an adapter's own `client` |
| `clientConfig` | `DynamoDBClientConfig` | none | — | what each `create*` call builds its own client from, and what `createAll` builds its one shared client from; its `region` is also given to an `s3` config that names none |
| `logger`, `ttl`, `compression`, `s3`, `retry` | as in [Shared options](#shared-options) | as there | as there | applied to every adapter the factory builds |

Anything else — `tableName`, `serde`, `indexName`, `indexShards`, `readConcurrency` and each adapter's own options — is given per adapter. `createSaver(options)`, `createStore(options)` and `createChatMessageHistory(options)` each take one adapter's full options, laid over the factory's defaults, and each builds a client of its own from `clientConfig`, or reuses the factory's `client`; a `client` or `clientConfig` given there replaces the factory's client choice as a unit, while the shared `logger`, `ttl`, `compression`, `s3` and `retry` still apply. `createAll({ saver?, store?, history? })` builds one shared client, or uses the factory's `client`, and takes a section per adapter: that adapter's options without `client` and `clientConfig` (`AdapterSection`). It builds only the adapters whose sections are given, refuses any other key, and returns them with one `destroy()` that releases all of them and the client it built — never a `client` the factory was given.

### Nested options

**`compression`** (`CompressionConfig`):

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `compression.enabled` | `boolean` | **required** | — | `false` stores every payload uncompressed |
| `compression.minSizeBytes` | `number` | 1024 (1 KB) | 512 MiB | a smaller payload is not gzipped, and `0` tries every payload; a gzipped one is kept only when it is more than 10% smaller |
| `compression.level` | `number` | 6 | 9 | the zlib level, 0–9 |
| `compression.maxDecompressedBytes` | `number` | 50 MiB | 512 MiB | a read refuses to inflate a payload past it, with `COMPRESSION_LIMIT` |

**`s3`** (`S3OffloadConfig`):

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `s3.bucketName` | `string` | **required** | — | a non-empty string |
| `s3.keyPrefix` | `string` | the adapter's own: `langgraph-checkpoints/checkpointer/`, `langgraph-checkpoints/store/` or `langgraph-checkpoints/history/` | — | a path ending in `/`; the rules are in the paragraph below |
| `s3.thresholdBytes` | `number` | 350 KB (358 400 bytes) | 392 KB (401 408 bytes), the largest payload stored inline | a stored payload at or above it is uploaded to S3 |
| `s3.serverSideEncryption` | `string` | `'AES256'` | — | one of `'AES256'`, `'aws:kms'` and `'aws:kms:dsse'` |
| `s3.sseKmsKeyId` | `string` | none | — | the KMS key for `'aws:kms'`; a non-empty string |
| `s3.maxDownloadBytes` | `number` | 50 MiB | 512 MiB | the largest offloaded object a read buffers, or `S3_OFFLOAD_FAILED` |
| `s3.clientConfig` | `S3ClientConfig` (typed `S3ClientConfigLike`) | none, but for the region the DynamoDB `clientConfig` names | — | the S3 client is built from it with `maxAttempts: 1` and a 5 s socket timeout, unless it names its own `maxAttempts` or `requestHandler` |

**`retry`** (`RetryPolicy`):

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `retry.maxAttempts` | `number` | 5 | 100 | attempts per DynamoDB call before `RETRY_EXHAUSTED`; a chat-history append never uses fewer than 18 |
| `retry.baseDelayMs` | `number` | 100 | 60 000 | the first backoff delay, in milliseconds |
| `retry.maxDelayMs` | `number` | 5 000 | 60 000 | the cap on one backoff delay, in milliseconds; at least `baseDelayMs` when that is given |

**`ttl`** (`TtlOption`) — exactly one of:

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `ttl.days` | `number` | — | 1825 (five years) | whole days |
| `ttl.seconds` | `number` | — | 157 680 000 (five years) | whole seconds |

`S3OffloadConfig`: `{ bucketName, keyPrefix?, thresholdBytes?, serverSideEncryption?, sseKmsKeyId?, maxDownloadBytes?, clientConfig? }`. `clientConfig` takes an `S3ClientConfig`; it is typed structurally (`S3ClientConfigLike`), so the shipped declarations compile whether or not `@aws-sdk/client-s3` is installed. Like the adapter's own `clientConfig`, it must be an object, and its keys go to the SDK unchecked. `sseKmsKeyId`, when given, must be a non-empty string; whether it names a key you can use is for S3 to answer. When `clientConfig.region` is omitted here, the S3 client inherits the adapter's DynamoDB `clientConfig.region` (the S3 SDK does not follow region redirects, so a cross-region bucket otherwise fails with `PermanentRedirect`). `maxDownloadBytes` caps the size of an offloaded object the adapter will buffer from S3 — checked against `ContentLength` before the body is read, and while streaming when the length is unknown — so together with `maxDecompressedBytes` no single payload can claim more memory than you allow. For a customer-managed key, set `serverSideEncryption: 'aws:kms'` plus `sseKmsKeyId`.

When `keyPrefix` is omitted, each adapter defaults to its own sub-prefix under the shared base (`langgraph-checkpoints/store/`, `langgraph-checkpoints/checkpointer/`, `langgraph-checkpoints/history/`) so that multiple adapters can safely share one bucket — their offloaded object keys and `ensureS3LifecycleRule()` TTL rules never collide. An explicit `keyPrefix` is always honored verbatim, including across adapters if you want them to share one; at that point avoiding a lifecycle-rule collision (e.g. by giving them the same TTL) is your responsibility, same as with any other explicit override. A `keyPrefix` must be a string holding a non-empty path ending in `/`, and every segment before that `/` must be a real name — not empty, not `.`, not `..` — with no control character and no unpaired surrogate anywhere in it. It is also the lifecycle rule's `Filter.Prefix` and the path an IAM object-key condition is written against, so an empty or root prefix would expire the whole bucket, a slash-less one would match sibling prefixes, and one carrying `..`, `.` or an empty segment would address keys outside the path you granted and the rule sweeps — an S3 key is a byte string rather than a path, so `a/../b/x.bin` and `b/x.bin` are two different objects, and the console, a lifecycle filter and anything that normalises a path first disagree about which. All of them are rejected at construction and again by `ensureS3LifecycleRule()`.

### Per-call options

Every page `limit` in this package has a ceiling of 10 000 (`VALIDATION` naming `limit`, raised at the call), and every options object refuses a key it does not read, naming `options.<key>` (`window.<key>` for `forSession`), except `redactLogger`'s, below.

**`history.getMessages(sessionId, options?)`** (`GetMessagesOptions`):

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `limit` | `number` | none: the whole session | 10 000 | only the newest `limit` messages, still returned oldest first; `0` is refused, since an empty window is what a chain reads as the whole session |
| `before` | `Date` | none | — | only messages appended before this instant, at millisecond precision; combines with `limit` |
| `signal` | `AbortSignal` | none | — | see [Cancellation](#cancellation) |

**`history.forSession(sessionId, window?)`** takes `{ limit? }`: the same `limit` as `getMessages` (none by default, ceiling 10 000, `0` refused), bounding what the single-session adapter feeds the chain to the newest that many messages.

**`history.listSessions(options?)`** (`ListSessionsOptions`):

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `limit` | `number` | 100 with `indexName`; without it, every session | 10 000 | newest-updated first; `0` returns an empty page and reads nothing |
| `cursor` | `string` | none | — | the `nextCursor` of the previous page; **requires `indexName`**, and is refused without it |
| `maxIterations` | `number` | 1000 | none; `Infinity` asks for no cap | scan pages read before `RESULT_TRUNCATED`; the scan path only |
| `maxItems` | `number` | 10 000 | none; `Infinity` asks for no cap | rows held in memory before `RESULT_TRUNCATED`; the scan path only |
| `signal` | `AbortSignal` | none | — | |

**`store.search(namespacePrefix, options?)`** (`SearchOptions`):

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `query` | `string` | none: a plain search | — | ranked by similarity when the store has an `index`; an empty string is no query ([Semantic search](#semantic-search)) |
| `filter` | `Record<string, any>` | none | — | conditions on top-level fields of the stored value, all of which must hold ([Differences from `InMemoryStore`](#differences-from-inmemorystore)) |
| `limit` | `number` | 10 | 10 000 | `0` returns an empty page without a read or an embedding |
| `offset` | `number` | 0 | — | items skipped first; `offset + limit` is what `maxScanItems` and `maxSearchCandidates` are measured against |
| `signal` | `AbortSignal` | none | — | |

**`store.listNamespaces(options?)`** (`ListNamespacesOptions`) takes no signal:

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `prefix` | `string[]` | none | — | only namespaces starting with these labels; `'*'` matches any one label |
| `suffix` | `string[]` | none | — | only namespaces ending with these labels; `'*'` matches any one label |
| `maxDepth` | `number` | none | — | truncates each namespace to this many labels, listing the ones that become equal once |
| `limit` | `number` | 100 | 10 000 | `0` returns an empty array without a read |
| `offset` | `number` | 0 | — | |

**`saver.list(config, options?)`** (upstream's `CheckpointListOptions`) reads its signal from `config.signal`:

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `limit` | `number` | none: every matching checkpoint | 10 000 | `0` yields nothing |
| `before` | `RunnableConfig` | none | — | only checkpoints older than the `checkpoint_id` it names |
| `filter` | `Record<string, any>` | none | — | metadata fields every yielded checkpoint must match |

**`saver.getDeltaChannelHistory(options)`** (`DeltaChannelHistoryOptions`, the shape upstream's `BaseCheckpointSaver` declares) takes exactly two keys:

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `config` | `RunnableConfig` | **required** | — | the checkpoint to walk back from, shaped as `getTuple` requires; its `signal` aborts the whole walk, every ancestor read included |
| `channels` | `string[]` | **required** | — | the delta channels to rebuild; `[]` reads nothing and returns `{}` |

**`redactLogger(logger, options?)`** (`RedactLoggerOptions`, see [Logging](#logging)) checks that `options` is an object and each list's element type, but does not refuse a key it does not read:

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `extraKeys` | `readonly string[]` | none: the built-in key names only | — | further key names to redact, matched like the built-in ones: a key is redacted when its lower-cased form with punctuation removed equals or ends with the name, so `'ssn'` covers `SSN` and `user_ssn` |
| `extraValuePatterns` | `readonly RegExp[]` | none: the built-in shapes only | — | further secret shapes, redacted wherever they appear inside a string and applied globally with or without the `g` flag; a pattern's first capture group, if it has one, is kept verbatim |

**A trailing `{ signal }`** (`CancelOptions`) is the only option of `saver.deleteThread`, `store.reconcileVectorIndex`, `history.addMessages`, `history.addMessage`, `history.clear` and `history.reconcileMessageCount`. The checkpointer's `getTuple`, `list`, `put`, `putWrites` and `getDeltaChannelHistory` read `config.signal` instead, and `store.get`, `store.put`, `store.delete`, `store.batch` and `store.listNamespaces` take none ([Cancellation](#cancellation)).

**`backfillRecencyIndex(options)`** (`BackfillOptions`), the [maintenance tool](#maintenance-operations) that prepares rows for the recency index:

| Option | Type | Default | Ceiling | Notes |
| --- | --- | --- | --- | --- |
| `client` | `DynamoDBDocument` | **required** | — | must provide `scan` and `update` |
| `tableName` | `string` | **required** | — | the adapters' rule |
| `indexShards` | `number` | 8 | 1024 | must equal the adapters' `indexShards`, or rows land on shards no listing queries |
| `pageSize` | `number` | 100 | — | rows per scan page |
| `maxPages` | `number` | none: the whole table | — | stops after this many pages and returns a `nextCursor` |
| `cursor` | `string` | none | — | the `nextCursor` of an earlier run, to resume it |
| `dryRun` | `boolean` | `false` | — | reports what would change without writing |
| `retry` | `RetryOptions` | 5 attempts, 100 ms base, 5 000 ms cap, the default retryable errors | 100 attempts, 60 000 ms for either delay | the full retry surface, not the adapters' `RetryPolicy`: also `retryableErrors` (`string[]`, the error names to retry), `isRetryable` (`(error) => boolean`, which replaces `retryableErrors`), `onRetry` (called before each backoff with `{ attempt, delayMs, error }` — the only way to watch a backfill's retries, since it takes no `logger`), `rng` (`() => number`, the jitter source, default `Math.random`) and `signal` |
| `signal` | `AbortSignal` | none | — | cancels the run; `retry.signal` does when this is absent, and this one wins when both are given |

## Retries and backoff

Every DynamoDB call the library makes runs inside its own retry layer, and that layer is the only one: clients the library constructs disable the SDK's retries (`maxAttempts: 1`) and hand the SDK's request handler a timeout, so the attempt counts below are exact and each of those attempts is bounded. `list()` without a `checkpoint_ns` covers every namespace of the thread (rows come grouped by namespace, newest first within each); with an explicit namespace, `before` is applied in the key condition so newer rows are never read, and a `checkpoint_id` is fetched directly instead of scanning. An injected `client` that keeps SDK retries stacks them inside each attempt — construct it with `maxAttempts: 1` (a `warn` is logged at construction otherwise) **and give it a request timeout of its own**. `maxAttempts: 1` is necessary and no longer sufficient: an injected client is used exactly as it was handed over, so one without a handler timeout leaves a single attempt unbounded, and the write-lifetime deadline below cannot shorten an attempt that has already started.

- **What is retried** — throttling and capacity errors, transaction conflicts (`ReplicatedWriteConflictException` included), `InternalFailure` and the other transient server errors, request timeouts, HTTP 429/5xx responses (including ones the SDK cannot map to a modeled exception), errors carrying the SDK's `$retryable` trait, and Node socket errors. Everything else — `ValidationException`, `ConditionalCheckFailedException`, `ResourceNotFoundException`, `AccessDeniedException`, a `TransactionCanceledException` with a permanent reason — is thrown on the first attempt. DynamoDB and S3 share one list, derived from the error table under [Error handling](#error-handling): every name it gives `THROTTLED`, `SERVICE_UNAVAILABLE` or `CONTENTION`, plus the Node network error codes.
- **Schedule** — `retry.maxAttempts` (default 5, ceiling 100) attempts with full-jitter exponential backoff from `retry.baseDelayMs` (default 100 ms), doubling per attempt and capped at `retry.maxDelayMs` (default 5 s; a value below a given `baseDelayMs` is refused, and both delays have a ceiling of 60 s): about 1.5 s worst case and 0.75 s expected before `RETRY_EXHAUSTED`. `addMessages` never uses fewer than 18 attempts (about 61 s worst case), because every concurrent append to one session contends on the same metadata row. Those are the figures for *sleeping*; a budget's worst-case wall time adds the attempts themselves, which the per-attempt bound below caps at 10 s each — so about 51.5 s for a five-attempt budget and about 4 minutes for `addMessages`, and a tokened write is cut at 300 s whichever way it gets there. `BatchWriteItem` `UnprocessedItems` are re-submitted for up to 10 rounds with the same backoff.
- **What bounds one attempt** — a client this library builds is given a **10 s request timeout** and a **5 s socket timeout** on the SDK's request handler, so a hung request fails with a retryable `TimeoutError` and is retried instead of hanging forever; `maxAttempts: 1` on its own bounds nothing. The request timeout covers socket acquisition, connect, the request write and the wait for response headers, and the socket timeout is an idle timer that activity in either direction resets, so it also covers a response body that stalls mid-stream. **No connect timeout is set, deliberately.** That timer starts when the request is created and is cleared only when the agent assigns one of its sockets (50 by default), so the whole time a request spends queued behind a wide fan-out counts against it — with a one-socket agent, a connect timeout of 800 ms killed 14 of 100 healthy requests and one of 2 500 ms killed 226 of 400, every one of which succeeded when it was left unset, and this library's own retry layer re-sends each one it kills. A value long enough to be safe bounds nothing the request timeout does not. The **S3 client** gets the idle timeout **only**: a `PutObject`'s response headers do not arrive until the whole body has been uploaded, so a total bound there would be a bound on upload speed — at the 50 MB ceiling this path carries, 10 s would demand a sustained 5 MB/s for the whole upload, and anything slower would have its upload destroyed *and* re-sent. A `requestHandler` in `clientConfig` or `s3.clientConfig` replaces the defaults whole: the documented way to tune them, and equally the documented way to give them up.
- **The write lifetime** — a write that carries a token (see [Write idempotency](#write-idempotency)) stops starting new attempts **300 s** in, whatever `retry` says: that is half the ten minutes DynamoDB honours the token for, and the other half absorbs the attempt still in flight. The deadline is tested before each backoff, so it can refuse to begin the next wait and can never shorten an attempt already running, which is what the per-attempt bound above is for. A `retry` policy whose nominal worst case is longer logs one `warn` at construction naming both numbers instead of being refused: `retry: { maxDelayMs: 60000 }` alone is already 8.7 minutes of sleep on the `addMessages` path, and such a call now ends in `RETRY_EXHAUSTED` where it might once have eventually succeeded. Nothing else carries the deadline: a read keeps the full configured budget, `store.delete`'s pre-read included.
- **Visibility** — every retry is logged at `debug` with the attempt number, the delay about to be slept and the error name; `RETRY_EXHAUSTED` carries the last error as `cause` (with the SDK's `$metadata.requestId`) and `context.attempts`.

## Error handling

Every error the library throws is a `DynamoDBLangGraphError` carrying a stable `code` from the `ErrorCode` enum, a structured `context` (`tableName`, `operation`, `field`, `key`, `attempts`, `threadId`, `checkpointId`, and — when the failure underneath came from AWS — `awsErrorName`, `requestId` and `httpStatusCode`; identifiers and counts, never a payload), `details` for the two codes that carry more, and a native `cause` chain. Raw AWS SDK errors never escape a public method: each one is given the code the classifier assigns (the table below) and keeps the SDK error as `cause`. Branch on `code` and detect library errors with the exported brand check rather than `instanceof`, which breaks when a bundler duplicates the package. Earlier releases set the same brand, so an error from an older copy installed beside this one is recognised too — in that release's shape: no `details`, its counts as flat properties, and possibly `code: 'UPSTREAM'`. The check is safe on any caught value, including one that is not an object at all — which is what a `catch` clause can actually hold. `ErrorCode` is frozen: a member cannot be reassigned by anything sharing the process, so `error.code === ErrorCode.X` means the same thing to every consumer:

```typescript
import { ErrorCode, isDynamoDBLangGraphError } from '@farukada/aws-langgraph-dynamodb-ts';

try {
  await store.put([''], 'k', { v: 1 });
} catch (error) {
  const e = error as Error; // guard a variable: a guard on `error as Error` leaves `error` itself unknown
  if (isDynamoDBLangGraphError(e)) {
    switch (e.code) {
      case ErrorCode.VALIDATION:
        console.error('bad input', e.context.field); // names the offending option or argument
        break;
      case ErrorCode.THROTTLED:
        console.warn('back off', e.context.awsErrorName); // says which limit
        break;
      case ErrorCode.COMPENSATION_FAILED:
        console.error(e.details.rollbackError); // typed by the code, no cast; then run reconcileMessageCount
        break;
    }
  }
}
```

| `ErrorCode` | Thrown by |
| --- | --- |
| `VALIDATION` | every constructor for a bad option, an option key it does not read, or a collaborator missing a method; every method for a bad identifier, key, window, value, `config` or options object; `backfillRecencyIndex` for a bad option; S3 offload configured without the `@aws-sdk/client-s3` peer; a descriptor the reader cannot honour; a row-sourced `s3Key` outside the path the row's own identifiers produce, on every adapter and under every corruption policy; a stored payload the configured serializer refuses to reconstruct — an `lc` constructor record naming a class outside its allow-list, or any other refusal the serializer raises — with the serializer's own error as `cause`, except where that refusal is already one of this library's errors and is passed through whole, as `JSON_SERDE`'s refusal of a `serdeType` it does not write is: that one carries no `cause`, because nothing raised it but itself |
| `THROTTLED` | any method, for a throttle no retry layer retried: `ProvisionedThroughputExceededException`, `ThrottlingException`, `RequestLimitExceeded`, S3 `SlowDown`, HTTP 429. An adapter's `retry` takes no list of errors — `retry.retryableErrors` is an unknown key there and is refused — and its retry layer retries every one of these, so on an adapter's DynamoDB call a throttle that outlasts `retry.maxAttempts` is `RETRY_EXHAUSTED`, with the throttle as `cause`, and an S3 transfer that ran out of its retries is `S3_OFFLOAD_FAILED`. `THROTTLED` itself comes from the paths with no retry layer — the S3 lifecycle calls `ensureS3LifecycleRule` makes, and whatever your own `vectorBackend` or `index.embeddings` throws — and from `backfillRecencyIndex` when its own `retry` leaves a throttle out: a `retryableErrors` list without the throttle's name, for an error that carries neither HTTP 429 nor the SDK's `$retryable` trait (both are retried whatever the list says), or an `isRetryable` that returns `false` for it — `isRetryable` replaces the whole decision, so it can leave out even an HTTP 429. Back off and retry later, or raise the table's capacity or the account quota |
| `SERVICE_UNAVAILABLE` | the same, for a transient AWS or network failure: `InternalServerError`, `InternalFailure`, `ServiceUnavailable`, S3 `InternalError`, a request timeout, HTTP 5xx, a reset or refused connection — and for a network failure raised by your own `vectorBackend` or `index.embeddings`, which the boundary cannot tell from AWS's (no `awsErrorName` is set on that one). Retry after a backoff; a write that failed this way may have been applied, so read it back before writing it again where that matters |
| `CONTENTION` | the same as `THROTTLED`, for a request that collided with another on the same item or object: `TransactionConflictException`, `TransactionInProgressException`, `ReplicatedWriteConflictException`, S3 `ConditionalRequestConflict`. Retry soon; more capacity would not help |
| `ACCESS_DENIED` | any method whose credentials or IAM policy AWS refused (`AccessDeniedException`, S3 `AccessDenied`, an expired or unrecognised token, a bad signature). Not retried: fix the credentials or the IAM policy; `context.awsErrorName` says which refusal it was |
| `NOT_FOUND` | any method whose table or index does not exist (`ResourceNotFoundException`), or whose offload bucket does not (`NoSuchBucket`). Not retried: create it, or fix the `tableName`, `indexName` or `s3.bucketName` the adapter was given |
| `AWS_REJECTED` | any method whose request AWS rejected as malformed (`ValidationException`, `IdempotentParameterMismatchException`, …). Not retried: the same request fails the same way, so fix the request — `context.awsErrorName` and `cause` say what AWS objected to |
| `AWS_REQUEST_FAILED` | any method, for an AWS failure no narrower code fits; `context.awsErrorName` names it |
| `UNEXPECTED_ERROR` | any method, for a failure that is neither this library's check nor AWS's: what your `vectorBackend`, `index.embeddings`, `serde` or the history a single-session adapter wraps threw, as `cause` |
| `RETRY_EXHAUSTED` | every DynamoDB call after `retry.maxAttempts` transient failures (`context.attempts`, the last error as `cause`) |
| `ABORTED` | any cancellable method whose `AbortSignal` fired, including `saver.deleteThread` and `history.clear` when it fires part-way through the delete, and `saver.getDeltaChannelHistory` when it fires part-way through the ancestor walk — the hop it fires on is the last read the call makes — a cancel is reported as a cancel, unwrapped, and no further row is issued after it. A collaborator's own abort is reported the same way: a `vectorBackend` or `index.embeddings` rejecting with an `AbortError` — from a timeout of its own, say — surfaces as `ABORTED` even though the caller's signal never fired, with that `AbortError` as `cause` |
| `CONDITION_CONFLICT` | `history.reconcileMessageCount` when the session changed while it counted, and when the session does not exist — repairing one that is not there would mean creating a permanent, TTL-less metadata row |
| `COMPENSATION_FAILED` | `history.addMessages` / `addMessage` when a multi-chunk append failed and the rollback of the committed chunks failed too (`details.rollbackError`; run `reconcileMessageCount`) |
| `BATCH_WRITE_INCOMPLETE` | `saver.deleteThread`, `history.clear` when a row's delete fails — a cancelled pass raises `ABORTED` instead, and never this. `details.kind` says which shape the error carries: `'drain'` for one `BatchWriteItem` sequence that ran out of `UnprocessedItems` rounds (`details.succeededCount`, `details.unprocessed` — the requests to re-submit — and `details.retries`), `'pass'` for a pass that attempted every chunk or row (`details.unit`, `details.succeededChunks`, `details.totalChunks`, `details.failedChunks`, `details.succeededCount`). A partition delete sends one conditional request per row, so its counts are **rows** (`details.unit: 'row'`): `details.succeededChunks`/`details.totalChunks` are rows deleted and rows attempted across the whole pass, `details.succeededCount` repeats the first, `details.failedChunks` holds each failing row's own error, and the message names the row unit. A row the pin refused is not a failure and is in neither count. The chunked form — `details.unit: 'chunk'`, counts in 25-row `BatchWriteItem` chunks, with a `'drain'` error per failing chunk inside it — is now raised only by the rollback of a failed multi-chunk `history.addMessages`, where it reaches a caller as the `COMPENSATION_FAILED` error's `details.rollbackError`; there `details.succeededCount` is the individual writes confirmed persisted across every chunk |
| `RESULT_TRUNCATED` | the paginated reads that keep rows in memory — `store.search`, `store.listNamespaces`, `store.reconcileVectorIndex`, `history.listSessions` — past `maxScanItems` / `maxItems` / `maxIterations`; and a listing through the recency index — `history.listSessions`, or `saver.list` without a `thread_id` — for an index shard that needs more than 1000 DynamoDB pages while one page of the listing is built |
| `S3_OFFLOAD_FAILED` | an upload or a download of an offloaded object that failed after the S3 retries (`context.operation` says which), an object over `maxDownloadBytes`, or an object that no longer exists (`context.key`). **Never a delete**: releasing an object is best-effort, so a failed delete is logged as an orphan at `warn` and the call carries on |
| `COMPRESSION_LIMIT` | a payload whose decompressed size would exceed `maxDecompressedBytes` |
| `PAYLOAD_CORRUPT` | a stored payload that can never be read: bytes marked compressed that are not gzip, or bytes that are no longer the form the row declares. The check is this package's own re-derivation of that form, not the serializer's word for it, so which `serde` the adapter carries does not change the verdict. Classified permanent, so a caller reports it instead of retrying |
| `FORMAT_UNSUPPORTED` | a row, or a payload inside one, written by a newer release of this package than the one reading it — `context.field` is `v` for the row and `schemaVersion` for the payload. Raised rather than skipped, on every adapter and whatever `onCorruptMessage` is set to: hiding a row that exists is worse than failing, and a newer reader reads it, so dropping it during a rollback or a canary loses turns that are not lost |
| `ANCESTOR_EXPIRED` | `saver.getDeltaChannelHistory` when a checkpoint a delta channel still needs has expired (`context.threadId`, `context.checkpointId`). Lower `snapshotFrequency`, or do not put a `ttl` on threads that use delta channels. A walk cancelled just as it reached the expired ancestor reports `ABORTED` instead: the caller had stopped waiting for the diagnosis |

`COMPENSATION_FAILED` is the one error that carries another: the append's original failure is `cause` and the rollback failure is `details.rollbackError`, which can itself be a `BATCH_WRITE_INCOMPLETE`. The session's stored `messageCount` may be wrong at that point; `reconcileMessageCount` repairs it.

### Cancellation

Every long-running method takes an `AbortSignal`: the checkpointer reads `RunnableConfig.signal` (which LangGraph propagates) on `getTuple`, `list`, `put` and `putWrites`, and `deleteThread`, `search`, `reconcileVectorIndex`, `getMessages`, `addMessages`, `addMessage`, `clear`, `listSessions` and `reconcileMessageCount` take a trailing `{ signal }`. A signal that is not an `AbortSignal` — an object with a boolean `aborted` and callable `addEventListener` and `removeEventListener` — is refused with `VALIDATION` naming `signal`, before any request, wherever it is passed: in a trailing `{ signal }`, or as `config.signal` to the checkpointer's `getTuple`, `list`, `put`, `putWrites` and `getDeltaChannelHistory`, which check it the same way. A signal that is already aborted, that aborts while the library waits (a retry backoff, the next page of a paginated read), or that aborts **while a request is in flight**, rejects the call with an `ABORTED` error whatever the abort reason was — the raw reason (a `DOMException` for a bare `controller.abort()`) is kept as `cause`. The signal is passed to the AWS SDK as `abortSignal` on every DynamoDB request and on both S3 transfers, so a cancel **ends** the request rather than waiting it out: a `getTuple` against a server that never answers returns in about the time it takes to call `abort()` rather than at the five-second socket timeout, and an S3 body that stalls after its headers — which no handler timeout releases — ends at the abort too. A cancelled request is never re-sent: the signal is read before the transport's own rejection is classified, so the socket error a cut request produces is reported as `ABORTED` instead of being retried as transient. `store.get`, `store.put` and `store.delete` take no signal — upstream's `BaseStore` gives those three no parameter for one, and adding one would change their signatures — so neither the S3 upload a large value costs nor the download reading one back is cancellable; `store.search` and `store.reconcileVectorIndex` do take one. Cleanup and verification reads that run after a failure are not cancelled, so an abort never strands a live row pointing at a deleted object.

## Logging

Logging is **per-instance and silent by default** — the library never writes to your console uninvited. Pass any object matching the `Logger` interface — all four of `info`, `warn`, `error` and `debug` are required, and a logger missing one is refused at construction, naming it (`logger.debug`):

```typescript
import { DynamoDBStore, redactLogger, type Logger } from '@farukada/aws-langgraph-dynamodb-ts';

const logger: Logger = {
  info: (m, ...a) => console.info(m, ...a),
  warn: (m, ...a) => console.warn(m, ...a),
  error: (m, ...a) => console.error(m, ...a),
  debug: () => {},
};

const store = new DynamoDBStore({ tableName: 'langgraph', logger: redactLogger(logger) });
```

**A logger you inject is wrapped, not used as given.** This package calls your `Logger` almost entirely from inside the paths that report or repair a failure, so each of its four methods is delegated through a wrapper that absorbs anything the method throws: nothing your logger does can stop a delete pass reporting what it could not delete, end a retry budget early, or replace the error you actually needed with one about logging. The message and arguments reach your method unchanged, and only a throw out of it is swallowed — so if you want to see your own logger's failures, handle them inside your own methods. One consequence worth knowing: the object the adapters hold is not the object you passed, so identity comparison against it will not match.

`redactLogger` wraps a logger so secret-looking fields (access keys, tokens, passwords, …) are replaced with `[REDACTED]` in structured log arguments. It also scans **string values, including an error's `message` and `stack`**, for recognisable credential shapes — AWS access key ids, `Bearer` tokens, JWTs, and `password=`/`token=` assignments — replacing just the matched substring so the text stays readable. Pass `extraKeys` to add field names and `extraValuePatterns` to add shapes. `redactSecrets` exposes the same redaction for arbitrary objects. Both helpers refuse what they cannot apply: `redactLogger` names `logger` (or `logger.<method>`) for a logger it cannot delegate to, and `options`/`extraKeys`/`extraValuePatterns` for an option of the wrong type; `redactSecrets` names `patterns`/`valuePatterns` for a list that is not an array of strings or of `RegExp` — a skipped pattern protects nothing while its caller believes it does. Past the wrap call nothing escapes a log call, the wrapped logger's own failure included.

**What is logged.** Identifiers and counts only: thread, namespace, checkpoint, session and task ids, store namespaces and keys, sort keys, channel names, S3 object keys, attempt and row counts, and the *name* of an underlying error — or, for one of this library's own, its `code`, since they all share one name. Never a payload, an embedding, a message body or a credential. `redactLogger` therefore matters most for the application logs around the library; it does not redact identifiers — pass `extraKeys: ['threadId', 'sessionId', 'namespace', 'key', 'sortKey', 's3Key']` when your deployment treats identifiers as personal data.

**Using pino or winston.** `Logger` methods take a message and then structured arguments — at most one plain object per call. winston and `console` accept that shape directly. pino treats a leading string as a format string and drops trailing objects, so merge the arguments into its first parameter:

<!-- sample:skip pino is not a dependency of this package -->
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
| `error` | `history.addMessages rollback failed; messageCount may have drifted` | `sessionId`, `committedChunks` | a multi-chunk append failed and its rollback failed too (`COMPENSATION_FAILED`); run `reconcileMessageCount` for the session once it is idle |
| `error` | `getMessages: skipped a corrupt message item` | `sessionId`, `sortKey`, `reason` | a message row could not be decoded (or its S3 object is gone) and was dropped under `onCorruptMessage: 'skip'`; inspect or delete the row |
| `warn` | `store.put: compare-and-swap exhausted; overwriting unconditionally` | `namespace`, `key`, `attempts` | three concurrent overwrites of one item; the put succeeded but one S3 object may be orphaned until the lifecycle rule sweeps it |
| `warn` | `store.delete: compare-and-swap exhausted; the item was not deleted` | `namespace`, `key`, `attempts` | three writes landed at one item between this delete's read and its attempt, each time; the item is still there and nothing was released, because the live row names it — re-run the delete once the key is idle |
| `warn` | `putWrites: special-write compare-and-swap exhausted; overwriting unconditionally` | `sortKey`, `channel`, `attempts` | same, for an interrupt/resume/error write written concurrently for one task |
| `warn` | `ensureS3LifecycleRule: versioning is off on the offload bucket, so releasing a payload deletes it outright with no recovery window` | `bucket` | the bucket keeps no versions, so releasing an offloaded payload erases it and no lifecycle rule can hold anything back; enable bucket versioning if you want a mistaken release to be recoverable |
| `warn` | `ensureS3LifecycleRule: versioning is suspended on the offload bucket, so releasing a payload deletes it outright` | `bucket` | same exposure, and not the same remedy: re-enable versioning to restore it from here on, and treat the payloads released during the suspension as gone — nothing brings those back |
| `warn` | `ensureS3LifecycleRule: could not read the offload bucket versioning state, so whether a released payload is recoverable is unknown` | `bucket`, `reason` | the lifecycle rules were written; only the versioning check failed, most often `AccessDenied` on a role without `s3:GetBucketVersioning`. Grant it, or check the state yourself |
| `warn` | `Some orphaned S3 objects could not be deleted after` | `failedCount` | objects leaked after a failed write or a delete; `ensureS3LifecycleRule()` reclaims them, otherwise clean up by prefix |
| `warn` | `Failed to clean up orphaned S3 objects after` | `reason` | the cleanup itself failed after retries; same remedy |
| `warn` | `: refusing to delete an S3 object outside this row's scope` | `key` | a row referenced an object outside its own key path — a tampered or foreign row; the object was left alone, investigate the writer |
| `warn` | `store vector-index sync failed; reconcileVectorIndex will repair` | `namespace`, `key`, `operation`, `reason` | the `vectorBackend` rejected the `operation` named in the fields, an upsert or a delete; the canonical item is fine, run `reconcileVectorIndex` when convenient |
| `warn` | `factory.destroy: an adapter did not release its resources` | `reason` | one adapter's teardown failed; the rest were released anyway and the process may hold that adapter's sockets until it exits |
| `warn` | `injected DynamoDB client keeps the SDK's own retries` | `maxAttempts` | construct the injected client with `maxAttempts: 1` unless you want the SDK's retries to stack inside the library's budget |
| `warn` | `retry policy outlives the write lifetime; the budget will be cut short` | `budgetMs`, `maxWriteLifetimeMs` | the `retry` policy you configured would nominally back off for `budgetMs`, longer than the 5-minute deadline every write carrying a request token runs under, so such a write gives up at the deadline rather than after its last attempt; the write itself is never at risk, but lower `maxAttempts` or `maxDelayMs` if you expect the whole budget to be spent |
| `warn` | `putWrites: write row held by an unexpected channel; write not persisted` | `sortKey`, `expected`, `found` | another writer holds this task's row for a different channel; only this library should write the key space |
| `warn` | `history.addMessages compensating committed chunks after a chunk failed` | `sessionId`, `committedChunks` | a large append is being rolled back; the caller receives the original error |
| `warn` | `list: scanned a large number of rows without the caller stopping` | `threadId`, `checkpointNs`, `scanned` | a `list()` walked over 10 000 rows; pass `limit` or narrow the filter |
| `warn` | `getMessages: a session holds very many messages; the read is complete but slow. Pass a ` | `sessionId`, `messages` | over 10 000 messages read in one call; pass `limit` to read only the newest turns |
| `warn` | `getTuple: a checkpoint carries very many pending-write rows; the read is complete but slow` | `threadId`, `checkpointId`, `rows` | over 10 000 pending writes on one checkpoint (a huge fan-out or many retried tasks); the read is correct |
| `warn` | `search: some candidates carry an embedding of a different dimension than the query` | `namespacePrefix`, `count` | items embedded with another model or `dims`; re-put them or run `reconcileVectorIndex` |
| `warn` | `search: vectorBackend returned ascending scores; VectorMatch.score must be a relevance` | `namespacePrefix` | the backend reports distances; set `vectorScoreDirection: 'distance'` |
| `warn` | `search: skipped an unusable vectorBackend match` | `namespace`, `key`, `reason` | the backend returned a key this store cannot address — `reason` is always `VALIDATION`, the only failure a match is dropped for; run `reconcileVectorIndex`. A read that *fails* (throttling, an outage, a cancel, an unreadable payload) fails the search instead of being logged here |
| `warn` | `: left a foreign row in place` | `sortKey` | `deleteThread`/`clear` found a row another adapter owns in the partition and kept it |
| `warn` | `: left a row rewritten since the read` | `sortKey` | `deleteThread`/`clear` found the row changed under it: another write landed after the partition was read, so the row and the object it names were kept. Re-run the call once the thread or session is idle |
| `warn` | `: skipped a row whose unit was refused` | `sortKey` | a `deleteThread` kept a checkpoint's payload or pending-write row because the same checkpoint's earlier row was rewritten and kept; re-run once the thread is idle |
| `warn` | `list: skipped a row that is not a checkpoint meta item` | `sortKey` | a foreign row shares the `META#` prefix on a shared table |
| `warn` | `getTuple: skipped a row that is not a checkpoint meta item` | `sortKey` | same, on the read-your-writes path |
| `warn` | `getMessages: refused a row that is not a chat message item` | `sessionId`, `sortKey` | a foreign row shares the `HISTORY#MSG#` prefix in this session's partition, or claims another session; the read is refused rather than answered with a conversation that quietly skips it, whatever `onCorruptMessage` is set to. Inspect or remove the row |
| `warn` | `store.get: ignored a row that is not a store item` | `partitionKey`, `sortKey` | a foreign row at a store key |
| `warn` | `reconcileVectorIndex: skipped a row that is not a store item` | `sortKey` | same, during reconciliation |
| `info` | `: deleted rows` | `deleted`, `skipped` | `deleteThread`/`clear` finished |
| `info` | `reconcileVectorIndex prune skipped: backend has no listKeys` | `prefix` | the backend cannot enumerate vectors, so stale ones were not pruned |
| `info` | `reconcileVectorIndex: kept a vector whose item reappeared` | `namespace`, `key` | an item was written while pruning; nothing to do |
| `info` | `store.delete: kept a vector whose item was not confirmed gone` | `namespace`, `key` | the delete's confirmation did not establish that the key is empty — a row is there because a put recreated it or the compare-and-swap was exhausted, **or the read itself failed and answered nothing** — so the vector was left alone; nothing to do, and `reconcileVectorIndex` clears it if the row really is gone |

## Tracing and metrics

This package has no tracing or metrics integration of its own: it depends on no OpenTelemetry or metrics library, and it writes nothing to the console. What it offers is a place for yours to attach.

**LangSmith and LangChain callbacks.** The adapters are persistence that LangGraph and LangChain call; they register no callbacks and start no runs. A graph or chain you trace is traced exactly as it would be over any other checkpointer, store or chat history, and the package itself emits nothing but what the injected `logger` receives.

**The logger.** Every retry is a `debug` line, `retrying after a transient error`, carrying the attempt, the delay about to be slept and the error's name, and every `warn` and `error` event is listed under [Logging](#logging). Counting those lines is the cheapest metric this package can give you: retries by error name, orphaned objects, exhausted compare-and-swaps.

**The DynamoDB client.** AWS-level latency, request counts and traces belong to the SDK client, and an injected client is used exactly as it is handed over. So build your own `DynamoDBClient`, add middleware to it (or instrument it the way your tracing setup instruments AWS SDK clients), wrap it with `DynamoDBDocument.from` and pass it as `client`. The wrapper shares the client's middleware stack, so the middleware sees every request the adapters send:

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { DynamoDBStore } from '@farukada/aws-langgraph-dynamodb-ts';

declare function recordLatency(command: string | undefined, ms: number): void;

const base = new DynamoDBClient({
  region: 'eu-west-1',
  maxAttempts: 1,
  requestHandler: { requestTimeout: 10_000, throwOnRequestTimeout: true },
});
base.middlewareStack.add(
  (next, context) => async (args) => {
    const started = performance.now();
    try {
      return await next(args);
    } finally {
      recordLatency(context.commandName, performance.now() - started);
    }
  },
  { step: 'deserialize', name: 'latency' },
);

const store = new DynamoDBStore({ tableName: 'langgraph', client: DynamoDBDocument.from(base) });
```

`maxAttempts: 1` and the request timeout are there for the reasons under [Retries and backoff](#retries-and-backoff): the library's own retry layer is then the only one, and each attempt is bounded. With `DynamoDBFactory.createAll`, pass the instrumented client as the factory's `client` and all three adapters share it.

**The S3 client.** S3 offload builds its own S3 client, one per adapter, from `s3.clientConfig`, and takes no client of yours. Its requests can be observed only through what an `S3ClientConfig` itself accepts — a `requestHandler` of your own, for instance, which replaces the default one and its 5 s idle timeout whole.

**Audit logs.** DynamoDB item-level calls (`GetItem`, `Query`, `TransactWriteItems`, …) can be recorded as CloudTrail data events on the table, and S3 object calls as data events on the bucket. Neither is recorded by default, and CloudTrail bills data events separately. The table's CloudWatch metrics are covered under [Monitoring](#monitoring).

## Advanced features

Each section below describes one capability and what it promises; the options it names are tabulated in the [Configuration reference](#configuration-reference).

### Gzip compression

Set `compression: { enabled: true }`. Payloads at or above `minSizeBytes` (default 1 KB, ceiling 512 MiB) are gzipped transparently; the stored descriptor records whether a payload was compressed, so reads never infer it from the bytes, and decompression is guarded against decompression-bomb expansion (`maxDecompressedBytes`, default 50 MiB, ceiling 512 MiB).

### S3 offloading

Set `s3: { bucketName }`. Any serialized payload at or above `thresholdBytes` (default 350 KB) is written to S3, with only a reference stored in DynamoDB. Only the payload counts toward the threshold: the store's inline vectors sit on the same item and are not weighed against it. Budget about 10 bytes per dimension **per configured field** — the store embeds one vector per extracted path, so `fields: ['title', 'body', 'summary']` at 1024 dims costs roughly 30 KB, not 10 KB — and keep `thresholdBytes` plus that total under DynamoDB's 400 KB item limit or the put fails with an `AWS_REJECTED` error wrapping DynamoDB's `ValidationException` — no raw AWS error escapes a public method. A value near the threshold indexed over many fields is the combination to watch. Reads rehydrate transparently. Requires the optional `@aws-sdk/client-s3` peer: constructing an adapter with `s3` starts loading it, and a missing package fails the first S3 operation with a `VALIDATION` error naming the install command — bundlers must keep it installed or external. Deleting a checkpoint thread / chat session also best-effort deletes its offloaded objects. When a `ttl` is also configured, call `ensureS3LifecycleRule()` once (e.g. during deployment) to install the matching S3 lifecycle rules ([their shapes](#s3-lifecycle-rules)). It **throws** when a rule cannot be written rather than logging — a `VALIDATION` error for a `keyPrefix` it will not scope a rule to, and the code the classifier assigns for anything S3 refuses — most often `ACCESS_DENIED`, for a missing `s3:PutLifecycleConfiguration` — so call it from a provisioning step and treat a rejection as a deployment error, not as something to ignore. Its one best-effort step is the versioning probe that follows the write, which warns instead (see [Maintenance operations](#maintenance-operations)). It is opt-in rather than automatic because it needs that broader bucket-level permission and is not safe to fire on every adapter construction. If you configure `ttl` + `s3` but never call it, nothing reclaims objects that best-effort cleanup misses — they stay in the bucket until you remove them or add a lifecycle rule yourself.

### Overwrite races and orphaned objects

Both the store's concurrent-`put` overwrite race and the checkpointer's *special*-write overwrite race (`__error__`, `__interrupt__`, `__resume__`, `__scheduled__`) are held by **two** mechanisms, and each answers a different question. The **compare-and-swap** decides *which* payload a write supersedes: each overwrite pins the previous descriptor it observed and re-reads on rejection, so it deletes exactly the payload it actually superseded instead of racing another writer for the same one. The **client request token** decides that a re-sent request lands *once*: a write whose payload was offloaded goes out as a one-item `TransactWriteItems` carrying a token drawn once per retry budget, so every attempt of that budget re-sends the identical request, and a retry that follows a lost acknowledgement is answered from DynamoDB's idempotency cache instead of putting the row back after a concurrent delete or a `ttl` sweep has released the object it names — a live row naming a deleted object, which every later read fails on. The two are not interchangeable, and [Write idempotency](#write-idempotency) below is why: the token says nothing about a write whose condition turned it away, and that is exactly the write the compare-and-swap then re-pins and re-issues — under a fresh token, because the re-pinned request is no longer the same request. A leak from either path remains possible in these cases, all backstopped by `ensureS3LifecycleRule()`: the bounded compare-and-swap (3 attempts) is exhausted under pathological contention, which falls back to an unconditional overwrite and logs a `warn`; a best-effort delete genuinely fails; a failed write cannot be verified, or a special write's first read of its row fails, so nothing is deleted; or one double-fault interleaving — a write that loses the swap and then exhausts its transient-error retries on an attempt that actually landed — leaves cleanup releasing the stale descriptor rather than the one it truly superseded, orphaning that one. Every write uploads under an id of its own — a store put's `rev`, a checkpoint put's ULID, a `putWrites` call's `writeGroup`, a history message's ULID — so no row another write commits names its objects, and no cleanup reads the row again before it deletes: a `store.put` or special write releases the payload it superseded once its own write has committed, `store.delete` releases the object of the row it removed, and a failed `store.put`, `saver.put` or `putWrites` releases its own uploads only once a read of the row, or the row returned with a rejected write, shows that the row does not hold its write. Uploads are sent with `If-None-Match: *`, so a retried upload request writes nothing new. Two writes of the same bytes store two objects. Separately, and unchanged by any of the above, the checkpointer's *regular* (non-special) writes still resolve a genuine race first-write-wins with no compare-and-swap, so the loser's own upload there remains an orphan reclaimed only by best-effort cleanup and `ensureS3LifecycleRule()`. A store `delete` used to have the same gap for a different reason — once the row was gone with its acknowledgement, nothing could say which object it had referenced — but it now reads the row before removing it, so the object of a delete whose acknowledgement is lost is released from that observation rather than left behind.

### Write idempotency

Some of the writes this library sends carry a **client request token**, which DynamoDB honours by treating a re-sent request as the same request rather than a new one for ten minutes. Three kinds of write carry one: every write that references an offloaded S3 object, whichever adapter sends it; the writes that are `TransactWriteItems` in their own right, which carry a token whether or not anything was offloaded — `saver.put`'s two rows, a `history.addMessages` chunk with its session row, and the session-row writes that roll such an append back; and the row removal inside `store.delete`. Everything else carries none — an inline `PutItem`, the per-row deletes of `deleteThread()`/`clear()`, and the `BatchWriteItem` that rolls back a failed multi-chunk append (that API accepts no token at all). Nothing in the token enforces those ten minutes — a re-send that arrives after them is simply a new request, and is applied — so this library's own budget does: a tokened write stops starting new attempts 300 s in, half the window, and the other half absorbs the attempt still in flight (see [Retries and backoff](#retries-and-backoff), which is also where that last attempt's own bound is, and where an injected client can give it up).

### What a token guarantees, and what it does not

A write whose first attempt **committed** is applied exactly once, at that moment — a later writer supersedes it normally, and a concurrent delete stands. A write whose first attempt was **rejected by its condition** carries no idempotency at all: a cancelled transaction never completes, so DynamoDB caches no result for its token, and a retry with the same token is a **fresh evaluation** against the table as it stands at retry time. The short version — "a retried write lands once" — is therefore false, and two further readings are wrong for the same reason. It is a statement about writes **this library sends with a token**, so it says nothing about a `BatchWriteItem`, which can carry none; and it says nothing about a first request that was already wrong, because a token only makes a *re-sent* request harmless and a race that needs no retry to go wrong is untouched by it. "Exactly once" is also about **application, not ordering**: a cancelled-then-retried write applies later than its first attempt, or not at all.

### What a token costs

A one-item transaction costs **2 write units per KB** where the `PutItem` it replaces cost 1 — on the offloaded write paths only, so an inline write is unchanged. On a *contended* row it also costs about **2.6 requests per logical write**, because most attempts come back as retryable transaction conflicts rather than as a clean win-or-lose: measured against DynamoDB, conflicts were 38% of attempts with two writers racing on one row, 65% with five and 86% with twenty, against 0% at every width for the plain conditional `PutItem` this replaces. Size a table's write capacity for the units and a bill for the requests: uncontended an offloaded write is 2× the units and 1× the requests of a plain conditional put, and on a hot row it is roughly five times the cost. The budget absorbs the conflicts — they are retried, not surfaced — and `putWrites`' inline fan-out stays at 1× both, which is why the token is scoped to the writes that reference an object rather than to every write of an S3-enabled adapter.

### What a partition delete promises

`deleteThread()` and `clear()` remove exactly the rows their one partition read observed, and nothing else. Each row goes out as its own `DeleteItem` conditioned on the per-write id that read saw on it — a pending write's `writeGroup`, a session row's own `writeId`, or the `writeId` inside the payload descriptor a checkpoint or message row carries — so a row **rewritten between the read and its delete is refused rather than removed**. The refusal is the whole of the promise: that rewrite was a write already acknowledged to its author, and deleting it would take the row *and* release the S3 object the rewrite had uploaded, leaving nothing behind to say either had happened. A refused row is left exactly as its writer left it, nothing it names is released, and it is logged at `warn` with its sort key and counted as skipped rather than deleted; the call itself still resolves. Refusals also carry forward inside a checkpoint: its rows arrive `META`, then `PAYLOAD`, then `WRITE`, and each kind is settled before the next is issued, so a refused checkpoint takes the rest of its own rows out of the pass instead of being half-deleted. Two limits stay, and neither is softened by the pin. A row written at a key the read never saw still survives the pass — that is the quiescence caveat, unchanged — and a row written before these ids existed carries none, so it is deleted unconditionally exactly as every row once was, which makes the promise **temporal**: a table upgraded in place drains into it as its rows are rewritten, and a table started on this release is already there. Re-running the call once the partition is idle is the remedy for every row a pass leaves behind, and [*What can still go wrong*](#what-can-still-go-wrong) lists the shapes one can take.

### What a partition delete costs

One conditional `DeleteItem` per row, where a `BatchWriteItem` carried twenty-five — **about 25× the requests**, so a 10 000-row thread costs roughly **10 000 requests** where it used to cost 400. There is no cheaper shape that still refuses anything: `BatchWriteItem` silently ignores a condition written on a delete request and removes the row anyway. The pass still buffers twenty-five rows at a time and keeps at most **8 requests in flight** — a fixed number, not an option — so a partition of any size opens at most eight sockets rather than one per row, and the memory it holds is bounded by the buffer rather than by the partition. Neither bound is on the *time*: the requests are the 25× above and they go out eight at a time, so a wide thread takes proportionally longer to empty than it used to, and nothing here caps that. **Write capacity for the rows actually deleted is unchanged**: a conditional `DeleteItem` is charged what the unconditional one was, and this path sends no transaction, so nothing here doubles the units the way an offloaded write does. What DynamoDB bills for a *refused* delete is **not a figure this project has measured**, and it is left unstated rather than guessed at — a cost table that quotes an unmeasured number is how a cost table becomes fiction. Size for the request count first: on a wide thread that is the term that grew.

### TTL expiry

Set `ttl: { days }` or `ttl: { seconds }`. The `ttl` attribute is written as a Unix-epoch-seconds timestamp; enable DynamoDB TTL on the `ttl` attribute for automatic deletion. Every adapter filters rows past their `ttl` on read — `get`/`search`/`listNamespaces` in the store, `getTuple`/`list` in the checkpointer, `getMessages`/`listSessions` in chat history — so nothing expired comes back during DynamoDB's sweep lag. For the checkpointer that means a thread whose head expired reads as its newest *live* checkpoint (or as empty), older checkpoints can expire while the head lives (so `parentConfig` may point at a checkpoint that is gone, which LangGraph's resume path does not need), and a swept payload reads as "no checkpoint" only for an already-expired head. Chat history anchors a single **uniform whole-conversation TTL** on the session's metadata row, shared by every message: normally it's set once, at session creation, via `if_not_exists`; but if the previously-stored anchor is ever found missing or already expired (DynamoDB's own TTL sweep can lag up to ~48h), the next append heals it with a plain overwrite instead of staying stuck. Every message written at any point in time shares whatever the current anchor is; expired messages are also filtered out on read. If the append that triggers a stale-anchor heal is itself later rolled back (a later chunk in the same call failed), the healed ttl is not reverted — the session simply keeps the fresher, never-shorter expiry rather than risk regressing a value a concurrent legitimate extension may have since written; this is a deliberate, self-healing tradeoff, not a bug. Turning `ttl` on for a chat-history table that already holds sessions stamps the anchor and every *new* message only; message rows written before that keep no `ttl`, outlive their session row, and still come back from `getMessages` — clear those sessions or backfill a `ttl` onto their rows when enabling expiry retroactively.

### Plain (metadata) search

In the store, a `search()` call with no `query` (or with a `query` but no `index`/`vectorBackend` configured) reads rows under the `namespacePrefix` and decodes them in batches of 8 — applying `filter` in-process — until `offset + limit` matching items are in hand, then stops: the page is the complete answer, so a namespace far larger than the page costs neither a full decode nor a `RESULT_TRUNCATED` error. Only a page that cannot be filled from fewer rows is bounded by `maxScanItems` (default 10,000; exceeding it throws rather than silently returning a partial result). This is a different cap from `maxSearchCandidates` below: `maxScanItems` gates rows read, `maxSearchCandidates` gates the in-DB semantic ranker. For namespaces that routinely exceed the default, prefer a `vectorBackend` or a narrower `namespacePrefix` over raising the cap, which stops at 1,000,000.

### Semantic search

Give the store an `index` with a LangChain `Embeddings` implementation. On `put`, each configured field is embedded separately — one vector per extracted path, as the reference store does — and on `search` with a `query` an item is ranked by its **best-matching** vector, so a long document with one strongly relevant section is found instead of being averaged away. By default those vectors are stored on the item and ranking happens in-process over the scoped candidate set (bounded by `maxSearchCandidates`, default 1000 and ceiling 100,000 — exceeding it throws a `VALIDATION` error as soon as more rows than that exist under the prefix, before any row is decoded or the query embedded, steering you to an external index). A row written before the per-path change carries a single vector and still ranks exactly as it did. A `vectorBackend` search that reaches `maxSearchCandidates` while its `filter` has left fewer than `offset + limit` matches throws the same error instead of returning a silently short page. A canonical read that fails fails the search for the same reason: under throttling or an outage the page used to come back quietly one item short, with only a `warn` the default silent logger never printed, while the in-DynamoDB path raised — the two paths now answer alike. Only a match naming an address this store cannot form (a namespace element holding the reserved separator, which `reconcileVectorIndex` repairs) is still dropped with that `warn`. For large corpora, pass a `vectorBackend`: a **single** vector over the joined fields is sent there instead of the per-path set, similarity search is delegated to it, and DynamoDB still holds the canonical item. Per-item indexing can be overridden via the `index` argument to `put` (`false` to skip, or a `string[]` of fields).

### Vector index consistency

When a `vectorBackend` is configured, **DynamoDB holds the canonical item** and the backend is a rebuildable index. After each canonical write the embedding is synced to the backend best-effort: a failure is logged (not thrown), so a backend hiccup never fails an otherwise-successful `put`/`delete`. A `delete` additionally confirms the key holds no row — one consistent `PK`-only read — immediately before dropping its vector, and keeps the vector when it finds one, so a put that recreates the item mid-delete, and a delete that resolves with the item still there, both stay searchable; an `info` records it. The confirmation also runs *above* the S3 cleanup rather than after it, so no round trip with its own retries and its own backoff sits inside the window any more. A put committing in the gap between that read and the backend call is what remains, and it needs a compare-and-swap the `VectorBackend` contract cannot express — which is a third-party promise no implementation would be obliged to honour, so the residue is narrowed twice and still open: the reorder took the window from a whole S3 cleanup down to adjacent statements, and the confirmation took it from *any* put landing in that stretch down to one that commits between the read and the backend call. To repair drift, call `store.reconcileVectorIndex(namespacePrefix)` — it re-pushes every live embedding and, when the backend implements the optional `listKeys`, prunes vectors with no canonical item; it returns `{ upserted, pruned }`. Run it when the namespace is idle. Caveats: reconciliation re-embeds with the store's **configured** index fields, so per-`put` field overrides are not reproduced; prune happens only when `listKeys` is implemented (otherwise reconcile re-pushes only and logs that prune was skipped); the prefix must be a non-empty namespace. The prune keeps two windows of its own, unchanged by this release and wider than the delete path's: a candidate the snapshot *saw* but that now yields no indexable text is pruned on that evidence alone, with no confirmation read, so an item re-put with indexable text between the snapshot and the prune loses its vector; and a candidate the snapshot never saw is confirmed gone one statement before the backend call, the same two-statement gap as above. "Run it when the namespace is idle" is a precondition, not a hedge.

### Checkpointer semantics

`put()` of an existing `checkpoint_id` is last-writer-wins, as in the reference savers: the transaction is unconditional, so two processes writing the same id keep whichever **committed** last, and the loser's offloaded objects wait for the lifecycle rule. Committed, not landed, and the difference is observable: every `put()` draws a token of its own, so two distinct calls never deduplicate each other, but a *retry* no longer overtakes a call that committed after it. A commits, A's acknowledgement is lost, B commits, A retries — A's retry is answered from the idempotency cache and B's checkpoint survives, where before it re-landed and A won. `putWrites` issues one guarded `PutItem` per write — a one-item `TransactWriteItems` where that write's payload was offloaded — all in parallel, so a `Send` fan-out of a thousand branches is a thousand concurrent writes (fine on on-demand tables; size provisioned capacity accordingly). `deleteThread()` reads the partition once and deletes what it saw, rows first and then their offloaded objects, with no read in between. A graph still running on the thread can leave fresh rows behind — a write that *starts* after the partition read lands and survives the pass — so call it when the thread is quiescent. A write that committed *before* that read and whose retry lands after the delete is now discarded instead of applied, but only where the write carries a token: `put()`'s two rows always do, and a `putWrites` write does when its payload was offloaded. A `putWrites` write that stayed **inline** is deliberately still a plain `PutItem` — it names no S3 object, so it can strand none, and tokenising a thousand-branch `Send` fan-out would double its write capacity to buy nothing — so that one can still put its row back after the delete. What comes back is an ordinary row rather than one pointing at a deleted object, which is why the cheap shape is the right one there. A delete that fails part-way leaves the objects of its already-deleted rows to the lifecycle rule. `list()` without a `thread_id` lists every thread in the table: through a table scan, like the reference savers, or through the recency index when `indexName` is set.

### Chat history semantics

Message order is the write order of one adapter instance (its ULIDs are strictly monotonic even within a millisecond); across instances or processes it is the writers' wall clocks at millisecond precision, so a process whose clock lags can sort a later turn before an earlier one. The default `serde` is the plain-JSON `JSON_SERDE`: a `Uint8Array`/`Buffer` inside a message (a `ToolMessage.artifact`, say) reads back as an index-keyed object, and so does a `Map` or a `Set`. For binary fidelity, pass LangGraph's `JsonPlusSerializer` — which **no package exports as a symbol you can import**: `@langchain/langgraph-checkpoint` ships it at `dist/serde/jsonplus`, exports neither it nor its module, and its `exports` map admits only `.` and `./package.json`, so both `import { JsonPlusSerializer } from '@langchain/langgraph-checkpoint'` and any deep path are errors rather than imports. The supported way to hold the instance is to take it off a saver that already has it, since it is the base class's default: `serde: new MemorySaver().serde`, with `MemorySaver` imported from that package, is a `SerializerProtocol` and is the same serializer `DynamoDBSaver` uses when you pass no `serde`. A `Date` is **not** a reason to reach for it: neither default round-trips one, and both read it back as an ISO string (see [Table schema](#table-schema)). Keep a `Date` as an ISO string, or an epoch number, in the message yourself. A batch over 99 messages or 3.5 MB is committed in chunks and is atomic from the writer's perspective only: a concurrent reader can see the first chunks before the append settles, and a rolled-back append still bumps the session's `updatedAt`. Under heavy contention on one session an append can spend up to about 61 seconds per chunk *sleeping* between retries (18 attempts, 5 s cap), which is about four minutes of wall time per chunk once the attempts themselves are counted at the per-attempt bound (see [Retries and backoff](#retries-and-backoff)) — and the sleeping is three times as long again when an injected client keeps the SDK's own retries. `clear()` has the same single-pass, quiescent-session caveat as `deleteThread()`: a message appended while it runs may survive it. Each message's object is keyed by that message's own id, so a new message never shares an object with a row being deleted.

### Differences from `InMemoryStore`

The store follows the reference semantics, and every observable difference is listed under [Versioning and compatibility](#differences-from-the-reference-implementations). The ones a caller meets first: `$gt`/`$gte`/`$lt`/`$lte` compare like types only, where the reference reduces both sides with `Number()` (a stored `'10'` does not match `{ $gt: 5 }` here, and two ISO-8601 date strings compare as dates rather than as `NaN`); results come back in key order, not insertion order; and the per-item `index` argument of `put` is honoured only on direct `DynamoDBStore` calls — LangGraph's `AsyncBatchedStore`, which wraps the store inside a graph, does not forward it. `$eq`/`$ne`/`$in`/`$nin` and a plain field condition compare by deep equality, where upstream compares with `===`, so there an object- or array-valued field never equals a condition, even an identical one. An empty field condition `{}` constrains nothing, as upstream does. `put()` refuses a `null` value, which the reference treats as a delete; call `delete()` instead.

### Strong consistency

Checkpointer read-your-writes (`getTuple`) and every `store.get` use `ConsistentRead`, so a value written and immediately read back is never served a stale replica. Bulk reads (`list`, `listNamespaces`, `listSessions`) stay eventually consistent for lower cost.

## Infrastructure setup

One table backs all three adapters. Create it with **AWS CDK** or **Terraform**.

<details>
<summary><strong>AWS CDK (TypeScript)</strong></summary>

<!-- sample:skip aws-cdk-lib is not a dependency of this package -->
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

### S3 lifecycle rules

`ensureS3LifecycleRule()` writes **two** rules, both scoped to the adapter's `keyPrefix`. They are
given verbatim here so a deployment that manages its own lifecycle can reproduce them — one that
configures `s3` without a `ttl` (where the call is a no-op), or one that never calls it at all:

```json
{
  "ID": "langgraph-ttl-langgraph-checkpoints",
  "Filter": { "Prefix": "langgraph-checkpoints/" },
  "Status": "Enabled",
  "Expiration": { "Days": 32 },
  "NoncurrentVersionExpiration": { "NoncurrentDays": 1 }
}
```

```json
{
  "ID": "langgraph-ttl-langgraph-checkpoints-markers",
  "Filter": { "Prefix": "langgraph-checkpoints/" },
  "Status": "Enabled",
  "Expiration": { "ExpiredObjectDeleteMarker": true }
}
```

Both ids are slugs of the `keyPrefix`, so each adapter's prefix gets its own pair. `Days` is the
`ttl` rounded up to whole days plus a two-day margin for DynamoDB's TTL sweep lag — 32 above is
`ttl: { days: 30 }` — and it governs the **current** version only.

`NoncurrentDays` is the grace a **released** payload gets. On a versioned bucket, releasing an
object does not erase it: it becomes a noncurrent version behind a delete marker, and this is the
window in which it can still be restored. One day is S3's smallest and rounds up to the next UTC
midnight, so the real window is 24–48 h.

It is a floor, never a cap, and the floor is measured against **every rule that already governs
these keys**: the longest `NoncurrentDays` among them is what gets written. S3 honours the
*shorter* of two overlapping expirations, so a prefix-scoped day written beside a bucket-wide
90-day retention would quietly cut the real window under this prefix from 90 days to one; taking
the longest is what makes "nothing here shortens a retention you chose" true rather than merely
intended.

Only an `Enabled` rule counts — a disabled one expires nothing, so it neither shortens a window nor
raises this floor. An enabled rule governs these keys when it:

- names no prefix at all: bucket-wide, or filtered only by tags or object size. A filter this
  library cannot read in full is taken to cover everything, which is the safe direction for your
  recovery window — it can only lengthen retention. Safe is not free: a longer floor holds another
  day of released payloads for every day it adds, and since a delete marker is only reclaimed once
  its last noncurrent version has expired, the marker set under the prefix grows with it, which is
  what an out-of-band sweep over these keys has to walk. Reading a prefix out of `Filter.And`
  makes an unreadable filter rare rather than impossible;
- names a prefix in `Filter.Prefix` that this `keyPrefix` starts with;
- names that prefix somewhere else the schema allows — nested in `Filter.And.Prefix` beside tags or
  size bounds, or in the older top-level `Prefix` — and this `keyPrefix` starts with it.

A rule scoped beside this prefix, or beneath it, is left out: it governs none of these keys, or
only some of them.

**The floor ratchets.** This library's own rule is one of the rules it measures against, so a value
written once outlives the rule that justified it — delete your bucket-wide 90-day rule and the 90
days stay, because lowering them is exactly the silent shortening this is here to prevent. The way
back down is to delete this library's rule and call `ensureS3LifecycleRule()` again, which writes
it afresh at the one-day grace.

Fields on either rule that this library does not manage survive the rewrite a changed `ttl`
triggers: `NewerNoncurrentVersions`, `Transitions`, `NoncurrentVersionTransitions` and
`AbortIncompleteMultipartUpload` are carried across. A rule written in the older schema — a
top-level `Prefix` and no `Filter` — is **upgraded** to a `Filter` rather than carried across
beside one, since the two are alternatives and a rule holding both is refused. Only the
`Expiration` is replaced outright rather than merged: merging this library's `Days` into a `Date`
you set would change the expiry you configured.

The second rule reclaims the delete markers themselves, once the last noncurrent version under a
key has expired. It has to be a separate rule — S3 rejects `ExpiredObjectDeleteMarker` inside an
`Expiration` that also carries `Days`, with `MalformedXML` — and without it every release leaves a
marker that never goes away.

Both of those clauses do nothing on a bucket **without versioning**: there are no noncurrent
versions to keep and no markers to reclaim, and a release is an ordinary delete with no recovery
window at all. Versioning is the operator's to enable; this library reports what it finds and
changes nothing it was not asked to. `ensureS3LifecycleRule()` reads the bucket's versioning state
after it has written the rules and logs a `warn` for anything but `Enabled` (see
[Logging](#logging)) — it never refuses, because the rules are worth writing either way and a
deployment that worked yesterday on an unversioned bucket must not start failing today.

**Versioning is reported, never enforced**, and that makes it the largest thing here that nothing
stops you getting wrong: the `warn` is the entire mechanism, and an operator who does not read it —
or who never calls `ensureS3LifecycleRule()`, and so never gets it — can be running the prevention
layer on an unversioned bucket without knowing. There is no grace window behind it there: every
release is a real delete, [the sweep](#finding-rows-whose-payload-was-released) has no delete
marker to list, and a row that does end up naming a released object is unrecoverable rather than
restorable. The library never calls `PutBucketVersioning` on your behalf: versioning is
bucket-wide, cannot be switched off once enabled (only suspended), and starts billing for every
version of every object in the bucket, so enabling it is a decision for whoever owns the bucket.
Suspending it is the worse of the two states, and the `warn` says so separately: a write then takes
the null version, a second write replaces it outright, and versions written while versioning was on
keep costing storage.

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

When S3 offloading is enabled, the role also needs the object actions under the configured key prefix (`langgraph-checkpoints/` by default; adjust when `keyPrefix` is set) and, only for the deployment-time `ensureS3LifecycleRule()` call, the two lifecycle actions plus the versioning read on the bucket itself:

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
  "Action": [
    "s3:GetLifecycleConfiguration",
    "s3:PutLifecycleConfiguration",
    "s3:GetBucketVersioning"
  ],
  "Resource": "arn:aws:s3:::<bucket>"
}
```

`s3:GetBucketVersioning` is the one action there whose absence is **not** fatal: the call reports the bucket's versioning state and logs a `warn` it cannot read it, so a role provisioned before this action existed keeps working and simply learns nothing about its recovery window.

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

### Trust boundary

**Whoever can write a row chooses a code path in whichever process reads it.** A payload is bytes plus a serializer, and the checkpointer's default serializer — LangGraph's `JsonPlusSerializer` — does more than parse them. A stored record carrying an `lc` marker is a *constructor* record: `{"lc":1,"type":"constructor","id":["langchain_core","messages","HumanMessage"],"kwargs":{…}}` reads back as a real `HumanMessage`, built by calling that class with the stored arguments. The `Map`, `Set` and `Uint8Array` it restores (see [Table schema](#table-schema)), and a `RegExp` and an `Error` besides, come from a second record shape, `{"lc":2,…}`, rebuilt from a fixed list of those five names that never consults the allow-list. The class is chosen by the row, not by your code.

Four measured facts bound what that means:

- **The set of constructible classes is an allow-list, not the module graph** — for the one record shape that reaches it. A record that is `lc: 1`, `type: "constructor"` and carries an array `id` is resolved through LangChain's `load()`, and an `id` that allow-list does not contain — `["evil","Thing"]`, `["node","child_process","exec"]`, and equally `["langchain_core","messages","NoSuchMessage"]` — **fails the read** rather than resolving to anything: a `VALIDATION` error naming `serde`, with LangChain's own resolution failure as `cause`, on all three adapters and under every corruption policy. So this is not a path to arbitrary code — no module outside the import maps `load()` consults can be named — but it is wider than a list of classes. The name is looked up across everything a resolved namespace exports and then invoked with `new`, so an ordinary exported *function* resolves exactly as a class does, and many of the reachable exports are ordinary functions. `load()` then renames what it built, `Object.defineProperty(instance.constructor, "name", …)`, so a name whose function returns a plain object renames the **global `Object`** for the life of the process and every plain object in it reports `constructor.name` as whatever the row chose — the one effect of such a read that is not confined to the value returned.
- **Every other record shape is returned without a word, and two of them are not data.** The second shape, `{"lc":2,"type":"constructor",…}`, is what restores a `Map`, a `Set`, a `RegExp`, an `Error` or a `Uint8Array`, from a fixed list of those five names that never consults the allow-list; an `id` outside it — `{"lc":2,"type":"constructor","id":["child_process"],"method":"exec","args":["…"]}` — reads back as the plain object it is, with nothing resolved, nothing invoked and **nothing raised**. The same holds for an `lc: 1` record whose `id` is not an array, one whose `type` is not `"constructor"`, and an `lc` value that is neither 1 nor 2. Two further `lc: 2` shapes are not constructor records at all and hand back no data: `{"lc":2,"type":"undefined"}` reads back as `undefined`, removing the key from the object that held it, and `{"lc":2,"type":"delta_snapshot","value":…}` builds a LangGraph `DeltaSnapshot` around whatever the row put in `value`. The *refusal* covers only the shape above, and inertness covers every shape but those two. Read the refusal as containment and not as detection: a planted row of any other shape is neutralised in silence, and the reader is handed a plain object, or nothing at all, where it expected a value.
- **A stored `{"__proto__": {…}}` becomes the revived object's own prototype.** Under `JsonPlusSerializer`, reading those bytes yields an object where `o.isAdmin` is `true` while `Object.hasOwn(o, 'isAdmin')` is `false` — so a `hasOwnProperty` check says the field is absent and a plain read says it is there. It is confined to that object: the process-wide `Object.prototype` is **not** touched. Under `JSON_SERDE` the same bytes parse to an ordinary own key called `__proto__`, and the object's prototype is unchanged.
- **Everything else on the read path is already bounded** and does not depend on this choice: an offloaded object must live under the row's own identifiers, downloads and decompression are capped, and a descriptor the reader does not understand is refused rather than guessed at.

**The control is that table write access is trusted access.** Scope it the way you scope the data: the `dynamodb:LeadingKeys` policy above is what keeps one tenant from writing into another's partitions, and it is the same control, since a row planted in your partition is read by your process. A role that may write the table should be treated as a role that may invoke allow-listed `langchain_core` exports inside every reader of it.

**If that is more trust than you want to grant, pass `serde: JSON_SERDE`** — the plain-JSON serializer this package exports, and the one the store and history adapters already use. It runs `JSON.parse` and reconstructs nothing, so no `lc` record and no `__proto__` key changes what a read produces. Two costs, both real:

- What it stores is the JSON projection recorded in [Table schema](#table-schema): no `Map`, no `Set`, no `Uint8Array`, and a `BigInt` or a cycle refused at the write instead of substituted.
- **It applies to every row it reads, including rows the other serializer wrote**, and almost nothing on the row distinguishes them: both defaults record `serdeType: "json"` for every value but a raw `Uint8Array`, which only `JsonPlusSerializer` writes and which it stamps `"bytes"`. A `HumanMessage` or a `Map` written under `JsonPlusSerializer` reads back as its `lc` record, a plain object, not as the class; a payload that *is* a raw `Uint8Array` is refused outright, as the `serde` `VALIDATION`, because `JSON_SERDE` reads only the `json` form it writes. Choose it for a new deployment, or migrate by rewriting the rows; do not switch it under a live thread and expect the old rows to read as they did.

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
- **Unified error model** — every error is a `DynamoDBLangGraphError`, distinguished by its `ErrorCode`.

## Versioning and compatibility

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). For a persistence adapter the storage layout is as much a contract as the TypeScript API, so both are stated here: what a `1.x` release promises to keep, what a minor may add, and what only a `2.0` may change.

### The public API

The public API is everything exported from the package entry point (`dist/index.js` / `dist/index.d.ts`): the five classes `DynamoDBSaver`, `DynamoDBStore`, `DynamoDBChatMessageHistory`, `DynamoDBSessionChatMessageHistory` and `DynamoDBFactory`; the error model (`DynamoDBLangGraphError`, `ErrorCode`, `isDynamoDBLangGraphError`); the operator tool `backfillRecencyIndex`; the logging helpers (`redactLogger`, `redactSecrets`); and every exported type. A test (`test/types/public-surface.test.ts`) enumerates the set and pins the adapter method signatures.

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
| Chat history | `HIST#<sessionId>` | `HISTORY#SESSION`, `HISTORY#MSG#<ULID>` | session: `sessionId`, `messageCount`, `createdAt`, `updatedAt`, `v`, `writeId` (the id of the append that last wrote the row; rows last written before this release carry none), optional `title`, `gsi1pk`, `gsi1sk`, `ttl`; message: `sessionId`, `message`, `v`, optional `ttl` |

`gsi1pk`/`gsi1sk` are the [recency-index](#table-schema) keys; they are written whether or not a table defines the index, so enabling `indexName` later needs only a backfill. `embeddings` holds one vector per indexed field; `embedding` is the single joined vector older rows carry and is still read. `storedChannels` was written by `1.0.0-rc.1` and no longer is: it is ignored on read and rows carrying it keep their meaning.

Offloaded objects live at `<keyPrefix><base64url(part)/...>/<write id>.bin` — the parts identify the row that points at the object (for a history message, its session), and the last segment, not encoded, is the id of the write that uploaded it: a UUID for a store put, a ULID for a checkpoint put, a `putWrites` call or a history message. Each object also carries its row's key as S3 user metadata (`dynamodb-pk-b64`, `dynamodb-sk-b64`), the backlink AWS recommends for cleaning up orphans, and the lifecycle rule id is `langgraph-ttl-<slug of keyPrefix>`. All three are stable for `1.x`. Objects written by `1.0.0-rc.1`, whose last segment was the same kind of id base64url-encoded, are still read and deleted exactly as before — a descriptor always records the full key, so nothing needs migrating. The `ttl` attribute is Unix epoch seconds; compression is gzip; `serdeType` records the tag the writing serializer returned and is handed back to the **configured** serializer's `loadsTyped` on read — it names a format to that serializer, it does not select one. Nothing on the row selects a serializer, and both defaults tag their bytes `"json"` for every value but a raw `Uint8Array`, which `JsonPlusSerializer` alone writes and tags `"bytes"`, so changing an adapter's `serde` changes how its existing rows read (see [Trust boundary](#trust-boundary)).

### Errors, logs and row versions

Every row this release writes carries `v`, its format version. A reader treats a row without `v` as version 0 and reads it under the rules that applied when it was written; a row whose `v` is higher than the reader understands fails with `FORMAT_UNSUPPORTED`, on every read that returns a row's content, rather than being read as though its unknown attributes did not matter. A minor may raise the version it writes only in a way older `1.x` readers still accept. A payload descriptor carries its own `schemaVersion` under the same rule and is read the same way: a forward one fails with `FORMAT_UNSUPPORTED` naming `schemaVersion` rather than `v`, on every read that returns a payload's content.

`ErrorCode` values are append-only in `1.x`; there is one error class, `ErrorContext` only gains fields, and the `details` shape of a code only gains fields. Error *messages* and log *messages* are not covered — branch on `code` and the structured fields, never on text.

**Text this library did not length-check is cut before it is quoted**, in a log line and in an error message alike: at 256 characters for a string and at 8 labels for a namespace or channel list, each marked `…(len N)` with what it really held. That covers a row's own attributes, an S3 object key, `s3.bucketName`, a `namespacePrefix` (checked label by label, never for how many labels), a failure's `name` wherever a line or a message quotes it, and a value off an object you passed in. Identifiers this library validated go in whole — a `sessionId`, a `threadId`, a `namespace` and `key` pair, and any key built from them are capped before a request is made. The structured `context` on an error is **not** cut, so what you branch on or log as data still carries the value in full.

**A relayed cause's own text takes a larger cap: 1024 characters.** Whenever an error of this library quotes what failed underneath it — an AWS SDK error a public method wraps, the last failure inside a `RETRY_EXHAUSTED` error, an S3 transfer failure, a `COMPENSATION_FAILED` error, or whatever your `serde` or `vectorBackend` threw — that text is redacted and then cut at 1024, marked the same way. It is prose rather than an identifier: an IAM `AccessDenied` naming a principal ARN, an action and a resource ARN runs to several hundred characters and is the one diagnostic worth reading in full, while an error thrown by your own collaborator is as long as you make it and is quoted once per row on reads that walk a whole prefix or table. The cause itself is attached as `err.cause` and keeps its message whole; only the quoted copy is cut. One option key is deliberately left alone: the `options.<key>` an unknown-option `VALIDATION` names is also its `context.field`, and `context.field` is not cut, so cutting the message would make the two disagree.

### Supported runtimes and peers

| Dependency | Supported | Verified by |
| --- | --- | --- |
| Node.js | 22, 24 and 26 | the unit tier on Linux, macOS and Windows |
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

`MemorySaver` and `InMemoryStore` are the behaviour this package matches. Every observable difference is listed here; anything not in this table is a defect, not a choice, and the differential tests are what enforce that. From `1.0.0`, adding a row is a **minor** at most, and only when the reference itself is the defect or this package's storage and key rules require the difference; changing one a caller may already rely on is a **major**.

| # | Difference | Kept because |
| --- | --- | --- |
| V-1 | Write identity is `(taskId, channel, occurrence)` | index positions are unstable across a retry; kept unobservable by read-side dedup |
| V-2 | Namespace prefixes match element-wise | the reference compares the joined string, so `['users']` matches `['userspace']` |
| V-3 | Namespace elements may not contain `#` | the separator is structural in the sort key |
| V-4 | A namespace whose items are all deleted stops being listed | the reference retains an empty namespace with no row behind it |
| V-5 | `search` / `listNamespaces` raise `RESULT_TRUNCATED` past `maxScanItems` | silently truncating a result set is worse than refusing it |
| V-6 | Re-putting with `index: false` clears the stored vector | the reference keeps a stale vector for a changed value |
| V-8 | A value JSON refuses (circular, `BigInt`) yields no index text instead of throwing from inside text extraction | the put is refused a moment later by the codec, with a `VALIDATION` error naming `value` rather than a raw `TypeError` from the embedding step |
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
| V-26 | Beyond V-3 and V-23, every store namespace label, item key and search or listing prefix label, and every checkpointer identifier — `thread_id`, `checkpoint_ns`, a given `checkpoint_id` or `thread_ts`, `taskId`, a pending-write channel and `list`'s `before` id — follows this package's identifier rules: no `#`, no control character, no unpaired surrogate, at most 256 bytes of UTF-8 (1024 for `thread_id`), and not blank, except that `checkpoint_ns` may be empty or blank; the sort key a store item or a pending write composes from them is also held to 1024 bytes. The reference stores and finds any such value. An item's namespace must also hold at least one label on every route that addresses an item — `get`, `delete` and a `batch()` put or get as well as `put()` — where the reference refuses an empty namespace in `put()` alone | each of these values is, or is matched against, a segment of a DynamoDB key, and these are the rules a key segment follows here: `#` separates segments, the byte caps keep a composed key within DynamoDB's limits of 2048 bytes for a partition key and 1024 for a sort key, an unpaired surrogate would let two ids encode to one key, and a control character would reach this package's log lines unneutralised. A value outside the rules can never be stored, so a lookup, search or listing naming one is refused rather than answered empty. A store item's partition key is its namespace's first label, so an empty namespace addresses no partition; the reference answers `get([], key)` with `null`, stores a `batch()` put under `[]`, which `listNamespaces` then reports as `['']`, and reads it back and deletes it |
| V-27 | The store's `index` option must be an object naming only `dims`, `embeddings` and `fields`, with `embeddings` providing `embedQuery` and `embedDocuments` and `fields`, when given, an array of strings; `null` is refused rather than read as no index | the reference ignores a misspelt key, so `{ feilds: ['title'] }` embeds the whole document; reads an `index` without `embeddings`, or a `null` or string one, as no index and answers every query unranked; fails at the first put when `embeddings` lacks `embedDocuments`; and crashes at construction on a string `fields` |
| V-28 | A signal that is not an `AbortSignal` — an object with a boolean `aborted` and callable `addEventListener` and `removeEventListener` — is refused with `VALIDATION` naming `signal`, before any request: as `config.signal` to `getTuple`, `list`, `put`, `putWrites` and `getDeltaChannelHistory`, and as the `signal` option of `search` and `deleteThread` | the reference never reads a signal: `MemorySaver` ignores `config.signal`, so `getTuple` with `signal: {}` answers as if none were given, `InMemoryStore.search` ignores a `signal` option, and `MemorySaver.deleteThread` takes no options. Here the wait before a retry calls the signal's `addEventListener` and `removeEventListener`, so a malformed one would otherwise fail partway through a call, after a throttled request and from inside a timer, while a call that is never retried would read only its `aborted` and ignore it silently; either way the option would go unnamed |
| V-29 | `store.delete()` can resolve with the item still there | the row is removed under a condition pinning the revision the call's own read observed, and three attempts in a row, each turned away by a write that landed since the observation that attempt pinned, exhaust the bounded compare-and-swap, so the call resolves, releases nothing and logs one `warn`. The reference holds a map and has no such race, so it always removes the item. Throwing would add a failure mode to an interleaving that succeeds today, which every caller deleting in a `finally` would have to handle, and falling back to an unconditional delete would erase the write that won. Re-run once the key is idle |
| V-30 | Namespaces are ordered by a collation pinned to the `en` locale, not by the host's | the reference sorts with bare `localeCompare`, which means "in the host's default locale", and locales disagree — `'ä'` sorts before `'z'` in German and after it in Swedish. `listNamespaces` pages by `offset`, an index into that sorted listing which the caller holds between two calls, so two hosts answering the same paged listing cut it in two different places and the caller misses one namespace and sees another twice. Parity with the reference was only ever parity on the same host, because the reference's own order varies too; pinning keeps it on every host whose locale agrees and makes the order deterministic on the rest. `en` is pinned because ICU applies no tailoring to it, and it is the one locale a Node built with small ICU still carries |

V-7 was withdrawn in 1.0.0-rc.2: it recorded `store.batch()` answering a put or a delete operation with `undefined` where the reference `InMemoryStore` answers `null`, kept for being "cosmetic" — a reason neither of the two this table allows a row for, the reference being the defect or this package's storage and key rules requiring the difference. That made the row describe a defect rather than a choice, so `batch()` was changed to answer `null` for both, matching the reference, and the row was deleted. The number stays unused.

## Production notes

- **Sharing one table** across all three adapters is supported — adapter-tagged partition keys make the key spaces provably disjoint (see [Table schema](#table-schema)), and table-wide reads filter to their own items. Checkpointer, chat-history, and *scoped* store reads are all partition-scoped (`Query`/`GetItem`).
- **Scoped reads are `Query`s.** `store.search`/`store.listNamespaces` with a concrete namespace prefix and `history.getMessages` are native `Query`s. Only a rootless `store.search([])` / unprefixed `listNamespaces`, `history.listSessions` and a `saver.list()` called without a `thread_id` (which, like the reference savers, lists every thread in the table) fall back to `Scan` (cost scales with table size, and the result spans every tenant); with `indexName` the last two read the recency index instead, whose result still spans every tenant — keep those rare or use a dedicated table. `listSessions` accepts an optional `{ maxIterations }` override for tables where non-session rows dominate the scan.
- **One S3 GET per offloaded payload per read.** Every offloaded row a read touches (`getTuple` pending writes, a plain `search()` applying its filter, `getMessages`) costs one S3 GET, and the returned bytes are decoded in memory. Reads decode up to 8 offloaded payloads at a time rather than one after another, but the request count is still linear in the offloaded row count — keep `thresholdBytes` high and compression on so that few payloads offload, and prefer a `vectorBackend` over the in-DB ranker for large semantic corpora.
- **Hot partitions.** The store's partition key is `STORE#<namespace[0]>` and chat history's is `HIST#<sessionId>` — the adapter tag is constant, so throughput still concentrates on the identifier you choose. A single partition tops out around ~1000 WCU / 3000 RCU, so avoid funneling very high write throughput through one tenant/session id; spread load across scope roots (e.g. include a tenant id as `namespace[0]`).
- **Identifier rules.** Every caller-supplied identifier (thread_id, checkpoint_ns, checkpoint_id, taskId, sessionId, store namespace elements and keys, pending-write channels) is validated before it reaches DynamoDB: it must be a non-blank, well-formed string (no unpaired surrogate) with no control characters and no reserved `#`, at most 1024 bytes of UTF-8 for the partition identifiers (`thread_id`, `sessionId`) and 256 bytes for every sort-key segment (an empty `checkpoint_ns` is legal, it is the root namespace). The same rules hold for every label of a `search` namespace prefix and of a `listNamespaces` prefix or suffix (where `'*'` still matches any label), and for `list()`'s `before` checkpoint id. Upstream's two further namespace rules — no `.` in a label, and a root other than `"langgraph"` — are applied by `store.put()` alone, exactly as `BaseStore.put` applies them: `get`, `delete`, `search`, `listNamespaces` and every `batch()` operation, which is how LangGraph reaches a store inside a graph, accept both, so a namespace such as `['memories', 'jane.doe@example.com']` that a graph writes through `batch()` can be read, searched, listed and deleted. Composed keys are checked too: a store namespace + key, or a checkpointer pending-write key, may not exceed DynamoDB's 1024-byte sort-key cap, and an offloaded S3 object key may not exceed S3's 1024 bytes. A violation is a `VALIDATION` error whose `context.field` names the offending value, thrown before any request is sent. Identifiers are stored and compared **as given**: this package does not normalise them, and it does not refuse Unicode format characters. `U+200B`, the zero-width non-joiner and joiner `U+200C` / `U+200D`, `U+FEFF`, the right-to-left override `U+202E` and the separators `U+2028` / `U+2029` are all accepted, and two identifiers differing only in Unicode composition — `café` written with `U+00E9` against `e` + `U+0301` — address two different rows. Both are deliberate. None of them can collide: DynamoDB compares strings by their UTF-8 bytes, the well-formedness rule above already makes that mapping injective, and an identifier that reaches an S3 key is base64url-encoded on the way, so the character never appears in a key at all. And refusing them would refuse ordinary text rather than hostile text — `U+200C` and `U+200D` carry meaning in Persian, Hindi and the Indic scripts, and `U+200D` is what joins the code points of a multi-person emoji. Normalising would be worse than refusing: it would fold two forms onto one key, so a row written before an upgrade would stop being found after it. What such a character *can* do is make two distinct identifiers render alike in a log line, a terminal or a dashboard; terminal escapes and line breaks, which are an injection rather than a rendering, are refused by the control-character rule above. If you want a normal form or a narrower alphabet, apply it to your own identifiers before you pass them.
- **Very large vector corpora** outgrow the in-DB ranker (`maxSearchCandidates`). Configure a `vectorBackend` (OpenSearch, pgvector, …) — the library keeps DynamoDB as the source of truth and only delegates similarity ranking.
- **TTL deletion timing** is governed by DynamoDB (typically within 48 h of expiry) and S3 lifecycle expiry is day-granular — the library writes the correct expiry timestamp (and filters expired chat messages on read) but does not guarantee instant deletion. The matching S3 lifecycle rule is not written automatically: it is installed only when you call `ensureS3LifecycleRule()`. That rule expires objects `ceil(ttl in days) + 2` days after creation — the two-day margin covers DynamoDB's sweep lag so an object never disappears before its row — and it expires **noncurrent** versions after the longer of one day and whatever `NoncurrentDays` already governs these keys, so a versioned bucket keeps a recovery window for a released payload without this library ever shortening a retention you chose (on such buckets the library's best-effort deletes only add delete markers). A **second** rule reclaims those delete markers once the last noncurrent version under a key has expired; without it every release leaves a marker that never goes away. [Both shapes are given verbatim](#s3-lifecycle-rules), for a deployment that manages its own lifecycle. `ensureS3LifecycleRule()` is a read-modify-write of the bucket's whole lifecycle configuration: call it sequentially across adapters and deployers, never concurrently.

## Operations

### Limits

*Value* is the limit in force: for an option, its default. *Ceiling* is the largest value that option accepts; a larger one is refused at construction with a `VALIDATION` error naming the option. *Fixed* marks a limit no option changes.

| Limit | Value | Ceiling | Where it bites |
| --- | --- | --- | --- |
| Page size (`limit` on `saver.list`, `store.search`, `store.listNamespaces`, `history.getMessages`, `history.listSessions`) | none — each method's own default | 10 000 | `VALIDATION` naming `limit`, **at the call** rather than at construction. `limit: 0` asks for an empty result and is answered without a read; a negative one is refused. The exception is `history.getMessages` and the `forSession` window, which refuse `0` too — an empty conversation window is what a chain reads as the whole session |
| DynamoDB item size | 400 KB | fixed | a payload over `thresholdBytes` (default 350 KB, ceiling 392 KB) must offload to S3; without `s3` a serialized payload over 392 KB is refused with a `VALIDATION` error before the write |
| Partition identifiers (`thread_id`, `sessionId`) | 1024 bytes UTF-8 | fixed | `VALIDATION` |
| Sort-key segments (`checkpoint_ns`, `checkpoint_id`, `taskId`, channel, store namespace element, store `key`) | 256 bytes each, 1024 bytes composed | fixed | `VALIDATION` |
| S3 object key | 1024 bytes | fixed | identifiers are base64url-encoded into it, so long ids reach it first |
| `ttl` | none (no expiry) | 5 years | `VALIDATION` at construction |
| Chat-history append transaction | 99 messages or 3.5 MB per chunk | fixed | larger batches are split into chunks with caller-observed atomicity |
| Append-rollback delete batches | 25 rows per `BatchWriteItem`, `UnprocessedItems` re-driven up to 10 times | fixed | `BATCH_WRITE_INCOMPLETE`, counted in chunks. Rolling back a failed multi-chunk `history.addMessages` is the only path left that deletes in batches |
| Partition delete | 25 rows buffered at a time, 8 requests in flight, one conditional `DeleteItem` per row | fixed | `BATCH_WRITE_INCOMPLETE`, counted in rows. `BatchWriteItem` cannot carry the condition each row is pinned with, so `deleteThread()`/`clear()` trade ~25× the requests for the pin |
| Rows one store read holds in memory (`maxScanItems`) | 10 000 | 1 000 000 | `RESULT_TRUNCATED` |
| Rows held in memory by `listSessions({ maxItems })` | 10 000 | none; `Infinity` asks for no cap | `RESULT_TRUNCATED` |
| Pages walked by `listSessions({ maxIterations })` | 1000 | none; `Infinity` asks for no cap | `RESULT_TRUNCATED` |
| In-DB semantic candidates (`maxSearchCandidates`) | 1000 | 100 000 | `VALIDATION` |
| Decompressed payload (`compression.maxDecompressedBytes`) and buffered S3 object (`s3.maxDownloadBytes`) | 50 MiB each | 512 MiB each | `COMPRESSION_LIMIT` / `S3_OFFLOAD_FAILED` |
| Smallest payload compressed (`compression.minSizeBytes`) | 1 KB | 512 MiB | a smaller payload is stored uncompressed; not an error |
| Retries per DynamoDB call (`retry.maxAttempts`) | 5 (about 1.5 s of sleep, about 51.5 s of wall time); message appends 18 (about 61 s of sleep, about 4 minutes) | 100 | `RETRY_EXHAUSTED` |
| Backoff delay (`retry.baseDelayMs`, `retry.maxDelayMs`) | 100 ms base, 5 s cap | 60 s each | latency, not an error |
| Offloaded payloads decoded concurrently by one read, and recency-index shards queried at once by one listing (`readConcurrency`) | 8 | 128 | latency and memory, not an error |
| Index shards per adapter (`indexShards`) | 8 | 1024 | an indexed listing issues at least one `Query` per shard, `readConcurrency` at a time; `backfillRecencyIndex` takes the same ceiling and must be given the same value |

### What each operation costs

Requests per call, before retries. "Consistent" reads are `ConsistentRead: true` (twice the read units of an eventually consistent read); S3 requests apply only to offloaded payloads.

| Operation | DynamoDB | S3 |
| --- | --- | --- |
| `saver.getTuple` | 1 consistent `GetItem` (by id) or `Query` (newest) for the META row — one more `Query` per 50 expired or foreign rows at the head of the namespace, which a `ttl` can leave behind during DynamoDB's sweep lag, since the newest-first read evaluates 50 rows per page and keeps the first live one —, 1 consistent `GetItem` for the payload, 1 consistent `Query` for the pending writes; a pre-v4 checkpoint adds a `Query` of its parent's writes | 1 `GET` per offloaded payload, 8 at a time |
| `saver.put` | 1 `TransactWriteItems` (META + PAYLOAD); after a failed transaction with `s3`, 1 consistent `GetItem` of the row carrying an offloaded descriptor, when something was offloaded | 1 `PUT` per offloaded payload; after a failure that read shows did not commit, 1 `DeleteObjects` of those uploads |
| `saver.putWrites` | 1 `PutItem` per write, all in parallel — a one-item `TransactWriteItems` instead, at twice the write units, for a write whose payload was offloaded — guarded except for a special write without `s3`; with `s3` each special write adds 1 consistent `GetItem` and up to 3 compare-and-swap attempts, then 1 unguarded `PutItem` if all 3 are rejected; with `s3`, each failed `PutItem` adds 1 consistent `GetItem` to learn whether it landed, except a regular write's conditional rejection and a special write's rejection that returned the row | 1 `PUT` per offloaded write, `DELETE` of a superseded special write |
| `saver.list` | 1 eventually consistent `Query` per page; without a `thread_id` a `Scan`, or — with `indexName` — per page of 100 rows 1 `Query` per index shard, `readConcurrency` at a time, and 1 more for a shard each time it has no row buffered while the page still needs one, even if the page then takes none of that query's rows, holding the 100 rows plus at most one DynamoDB page (1 MB) per shard; per yielded tuple 1 `GetItem` and 1 `Query` for its writes | `GET` per offloaded payload and metadata |
| `saver.deleteThread`, `history.clear` | 1 consistent `Query` per page, then 1 `DeleteItem` per row — one request each, because `BatchWriteItem` silently ignores the condition every row is pinned with — at most 8 in flight, issued in batches of 25 | 1 `DeleteObjects` per 1000 keys |
| `store.get` | 1 consistent `GetItem` | 1 `GET` |
| `store.put` | 1 consistent `GetItem` (previous descriptor and revision), 1 `PutItem` (with `s3` guarded: up to 3 attempts under contention, each re-reading from the rejection, then 1 unguarded if all 3 are rejected), sent instead as a one-item `TransactWriteItems` at twice the write units when the payload was offloaded, 1 consistent `GetItem` after a write that fails, to learn whether it landed, plus the `vectorBackend` upsert | 1 `PUT`, then `DELETE` of the superseded object |
| `store.delete` | 1 consistent `GetItem` (the revision to pin on and the descriptor to release); with a row there, 1 `TransactWriteItems` removing it under that pin, up to 3 attempts under contention, each re-pinning from the rejection and none of them deleting if all 3 are rejected; **no write at all when there is no row**; 1 consistent `GetItem` after a write whose budget is spent, to learn whether it landed; and, **only when a `vectorBackend` is configured**, 1 more consistent `GetItem` projecting `PK` alone to confirm the key really holds no row, on every path including the one that had none to begin with, followed by the `vectorBackend` delete when it does not | `DELETE` of the released object |
| `store.search` | 1 eventually consistent `Query` per page (`Scan` for `[]`), reading rows in batches of 8 until the page is full; a `query` adds one embedding call | 1 `GET` per offloaded candidate |
| `store.listNamespaces` | `Query` (`Scan` without a prefix root) per page, projected to each item's key and format version | none |
| `history.addMessages` | 1 consistent `GetItem` of the session row when `ttl` is set, then 1 `TransactWriteItems` per chunk (up to 99 messages plus the session update); a rollback costs 1 `BatchWriteItem` per 25 rows plus a session update | 1 `PUT` per offloaded message |
| `history.getMessages` | 1 consistent `Query` per page (newest-first with a page cap under `limit`) | 1 `GET` per offloaded message, 8 at a time |
| `history.listSessions` | 1 `Scan` per page, or — with `indexName` — 1 `Query` per index shard (8 by default), `readConcurrency` at a time, and 1 more for a shard each time it has no row buffered while the page still needs one, even if the page then takes none of that query's rows, holding the page (up to `limit` rows, and `limit` is capped at 10,000) plus at most one DynamoDB page (1 MB) per shard; pageable by cursor | none |
| `history.reconcileMessageCount` | 1 consistent `GetItem` of the stored count, 1 eventually consistent `Query` per page returning only each message's `v` and `ttl`, 1 guarded `UpdateItem`; all three again, up to 3 attempts in all, when the stored count changes while it counts | none |
| `store.reconcileVectorIndex` | 1 `Query` per page, embedding calls in batches, backend upserts and deletes | `GET` per offloaded item |

### Monitoring

Alert on the two `error` events (a corrupt message row, a failed append rollback) and on the five `warn` events that name an orphan or an exhausted compare-and-swap (see [Logging](#logging)); count `RETRY_EXHAUSTED` and the AWS codes (`THROTTLED`, `SERVICE_UNAVAILABLE`, `ACCESS_DENIED`, …) by `context.operation` and `context.httpStatusCode`. For AWS Support you want the `requestId` of the last failure, and it is on the **cause**: ``RETRY_EXHAUSTED`.context` carries `attempts` and nothing else, the last error is its `cause`, and the id is that error's own `$metadata.requestId`. The `debug` retry line names the attempt, the delay and the error's name — no `requestId`. An AWS failure a public method wrapped is the one that carries it in its own context (`error.context.requestId`), copied off the SDK error it wraps. Watch the table's `ThrottledRequests` and `ConsumedWriteCapacityUnits` per partition key prefix — the [hot-partition](#production-notes) note explains which identifier concentrates load.

### What can still go wrong

A row in DynamoDB and its payload in S3 are two writes with no transaction across them, and the durability of that pair is layered: a compare-and-swap and a request token prevent the losses they can, S3 versioning contains what slips through, and the sweep below finds it. No layer is total. This is the list of what is left, so that none of it is met as a surprise. None of these is a known defect — each is a deliberate limit, with what backstops it.

- **A write that outlives the token window.** DynamoDB honours a token for ten minutes and a tokened write stops starting attempts at 300 s, so reaching the window takes an injected client with no request timeout of its own, or a clock that jumps backwards. Past it a re-send is a new request and is applied, which can put a row back naming an object something else released. On a versioned bucket the payload is still there for the grace window, so the row is restorable and the sweep below finds it.
- **A strand older than the grace window.** Once S3 has reclaimed the noncurrent version and then the delete marker, there is no marker to list and no backlink to read. The sweep is blind to it by construction; the table-scan recipe below is the only way to find one.
- **An inline write can still re-land.** An inline `store.put` or `putWrites` whose acknowledgement is lost can put back a row a concurrent delete removed, because inline writes carry no token on purpose. The row simply comes back: it names no S3 object, so no read fails. An offloaded write in the same interleaving lets the delete stand — the two differ by where `s3.thresholdBytes` falls, and a caller who wants them uniform sets it low.
- **Versioning off, or suspended.** The containment layer is then absent and the guarantee is the prevention layer's alone, bounded by those ten minutes. `ensureS3LifecycleRule()` warns and carries on; nothing enforces it, and nothing tells a caller at read time.
- **Transaction conflicts on a contended row are ordinary, not pathological.** On an offloaded write path a `TransactionCanceledException` whose reason is `TransactionConflict` replaces what would have been a clean win-or-lose, at the rates under *What a token costs* above. The retry budget absorbs them — at the widest race measured, 60 logical writes produced 60 clean outcomes and no exhaustion — so the residual is cost, not correctness. Exhaustion stays possible in principle under contention heavier than that.
- **A new retryable error on the inline paths.** Because an inline write stays a `PutItem` while an offloaded write to the same row is a transaction, an inline write can now meet a bare `TransactionConflictException`, which it could not before this release: 18% of the inline side's attempts under ten-against-ten contention on one row. It is retryable by name, so it costs requests rather than correctness — but it is a behaviour change on a path that is otherwise untouched, and it is the price of deciding by payload rather than by adapter.
- **The store's unconditional fallback is still unconditional.** When `store.put`'s compare-and-swap budget is spent it overwrites with no guard at all and logs a `warn`. A token stops that put's own retries re-landing it *when the payload was offloaded*, and nothing does when it was inline; nothing at all stops it overwriting what a racer committed in the meantime, and the object it then releases is whatever its last observation named. Unchanged behaviour, listed here so that "the overwrite race is closed" is not read as "the store put has no unguarded write left".
- **`deleteThread()` and `clear()` are still single-pass.** A write that starts after the partition read lands and survives the pass; only the re-landing of a write that committed *before* the read is prevented, and only where that write carries a token.
- **Leaks are unchanged.** Every orphan case listed under *S3 offloading* — an exhausted compare-and-swap, a best-effort delete that genuinely fails, a write that cannot be verified — still leaves an object behind, and `ensureS3LifecycleRule()` is still what reclaims it.
- **Some rows written before this release carry no per-write id.** A partition delete pins each row on the id the read observed of it, and a row carrying none is deleted unconditionally, exactly as every row was before. It affects the rows whose id arrived in this release — a checkpoint's `META` and `PAYLOAD` rows, a history message row and the history `SESSION` row — and not pending-write rows, which have carried `writeGroup` since `0.8.0`. It drains rather than needing a migration: a row gets an id the next time it is written, and a table started on this release has none.
- **A partition delete can split a checkpoint from its pending writes.** The two are written by different calls under different ids, so a refusal on one side leaves the other deletable: pending writes can outlive their checkpoint. The reverse — a checkpoint that loses its acknowledged `putWrites` output — is closed, because a refused checkpoint row makes the pass skip the rest of that checkpoint's rows. Closing the open direction would need the refusal known before any of the unit's deletes went out, and no ordering gives that: deleting pending writes first only swaps which direction closes. Orphaned pending writes are unreachable while their `META` row is gone — every read path starts there — with one exception: a surviving pre-v4 checkpoint whose `parentCheckpointId` names them still reads their `TASKS`-channel entries back as its own pending sends. They become reachable again if a later `saver.put` writes that checkpoint id, which serves them as that checkpoint's completed task results. What is left is reported — every row the pass leaves in place is logged at `warn` with its sort key, **one line per row and not one per checkpoint**, so a wide unit costs as many lines as it has rows — and a second call clears it.
- **A partition delete can leave a payload row whose metadata row is gone.** This is the third shape, and the split above does not describe it: a racing `saver.put` cannot cause it, because both rows go out in one transaction and nothing else writes a payload row. A delete that **fails** rather than being refused ends the pass with the metadata row already removed, and DynamoDB's own TTL sweep produces the same shape transiently while it works through a thread. Both predate this release and both are a **leak, not data loss** — every read path starts from the metadata row, so nothing serves the orphan — and both clear on a re-run.
- **`store.delete` can resolve without deleting.** Three writers landing at the item between a re-pin and its attempt exhaust the compare-and-swap; the item stays, nothing is released — correctly, a live row names it — and the call reports success with one `warn`.
- **`store.delete` cannot be cancelled, and its pre-read is not bounded by the write lifetime.** The call takes no `AbortSignal`, and the deadline covers only the writes that carry a token, so the pre-read keeps the full configured retry budget on top of the three bounded transactions: about three and a half minutes at the defaults, hours at the ceilings `retry` accepts, with nothing able to interrupt it.
- **A vector can still be dropped for a live item.** The window is two statements wide — a put that commits between the confirmation read and the backend call — and `store.reconcileVectorIndex()` is the repair, as *Vector index consistency* above describes.

Two of the things this list rests on are **new and deliberate** rather than left over, and they are the two most worth reading twice: what a token does and does not promise (*What a token guarantees, and what it does not*), and the 300 s cut on a write's retry budget ([Retries and backoff](#retries-and-backoff)).

### Finding rows whose payload was released

On a versioned bucket a released payload is not erased: it becomes a noncurrent version behind a delete marker, and it stays there for the grace window the [lifecycle rules](#s3-lifecycle-rules) set. That window is the only cheap opportunity to find a **stranded row** — one that is still live and still names an object whose payload has been released — because the object side lists exactly the releases, and every offloaded object carries its row's key as S3 user metadata (`dynamodb-pk-b64`, `dynamodb-sk-b64`).

The sweep that does this lives at `scripts/find-stranded-payloads.mjs` **in the repository**. It is deliberately not in the npm tarball and there is no `bin` for it: its command line would otherwise become a `1.x` compatibility promise for a tool an operator runs a handful of times. Clone the repository (or copy the one file) to run it:

```bash
node scripts/find-stranded-payloads.mjs \
  --bucket my-bucket --table my-table --region eu-west-1 \
  --prefix langgraph-checkpoints/ --grace-days 1
```

`--prefix` defaults to `langgraph-checkpoints/` and `--grace-days` to `1`, the grace `ensureS3LifecycleRule()` writes; pass the larger number when the bucket carries a longer `NoncurrentDays` floor, so the hours-remaining figure is not pessimistic. The script prints the settings it swept with, so a report pasted into an incident channel says what it ran against. It **exits 0 whenever the sweep completed**, found something or not, and non-zero only when the sweep itself failed — so anything you wire it into should alert on the report, not on the exit code.

**Permissions are the operator's, not the library's.** The sweep needs `s3:ListBucketVersions` and `s3:GetObjectVersion` on the bucket and `dynamodb:GetItem` on the table. The first two are actions this library never calls, which is why they are absent from the policy under [IAM permissions](#iam-permissions): grant them to whoever runs the sweep, not to the role your application runs as.

**When to run it.** On demand: after an incident, or when `S3_OFFLOAD_FAILED` or a `NoSuchKey` read failure starts alarming. Not hourly — not for what it costs in money, which is about a cent (below), but for the requests it puts on a live table and bucket. It costs per release, not per query, and the numbers below are per sweep.

**What it reads, in order.** `ListObjectVersions` under the prefix, paginated; for each released key, `HeadObject` on the **surviving payload version** to read the backlink; then a strongly consistent `GetItem` on the decoded key. A key counts as released only when its **current** version is a delete marker: one written again after a release carries its marker further down its history, its payload is current and readable, and it costs the sweep no request at all. It reports a row that is live and still names that key. A row that is gone is the ordinary release — on the happy path that is every marker — and a row that now names a different object was superseded, not stranded; neither is reported. Each finding prints the DynamoDB key, the object key, the payload version's id, the delete marker's id and timestamp, and the hours of grace remaining.

An object whose backlink cannot be read, and a row DynamoDB will not hand back, are each printed as one `UNREADABLE` line naming the object key and the reason, and the sweep carries on: one 404, one object written by something else, and one throttled read must not cost you the rest of the report.

**What it costs.** Per sweep, with `V` versions and `M` delete markers under the prefix:

| | requests |
| --- | --- |
| listing | `ceil((V + M) / 1000)` — `ListObjectVersions` returns at most 1000 entries per page, counting versions and markers together |
| per marker | 1 `HeadObject` + 1 `GetItem` |
| total | `ceil((V + M) / 1000) + 2M` |

With the marker-reclaim rule on the bucket, `M` is the releases still inside the grace window — roughly one to two days of release volume — and `V` is the live payload count plus the same. A deployment releasing 10 000 payloads a day with 100 000 live offloaded objects therefore has `V = 120 000` (100 000 live plus 20 000 not-yet-expired noncurrent) and `M = 20 000`, so one sweep costs `ceil(140 000 / 1000) + 2 x 20 000` = **40 140 requests**, dominated by the per-marker pair. At on-demand prices that is **one to two cents**, not a few dollars: 20 000 `HeadObject` at $0.0004 per 1 000 is $0.008, 140 `ListObjectVersions` at $0.005 per 1 000 is $0.0007, and 20 000 strongly-consistent `GetItem` on small items is 20 000 read request units, about $0.0025. So money is not the reason to run this on demand rather than hourly. The reason is the 40 000 requests themselves, against a live table and bucket, most of them strongly-consistent reads on rows a running graph is using.

**Without the marker-reclaim rule, `M` is total lifetime release volume** and the figure above has no upper bound: every release leaves a marker that is never reclaimed, so the sweep's cost grows for the life of the bucket. Two deployments do not get that rule from this library:

- **`s3` configured without a `ttl`.** `ensureS3LifecycleRule()` is a no-op in that shape, so a versioned bucket accumulates a delete marker per release forever.
- **Anyone who never calls `ensureS3LifecycleRule()` at all.**

Both must write the two rules themselves; [their shapes are above](#s3-lifecycle-rules), verbatim.

The cost grows with that listing; the memory does not. `ListObjectVersions` answers in ascending key order, so every entry for one object key arrives together and the sweep joins a key the moment a later one appears — it holds one key at a time, never the listing. That is what lets it finish on the bucket described above, which is the one you are most likely to sweep after an incident. It also checks that order rather than assuming it: a key listed after a later key has already been joined fails the sweep with a non-zero exit instead of reporting a join it cannot stand behind.

**What it cannot find.** A strand whose grace window has already expired. S3 reclaims the noncurrent version first and then the delete marker, so there is neither a marker to list nor a backlink to read, and the sweep is blind to it by construction. Finding those needs the opposite direction — a full table `Scan`, keeping every row that carries an offloaded descriptor, then one `HeadObject` per descriptor to see whether the object is still there — which costs a read of the whole table and stays a recipe rather than a script. While the marker is still present but its last version has gone, the sweep counts the key separately as having no surviving payload version, which is the last warning you get. Read that count as an upper bound on expired grace windows rather than a list of them: a bare delete marker is also what a `DeleteObject` on a key that never existed leaves, and what any foreign delete under the prefix leaves.

**What to do with a finding.** The script repairs nothing, and it should not: the right remedy depends on why the row is there. Either **restore the payload** — `DeleteObjectVersion` on the *delete marker's* version id, which makes the payload current again, and which only works while the hours remaining are positive — or **accept the delete** — `DeleteItem` on the DynamoDB key. For a checkpointer `WRITE` row that survived a `deleteThread()`, deleting the row is right; for a store item recreated after its object was released, it is not.

### Lambda and other short-lived runtimes

Construct the adapters once at module scope (or one `DynamoDBFactory.createAll()`), reuse them across invocations, and pass a `client` you own if the function also uses DynamoDB elsewhere; `destroy()` is only needed when a process wants to release sockets before exit. Size the function timeout against the worst-case retry budgets above: a heavily contended chat append spends about a minute sleeping and can take about four with its attempts, and `retry.maxAttempts` / `retry.maxDelayMs` trade that ceiling against resilience to throttling. Every long-running method takes an `AbortSignal`, so a timeout can cancel cleanly (see [Cancellation](#cancellation)).

### Multi-tenancy

See [Multi-tenant deployments](#multi-tenant-deployments) under IAM permissions for the identifier convention, the table-scan operations that are cross-tenant by construction, and the `dynamodb:LeadingKeys` policy.

### Maintenance operations

Four tools repair or provision state and are meant for deployment scripts and operators, not request paths:

- **`ensureS3LifecycleRule()`** (all three adapters) — installs the S3 lifecycle expiration rule that matches the configured `ttl` under the adapter's key prefix, idempotently. It **throws** when the bucket's lifecycle configuration cannot be read or written (`AccessDenied`, `NoSuchBucket`, throttling) — that part swallows nothing — so call it once at deployment time, from a role that holds the two lifecycle actions, and treat a failure as a deployment failure. One thing it does not raise: the bucket-versioning probe that runs **after** the rules are written is best-effort and reports at `warn` (see [Logging](#logging)), because a role that provisioned rules yesterday without `s3:GetBucketVersioning` must not start failing today. A bucket with no lifecycle configuration at all is not an error either; the rules are written onto an empty set. It is a no-op when `s3` or `ttl` is not configured.
- **`store.reconcileVectorIndex(namespacePrefix)`** — re-pushes every live item's embedding to the configured `vectorBackend` and, when the backend implements `listKeys`, prunes vectors whose item is gone; returns `{ upserted, pruned }`. Run it when the namespace is idle; it reads every row under the prefix (bounded by `maxScanItems`).
- **`backfillRecencyIndex({ tableName, client, … })`** — gives rows written before the recency index their `gsi1pk`/`gsi1sk`. **Run it before setting `indexName` on any adapter**: a row without the keys is not in the index, so enabling the index first makes every pre-existing session, item and checkpoint vanish from the listings that read it — the rows are still there, and every other read still returns them, but a listing would not. Resumable by passing back the `nextCursor` it returns as `cursor`, re-runnable, and safe against a live table: every write is conditional on the row still being there **and** having no keys yet. That first half is not decoration — `UpdateItem` upserts, so a condition naming only the index attribute is satisfied by a key holding nothing at all, and a row deleted between the scan that found it and the update that backfilled it used to come back, as a stub of `PK`, `SK` and the two index keys and therefore *inside* the index, where a thread-less `saver.list()` logged one `warn` for it on every listing thereafter and `history.listSessions()` dropped it silently, one row short of the `limit` its page had asked for. `indexShards` must match what the adapters use. Every option is checked before the first read, with `VALIDATION` naming it: an unknown key, a `tableName` DynamoDB would refuse, a `client` without `scan` and `update`, an `indexShards` outside 1–1024, a `pageSize` or `maxPages` that is not an integer of at least 1, a `dryRun` that is not a boolean, a `retry` whose numbers break the adapters' bounds or whose hooks are not functions, a `signal` that is not an `AbortSignal`, and a `cursor` the tool did not issue. `signal` cancels the run; so does `retry.signal` when no top-level `signal` is given, and when both are given the top-level one wins. A refused write is not a failure and does not stop the run. Both halves of the condition refuse exactly the rows this run has nothing to do for — one that already carries keys a live adapter gave it, one that is no longer there — so the row is counted in the `skipped` of the `BackfillResult` and the walk carries on; on a table with adapters writing to it, which is the only kind a backfill is ever run against, the already-indexed refusal is the normal case rather than an edge one. Any *other* AWS SDK error it does not retry reaches the caller with the code the classifier assigns and the SDK error as `cause`, and the run ends there with its result discarded — re-run it, and the scan's own filter skips whatever the stopped run had already indexed.
- **`history.reconcileMessageCount(sessionId)`** — recounts a session's live messages and rewrites the stored `messageCount`; returns the count. Run it after a `COMPENSATION_FAILED` error or the `rollback failed` log event, when the session is idle; it throws `CONDITION_CONFLICT` if an append lands through every one of its three attempts, and for a session that does not exist rather than creating one. It also refuses, with a `VALIDATION` error naming `message`, a session whose message key space holds a row this adapter did not write — the same row `getMessages` refuses — because a count written back for a session no read can open repairs nothing. It reads each row's identity, format version and ttl only; no message payload is transferred.

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

The real-AWS tier runs the same adapters against real DynamoDB, S3 and Bedrock. Every suite creates and tears down its own uniquely named table and bucket (`aws-langgraph-<suite>test-<uuid>`) in the account of the default credential chain. It runs on every release tag, assuming the OIDC role named by the repository variable or secret `AWS_TEST_ROLE_ARN` in the region `AWS_TEST_REGION` names, and the release does not publish unless it passed; it runs on no schedule, so no job bills the account between releases. A maintainer can also run it locally.

```bash
npm run test:aws                # needs AWS credentials and AWS_REGION; refuses to run without a region
```

The `examples/live-*.mjs` scripts are demos against real AWS, not a test tier: `live-checkpointer.mjs` runs a LangGraph agent across two saver instances and deletes its table afterwards; `live-agent.mjs`, `live-persist.mjs` and `live-store.mjs` leave their table in place so you can inspect the rows in the console. They need `AWS_REGION` (each stops and says so when it is unset) and read `LANGGRAPH_DEMO_TABLE` (default `langgraph-saver-demo` / `langgraph-store-demo`), and `live-agent.mjs` needs a Bedrock model enabled in that region.

### What the suite does and does not prove

| Tier | Runs | Proves |
| --- | --- | --- |
| Unit, static guards, type locks, property tests (`npm test`) | every push and PR, three OSes × Node 22, 24 and 26 | every code path (100 % coverage), the repository rules (JSDoc-only comments, no `any`/`unknown`/`instanceof`, no re-exports, no import cycles, no dead error codes, every public async method behind the error boundary, no planning references or raw control characters in committed code), the exact public export set and adapter signatures, the stated invariants (sort-key order, item-size estimate, write resolution, redaction, backoff) |
| Integration (`npm run test:integration`, DynamoDB Local) | every push and PR | end-to-end adapter flows and fault injection; the write races the compare-and-swap exists for, with an in-memory S3 in the loop; the DynamoDB semantics the unit mocks assume; parity with `InMemoryStore` and `InMemoryChatMessageHistory` under `RunnableWithMessageHistory`; a 30-way single-session append storm |
| Conformance (`npm run test:conformance`, DynamoDB Local) | every push and PR, against the declared floor and the latest `@langchain/langgraph-checkpoint` | a compiled LangGraph graph over the saver (interrupt/resume, subgraph namespaces, forks, history windows, crash-and-resume, `Send` fan-out) and LangChain's official checkpointer validation suite |
| Package smoke (`npm run test:package-smoke`) | every push and PR | the packed tarball installs and imports without the optional S3 peer, and its declarations type-check without it |
| Real AWS (`npm run test:aws`) | every release tag, gating publish; on demand locally | S3 offload, lifecycle rules and the S3 error taxonomy against the real services; real 30-way append contention; Bedrock embeddings (skipped with a reason when the model is not enabled) |

Nothing in the suite provokes real throttling or `ProvisionedThroughputExceededException` (only its classification is tested), receives `UnprocessedItems` from a batch write (DynamoDB Local and on-demand tables never return them), observes DynamoDB's TTL sweep (only the stamped attribute is asserted), uses a versioned bucket, exercises a hot partition, or measures the write capacity the compare-and-swap fallback consumes. An injected `client` that keeps the SDK's own retries multiplies the library's attempt budget; the integration tier pins that count once and every adapter warns about it at construction.

## Design decisions and evidence

Two directories worth reading before depending on this, and one guide worth reading before touching the source.

**[`docs/decisions/`](docs/decisions/README.md) — the choices that are expensive to reverse.** Eighteen architecture decision records, each stating the context, the decision and the consequences including the negative ones: why the DynamoDB SDK ships as a dependency while LangChain and S3 are peers, why every adapter shares one table under a structured key, why a large payload offloads to S3 behind a descriptor instead of being written inline, why `MemorySaver` and `InMemoryStore` are treated as the behavioural oracle, why file length and function complexity are not capped, and why the live-AWS tier gates a release rather than running on a schedule. If a constraint you have hit looks arbitrary, this is where the answer is.

**[`docs/evidence/`](docs/evidence/README.md) — what DynamoDB and S3 actually do, where AWS does not say.** Seventeen claims established by probing the live services: how the idempotency cache treats a cancelled transaction's replay, that `BatchWriteItem` accepts a condition on a `DeleteRequest` and silently ignores it, what a conditional delete against an already-gone row reports, how a versioned bucket's delete markers and lifecycle rules behave. Each claim is paired with a named live test that fails if the service's answer ever changes, and the file records the date, Region and SDK version each probe ran under — a claim is only as fresh as the last run that checked it.

**[`docs/coding-guidelines.md`](docs/coding-guidelines.md)** is the standard the source is held to, if you are contributing or auditing.

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
