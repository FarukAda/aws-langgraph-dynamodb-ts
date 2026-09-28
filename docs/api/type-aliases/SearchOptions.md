[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SearchOptions

# Type Alias: SearchOptions

> **SearchOptions** = `Pick`\<`SearchOperation`, `"filter"` \| `"limit"` \| `"offset"` \| `"query"`\> & [`CancelOptions`](../interfaces/CancelOptions.md)

Defined in: [store/types.ts:78](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L78)

Options [DynamoDBStore.search](../classes/DynamoDBStore.md#search) accepts: the metadata/paging fields of
`SearchOperation` it exposes as its own parameter (`namespacePrefix` is a
separate positional argument instead), plus cancellation.
