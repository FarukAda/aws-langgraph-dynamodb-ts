[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionMetadata

# Interface: SessionMetadata

Defined in: [history/types.ts:100](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L100)

Summary of a stored chat session.

## Properties

### createdAt

> **createdAt**: `string`

Defined in: [history/types.ts:104](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L104)

***

### expiresAt?

> `optional` **expiresAt?**: `string`

Defined in: [history/types.ts:107](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L107)

When the session's TTL expires, as an ISO-8601 instant; absent when no TTL is stored.

***

### messageCount

> **messageCount**: `number`

Defined in: [history/types.ts:103](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L103)

***

### sessionId

> **sessionId**: `string`

Defined in: [history/types.ts:101](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L101)

***

### title?

> `optional` **title?**: `string`

Defined in: [history/types.ts:102](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L102)

***

### updatedAt

> **updatedAt**: `string`

Defined in: [history/types.ts:105](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L105)
