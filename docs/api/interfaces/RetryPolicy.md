[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryPolicy

# Interface: RetryPolicy

Defined in: [shared/dynamodb/retry-policy.ts:15](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry-policy.ts#L15)

Caller-facing retry tunables for every DynamoDB call an adapter makes. The
schedule is full-jitter exponential backoff: `baseDelayMs` doubling per
attempt, capped at `maxDelayMs`, for `maxAttempts` attempts. The
message-append path never goes below its own contention floor.

## Properties

### baseDelayMs?

> `optional` **baseDelayMs?**: `number`

Defined in: [shared/dynamodb/retry-policy.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry-policy.ts#L19)

First backoff delay in milliseconds (default 100).

***

### maxAttempts?

> `optional` **maxAttempts?**: `number`

Defined in: [shared/dynamodb/retry-policy.ts:17](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry-policy.ts#L17)

Attempts per call before `RetryExhaustedError` (default 5).

***

### maxDelayMs?

> `optional` **maxDelayMs?**: `number`

Defined in: [shared/dynamodb/retry-policy.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry-policy.ts#L21)

Cap on a single backoff delay in milliseconds (default 5000).
