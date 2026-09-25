[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CancelOptions

# Interface: CancelOptions

Defined in: [shared/options.ts:92](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L92)

Per-call cancellation for the long-running adapter methods.

## Extended by

- [`ListSessionsOptions`](ListSessionsOptions.md)

## Properties

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/options.ts:94](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L94)

Aborting it rejects the call with an `ABORTED` error at the next wait.
