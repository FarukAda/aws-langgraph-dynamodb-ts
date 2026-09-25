[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryAttemptInfo

# Interface: RetryAttemptInfo

Defined in: [shared/dynamodb/retry.ts:71](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L71)

What [RetryOptions.onRetry](RetryOptions.md#onretry) learns before each backoff sleep.

## Properties

### attempt

> **attempt**: `number`

Defined in: [shared/dynamodb/retry.ts:72](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L72)

***

### delayMs

> **delayMs**: `number`

Defined in: [shared/dynamodb/retry.ts:73](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L73)

***

### error

> **error**: `Error`

Defined in: [shared/dynamodb/retry.ts:74](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L74)
