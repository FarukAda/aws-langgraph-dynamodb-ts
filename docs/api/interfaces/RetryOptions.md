[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryOptions

# Interface: RetryOptions

Defined in: [shared/dynamodb/retry.ts:78](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L78)

How a failed request is retried: how many attempts, how long each wait, and
which failures qualify.

## Properties

### baseDelayMs?

> `optional` **baseDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:80](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L80)

***

### isRetryable?

> `optional` **isRetryable?**: (`error`) => `boolean`

Defined in: [shared/dynamodb/retry.ts:87](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L87)

Decides retryability instead of `retryableErrors`: called with each failed
attempt's error, it retries when it returns `true`.

#### Parameters

##### error

`Error`

#### Returns

`boolean`

***

### maxAttempts?

> `optional` **maxAttempts?**: `number`

Defined in: [shared/dynamodb/retry.ts:79](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L79)

***

### maxDelayMs?

> `optional` **maxDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:81](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L81)

***

### onRetry?

> `optional` **onRetry?**: (`info`) => `void`

Defined in: [shared/dynamodb/retry.ts:89](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L89)

Called before every backoff sleep, so retries are visible before the budget is exhausted.

#### Parameters

##### info

[`RetryAttemptInfo`](RetryAttemptInfo.md)

#### Returns

`void`

***

### retryableErrors?

> `optional` **retryableErrors?**: readonly `string`[]

Defined in: [shared/dynamodb/retry.ts:82](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L82)

***

### rng?

> `optional` **rng?**: () => `number`

Defined in: [shared/dynamodb/retry.ts:91](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L91)

#### Returns

`number`

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/dynamodb/retry.ts:90](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L90)
