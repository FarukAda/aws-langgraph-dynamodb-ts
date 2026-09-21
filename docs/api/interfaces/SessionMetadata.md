[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionMetadata

# Interface: SessionMetadata

Defined in: [history/types.ts:81](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L81)

Summary of a stored chat session.

## Properties

### createdAt

> **createdAt**: `string`

Defined in: [history/types.ts:85](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L85)

***

### expiresAt?

> `optional` **expiresAt?**: `string`

Defined in: [history/types.ts:88](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L88)

When the session's TTL expires, as an ISO-8601 instant; absent when no TTL is stored.

***

### messageCount

> **messageCount**: `number`

Defined in: [history/types.ts:84](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L84)

***

### sessionId

> **sessionId**: `string`

Defined in: [history/types.ts:82](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L82)

***

### title?

> `optional` **title?**: `string`

Defined in: [history/types.ts:83](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L83)

***

### updatedAt

> **updatedAt**: `string`

Defined in: [history/types.ts:86](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L86)
