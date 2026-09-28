[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BaseAdapterOptions

# Interface: BaseAdapterOptions

Defined in: [shared/options.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L24)

Options common to every adapter (the unified options shape). An adapter
either reuses an injected `client` or builds one from `clientConfig`.

## Properties

### client?

> `optional` **client?**: [`DynamoDBDocumentLike`](../type-aliases/DynamoDBDocumentLike.md)

Defined in: [shared/options.ts:28](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L28)

Pre-built DocumentClient to reuse; when set, the adapter does not own it.

***

### clientConfig?

> `optional` **clientConfig?**: `DynamoDBClientConfig`

Defined in: [shared/options.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L30)

The config a client is built from when `client` is not provided.

***

### indexName?

> `optional` **indexName?**: `string`

Defined in: [shared/options.ts:74](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L74)

Name of the recency index (a GSI on `gsi1pk`/`gsi1sk`) on this table.

Opt-in on purpose: whether the table carries the index is deployment
configuration the operator knows, and probing for it would spend a failed
request per process to find out. Naming it switches two listings that
would otherwise scan the whole table onto a read of the index, newest
first: `history.listSessions`, which pages it by cursor, and a
`saver.list` without a `thread_id`, which streams it and takes no cursor.
Leaving it unset keeps both on the table scan, so the index can be created
and backfilled before any adapter reads it.

The store takes no `indexName`: its rootless search and its namespace
listing stay table scans.

***

### indexShards?

> `optional` **indexShards?**: `number`

Defined in: [shared/options.ts:58](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L58)

Index partitions per adapter in the recency index (GSI1), default 8.

Checkpoint and session rows carry the index attributes whether or not the
table defines the index, so enabling it later needs only a backfill of the
rows written before. The value is fixed for the table's life. Every row
keeps the shard it was written with, and `backfillRecencyIndex` writes
keys only to rows that have none, so it cannot move a row. Raising the
count is safe: the old shards stay among the ones a listing queries.
Lowering it hides every row on a dropped shard from the listings. The
store takes no `indexShards`.

A single index partition per adapter would concentrate every listing on
one partition, which is worse than the table scan it replaces.

***

### logger?

> `optional` **logger?**: [`Logger`](Logger.md)

Defined in: [shared/options.ts:40](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L40)

Optional per-instance logger (defaults to a silent logger).

***

### readConcurrency?

> `optional` **readConcurrency?**: `number`

Defined in: [shared/options.ts:87](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L87)

How many payloads a single call decodes at once, default 8.

It is the multiplier on this package's memory ceiling, which is
`readConcurrency × (s3.maxDownloadBytes + compression.maxDecompressedBytes)`
— a downloaded object and its decompressed form are both resident while a
payload is decoded, and that much can be in flight for each concurrent
decode. Lower it on a small container; raising it trades memory for
latency on reads that fetch many offloaded payloads.

It also bounds how many recency-index shards one listing queries at once.

***

### retry?

> `optional` **retry?**: [`RetryPolicy`](RetryPolicy.md)

Defined in: [shared/options.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L42)

Retry budget and backoff for every DynamoDB call (see the README "Retries and backoff").

***

### tableName

> **tableName**: `string`

Defined in: [shared/options.ts:26](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L26)

DynamoDB table name.

***

### ttl?

> `optional` **ttl?**: [`TtlOption`](../type-aliases/TtlOption.md)

Defined in: [shared/options.ts:38](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L38)

Optional time-to-live applied to written items.
