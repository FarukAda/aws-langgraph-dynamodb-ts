[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ListSessionsOptions

# Interface: ListSessionsOptions

Defined in: [history/types.ts:72](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L72)

Options for `listSessions`: the page, the scan caps, and cancellation.

## Extends

- [`CancelOptions`](CancelOptions.md)

## Properties

### cursor?

> `optional` **cursor?**: `string`

Defined in: [history/types.ts:89](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L89)

Opaque cursor from a previous page. Requires a configured `indexName` —
without the index there is no position to resume from, and passing one is
refused rather than answered with the first page again.

***

### limit?

> `optional` **limit?**: `number`

Defined in: [history/types.ts:83](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L83)

How many sessions to return, newest-updated first; an integer from 0 to
`MAX_PAGE_LIMIT` (10,000).

With a configured `indexName` it is the page size and defaults to 100.
Without one the read is a table scan that cannot be paged: an explicit
limit still selects the newest N, but omitting it returns every session,
because there would be no cursor to fetch the rest with. `0` returns an
empty page on either path and reads neither.

***

### maxItems?

> `optional` **maxItems?**: `number`

Defined in: [history/types.ts:93](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L93)

Cap on rows read into memory before `RESULT_TRUNCATED` (default 10 000). Scan path only.

***

### maxIterations?

> `optional` **maxIterations?**: `number`

Defined in: [history/types.ts:91](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L91)

Cap on scan pages before `RESULT_TRUNCATED` (default 1000). Scan path only.

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/options.ts:94](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L94)

Aborting it rejects the call with an `ABORTED` error at the next wait.

#### Inherited from

[`CancelOptions`](CancelOptions.md).[`signal`](CancelOptions.md#signal)
