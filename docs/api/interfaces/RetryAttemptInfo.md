[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryAttemptInfo

# Interface: RetryAttemptInfo

Defined in: [shared/dynamodb/retry.ts:77](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L77)

What [RetryOptions.onRetry](RetryOptions.md#onretry) learns before each backoff sleep.

## Properties

### attempt

> **attempt**: `number`

Defined in: [shared/dynamodb/retry.ts:78](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L78)

***

### delayMs

> **delayMs**: `number`

Defined in: [shared/dynamodb/retry.ts:79](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L79)

***

### error

> **error**: `Error`

Defined in: [shared/dynamodb/retry.ts:80](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/retry.ts#L80)
