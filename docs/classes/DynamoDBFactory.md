[**AWS LangGraph DynamoDB TypeScript v0.1.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBFactory

# Class: DynamoDBFactory

Defined in: [factory.ts:26](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/factory.ts#L26)

Factory class for creating DynamoDB persistence instances

## Constructors

### Constructor

> **new DynamoDBFactory**(): `DynamoDBFactory`

#### Returns

`DynamoDBFactory`

## Methods

### createAll()

> `static` **createAll**(`options?`): `object`

Defined in: [factory.ts:172](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/factory.ts#L172)

Create all DynamoDB persistence instances at once with a shared configuration

#### Parameters

##### options?

Configuration options

###### clientConfig?

`DynamoDBClientConfig`

Optional DynamoDB client configuration (shared)

###### embedding?

`EmbeddingsInterface`\<`number`[]\>

Optional Bedrock embeddings for semantic search in store

###### serde?

`SerializerProtocol`

Optional custom serializer protocol for checkpointer

###### tablePrefix?

`string`

Optional prefix for all table names (default: 'langgraph')

###### ttlDays?

`number`

Optional TTL in days for automatic cleanup (applies to all)

#### Returns

Object containing all three persistence instances

##### chatHistory

> **chatHistory**: [`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

##### checkpointer

> **checkpointer**: [`DynamoDBSaver`](DynamoDBSaver.md)

##### destroy()

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

Defined in: [factory.ts:132](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/factory.ts#L132)

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

Defined in: [factory.ts:53](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/factory.ts#L53)

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

Defined in: [factory.ts:97](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/factory.ts#L97)

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
