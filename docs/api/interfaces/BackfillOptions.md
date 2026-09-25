[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BackfillOptions

# Interface: BackfillOptions

Defined in: [backfill/backfill.ts:311](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L311)

What the backfill needs to walk a table. A key this type does not declare is refused.

## Properties

### client

> **client**: [`DynamoDBDocumentLike`](../type-aliases/DynamoDBDocumentLike.md)

Defined in: [backfill/backfill.ts:312](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L312)

***

### cursor?

> `optional` **cursor?**: `string`

Defined in: [backfill/backfill.ts:320](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L320)

***

### dryRun?

> `optional` **dryRun?**: `boolean`

Defined in: [backfill/backfill.ts:322](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L322)

Report what would change without writing.

***

### indexShards?

> `optional` **indexShards?**: `number`

Defined in: [backfill/backfill.ts:315](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L315)

Must equal the adapters' `indexShards`, or rows land on shards no listing queries.

***

### maxPages?

> `optional` **maxPages?**: `number`

Defined in: [backfill/backfill.ts:319](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L319)

Stop after this many pages and return a cursor. Default: walk the whole table.

***

### pageSize?

> `optional` **pageSize?**: `number`

Defined in: [backfill/backfill.ts:317](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L317)

Rows per scan page.

***

### retry?

> `optional` **retry?**: [`RetryOptions`](RetryOptions.md)

Defined in: [backfill/backfill.ts:328](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L328)

The full retry surface, not the adapters' narrower `RetryPolicy`:
`onRetry` is backfill's only way to observe retries in progress, since it
takes no `logger`.

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [backfill/backfill.ts:329](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L329)

***

### tableName

> **tableName**: `string`

Defined in: [backfill/backfill.ts:313](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L313)
