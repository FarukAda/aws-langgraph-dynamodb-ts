[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryPolicy

# Interface: RetryPolicy

Defined in: [shared/dynamodb/retry.ts:372](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L372)

Caller-facing retry tunables for every DynamoDB call an adapter makes. The
schedule is full-jitter exponential backoff: `baseDelayMs` doubling per
attempt, capped at `maxDelayMs`, for `maxAttempts` attempts. The
message-append path never goes below its own contention floor.

## Properties

### baseDelayMs?

> `optional` **baseDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:376](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L376)

First backoff delay in milliseconds (default 100).

***

### maxAttempts?

> `optional` **maxAttempts?**: `number`

Defined in: [shared/dynamodb/retry.ts:374](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L374)

Attempts per call before `RETRY_EXHAUSTED` (default 5).

***

### maxDelayMs?

> `optional` **maxDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:378](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L378)

Cap on a single backoff delay in milliseconds (default 5000).
