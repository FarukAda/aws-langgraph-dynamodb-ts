[**AWS LangGraph DynamoDB TypeScript v0.0.9**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBFactory

# Class: DynamoDBFactory

Defined in: [factory.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/factory.ts#L25)

Factory class for creating DynamoDB persistence instances

## Constructors

### Constructor

> **new DynamoDBFactory**(): `DynamoDBFactory`

#### Returns

`DynamoDBFactory`

## Methods

### createAll()

> `static` **createAll**(`options`): `object`

Defined in: [factory.ts:165](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/factory.ts#L165)

Create all DynamoDB persistence instances at once with a shared configuration

#### Parameters

##### options

Configuration options

###### clientConfig?

`DynamoDBClientConfig`

Optional DynamoDB client configuration (shared)

###### embedding?

`BedrockEmbeddings`

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

`object`

Object containing all three persistence instances

##### chatHistory

> **chatHistory**: [`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

##### checkpointer

> **checkpointer**: [`DynamoDBSaver`](DynamoDBSaver.md)

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

> `static` **createChatMessageHistory**(`options`): [`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

Defined in: [factory.ts:126](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/factory.ts#L126)

Create a DynamoDBChatMessageHistory instance with sensible defaults

#### Parameters

##### options

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

> `static` **createSaver**(`options`): [`DynamoDBSaver`](DynamoDBSaver.md)

Defined in: [factory.ts:52](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/factory.ts#L52)

Create a DynamoDBSaver instance with sensible defaults

#### Parameters

##### options

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

> `static` **createStore**(`options`): [`DynamoDBStore`](DynamoDBStore.md)

Defined in: [factory.ts:92](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/factory.ts#L92)

Create a DynamoDBStore instance with sensible defaults

#### Parameters

##### options

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
