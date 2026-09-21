[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryAttemptInfo

# Interface: RetryAttemptInfo

Defined in: [shared/dynamodb/retry.ts:32](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L32)

What [RetryOptions.onRetry](RetryOptions.md#onretry) learns before each backoff sleep.

## Properties

### attempt

> **attempt**: `number`

Defined in: [shared/dynamodb/retry.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L33)

***

### delayMs

> **delayMs**: `number`

Defined in: [shared/dynamodb/retry.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L34)

***

### error

> **error**: `Error`

Defined in: [shared/dynamodb/retry.ts:35](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L35)
