[**AWS LangGraph DynamoDB TypeScript v0.1.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistory

# Class: DynamoDBChatMessageHistory

Defined in: [history/index.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/index.ts#L19)

## Constructors

### Constructor

> **new DynamoDBChatMessageHistory**(`options`): `DynamoDBChatMessageHistory`

Defined in: [history/index.ts:35](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/index.ts#L35)

Create a new DynamoDB chat message history instance

#### Parameters

##### options

[`DynamoDBChatMessageHistoryOptions`](../interfaces/DynamoDBChatMessageHistoryOptions.md)

Configuration options for the chat message history

#### Returns

`DynamoDBChatMessageHistory`

## Methods

### addMessage()

> **addMessage**(`userId`, `sessionId`, `message`, `title?`): `Promise`\<`void`\>

Defined in: [history/index.ts:88](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/index.ts#L88)

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

Defined in: [history/index.ts:116](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/index.ts#L116)

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

`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]

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

Defined in: [history/index.ts:141](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/index.ts#L141)

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

### destroy()

> **destroy**(): `void`

Defined in: [history/index.ts:54](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/index.ts#L54)

Release underlying DynamoDB client resources.
Call this when the history is no longer needed to prevent resource leaks.
Skips cleanup if a shared client was injected via options.

#### Returns

`void`

***

### getMessages()

> **getMessages**(`userId`, `sessionId`): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: [history/index.ts:69](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/index.ts#L69)

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

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Array of BaseMessage objects in chronological order

#### Throws

Error if the operation fails or validation fails

***

### listSessions()

> **listSessions**(`userId`, `limit?`): `Promise`\<[`SessionMetadata`](../interfaces/SessionMetadata.md)[]\>

Defined in: [history/index.ts:159](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/index.ts#L159)

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
