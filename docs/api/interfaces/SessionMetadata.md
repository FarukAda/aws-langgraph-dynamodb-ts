[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionMetadata

# Interface: SessionMetadata

Defined in: [history/types.ts:50](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/types.ts#L50)

Summary of a stored chat session.

## Properties

### createdAt

> **createdAt**: `string`

Defined in: [history/types.ts:54](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/types.ts#L54)

***

### expiresAt?

> `optional` **expiresAt?**: `string`

Defined in: [history/types.ts:57](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/types.ts#L57)

When the session's TTL expires, as an ISO-8601 instant; absent when no TTL is stored.

***

### messageCount

> **messageCount**: `number`

Defined in: [history/types.ts:53](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/types.ts#L53)

***

### sessionId

> **sessionId**: `string`

Defined in: [history/types.ts:51](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/types.ts#L51)

***

### title?

> `optional` **title?**: `string`

Defined in: [history/types.ts:52](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/types.ts#L52)

***

### updatedAt

> **updatedAt**: `string`

Defined in: [history/types.ts:55](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/types.ts#L55)
