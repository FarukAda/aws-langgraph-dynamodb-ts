[**AWS LangGraph DynamoDB TypeScript v0.0.7**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaver

# Class: DynamoDBSaver

Defined in: [checkpointer/index.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L24)

## Extends

- `BaseCheckpointSaver`

## Constructors

### Constructor

> **new DynamoDBSaver**(`options`): `DynamoDBSaver`

Defined in: [checkpointer/index.ts:41](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L41)

Create a new DynamoDB checkpoint saver

#### Parameters

##### options

[`DynamoDBSaverOptions`](../interfaces/DynamoDBSaverOptions.md)

Configuration options for the saver

#### Returns

`DynamoDBSaver`

#### Overrides

`BaseCheckpointSaver.constructor`

## Properties

### checkpointsTableName

> `private` `readonly` **checkpointsTableName**: `string`

Defined in: [checkpointer/index.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L27)

***

### client

> `private` `readonly` **client**: `DynamoDBDocument`

Defined in: [checkpointer/index.ts:26](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L26)

***

### ddbClient

> `private` `readonly` **ddbClient**: `DynamoDBClient`

Defined in: [checkpointer/index.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L25)

***

### ttlDays?

> `private` `readonly` `optional` **ttlDays**: `number`

Defined in: [checkpointer/index.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L29)

***

### writesTableName

> `private` `readonly` **writesTableName**: `string`

Defined in: [checkpointer/index.ts:28](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L28)

## Methods

### deleteThread()

> **deleteThread**(`threadId`): `Promise`\<`void`\>

Defined in: [checkpointer/index.ts:56](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L56)

Delete a thread and all its checkpoints and writes

#### Parameters

##### threadId

`string`

The thread ID to delete

#### Returns

`Promise`\<`void`\>

#### Throws

Error if validation fails or operation fails

#### Overrides

`BaseCheckpointSaver.deleteThread`

***

### getTuple()

> **getTuple**(`config`): `Promise`\<`CheckpointTuple` \| `undefined`\>

Defined in: [checkpointer/index.ts:72](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L72)

Get a checkpoint tuple from DynamoDB

#### Parameters

##### config

`RunnableConfig`

Runnable configuration containing thread_id and optional checkpoint_id

#### Returns

`Promise`\<`CheckpointTuple` \| `undefined`\>

CheckpointTuple if found, undefined otherwise

#### Throws

Error if validation fails or operation fails

#### Overrides

`BaseCheckpointSaver.getTuple`

***

### list()

> **list**(`config`, `options`): `AsyncGenerator`\<`CheckpointTuple`\>

Defined in: [checkpointer/index.ts:137](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L137)

List checkpoints for a thread

#### Parameters

##### config

`RunnableConfig`

Runnable configuration containing thread_id

##### options

List options including limit and before checkpoint

`CheckpointListOptions` | `undefined`

#### Returns

`AsyncGenerator`\<`CheckpointTuple`\>

#### Yields

CheckpointTuple objects in descending order

#### Throws

Error if validation fails or operation fails

#### Overrides

`BaseCheckpointSaver.list`

***

### put()

> **put**(`config`, `checkpoint`, `metadata`, `newVersions`): `Promise`\<`RunnableConfig`\<`Record`\<`string`, `any`\>\>\>

Defined in: [checkpointer/index.ts:92](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L92)

Save a checkpoint to DynamoDB

#### Parameters

##### config

`RunnableConfig`

Runnable configuration

##### checkpoint

`Checkpoint`

Checkpoint to save

##### metadata

`CheckpointMetadata`

Checkpoint metadata

##### newVersions

`ChannelVersions`

Channel versions (not used in DynamoDB implementation)

#### Returns

`Promise`\<`RunnableConfig`\<`Record`\<`string`, `any`\>\>\>

Updated RunnableConfig with checkpoint information

#### Throws

Error if validation fails or operation fails

#### Overrides

`BaseCheckpointSaver.put`

***

### putWrites()

> **putWrites**(`config`, `writes`, `taskId`): `Promise`\<`void`\>

Defined in: [checkpointer/index.ts:117](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/index.ts#L117)

Save pending writes to DynamoDB

#### Parameters

##### config

`RunnableConfig`

Runnable configuration

##### writes

`PendingWrite`[]

Array of pending writes to save

##### taskId

`string`

Task ID for the writes

#### Returns

`Promise`\<`void`\>

#### Throws

Error if validation fails or operation fails

#### Overrides

`BaseCheckpointSaver.putWrites`
