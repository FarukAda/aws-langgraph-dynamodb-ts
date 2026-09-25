[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryOptions

# Interface: RetryOptions

Defined in: [shared/dynamodb/retry.ts:81](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L81)

How a failed request is retried: how many attempts, how long each wait, and
which failures qualify.

## Properties

### baseDelayMs?

> `optional` **baseDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:83](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L83)

***

### isRetryable?

> `optional` **isRetryable?**: (`error`) => `boolean`

Defined in: [shared/dynamodb/retry.ts:90](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L90)

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

Defined in: [shared/dynamodb/retry.ts:82](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L82)

***

### maxDelayMs?

> `optional` **maxDelayMs?**: `number`

Defined in: [shared/dynamodb/retry.ts:84](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L84)

***

### onRetry?

> `optional` **onRetry?**: (`info`) => `void`

Defined in: [shared/dynamodb/retry.ts:92](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L92)

Called before every backoff sleep, so retries are visible before the budget is exhausted.

#### Parameters

##### info

[`RetryAttemptInfo`](RetryAttemptInfo.md)

#### Returns

`void`

***

### retryableErrors?

> `optional` **retryableErrors?**: readonly `string`[]

Defined in: [shared/dynamodb/retry.ts:85](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L85)

***

### rng?

> `optional` **rng?**: () => `number`

Defined in: [shared/dynamodb/retry.ts:94](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L94)

#### Returns

`number`

***

### signal?

> `optional` **signal?**: `AbortSignal`

Defined in: [shared/dynamodb/retry.ts:93](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L93)
