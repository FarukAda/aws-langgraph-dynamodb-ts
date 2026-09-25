[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryPolicy

# Interface: RetryPolicy

Defined in: [shared/dynamodb/retry.ts:353](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L353)

Caller-facing retry tunables for every DynamoDB call an adapter makes. The
schedule is full-jitter exponential backoff: `baseDelayMs` doubling per
attempt, capped at `maxDelayMs`, for `maxAttempts` attempts. The
message-append path never goes below its own contention floor.

## Properties

### baseDelayMs?

> `optional` **baseDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:357](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L357)

First backoff delay in milliseconds (default 100).

***

### maxAttempts?

> `optional` **maxAttempts?**: `number`

Defined in: [shared/dynamodb/retry.ts:355](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L355)

Attempts per call before `RETRY_EXHAUSTED` (default 5).

***

### maxDelayMs?

> `optional` **maxDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:359](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L359)

Cap on a single backoff delay in milliseconds (default 5000).
