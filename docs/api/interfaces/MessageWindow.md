[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / MessageWindow

# Interface: MessageWindow

Defined in: [history/types.ts:54](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L54)

Which slice of a session `getMessages` returns. Both bounds are optional
and combine: `{ limit: 50, before }` is the fifty messages just before
`before`.

## Properties

### before?

> `optional` **before?**: `Date`

Defined in: [history/types.ts:65](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L65)

Return only messages appended before this instant (millisecond precision).

***

### limit?

> `optional` **limit?**: `number`

Defined in: [history/types.ts:63](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L63)

Return only the newest `limit` messages — still in chronological order. An
integer from 1 to `MAX_PAGE_LIMIT` (10,000): the page rule every `limit` in
this package follows, with the one floor of 1 it has. `0` is refused rather
than answered with nothing, since for a window into a conversation it is
far more likely a bug than a request — and the empty window it would
produce is what a chain reads as the whole session.
