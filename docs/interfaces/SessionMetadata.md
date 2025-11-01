[**AWS LangGraph DynamoDB TypeScript v0.0.9**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionMetadata

# Interface: SessionMetadata

Defined in: [history/types/index.ts:46](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/types/index.ts#L46)

Session metadata for listing (excludes messages)

## Properties

### createdAt

> **createdAt**: `number`

Defined in: [history/types/index.ts:52](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/types/index.ts#L52)

Timestamp when session was created (milliseconds)

***

### messageCount

> **messageCount**: `number`

Defined in: [history/types/index.ts:56](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/types/index.ts#L56)

Number of messages in the session

***

### sessionId

> **sessionId**: `string`

Defined in: [history/types/index.ts:48](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/types/index.ts#L48)

Session identifier

***

### title

> **title**: `string`

Defined in: [history/types/index.ts:50](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/types/index.ts#L50)

Session title

***

### updatedAt

> **updatedAt**: `number`

Defined in: [history/types/index.ts:54](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/types/index.ts#L54)

Timestamp when the session was last updated (milliseconds)
