[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BackfillOptions

# Interface: BackfillOptions

Defined in: [backfill/backfill.ts:309](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L309)

What the backfill needs to walk a table. A key this type does not declare is refused.

## Properties

### client

> **client**: [`DynamoDBDocumentLike`](../type-aliases/DynamoDBDocumentLike.md)

Defined in: [backfill/backfill.ts:310](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L310)

***

### cursor?

> `optional` **cursor?**: `string`

Defined in: [backfill/backfill.ts:318](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L318)

***

### dryRun?

> `optional` **dryRun?**: `boolean`

Defined in: [backfill/backfill.ts:320](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L320)

Report what would change without writing.

***

### indexShards?

> `optional` **indexShards?**: `number`

Defined in: [backfill/backfill.ts:313](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L313)

Must equal the adapters' `indexShards`, or rows land on shards no listing queries.

***

### maxPages?

> `optional` **maxPages?**: `number`

Defined in: [backfill/backfill.ts:317](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L317)

Stop after this many pages and return a cursor. Default: walk the whole table.

***

### pageSize?

> `optional` **pageSize?**: `number`

Defined in: [backfill/backfill.ts:315](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L315)

Rows per scan page.

***

### retry?

> `optional` **retry?**: [`RetryOptions`](RetryOptions.md)

Defined in: [backfill/backfill.ts:326](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L326)

The full retry surface, not the adapters' narrower `RetryPolicy`:
`onRetry` is backfill's only way to observe retries in progress, since it
takes no `logger`.

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [backfill/backfill.ts:327](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L327)

***

### tableName

> **tableName**: `string`

Defined in: [backfill/backfill.ts:311](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/backfill/backfill.ts#L311)
