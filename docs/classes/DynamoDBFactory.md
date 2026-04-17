[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBFactory

# Class: DynamoDBFactory

Defined in: [factory.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/factory.ts#L27)

Factory class for creating DynamoDB persistence instances

## Constructors

### Constructor

> **new DynamoDBFactory**(): `DynamoDBFactory`

#### Returns

`DynamoDBFactory`

## Methods

### createAll()

> `static` **createAll**(`options?`): `object`

Defined in: [factory.ts:174](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/factory.ts#L174)

Create all DynamoDB persistence instances at once with a shared configuration

#### Parameters

##### options?

Configuration options

###### clientConfig?

`DynamoDBClientConfig`

Optional DynamoDB client configuration (shared)

###### compression?

[`CompressionConfig`](../interfaces/CompressionConfig.md)

Compression configuration forwarded to the saver.

###### embedding?

`EmbeddingsInterface`\<`number`[]\>

Optional Bedrock embeddings for semantic search in store

###### fallbackToLexicalOnEmbeddingFailure?

`boolean`

Forwarded to the store — if true, semantic-search calls that hit an
embedding failure log a warning and return unranked results instead of
throwing. Defaults to false (fail-closed). See
[DynamoDBStoreOptions.fallbackToLexicalOnEmbeddingFailure](../interfaces/DynamoDBStoreOptions.md#fallbacktolexicalonembeddingfailure).

###### s3OffloadConfig?

[`S3OffloadConfig`](../interfaces/S3OffloadConfig.md)

S3 offloading configuration forwarded to the saver.

###### serde?

`SerializerProtocol`

Optional custom serializer protocol for checkpointer

###### tablePrefix?

`string`

Optional prefix for all table names (default: 'langgraph')

###### ttlDays?

`number`

Optional TTL in days for automatic cleanup (applies to all)

###### ttlSeconds?

`number`

TTL in seconds for the saver (overrides ttlDays if both set).

#### Returns

Object containing all three persistence instances

##### chatHistory

> **chatHistory**: [`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

##### checkpointer

> **checkpointer**: [`DynamoDBSaver`](DynamoDBSaver.md)

##### destroy

> **destroy**: () => `void`

Destroy the shared DynamoDB client created by createAll(). Call when no longer needed.

###### Returns

`void`

##### store

> **store**: [`DynamoDBStore`](DynamoDBStore.md)

#### Example

```TypeScript
// Create all instances with shared configuration
const { checkpointer, store, chatHistory } = DynamoDBFactory.createAll({
  tablePrefix: 'my-app',
  ttlDays: 30,
  clientConfig: { region: 'us-east-1' },
});

// Use with LangGraph
const app = workflow.compile({
  checkpointer,
  store,
});
```

***

### createChatMessageHistory()

> `static` **createChatMessageHistory**(`options?`): [`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

Defined in: [factory.ts:134](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/factory.ts#L134)

Create a DynamoDBChatMessageHistory instance with sensible defaults

#### Parameters

##### options?

`Partial`\<[`DynamoDBChatMessageHistoryOptions`](../interfaces/DynamoDBChatMessageHistoryOptions.md)\> = `{}`

Partial configuration options

#### Returns

[`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

Configured DynamoDBChatMessageHistory instance

#### Example

```TypeScript
// Minimal configuration (uses defaults)
const history = DynamoDBFactory.createChatMessageHistory({
  clientConfig: { region: 'us-east-1' }
});

// Custom table name and TTL
const history = DynamoDBFactory.createChatMessageHistory({
  tableName: 'my-chat-history',
  ttlDays: 365,
});
```

***

### createSaver()

> `static` **createSaver**(`options?`): [`DynamoDBSaver`](DynamoDBSaver.md)

Defined in: [factory.ts:54](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/factory.ts#L54)

Create a DynamoDBSaver instance with sensible defaults

#### Parameters

##### options?

`Partial`\<[`DynamoDBSaverOptions`](../interfaces/DynamoDBSaverOptions.md)\> = `{}`

Partial configuration options

#### Returns

[`DynamoDBSaver`](DynamoDBSaver.md)

Configured DynamoDBSaver instance

#### Example

```TypeScript
// Minimal configuration (uses defaults)
const checkpointer = DynamoDBFactory.createSaver({
  clientConfig: { region: 'us-east-1' }
});

// Custom table names and TTL
const checkpointer = DynamoDBFactory.createSaver({
  checkpointsTableName: 'my-checkpoints',
  writesTableName: 'my-writes',
  ttlDays: 30,
});
```

***

### createStore()

> `static` **createStore**(`options?`): [`DynamoDBStore`](DynamoDBStore.md)

Defined in: [factory.ts:98](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/factory.ts#L98)

Create a DynamoDBStore instance with sensible defaults

#### Parameters

##### options?

`Partial`\<[`DynamoDBStoreOptions`](../interfaces/DynamoDBStoreOptions.md)\> = `{}`

Partial configuration options

#### Returns

[`DynamoDBStore`](DynamoDBStore.md)

Configured DynamoDBStore instance

#### Example

```TypeScript
// Without a semantic search
const store = DynamoDBFactory.createStore({
  clientConfig: { region: 'us-east-1' }
});

// With semantic search
import { BedrockEmbeddings } from '@langchain/aws';

const store = DynamoDBFactory.createStore({
  embedding: new BedrockEmbeddings({
    model: 'amazon.titan-embed-text-v1',
  }),
  ttlDays: 90,
});
```
