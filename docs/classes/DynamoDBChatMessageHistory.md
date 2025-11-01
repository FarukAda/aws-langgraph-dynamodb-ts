[**AWS LangGraph DynamoDB TypeScript v0.0.9**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistory

# Class: DynamoDBChatMessageHistory

Defined in: [history/index.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/index.ts#L19)

## Constructors

### Constructor

> **new DynamoDBChatMessageHistory**(`options`): `DynamoDBChatMessageHistory`

Defined in: [history/index.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/index.ts#L33)

Create a new DynamoDB chat message history instance

#### Parameters

##### options

[`DynamoDBChatMessageHistoryOptions`](../interfaces/DynamoDBChatMessageHistoryOptions.md)

Configuration options for the chat message history

#### Returns

`DynamoDBChatMessageHistory`

## Properties

### client

> `private` `readonly` **client**: `DynamoDBDocument`

Defined in: [history/index.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/index.ts#L21)

***

### ddbClient

> `private` `readonly` **ddbClient**: `DynamoDBClient`

Defined in: [history/index.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/index.ts#L20)

***

### tableName

> `private` `readonly` **tableName**: `string`

Defined in: [history/index.ts:22](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/index.ts#L22)

***

### ttlDays?

> `private` `readonly` `optional` **ttlDays**: `number`

Defined in: [history/index.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/index.ts#L23)

## Methods

### addMessage()

> **addMessage**(`userId`, `sessionId`, `message`, `title?`): `Promise`\<`void`\>

Defined in: [history/index.ts:68](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/index.ts#L68)

Add a single message to a session
Generates title from the first message if this is a new session

#### Parameters

##### userId

`string`

User identifier

##### sessionId

`string`

Session identifier

##### message

`BaseMessage`

The BaseMessage to add to the session

##### title?

`string`

Optional session title (auto-generated from the first message if not provided)

#### Returns

`Promise`\<`void`\>

#### Throws

Error if the operation fails or validation fails

***

### addMessages()

> **addMessages**(`userId`, `sessionId`, `messages`, `title?`): `Promise`\<`void`\>

Defined in: [history/index.ts:96](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/index.ts#L96)

Add multiple messages to a session
Generates title from the first message if this is a new session
Preferred over calling addMessage multiple times for performance

#### Parameters

##### userId

`string`

User identifier

##### sessionId

`string`

Session identifier

##### messages

`BaseMessage`\<`MessageStructure`, `MessageType`\>[]

Array of BaseMessage objects to add

##### title?

`string`

Optional session title (auto-generated from the first message if not provided)

#### Returns

`Promise`\<`void`\>

#### Throws

Error if the operation fails or validation fails

***

### clear()

> **clear**(`userId`, `sessionId`): `Promise`\<`void`\>

Defined in: [history/index.ts:121](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/index.ts#L121)

Clear all messages in a session
Deletes the session item from DynamoDB

#### Parameters

##### userId

`string`

User identifier

##### sessionId

`string`

Session identifier

#### Returns

`Promise`\<`void`\>

#### Throws

Error if the operation fails or validation fails

***

### getMessages()

> **getMessages**(`userId`, `sessionId`): `Promise`\<`BaseMessage`\<`MessageStructure`, `MessageType`\>[]\>

Defined in: [history/index.ts:49](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/index.ts#L49)

Get all messages for a session
Messages are returned in chronological order

#### Parameters

##### userId

`string`

User identifier

##### sessionId

`string`

Session identifier

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`, `MessageType`\>[]\>

Array of BaseMessage objects in chronological order

#### Throws

Error if the operation fails or validation fails

***

### listSessions()

> **listSessions**(`userId`, `limit?`): `Promise`\<[`SessionMetadata`](../interfaces/SessionMetadata.md)[]\>

Defined in: [history/index.ts:139](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/index.ts#L139)

List all sessions for a user, sorted by most recent
Returns metadata only (excludes messages for performance)

#### Parameters

##### userId

`string`

User ID to list sessions for

##### limit?

`number`

Optional maximum number of sessions to return (default: no limit)

#### Returns

`Promise`\<[`SessionMetadata`](../interfaces/SessionMetadata.md)[]\>

Array of session metadata, sorted by most recent first

#### Throws

Error if the operation fails or validation fails
