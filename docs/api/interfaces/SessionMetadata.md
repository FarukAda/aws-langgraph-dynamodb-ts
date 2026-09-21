[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionMetadata

# Interface: SessionMetadata

Defined in: [history/types.ts:86](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L86)

Summary of a stored chat session.

## Properties

### createdAt

> **createdAt**: `string`

Defined in: [history/types.ts:90](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L90)

***

### expiresAt?

> `optional` **expiresAt?**: `string`

Defined in: [history/types.ts:93](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L93)

When the session's TTL expires, as an ISO-8601 instant; absent when no TTL is stored.

***

### messageCount

> **messageCount**: `number`

Defined in: [history/types.ts:89](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L89)

***

### sessionId

> **sessionId**: `string`

Defined in: [history/types.ts:87](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L87)

***

### title?

> `optional` **title?**: `string`

Defined in: [history/types.ts:88](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L88)

***

### updatedAt

> **updatedAt**: `string`

Defined in: [history/types.ts:91](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L91)
