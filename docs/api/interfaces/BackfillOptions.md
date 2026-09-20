[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BackfillOptions

# Interface: BackfillOptions

Defined in: [shared/dynamodb/backfill-types.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L30)

What the backfill needs to walk a table.

Split out of `backfill-index.ts` so `backfill-validation.ts` can build a
compiler-verified key list against it (`allKeysOf<BackfillOptions>`)
without that module and `backfill-index.ts` importing each other.

## Properties

### client

> **client**: `DynamoDBDocument`

Defined in: [shared/dynamodb/backfill-types.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L31)

***

### cursor?

> `optional` **cursor?**: `string`

Defined in: [shared/dynamodb/backfill-types.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L39)

***

### dryRun?

> `optional` **dryRun?**: `boolean`

Defined in: [shared/dynamodb/backfill-types.ts:41](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L41)

Report what would change without writing.

***

### indexShards?

> `optional` **indexShards?**: `number`

Defined in: [shared/dynamodb/backfill-types.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L34)

Must equal the adapters' `indexShards`, or rows land on shards no listing queries.

***

### maxPages?

> `optional` **maxPages?**: `number`

Defined in: [shared/dynamodb/backfill-types.ts:38](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L38)

Stop after this many pages and return a cursor. Default: walk the whole table.

***

### pageSize?

> `optional` **pageSize?**: `number`

Defined in: [shared/dynamodb/backfill-types.ts:36](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L36)

Rows per scan page.

***

### retry?

> `optional` **retry?**: [`RetryOptions`](RetryOptions.md)

Defined in: [shared/dynamodb/backfill-types.ts:47](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L47)

The full retry surface, not the adapters' narrower `RetryPolicy`:
`onRetry` is backfill's only way to observe retries in progress, since it
takes no `logger`.

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/dynamodb/backfill-types.ts:48](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L48)

***

### tableName

> **tableName**: `string`

Defined in: [shared/dynamodb/backfill-types.ts:32](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/backfill-types.ts#L32)
