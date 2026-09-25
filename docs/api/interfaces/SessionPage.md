[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionPage

# Interface: SessionPage

Defined in: [history/types.ts:93](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L93)

One page of [SessionMetadata](SessionMetadata.md), and where the next one resumes.

## Properties

### nextCursor?

> `optional` **nextCursor?**: `string`

Defined in: [history/types.ts:96](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L96)

Absent when this page is the last one, or when the read was a scan.

***

### sessions

> **sessions**: [`SessionMetadata`](SessionMetadata.md)[]

Defined in: [history/types.ts:94](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L94)
