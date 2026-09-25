[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DeltaChannelHistoryOptions

# Interface: DeltaChannelHistoryOptions

Defined in: [checkpointer/types.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/types.ts#L39)

Options [DynamoDBSaver.getDeltaChannelHistory](../classes/DynamoDBSaver.md#getdeltachannelhistory) accepts: the object
`BaseCheckpointSaver.getDeltaChannelHistory` declares inline, named so a
caller can type the options it builds. A test pins it equal to upstream's
parameter type.

## Properties

### channels

> **channels**: `string`[]

Defined in: [checkpointer/types.ts:46](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/types.ts#L46)

The delta channels to rebuild, as an array of strings; `[]` reads nothing
and returns `{}`.

***

### config

> **config**: `RunnableConfig`

Defined in: [checkpointer/types.ts:41](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/types.ts#L41)

The checkpoint to walk back from; must be an object.
