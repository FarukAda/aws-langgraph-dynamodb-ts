[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryOptions

# Interface: RetryOptions

Defined in: [shared/dynamodb/retry.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L39)

Options controlling withRetry.

## Properties

### baseDelayMs?

> `optional` **baseDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:41](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L41)

***

### isRetryable?

> `optional` **isRetryable?**: (`error`) => `boolean`

Defined in: [shared/dynamodb/retry.ts:49](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L49)

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

Defined in: [shared/dynamodb/retry.ts:40](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L40)

***

### maxDelayMs?

> `optional` **maxDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L42)

***

### onRetry?

> `optional` **onRetry?**: (`info`) => `void`

Defined in: [shared/dynamodb/retry.ts:51](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L51)

Called before every backoff sleep, so retries are visible before the budget is exhausted.

#### Parameters

##### info

[`RetryAttemptInfo`](RetryAttemptInfo.md)

#### Returns

`void`

***

### retryableErrors?

> `optional` **retryableErrors?**: readonly `string`[]

Defined in: [shared/dynamodb/retry.ts:43](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L43)

***

### rng?

> `optional` **rng?**: () => `number`

Defined in: [shared/dynamodb/retry.ts:53](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L53)

#### Returns

`number`

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/dynamodb/retry.ts:52](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L52)
