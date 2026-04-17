[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionMetadata

# Interface: SessionMetadata

Defined in: [history/types/index.ts:90](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/types/index.ts#L90)

Session metadata for listing (excludes messages)

## Properties

### createdAt

> **createdAt**: `number`

Defined in: [history/types/index.ts:96](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/types/index.ts#L96)

Timestamp when session was created (milliseconds)

***

### messageCount

> **messageCount**: `number`

Defined in: [history/types/index.ts:100](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/types/index.ts#L100)

Number of messages in the session

***

### sessionId

> **sessionId**: `string`

Defined in: [history/types/index.ts:92](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/types/index.ts#L92)

Session identifier

***

### title

> **title**: `string`

Defined in: [history/types/index.ts:94](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/types/index.ts#L94)

Session title

***

### updatedAt

> **updatedAt**: `number`

Defined in: [history/types/index.ts:98](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/types/index.ts#L98)

Timestamp when the session was last updated (milliseconds)
