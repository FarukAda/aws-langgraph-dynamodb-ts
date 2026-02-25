[**AWS LangGraph DynamoDB TypeScript v0.1.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaver

# Class: DynamoDBSaver

Defined in: [checkpointer/index.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/index.ts#L34)

DynamoDB-based checkpoint saver for LangGraph.
Provides persistent storage for checkpoints and pending writes.

## Remarks

Uses the base class default for `getNextVersion()` (monotonic integers).
Channel versioning is internal to LangGraph's execution engine and does not
affect DynamoDB key ordering, which relies on checkpoint IDs.

## Extends

- `BaseCheckpointSaver`

## Constructors

### Constructor

> **new DynamoDBSaver**(`options`): `DynamoDBSaver`

Defined in: [checkpointer/index.ts:59](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/index.ts#L59)

Create a new DynamoDB checkpoint saver

#### Parameters

##### options

[`DynamoDBSaverOptions`](../interfaces/DynamoDBSaverOptions.md)

Configuration options for the saver

#### Returns

`DynamoDBSaver`

#### Overrides

`BaseCheckpointSaver.constructor`

## Methods

### deleteThread()

> **deleteThread**(`threadId`): `Promise`\<`void`\>

Defined in: [checkpointer/index.ts:113](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/index.ts#L113)

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

### destroy()

> **destroy**(): `void`

Defined in: [checkpointer/index.ts:100](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/index.ts#L100)

Release underlying DynamoDB and S3 client resources.
Call this when the saver is no longer needed to prevent resource leaks.
Skips DynamoDB client cleanup if a shared client was injected via options.

#### Returns

`void`

***

### getTuple()

> **getTuple**(`config`): `Promise`\<`CheckpointTuple` \| `undefined`\>

Defined in: [checkpointer/index.ts:130](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/index.ts#L130)

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

Defined in: [checkpointer/index.ts:204](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/index.ts#L204)

List checkpoints for a thread

#### Parameters

##### config

`RunnableConfig`

Runnable configuration containing thread_id

##### options

List options including limit, before checkpoint, and metadata filter

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

Defined in: [checkpointer/index.ts:152](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/index.ts#L152)

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

Defined in: [checkpointer/index.ts:181](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/index.ts#L181)

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
