[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ListSessionsOptions

# Interface: ListSessionsOptions

Defined in: [history/types.ts:46](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L46)

Options for `listSessions`: the page, the scan caps, and cancellation.

## Extends

- [`CancelOptions`](CancelOptions.md)

## Properties

### cursor?

> `optional` **cursor?**: `string`

Defined in: [history/types.ts:61](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L61)

Opaque cursor from a previous page. Requires a configured `indexName` —
without the index there is no position to resume from, and passing one is
refused rather than answered with the first page again.

***

### limit?

> `optional` **limit?**: `number`

Defined in: [history/types.ts:55](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L55)

How many sessions to return, newest-updated first; a positive integer.

With a configured `indexName` it is the page size and defaults to 100.
Without one the read is a table scan that cannot be paged: an explicit
limit still selects the newest N, but omitting it returns every session,
because there would be no cursor to fetch the rest with.

***

### maxItems?

> `optional` **maxItems?**: `number`

Defined in: [history/types.ts:65](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L65)

Cap on rows read into memory before `ResultTruncatedError` (default 10 000). Scan path only.

***

### maxIterations?

> `optional` **maxIterations?**: `number`

Defined in: [history/types.ts:63](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L63)

Cap on scan pages before `ResultTruncatedError` (default 1000). Scan path only.

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/options.ts:80](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L80)

Aborting it rejects the call with `AbortError` (`ABORTED`) at the next wait.

#### Inherited from

[`CancelOptions`](CancelOptions.md).[`signal`](CancelOptions.md#signal)
