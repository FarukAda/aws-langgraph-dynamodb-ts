[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BackfillOptions

# Interface: BackfillOptions

Defined in: shared/dynamodb/backfill-index.ts:28

What the backfill needs to walk a table.

## Properties

### client

> **client**: `DynamoDBDocument`

Defined in: shared/dynamodb/backfill-index.ts:29

***

### cursor?

> `optional` **cursor?**: `string`

Defined in: shared/dynamodb/backfill-index.ts:37

***

### dryRun?

> `optional` **dryRun?**: `boolean`

Defined in: shared/dynamodb/backfill-index.ts:39

Report what would change without writing.

***

### indexShards?

> `optional` **indexShards?**: `number`

Defined in: shared/dynamodb/backfill-index.ts:32

Must equal the adapters' `indexShards`, or rows land on shards no listing queries.

***

### maxPages?

> `optional` **maxPages?**: `number`

Defined in: shared/dynamodb/backfill-index.ts:36

Stop after this many pages and return a cursor. Default: walk the whole table.

***

### pageSize?

> `optional` **pageSize?**: `number`

Defined in: shared/dynamodb/backfill-index.ts:34

Rows per scan page.

***

### retry?

> `optional` **retry?**: [`RetryOptions`](RetryOptions.md)

Defined in: shared/dynamodb/backfill-index.ts:40

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: shared/dynamodb/backfill-index.ts:41

***

### tableName

> **tableName**: `string`

Defined in: shared/dynamodb/backfill-index.ts:30
