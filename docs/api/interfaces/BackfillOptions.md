[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BackfillOptions

# Interface: BackfillOptions

Defined in: [backfill/backfill.ts:323](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L323)

What the backfill needs to walk a table. A key this type does not declare is refused.

## Properties

### client

> **client**: [`DynamoDBDocumentLike`](../type-aliases/DynamoDBDocumentLike.md)

Defined in: [backfill/backfill.ts:324](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L324)

***

### cursor?

> `optional` **cursor?**: `string`

Defined in: [backfill/backfill.ts:332](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L332)

***

### dryRun?

> `optional` **dryRun?**: `boolean`

Defined in: [backfill/backfill.ts:334](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L334)

Report what would change without writing.

***

### indexShards?

> `optional` **indexShards?**: `number`

Defined in: [backfill/backfill.ts:327](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L327)

Must equal the saver's and the history's `indexShards`, or rows land on shards no listing queries.

***

### maxPages?

> `optional` **maxPages?**: `number`

Defined in: [backfill/backfill.ts:331](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L331)

Stop after this many pages and return a cursor. Default: walk the whole table.

***

### pageSize?

> `optional` **pageSize?**: `number`

Defined in: [backfill/backfill.ts:329](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L329)

Rows per scan page.

***

### retry?

> `optional` **retry?**: [`RetryOptions`](RetryOptions.md)

Defined in: [backfill/backfill.ts:340](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L340)

The full retry surface, not the adapters' narrower `RetryPolicy`:
`onRetry` is backfill's only way to observe retries in progress, since it
takes no `logger`.

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [backfill/backfill.ts:341](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L341)

***

### tableName

> **tableName**: `string`

Defined in: [backfill/backfill.ts:325](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L325)
