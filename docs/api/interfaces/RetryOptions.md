[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryOptions

# Interface: RetryOptions

Defined in: [shared/dynamodb/retry.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L21)

Options controlling withRetry.

## Properties

### baseDelayMs?

> `optional` **baseDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L23)

***

### isRetryable?

> `optional` **isRetryable?**: (`error`) => `boolean`

Defined in: [shared/dynamodb/retry.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L31)

Decides retryability instead of `retryableErrors`, so a call site can
share one classifier (see `isTransientS3Error`) with paths that do not
go through `withRetry`.

#### Parameters

##### error

`Error`

#### Returns

`boolean`

***

### maxAttempts?

> `optional` **maxAttempts?**: `number`

Defined in: [shared/dynamodb/retry.ts:22](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L22)

***

### maxDelayMs?

> `optional` **maxDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L24)

***

### onRetry?

> `optional` **onRetry?**: (`info`) => `void`

Defined in: [shared/dynamodb/retry.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L33)

Called before every backoff sleep, so retries are visible before the budget is exhausted.

#### Parameters

##### info

[`RetryAttemptInfo`](RetryAttemptInfo.md)

#### Returns

`void`

***

### retryableErrors?

> `optional` **retryableErrors?**: readonly `string`[]

Defined in: [shared/dynamodb/retry.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L25)

***

### rng?

> `optional` **rng?**: () => `number`

Defined in: [shared/dynamodb/retry.ts:35](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L35)

#### Returns

`number`

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/dynamodb/retry.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L34)
