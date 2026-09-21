[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionPage

# Interface: SessionPage

Defined in: [history/types.ts:79](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L79)

One page of [SessionMetadata](SessionMetadata.md), and where the next one resumes.

## Properties

### nextCursor?

> `optional` **nextCursor?**: `string`

Defined in: [history/types.ts:82](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L82)

Absent when this page is the last one, or when the read was a scan.

***

### sessions

> **sessions**: [`SessionMetadata`](SessionMetadata.md)[]

Defined in: [history/types.ts:80](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L80)
