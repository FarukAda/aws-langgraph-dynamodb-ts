[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryOptions

# Interface: RetryOptions

Defined in: [shared/utils/retry.ts:8](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/retry.ts#L8)

## Properties

### baseDelayMs?

> `optional` **baseDelayMs?**: `number`

Defined in: [shared/utils/retry.ts:10](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/retry.ts#L10)

***

### maxAttempts?

> `optional` **maxAttempts?**: `number`

Defined in: [shared/utils/retry.ts:9](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/retry.ts#L9)

***

### maxDelayMs?

> `optional` **maxDelayMs?**: `number`

Defined in: [shared/utils/retry.ts:11](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/retry.ts#L11)

***

### retryableErrors?

> `optional` **retryableErrors?**: `string`[]

Defined in: [shared/utils/retry.ts:12](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/retry.ts#L12)

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/utils/retry.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/retry.ts#L19)

Optional abort signal. When aborted, any in-flight sleep between retries
resolves immediately and `withRetry` rejects with the signal's abort reason.
The signal is checked before every attempt, so an abort mid-backoff short-
circuits the remaining retries rather than consuming the full schedule.
