[**AWS LangGraph DynamoDB TypeScript v0.1.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionMetadata

# Interface: SessionMetadata

Defined in: [history/types/index.ts:69](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/types/index.ts#L69)

Session metadata for listing (excludes messages)

## Properties

### createdAt

> **createdAt**: `number`

Defined in: [history/types/index.ts:75](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/types/index.ts#L75)

Timestamp when session was created (milliseconds)

***

### messageCount

> **messageCount**: `number`

Defined in: [history/types/index.ts:79](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/types/index.ts#L79)

Number of messages in the session

***

### sessionId

> **sessionId**: `string`

Defined in: [history/types/index.ts:71](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/types/index.ts#L71)

Session identifier

***

### title

> **title**: `string`

Defined in: [history/types/index.ts:73](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/types/index.ts#L73)

Session title

***

### updatedAt

> **updatedAt**: `number`

Defined in: [history/types/index.ts:77](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/types/index.ts#L77)

Timestamp when the session was last updated (milliseconds)
