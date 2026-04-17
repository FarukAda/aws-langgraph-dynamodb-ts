[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSessionChatMessageHistory

# Class: DynamoDBSessionChatMessageHistory

Defined in: history/session-adapter.ts:31

Single-session LangChain `BaseListChatMessageHistory` backed by the same
DynamoDB table used by `DynamoDBChatMessageHistory`. Instances close over a
specific `(userId, sessionId)` pair; pass through
`RunnableWithMessageHistory` via a `GetSessionHistoryCallable`.

## Extends

- `BaseListChatMessageHistory`

## Constructors

### Constructor

> **new DynamoDBSessionChatMessageHistory**(`params`): `DynamoDBSessionChatMessageHistory`

Defined in: history/session-adapter.ts:40

#### Parameters

##### params

`DynamoDBSessionChatMessageHistoryParams`

#### Returns

`DynamoDBSessionChatMessageHistory`

#### Overrides

`BaseListChatMessageHistory.constructor`

## Properties

### lc\_namespace

> **lc\_namespace**: `string`[]

Defined in: history/session-adapter.ts:32

A path to the module that contains the class, eg. ["langchain", "llms"]
Usually should be the same as the entrypoint the class is exported from.

#### Overrides

`BaseListChatMessageHistory.lc_namespace`

## Methods

### addMessage()

> **addMessage**(`message`): `Promise`\<`void`\>

Defined in: history/session-adapter.ts:58

Add a message object to the store.

#### Parameters

##### message

`BaseMessage`

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseListChatMessageHistory.addMessage`

***

### addMessages()

> **addMessages**(`messages`): `Promise`\<`void`\>

Defined in: history/session-adapter.ts:69

Add a list of messages.

Implementations should override this method to handle bulk addition of messages
in an efficient manner to avoid unnecessary round-trips to the underlying store.

#### Parameters

##### messages

`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]

A list of BaseMessage objects to store.

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseListChatMessageHistory.addMessages`

***

### clear()

> **clear**(): `Promise`\<`void`\>

Defined in: history/session-adapter.ts:80

Remove all messages from the store.

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseListChatMessageHistory.clear`

***

### getMessages()

> **getMessages**(): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: history/session-adapter.ts:49

Returns a list of messages stored in the store.

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

#### Overrides

`BaseListChatMessageHistory.getMessages`
