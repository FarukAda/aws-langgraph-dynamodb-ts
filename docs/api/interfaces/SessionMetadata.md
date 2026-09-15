[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionMetadata

# Interface: SessionMetadata

Defined in: [history/types.ts:76](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L76)

Summary of a stored chat session.

## Properties

### createdAt

> **createdAt**: `string`

Defined in: [history/types.ts:80](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L80)

***

### expiresAt?

> `optional` **expiresAt?**: `string`

Defined in: [history/types.ts:83](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L83)

When the session's TTL expires, as an ISO-8601 instant; absent when no TTL is stored.

***

### messageCount

> **messageCount**: `number`

Defined in: [history/types.ts:79](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L79)

***

### sessionId

> **sessionId**: `string`

Defined in: [history/types.ts:77](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L77)

***

### title?

> `optional` **title?**: `string`

Defined in: [history/types.ts:78](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L78)

***

### updatedAt

> **updatedAt**: `string`

Defined in: [history/types.ts:81](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L81)
