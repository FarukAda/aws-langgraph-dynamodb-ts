[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CancelOptions

# Interface: CancelOptions

Defined in: [shared/options.ts:44](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L44)

Per-call cancellation for the long-running adapter methods.

## Extended by

- [`ListSessionsOptions`](ListSessionsOptions.md)

## Properties

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/options.ts:46](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L46)

Aborting it rejects the call with `AbortError` (`ABORTED`) at the next wait.
