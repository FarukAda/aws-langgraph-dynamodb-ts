[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BackfillOptions

# Interface: BackfillOptions

Defined in: [backfill/backfill.ts:312](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L312)

What the backfill needs to walk a table. A key this type does not declare is refused.

## Properties

### client

> **client**: [`DynamoDBDocumentLike`](../type-aliases/DynamoDBDocumentLike.md)

Defined in: [backfill/backfill.ts:313](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L313)

***

### cursor?

> `optional` **cursor?**: `string`

Defined in: [backfill/backfill.ts:321](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L321)

***

### dryRun?

> `optional` **dryRun?**: `boolean`

Defined in: [backfill/backfill.ts:323](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L323)

Report what would change without writing.

***

### indexShards?

> `optional` **indexShards?**: `number`

Defined in: [backfill/backfill.ts:316](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L316)

Must equal the adapters' `indexShards`, or rows land on shards no listing queries.

***

### maxPages?

> `optional` **maxPages?**: `number`

Defined in: [backfill/backfill.ts:320](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L320)

Stop after this many pages and return a cursor. Default: walk the whole table.

***

### pageSize?

> `optional` **pageSize?**: `number`

Defined in: [backfill/backfill.ts:318](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L318)

Rows per scan page.

***

### retry?

> `optional` **retry?**: [`RetryOptions`](RetryOptions.md)

Defined in: [backfill/backfill.ts:329](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L329)

The full retry surface, not the adapters' narrower `RetryPolicy`:
`onRetry` is backfill's only way to observe retries in progress, since it
takes no `logger`.

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [backfill/backfill.ts:330](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L330)

***

### tableName

> **tableName**: `string`

Defined in: [backfill/backfill.ts:314](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L314)
