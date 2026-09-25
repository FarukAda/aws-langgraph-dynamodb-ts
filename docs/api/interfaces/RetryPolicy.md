[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryPolicy

# Interface: RetryPolicy

Defined in: [shared/dynamodb/retry.ts:354](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L354)

Caller-facing retry tunables for every DynamoDB call an adapter makes. The
schedule is full-jitter exponential backoff: `baseDelayMs` doubling per
attempt, capped at `maxDelayMs`, for `maxAttempts` attempts. The
message-append path never goes below its own contention floor.

## Properties

### baseDelayMs?

> `optional` **baseDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:358](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L358)

First backoff delay in milliseconds (default 100).

***

### maxAttempts?

> `optional` **maxAttempts?**: `number`

Defined in: [shared/dynamodb/retry.ts:356](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L356)

Attempts per call before `RETRY_EXHAUSTED` (default 5).

***

### maxDelayMs?

> `optional` **maxDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:360](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L360)

Cap on a single backoff delay in milliseconds (default 5000).
