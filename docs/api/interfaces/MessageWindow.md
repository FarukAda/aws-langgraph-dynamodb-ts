[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / MessageWindow

# Interface: MessageWindow

Defined in: [history/types.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L31)

Which slice of a session `getMessages` returns. Both bounds are optional
and combine: `{ limit: 50, before }` is the fifty messages just before
`before`.

## Properties

### before?

> `optional` **before?**: `Date`

Defined in: [history/types.ts:35](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L35)

Return only messages appended before this instant (millisecond precision).

***

### limit?

> `optional` **limit?**: `number`

Defined in: [history/types.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L33)

Return only the newest `limit` messages — still in chronological order.
