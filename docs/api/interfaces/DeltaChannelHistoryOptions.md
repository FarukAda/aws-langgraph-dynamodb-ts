[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DeltaChannelHistoryOptions

# Interface: DeltaChannelHistoryOptions

Defined in: [checkpointer/types.ts:40](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/types.ts#L40)

Options [DynamoDBSaver.getDeltaChannelHistory](../classes/DynamoDBSaver.md#getdeltachannelhistory) accepts: the object
`BaseCheckpointSaver.getDeltaChannelHistory` declares inline, named so a
caller can type the options it builds. A test pins it equal to upstream's
parameter type.

## Properties

### channels

> **channels**: `string`[]

Defined in: [checkpointer/types.ts:47](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/types.ts#L47)

The delta channels to rebuild, as an array of strings; `[]` reads nothing
and returns `{}`.

***

### config

> **config**: `RunnableConfig`

Defined in: [checkpointer/types.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/types.ts#L42)

The checkpoint to walk back from; must be an object.
