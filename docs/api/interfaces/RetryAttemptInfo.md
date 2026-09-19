[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryAttemptInfo

# Interface: RetryAttemptInfo

Defined in: [shared/dynamodb/retry.ts:15](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L15)

What [RetryOptions.onRetry](RetryOptions.md#onretry) learns before each backoff sleep.

## Properties

### attempt

> **attempt**: `number`

Defined in: [shared/dynamodb/retry.ts:16](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L16)

***

### delayMs

> **delayMs**: `number`

Defined in: [shared/dynamodb/retry.ts:17](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L17)

***

### error

> **error**: `Error`

Defined in: [shared/dynamodb/retry.ts:18](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L18)
