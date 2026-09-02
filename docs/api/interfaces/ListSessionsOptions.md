[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ListSessionsOptions

# Interface: ListSessionsOptions

Defined in: [history/types.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/types.ts#L42)

Options for `listSessions`: the scan caps plus cancellation.

## Extends

- [`CancelOptions`](CancelOptions.md)

## Properties

### maxItems?

> `optional` **maxItems?**: `number`

Defined in: [history/types.ts:46](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/types.ts#L46)

Cap on rows read into memory before `ResultTruncatedError` (default 10 000).

***

### maxIterations?

> `optional` **maxIterations?**: `number`

Defined in: [history/types.ts:44](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/types.ts#L44)

Cap on scan pages before `ResultTruncatedError` (default 1000).

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/options.ts:46](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/options.ts#L46)

Aborting it rejects the call with `AbortError` (`ABORTED`) at the next wait.

#### Inherited from

[`CancelOptions`](CancelOptions.md).[`signal`](CancelOptions.md#signal)
