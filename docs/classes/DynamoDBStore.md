[**AWS LangGraph DynamoDB TypeScript v0.0.7**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStore

# Class: DynamoDBStore

Defined in: [store/index.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L31)

## Extends

- `BaseStore`

## Constructors

### Constructor

> **new DynamoDBStore**(`options`): `DynamoDBStore`

Defined in: [store/index.ts:47](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L47)

Create a new DynamoDB store instance

#### Parameters

##### options

[`DynamoDBStoreOptions`](../interfaces/DynamoDBStoreOptions.md)

Configuration options for the store

#### Returns

`DynamoDBStore`

#### Overrides

`BaseStore.constructor`

## Properties

### client

> `private` `readonly` **client**: `DynamoDBDocument`

Defined in: [store/index.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L33)

***

### ddbClient

> `private` `readonly` **ddbClient**: `DynamoDBClient`

Defined in: [store/index.ts:32](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L32)

***

### embedding?

> `private` `readonly` `optional` **embedding**: `BedrockEmbeddings`

Defined in: [store/index.ts:35](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L35)

***

### memoryTableName

> `private` `readonly` **memoryTableName**: `string`

Defined in: [store/index.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L34)

***

### ttlDays?

> `private` `readonly` `optional` **ttlDays**: `number`

Defined in: [store/index.ts:36](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L36)

## Methods

### batch()

> **batch**\<`Op`\>(`operations`, `config?`): `Promise`\<`OperationResults`\<`Op`\>\>

Defined in: [store/index.ts:79](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L79)

Execute a batch of operations in parallel

#### Type Parameters

##### Op

`Op` *extends* `Operation`[]

#### Parameters

##### operations

`Op`

Array of operations to execute

##### config?

`RunnableConfig`\<`Record`\<`string`, `any`\>\>

Runnable configuration containing user_id

#### Returns

`Promise`\<`OperationResults`\<`Op`\>\>

Array of results corresponding to each operation

#### Throws

Error if user_id is not provided in config or if any operation fails

#### Overrides

`BaseStore.batch`

***

### getOperation()

> `private` **getOperation**(`userId`, `op`): `Promise`\<`Item` \| `null`\>

Defined in: [store/index.ts:117](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L117)

Get a single item from the store

#### Parameters

##### userId

`string`

User ID for the item

##### op

`GetOperation`

Get operation parameters

#### Returns

`Promise`\<`Item` \| `null`\>

The item if found, null otherwise

***

### getUserId()

> `private` **getUserId**(`config?`): `string`

Defined in: [store/index.ts:63](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L63)

Extract and validate user ID from config

#### Parameters

##### config?

`RunnableConfig`\<`Record`\<`string`, `any`\>\>

Runnable configuration

#### Returns

`string`

User ID string

#### Throws

Error if user_id is not provided or invalid

***

### listNamespacesOperation()

> `private` **listNamespacesOperation**(`userId`, `op`): `Promise`\<`string`[][]\>

Defined in: [store/index.ts:167](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L167)

List unique namespaces in the store

#### Parameters

##### userId

`string`

User ID for filtering namespaces

##### op

`ListNamespacesOperation`

List namespaces operation parameters

#### Returns

`Promise`\<`string`[][]\>

Array of namespace paths

***

### putOperation()

> `private` **putOperation**(`userId`, `op`): `Promise`\<`void`\>

Defined in: [store/index.ts:132](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L132)

Put an item into the store

#### Parameters

##### userId

`string`

User ID for the item

##### op

`PutOperation`

Put operation parameters

#### Returns

`Promise`\<`void`\>

***

### searchOperation()

> `private` **searchOperation**(`userId`, `op`): `Promise`\<`SearchItem`[]\>

Defined in: [store/index.ts:150](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/store/index.ts#L150)

Search for items in the store with optional semantic search

#### Parameters

##### userId

`string`

User ID for filtering items

##### op

`SearchOperation`

Search operation parameters

#### Returns

`Promise`\<`SearchItem`[]\>

Array of matching items with optional similarity scores
