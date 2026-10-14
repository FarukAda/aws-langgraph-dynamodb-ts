[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CancelOptions

# Interface: CancelOptions

Defined in: [shared/options.ts:99](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L99)

Per-call cancellation for the long-running adapter methods.

## Extended by

- [`ListSessionsOptions`](ListSessionsOptions.md)

## Properties

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/options.ts:110](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L110)

Aborting it rejects the call with an `ABORTED` error — carrying the abort
reason as `cause` — whether the signal was already aborted (nothing is
sent), aborts while the call waits between requests, or aborts while a
request is in flight: the signal reaches the AWS SDK on every DynamoDB
request and S3 transfer the call makes for you, so the request itself
ends. The verification reads and the cleanup that follow a failure run to
completion regardless. A value that is not `AbortSignal`-shaped is refused
with `VALIDATION` naming `signal` before anything is sent.
